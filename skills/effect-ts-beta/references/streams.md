# Stream Patterns in Effect v4

Streams are lazy, pull-based sequences of values that can be infinite. Handle with care.

## v3 to v4 Changes

| v3                            | v4                                          |
| ----------------------------- | ------------------------------------------- |
| `Stream.catchAll`             | `Stream.catch`                              |
| `Stream.catchSome`            | `Stream.catchFilter`                        |
| `Stream.repeatEffect`         | `Stream.fromEffectRepeat`                   |
| `Stream.fromChunk`            | `Stream.fromArray`                          |
| `Stream.acquireRelease`       | `Stream.scoped(Effect.acquireRelease(...))` |
| `runCollect` gives `Chunk<A>` | `runCollect` gives `Array<A>`               |

The chunk representation is now a plain array, which is why the array-oriented combinators (`fromArray`,
`fromArrays`, `mapArray`, `flattenArray`, `bufferArray`, `runForEachArray`) replace the `Chunk`-oriented ones.
`Stream.grouped` still produces grouped output, now as arrays.

## Create Streams

```typescript
import { Stream } from "effect";

Stream.make(1, 2, 3);
Stream.fromIterable([1, 2, 3]);
Stream.fromArray([1, 2, 3]);
Stream.fromEffect(fetchUser());

// Repeat an effect forever (v3: repeatEffect).
Stream.fromEffectRepeat(Effect.sync(() => Math.random()));

// Poll an effect on a schedule.
Stream.fromEffectSchedule(pollStatus, Schedule.spaced("5 seconds"));

// Paginated APIs.
Stream.paginate(0, (page) => fetchPage(page));

Stream.fromAsyncIterable(asyncGenerator(), (error) => new StreamError({ cause: error }));
Stream.fromEventListener(window, "resize");
Stream.fromReadableStream(webStream, (error) => new StreamError({ cause: error }));
Stream.fromQueue(queue);
Stream.fromPubSub(pubsub);

// Any callback-based API. The callback receives a Queue to push into, and
// returns an Effect that registers cleanup in the stream's Scope.
Stream.callback<number>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => setInterval(() => Queue.offerUnsafe(queue, Date.now()), 1000)),
    (id) => Effect.sync(() => clearInterval(id)),
  ),
);
```

## Consume Streams

```typescript
// Collect all values. DANGEROUS for infinite streams. Returns Array<A> in v4.
const allValues = yield * Stream.runCollect(stream);

yield * Stream.runForEach(stream, (value) => Effect.log(`Got: ${value}`));
const sum = yield * Stream.runFold(stream, 0, (acc, n) => acc + n);
const first = yield * Stream.runHead(stream); // Option<A>
const last = yield * Stream.runLast(stream); // Option<A>
const count = yield * Stream.runCount(stream);
yield * Stream.runDrain(stream); // Run for side effects, discard values
```

## Bound Consumption (Critical for Safety)

```typescript
// WRONG: hangs forever on an infinite stream.
yield * Stream.runCollect(infiniteStream);

// RIGHT: take first N elements.
yield * Stream.runCollect(Stream.take(infiniteStream, 100));

// RIGHT: take until a condition.
yield * Stream.runCollect(Stream.takeUntil(stream, (x) => x > 100));

// RIGHT: take while a condition holds.
yield * Stream.runCollect(Stream.takeWhile(stream, (x) => x < 100));

// RIGHT: apply a timeout.
yield * Stream.runCollect(stream).pipe(Effect.timeout("5 seconds"));

// RIGHT: stop on an external signal.
yield * Stream.runDrain(Stream.haltWhen(stream, shutdownSignal));
```

## Transform Streams

```typescript
Stream.map(stream, (x) => x * 2);
Stream.mapEffect(stream, (x) => process(x), { concurrency: 5 });
Stream.filter(stream, (x) => x > 0);
Stream.filterMap(stream, (x) => (x > 0 ? Option.some(x) : Option.none()));
Stream.flatMap(userIds, (id) => Stream.fromEffect(fetchUser(id)));
Stream.switchMap(stream, (x) => innerStream(x)); // Cancel the previous inner stream
Stream.tap(stream, (x) => Effect.log(`Processing: ${x}`));
Stream.scan(stream, 0, (acc, x) => acc + x); // Emits running totals
Stream.mapAccum(stream, initial, (state, x) => [nextState, output]);
Stream.zipWithIndex(stream);
Stream.changes(stream); // Drop consecutive duplicates
```

