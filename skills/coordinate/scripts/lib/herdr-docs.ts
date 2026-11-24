import { Effect, Schema } from "effect";
import { herdr } from "./herdr.ts";
import { Proc } from "./proc.ts";

/**
 * The most serialized JSON a Herdr document may hold.
 */
export const DOC_LIMIT_BYTES = 1024 * 1024;

/**
 * The longest document name Herdr accepts.
 */
export const DOC_NAME_LIMIT = 32;

/**
 * Why Herdr would refuse a document name, or undefined when it accepts it: 1-32 of a-z, 0-9, `-`,
 * `_` and `.`, starting with a letter or digit, and not shaped like a terminal id (`t7`).
 * @param name Document name.
 * @returns The reason, or undefined.
 */
export const docNameProblem = (name: string): string | undefined => {
  if (name.length > DOC_NAME_LIMIT)
    return `${name} is ${name.length} characters, over Herdr's ${DOC_NAME_LIMIT}-character document name limit`;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name))
    return `${name} is not a Herdr document name (a-z 0-9 - _ . starting with a letter or digit)`;
  if (/^t[0-9a-z]+$/.test(name)) return `${name} is shaped like a Herdr terminal id`;
  return undefined;
};

/**
 * One document call over `hc connect`. `on` names the machine that holds the document; leave it
 * out for this core.
 */
export type DocRequest =
  | { method: "doc.get"; params: { name: string; on?: string } }
  | { method: "doc.set"; params: { name: string; value: unknown; version: number; on?: string } };

/**
 * A call's reply: its result, or herdr-core's error kind (`conflict`, `invalid_params`,
 * `unavailable`, `machine_unknown`, ...) and message.
 */
export type DocReply = { ok: true; result: unknown } | { ok: false; kind: string; message: string };

/**
 * `hc connect` could not be run or gave no usable reply (not running, timed out, garbled output).
 */
export class DocUnreachable extends Schema.TaggedError<DocUnreachable>()("DocUnreachable", {
  message: Schema.String,
}) {}

/**
 * Send document calls and receive one reply per call, in order.
 */
export type DocTransport = (
  requests: readonly DocRequest[],
) => Effect.Effect<DocReply[], DocUnreachable>;

// An unreachable machine takes a few seconds for ssh to give up; allow for it.
const CONNECT_TIMEOUT_MS = 30_000;

const Reply = Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      data: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ kind: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
});

/**
 * Parse `hc connect`'s reply lines into one reply per request id.
 * @param text stdout.
 * @param count How many requests were sent (ids 1 to count).
 * @returns Replies in request order.
 */
export const parseDocReplies = (
  text: string,
  count: number,
): Effect.Effect<DocReply[], DocUnreachable> =>
  Effect.try({
    try: () => {
      const byId = new Map<number, DocReply>();
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const reply = Schema.decodeUnknownSync(Reply)(JSON.parse(line));
        byId.set(
          reply.id,
          reply.error === undefined
            ? { ok: true, result: reply.result }
            : {
                ok: false,
                kind: reply.error.data?.kind ?? "error",
                message: reply.error.message ?? "herdr-core error",
              },
        );
      }
      return Array.from({ length: count }, (_, index) => {
        const reply = byId.get(index + 1);
        if (reply === undefined)
          throw new Error(`hc connect gave no reply to request ${index + 1}`);
        return reply;
      });
    },
    catch: (cause) =>
      new DocUnreachable({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

/**
 * The real transport: one `hc connect` process per batch, one JSON-RPC request per line, closed
 * when stdin ends.
 * @param requests Calls.
 * @returns Replies in order.
 */
export const hcConnectTransport: DocTransport = (requests) =>
  Effect.gen(function* () {
    const input = requests
      .map((request, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request }))
      .map((line) => `${line}\n`)
      .join("");
    const out = yield* herdr(["hc", "connect"], CONNECT_TIMEOUT_MS, input).pipe(
      Effect.mapError((error) => new DocUnreachable({ message: error.message })),
      Effect.provide(Proc.layer),
    );
    return yield* parseDocReplies(out, requests.length);
  });
