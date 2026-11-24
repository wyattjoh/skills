import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { backlogList } from "./backlog-list.ts";
import { addItem, emptyBacklog, updateItem } from "./backlog-store/ops.ts";
import type { Backlog } from "./backlog-store/schema.ts";
import { tempDir } from "./fixture.ts";
import { fakeDocCores, memoryDocTransport, type FakeDocCores } from "./herdr-docs-fake.ts";
import { herdrStore } from "./state-herdr.ts";
import { keys, type StateKey, type StateStore } from "./state-store.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const noRemote = () => Effect.die(new Error("this test touches no remote archive"));
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const LIVE = "2026-11-23T12:02:00.000Z";
const LAPSED = "2026-11-23T11:59:00.000Z";

/**
 * One machine's store over the shared fake cores, the home being homebase.
 */
const machine = (cores: FakeDocCores, self: string): StateStore =>
  herdrStore({
    home: "homebase",
    prefix: "ct.",
    appendRemote: noRemote,
    readRemote: noRemote,
    transport: memoryDocTransport({ ...cores, self }),
    self: Effect.succeed(self),
    stateDir: tempDir("coordinate-backlog-list-"),
  });

const put = async (store: StateStore, key: StateKey, value: unknown) =>
  run(store.write(key, value, (await run(store.read(key))).version));

const withItem = (domain: string, patch: Partial<Backlog> = {}): Backlog => {
  const added = addItem(emptyBacklog(domain, null), {
    title: "first",
    now: "2026-11-23T10:00:00.000Z",
  });
  if (!added.ok) throw new Error(added.reason);
  return { ...added.backlog, ...patch };
};

// Every domain one machine lists, with documents.
const listed = async (store: StateStore, self: string) =>
  (await run(backlogList(store, { machine: self, now: NOW, documents: true, domain: undefined })))
    .domains;

describe("backlogList", () => {
  test("lists every domain in name order with its lease, composed for this machine", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const strix = machine(cores, "strix");
    await put(
      strix,
      keys.backlog("beta"),
      withItem("beta", { lease: { machine: "finbar", address: "t3", expiry: LIVE } }),
    );
    await put(
      strix,
      keys.backlog("alpha"),
      withItem("alpha", { lease: { machine: "strix", address: "t1fn", expiry: LIVE } }),
    );
    await put(strix, keys.backlog("gamma"), withItem("gamma"));
    await put(
      strix,
      keys.backlog("delta"),
      withItem("delta", { lease: { machine: "finbar", address: "t9", expiry: LAPSED } }),
    );
    expect(
      await run(
        backlogList(strix, { machine: "strix", now: NOW, documents: false, domain: undefined }),
      ),
    ).toEqual({
      machine: "strix",
      domains: [
        {
          domain: "alpha",
          lease: { machine: "strix", address: "t1fn", expiry: LIVE, live: true, terminal: "t1fn" },
        },
        {
          domain: "beta",
          lease: {
            machine: "finbar",
            address: "t3",
            expiry: LIVE,
            live: true,
            terminal: "finbar/t3",
          },
        },
        {
          domain: "delta",
          lease: {
            machine: "finbar",
            address: "t9",
            expiry: LAPSED,
            live: false,
            terminal: "finbar/t9",
          },
        },
        { domain: "gamma", lease: null },
      ],
    });
  });

  test("names no terminal when this core's name is unknown", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const strix = machine(cores, "strix");
    await put(
      strix,
      keys.backlog("alpha"),
      withItem("alpha", { lease: { machine: "strix", address: "t1fn", expiry: LIVE } }),
    );
    expect(
      await run(
        backlogList(strix, { machine: undefined, now: NOW, documents: false, domain: undefined }),
      ),
    ).toEqual({
      machine: null,
      domains: [
        {
          domain: "alpha",
          lease: { machine: "strix", address: "t1fn", expiry: LIVE, live: true, terminal: null },
        },
      ],
    });
  });

  test("with documents, gives each stored backlog and the ended records its delegate refs name", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const strix = machine(cores, "strix");
    const delegated = withItem("alpha");
    const alpha: Backlog = {
      ...delegated,
      items: delegated.items.map((item) => ({
        ...item,
        status: "delegated",
        delegates: [
          {
            name: "a",
            session: "s-ended",
            branch: null,
            worktree: null,
            brief: "/b",
            report: "/r",
          },
          { name: "b", session: "s-live", branch: null, worktree: null, brief: "/b", report: "/r" },
        ],
      })),
    };
    await put(strix, keys.backlog("alpha"), alpha);
    await put(strix, keys.backlog("broken"), { schemaVersion: 1 });
    await put(strix, keys.ended("s-ended"), {
      session: "s-ended",
      ended_at: "2026-11-20T09:00:00.000Z",
    });
    await put(strix, keys.ended("s-other"), {
      session: "s-other",
      ended_at: "2026-11-21T09:00:00.000Z",
    });
    expect(
      await run(
        backlogList(strix, { machine: "strix", now: NOW, documents: true, domain: undefined }),
      ),
    ).toEqual({
      machine: "strix",
      domains: [
        {
          domain: "alpha",
          lease: null,
          document: alpha,
          unreadable: null,
          ended: { "s-ended": "2026-11-20T09:00:00.000Z" },
        },
        {
          domain: "broken",
          lease: null,
          document: { schemaVersion: 1 },
          unreadable: null,
          ended: {},
        },
      ],
    });
  });

  test("lists only the domain asked for, and none for a domain with no backlog", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const strix = machine(cores, "strix");
    await put(strix, keys.backlog("alpha"), withItem("alpha"));
    await put(strix, keys.backlog("beta"), withItem("beta"));
    const only = (domain: string) =>
      run(backlogList(strix, { machine: "strix", now: NOW, documents: false, domain }));
    expect(await only("beta")).toEqual({
      machine: "strix",
      domains: [{ domain: "beta", lease: null }],
    });
    expect(await only("nope")).toEqual({ machine: "strix", domains: [] });
  });

  test("off the home and on it, two machines list the same domains, and an answer given on one shows on the other", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const strix = machine(cores, "strix");
    const home = machine(cores, "homebase");
    const asked = withItem("alpha");
    const alpha: Backlog = {
      ...asked,
      items: asked.items.map((item) => ({
        ...item,
        status: "waiting-user",
        ask: {
          question: "Which?",
          context: null,
          options: ["a", "b"],
          rec: "a",
          recReason: "short",
          discuss: null,
        },
      })),
    };
    await put(home, keys.backlog("alpha"), alpha);
    await put(home, keys.backlog("beta"), withItem("beta"));
    const names = async (store: StateStore, self: string) =>
      (await listed(store, self)).map((row) => row.domain);
    expect(await names(strix, "strix")).toEqual(["alpha", "beta"]);
    expect(await names(home, "homebase")).toEqual(["alpha", "beta"]);
    const answered = updateItem(alpha, {
      id: "i1",
      status: undefined,
      outcome: undefined,
      decided: [],
      touch: [],
      untouch: [],
      due: undefined,
      ask: undefined,
      context: undefined,
      options: [],
      rec: undefined,
      why: undefined,
      answer: "a",
      now: "2026-11-23T11:00:00.000Z",
    });
    if (!answered.ok) throw new Error(answered.reason);
    await put(strix, keys.backlog("alpha"), answered.backlog);
    const seen = (await listed(home, "homebase"))[0]?.document as Backlog;
    expect(seen.items[0]?.answered.map((entry) => [entry.question, entry.answer])).toEqual([
      ["Which?", "a"],
    ]);
  });
});