## Chunk, Batch, and Rate

```typescript
Stream.grouped(stream, 100); // Batches of 100
Stream.groupedWithin(stream, 100, "1 second"); // Batch by size or time, whichever first
Stream.rechunk(stream, 1000);
Stream.buffer(stream, { capacity: 64, strategy: "suspend" });
// `cost` is required: it prices each batch against `units` per `duration`.
Stream.throttle(stream, { cost: (batch) => batch.length, units: 10, duration: "1 second" });
Stream.debounce(stream, "300 millis");
Stream.sliding(stream, 3); // Sliding windows
```

## Handle Errors in Streams

```typescript
Stream.catch(stream, (error) => Stream.make(fallbackValue)); // v3: catchAll
Stream.catchCause(stream, (cause) => Stream.empty);
Stream.catchTag(stream, "NetworkError", (e) => Stream.empty);
Stream.catchTags(stream, { NetworkError: fn, ParseError: fn });
Stream.catchFilter(Filter.fromPredicate(pred), (e) => Stream.empty); // v3: catchSome
Stream.retry(stream, Schedule.exponential("100 millis"));
Stream.orDie(stream); // Convert failures to defects
Stream.ignoreCause(stream);
```

New in v4, matching the `Effect` combinators: `Stream.catchReason` and `Stream.catchReasons` for tagged reasons
inside an error.

## Resource Safety

```typescript
// v4 has no Stream.acquireRelease. Wrap a scoped effect instead.
Stream.scoped(Effect.acquireRelease(openFile(path), (handle) => Effect.sync(() => handle.close())));

// Unwrap a stream produced by a scoped effect.
Stream.unwrap(
  Effect.gen(function* () {
    const conn = yield* acquireConnection;
    return Stream.fromQueue(conn.queue);
  }),
);

Stream.ensuring(stream, cleanup);
Stream.onExit(stream, (exit) => Effect.log(`finished: ${exit._tag}`));
```

## Encoding and Decoding

```typescript
import { Ndjson } from "effect/unstable/encoding";

Stream.decodeText(byteStream);
Stream.encodeText(textStream);
Stream.splitLines(textStream);
Stream.pipeThroughChannel(byteStream, Ndjson.decodeSchema(MySchema));
```

## Fan-Out and Merge

```typescript
Stream.merge(a, b);
Stream.mergeAll([a, b, c], { concurrency: 3 });
Stream.zip(a, b);
Stream.zipLatest(a, b);
Stream.concat(a, b);
Stream.interleave(a, b);
Stream.partition(stream, (x) => x > 0);

// Scoped fan-out. Both return Effects requiring a Scope.
yield * Stream.broadcast(stream, { capacity: 16 }); // one shared downstream Stream
yield * Stream.broadcastN(stream, { n: 3, capacity: 16 }); // a tuple of 3 Streams
yield * Stream.share(stream, { capacity: 16, idleTimeToLive: "10 seconds" });
```

## Common Gotchas

1. **Infinite streams**: always bound consumption with `take`, `takeUntil`, `haltWhen`, or a timeout.
2. **`runCollect` returns an `Array` now**: v3 code calling `Chunk.toReadonlyArray` on the result will not compile.
3. **`catchAll` does not exist**: it is `Stream.catch`.
4. **Backpressure**: streams are pull-based, so slow consumers apply backpressure automatically. A stalled consumer
   stalls the producer rather than buffering without bound.
5. **Resource leaks**: use `Stream.scoped` with `Effect.acquireRelease`. There is no `Stream.acquireRelease` in v4.
6. **Error propagation**: errors terminate the stream. Use `Stream.catch` to recover, `Stream.retry` to restart.
7. **Chunking overhead**: `rechunk` for better throughput with many small items.
