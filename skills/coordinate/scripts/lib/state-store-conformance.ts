import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { keys, runCommand, type StateKey, type StateStore } from "./state-store.ts";

/**
 * One backend under test: a fresh, empty store, and a way to change a document behind the store's
 * back, the way a writer on another machine would.
 */
export type ConformanceBackend = {
  store: StateStore;
  /**
   * Overwrite a document directly, bypassing every lock and version check.
   */
  interfere: (key: StateKey, value: unknown) => Promise<void>;
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(effect));

/**
 * The behavior every state backend must share: versioned writes, conflict retry and refusal,
 * enumeration, and the capacity queue's claims. Run it once per backend with a factory that returns
 * a fresh store. Lease and offline-refusal cases join this suite with the tickets that add them.
 * @param name Backend name, for the describe block.
 * @param make A fresh backend per test.
 */
export const storeConformance = (name: string, make: () => Promise<ConformanceBackend>) =>
  describe(`${name} store conformance`, () => {
    describe("versioned writes", () => {
      test("a document never written reads as null", async () => {
        const { store } = await make();
        expect((await run(store.read(keys.backlog("app")))).value).toBe(null);
      });

      test("a write returns the version a read then reports, with the value written", async () => {
        const { store } = await make();
        const key = keys.policy();
        const first = await run(store.read(key));
        const version = await run(store.write(key, { revision: 1 }, first.version));
        expect(await run(store.read(key))).toEqual({ value: { revision: 1 }, version });
      });

      test("a write with a stale version conflicts and leaves the document as it was", async () => {
        const { store, interfere } = await make();
        const key = keys.queue("app");
        const first = await run(store.read(key));
        await run(store.write(key, { n: 1 }, first.version));
        const read = await run(store.read(key));
        await interfere(key, { n: 2 });
        const error = await fail(store.write(key, { n: 3 }, read.version));
        expect(error._tag).toBe("StoreConflict");
        expect((await run(store.read(key))).value).toEqual({ n: 2 });
      });

      test("writing null deletes, and the version from that write recreates it", async () => {
        const { store } = await make();
        const key = keys.ended("s-1");
        const first = await run(store.read(key));
        const written = await run(store.write(key, { name: "a" }, first.version));
        const deleted = await run(store.write(key, null, written));
        expect((await run(store.read(key))).value).toBe(null);
        await run(store.write(key, { name: "b" }, deleted));
        expect((await run(store.read(key))).value).toEqual({ name: "b" });
      });
    });

    describe("conflict retry and refusal", () => {
      test("a command that loses one race runs again on the fresh document and wins", async () => {
        const { store, interfere } = await make();
        const key = keys.backlog("app");
        let runs = 0;
        const value = await run(
          runCommand(store, key, (current) =>
            Effect.promise(async () => {
              runs += 1;
              if (runs === 1) await interfere(key, { count: 10 });
              const count = (current.value as { count: number } | null)?.count ?? 0;
              return { write: true as const, next: { count: count + 1 }, value: count + 1 };
            }),
          ),
        );
        expect([runs, value]).toEqual([2, 11]);
        expect((await run(store.read(key))).value).toEqual({ count: 11 });
      });

      test("a command that loses three races refuses and writes nothing of its own", async () => {
        const { store, interfere } = await make();
        const key = keys.backlog("app");
        let runs = 0;
        const error = await fail(
          runCommand(store, key, () =>
            Effect.promise(async () => {
              runs += 1;
              await interfere(key, { other: runs });
              return { write: true as const, next: { mine: runs }, value: runs };
            }),
          ),
        );
        expect(runs).toBe(3);
        expect(error._tag).toBe("Refused");
        expect(error.message).toBe(
          `${store.location(key)} kept changing: 3 attempts lost a write race; run the command again`,
        );
        expect((await run(store.read(key))).value).toEqual({ other: 3 });
      });

      test("a command that writes nothing leaves the version as it was", async () => {
        const { store } = await make();
        const key = keys.session("s-1");
        const first = await run(store.read(key));
        const version = await run(store.write(key, { resumes: 1 }, first.version));
        const value = await run(
          runCommand(store, key, () => Effect.succeed({ write: false as const, value: "kept" })),
        );
        expect(value).toBe("kept");
        expect((await run(store.read(key))).version).toBe(version);
      });
    });

    describe("enumeration", () => {
      test("lists the domains and ended sessions present, never a deleted one", async () => {
        const { store } = await make();
        const put = async (key: StateKey, value: unknown) =>
          run(store.write(key, value, (await run(store.read(key))).version));
        await put(keys.backlog("zeta"), { domain: "zeta" });
        await put(keys.backlog("alpha"), { domain: "alpha" });
        await put(keys.backlog("gone"), { domain: "gone" });
        await put(keys.backlog("gone"), null);
        await put(keys.ended("s-2"), { session: "s-2" });
        await put(keys.ended("s-1"), { session: "s-1" });
        expect([
          [...(await run(store.list("backlog")))].toSorted(),
          [...(await run(store.list("ended")))].toSorted(),
        ]).toEqual([
          ["alpha", "zeta"],
          ["s-1", "s-2"],
        ]);
      });
    });

    describe("capacity queue claims", () => {
      test("a held slot refuses a second claim until it is released", async () => {
        const { store } = await make();
        const claim = await run(store.claim("app", "i1"));
        const busy = await fail(store.claim("app", "i1"));
        expect(busy._tag).toBe("ClaimBusy");
        const other = await run(store.claim("app", "i2"));
        await run(store.release(claim));
        await run(store.release(other));
        await run(store.release(await run(store.claim("app", "i1"))));
      });

      test("a version-checked queue entry survives a concurrent enqueue", async () => {
        const { store, interfere } = await make();
        const key = keys.queue("app");
        let runs = 0;
        await run(
          runCommand(store, key, (current) =>
            Effect.promise(async () => {
              runs += 1;
              if (runs === 1) await interfere(key, { entries: ["i1"] });
              const entries = (current.value as { entries: string[] } | null)?.entries ?? [];
              return {
                write: true as const,
                next: { entries: [...entries, "i2"] },
                value: undefined,
              };
            }),
          ),
        );
        expect((await run(store.read(key))).value).toEqual({ entries: ["i1", "i2"] });
      });
    });
  });
