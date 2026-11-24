import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { tempDir } from "./fixture.ts";
import {
  hcConnectSubscriber,
  hcConnectTransport,
  subscriptionLine,
  type DocRequest,
  type DocTransport,
} from "./herdr-docs.ts";
import {
  fakeDocCores,
  memoryDocSubscriber,
  memoryDocTransport,
  type FakeDocCores,
} from "./herdr-docs-fake.ts";
import { storeConformance } from "./state-store-conformance.ts";
import { CLAIM_TTL_MS, herdrStore } from "./state-herdr.ts";
import { keys, type StateKey, type StateStore } from "./state-store.ts";

const noRemote = () => Effect.die(new Error("this test touches no remote archive"));
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const fail = <A, E>(effect: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(effect));

/**
 * A herdr-doc store over fake cores, with the home on another machine (strix calling homebase) or on
 * this core.
 */
const fakeStore = (
  options: { remote: boolean } = { remote: true },
): { store: StateStore; cores: FakeDocCores; stateDir: string; sent: DocRequest[] } => {
  const cores = options.remote
    ? fakeDocCores("strix", { homebase: "up" })
    : fakeDocCores("homebase");
  const stateDir = tempDir("coordinate-herdr-store-");
  const sent: DocRequest[] = [];
  const memory = memoryDocTransport(cores);
  const transport: DocTransport = (requests) => {
    sent.push(...requests);
    return memory(requests);
  };
  return {
    cores,
    stateDir,
    sent,
    store: herdrStore({
      home: "homebase",
      prefix: "ct.",
      appendRemote: noRemote,
      readRemote: noRemote,
      transport,
      self: Effect.succeed(cores.self),
      stateDir,
    }),
  };
};

/**
 * A transport that holds the reply to the first claims-document reads until `parties` callers have
 * read, so rival coordinators all read the same claims before any of them writes.
 * @param inner The transport to pass the requests to.
 * @param parties How many first reads to gather.
 * @returns The transport.
 */
const lockstep = (inner: DocTransport, parties = 2): DocTransport => {
  let waiting: Array<() => void> = [];
  let open = false;
  return (requests) => {
    const claimRead = requests.some(
      (request) => request.method === "doc.get" && request.params.name.includes(".k."),
    );
    if (!claimRead || open) return inner(requests);
    // Read first, then hold the reply, so every party's read lands before any party writes.
    return Effect.flatMap(inner(requests), (replies) =>
      Effect.as(
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              waiting.push(resolve);
              if (waiting.length < parties) return;
              open = true;
              for (const release of waiting) release();
              waiting = [];
            }),
        ),
        replies,
      ),
    );
  };
};

const put = async (store: StateStore, key: StateKey, value: unknown) =>
  run(store.write(key, value, (await run(store.read(key))).version));

storeConformance(
  "herdr-doc (fake core)",
  async () => {
    const { store, cores } = fakeStore();
    // A second store over the same cores is another machine writing the same home.
    const other = herdrStore({
      home: "homebase",
      prefix: "ct.",
      appendRemote: noRemote,
      readRemote: noRemote,
      transport: memoryDocTransport(cores),
      self: Effect.succeed("strix"),
      stateDir: tempDir("coordinate-herdr-other-"),
    });
    const coordinatorOn = (self: string, host: string, transport: DocTransport) =>
      herdrStore({
        home: "homebase",
        prefix: "ct.",
        appendRemote: noRemote,
        readRemote: noRemote,
        transport,
        self: Effect.succeed(self),
        host,
        stateDir: tempDir("coordinate-herdr-rival-"),
      });
    return {
      store,
      interfere: async (key, value) => {
        await put(other, key, value);
      },
      rivals: () => {
        const shared = lockstep(memoryDocTransport(cores));
        return [coordinatorOn("strix", "strix", shared), coordinatorOn("finbar", "finbar", shared)];
      },
      offline: {
        home: "homebase",
        cut: () => {
          cores.machines.homebase = "down";
        },
      },
    };
  },
  { offline: true },
);

const claimsOf = (cores: FakeDocCores): Record<string, Record<string, unknown>> =>
  (cores.docs.homebase?.["ct.k.app"]?.value as { claims?: Record<string, Record<string, unknown>> })
    ?.claims ?? {};

describe("herdr-doc capacity claims across machines", () => {
  const coordinator = (cores: FakeDocCores, host: string, clock: { now: number }) =>
    herdrStore({
      home: "homebase",
      prefix: "ct.",
      appendRemote: noRemote,
      readRemote: noRemote,
      transport: memoryDocTransport(cores),
      self: Effect.succeed(host),
      host,
      now: () => clock.now,
      stateDir: tempDir("coordinate-herdr-claim-"),
    });

  test("a claim held from another machine refuses until it expires, then another machine takes it", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const clock = { now: Date.parse("2026-11-23T10:00:00.000Z") };
    const strix = coordinator(cores, "strix", clock);
    const finbar = coordinator(cores, "finbar", clock);
    await run(strix.claim("app", "i1"));
    clock.now += CLAIM_TTL_MS - 1;
    const busy = await fail(finbar.claim("app", "i1"));
    expect([busy._tag, busy.message]).toEqual([
      "ClaimBusy",
      "queued item is already being retried (pid " +
        process.pid +
        " on strix, until 2026-11-23T10:15:00.000Z)",
    ]);
    clock.now += 1;
    const taken = await run(finbar.claim("app", "i1"));
    expect(claimsOf(cores)).toEqual({
      i1: {
        token: taken.token,
        pid: process.pid,
        host: "finbar",
        expires: Date.parse("2026-11-23T10:30:00.000Z"),
      },
    });
  });

  test("a claim another machine left without an expiry is taken over", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    cores.docs.homebase = {
      "ct.k.app": {
        value: { claims: { i1: { token: "old", pid: 1, host: "strix" } } },
        version: 1,
      },
    };
    const clock = { now: Date.parse("2026-11-23T10:00:00.000Z") };
    const taken = await run(coordinator(cores, "finbar", clock).claim("app", "i1"));
    expect(taken.location).toBe("herdr-doc://homebase/ct.k.app#i1");
  });

  test("the expired claim's first owner does not release the new owner's claim", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const clock = { now: Date.parse("2026-11-23T10:00:00.000Z") };
    const strix = coordinator(cores, "strix", clock);
    const finbar = coordinator(cores, "finbar", clock);
    const stale = await run(strix.claim("app", "i1"));
    clock.now += CLAIM_TTL_MS;
    const taken = await run(finbar.claim("app", "i1"));
    await run(strix.release(stale));
    expect(claimsOf(cores).i1?.token).toBe(taken.token);
  });

  test("lists another machine's claim as held until it expires", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const clock = { now: Date.parse("2026-11-23T10:00:00.000Z") };
    await run(coordinator(cores, "strix", clock).claim("app", "i1"));
    const finbar = coordinator(cores, "finbar", clock);
    clock.now += CLAIM_TTL_MS - 1;
    const before = await run(finbar.heldClaims(["app"]));
    clock.now += 1;
    expect([before, await run(finbar.heldClaims(["app"]))]).toEqual([
      ["herdr-doc://homebase/ct.k.app#i1"],
      [],
    ]);
  });
});

describe("herdr-doc store", () => {
  test("keeps each kind under the prefix: one document per backlog and queue, an index of domains, and ended records in shards", async () => {
    const { store, cores } = fakeStore();
    await put(store, keys.backlog("app"), { domain: "app" });
    await put(store, keys.policy(), { revision: 1 });
    await put(store, keys.queue("app"), { entries: [] });
    await put(store, keys.ended("s-1"), { session: "s-1" });
    const names = Object.keys(cores.docs.homebase ?? {}).toSorted();
    expect(names.filter((name) => !name.startsWith("ct.ended."))).toEqual([
      "ct.b.app",
      "ct.domains",
      "ct.policy",
      "ct.q.app",
    ]);
    const shards = names.filter((name) => name.startsWith("ct.ended."));
    expect(shards.length).toBe(1);
    expect(cores.docs.homebase?.[shards[0] ?? ""]?.value).toEqual({
      records: { "s-1": { session: "s-1" } },
    });
    expect(cores.docs.homebase?.["ct.domains"]?.value).toEqual({ domains: ["app"] });
  });

  test("names each document's address on the home in messages", () => {
    const { store } = fakeStore();
    expect([store.location(keys.backlog("app")), store.location(keys.policy())]).toEqual([
      "herdr-doc://homebase/ct.b.app",
      "herdr-doc://homebase/ct.policy",
    ]);
  });

  test("sends on: <home> from another machine and leaves it out on the home itself", async () => {
    const away = fakeStore({ remote: true });
    const home = fakeStore({ remote: false });
    await run(away.store.read(keys.policy()));
    await run(home.store.read(keys.policy()));
    expect([away.sent, home.sent]).toEqual([
      [{ method: "doc.get", params: { name: "ct.policy", on: "homebase" } }],
      [{ method: "doc.get", params: { name: "ct.policy" } }],
    ]);
  });

  test("keeps session state and the wiki lint clock in local files", async () => {
    const { store, cores, stateDir } = fakeStore();
    await put(store, keys.session("s-1"), { resumes: 1 });
    await put(store, keys.lint("app"), { at: "x" });
    expect([
      existsSync(join(stateDir, "sessions", "s-1.json")),
      existsSync(join(stateDir, "wiki-lint", "app.json")),
      Object.keys(cores.docs.homebase ?? {}),
    ]).toEqual([true, true, []]);
  });

  test("refuses a domain whose document name would pass 32 characters", async () => {
    const { store, sent } = fakeStore();
    const domain = "a-very-long-domain-name-for-docs";
    expect(store.refusal(keys.backlog(domain))).toBe(
      `domain ${domain} cannot be stored in the herdr-doc backend: ct.b.${domain} is 37 characters, over Herdr's 32-character document name limit`,
    );
    expect(store.refusal(keys.backlog("app"))).toBe(undefined);
    const error = await fail(
      store.write(keys.backlog(domain), { domain }, (await run(store.read(keys.policy()))).version),
    );
    expect(error._tag).toBe("BacklogError");
    expect(sent.filter((request) => request.method === "doc.set")).toEqual([]);
  });

  test("reports a document over 1 MiB as a write failure and keeps the old one", async () => {
    const { store } = fakeStore();
    await put(store, keys.backlog("app"), { domain: "app" });
    const current = await run(store.read(keys.backlog("app")));
    const error = await fail(
      store.write(keys.backlog("app"), { big: "x".repeat(1024 * 1024) }, current.version),
    );
    expect([error._tag, error.message]).toEqual([
      "BacklogError",
      "herdr-doc://homebase/ct.b.app: document exceeds 1 MiB of JSON",
    ]);
    expect((await run(store.read(keys.backlog("app")))).value).toEqual({ domain: "app" });
  });

  test("keeps archives in local files on the home and reaches them through the home from elsewhere", async () => {
    const home = fakeStore({ remote: false });
    await run(home.store.appendArchive("app", ['{"id":"i1"}']));
    const appended: unknown[] = [];
    const away = herdrStore({
      home: "homebase",
      prefix: "ct.",
      appendRemote: (machine, domain, lines) =>
        Effect.sync(() => void appended.push([machine, domain, lines])),
      readRemote: (machine, domain) => Effect.succeed(`read ${domain} on ${machine}\n`),
      transport: memoryDocTransport(fakeDocCores("strix", { homebase: "up" })),
      self: Effect.succeed("strix"),
      stateDir: tempDir("coordinate-herdr-away-"),
    });
    await run(away.appendArchive("app", ['{"id":"i2"}']));
    expect([
      readFileSync(join(home.stateDir, "backlogs", "app.archive.jsonl"), "utf8"),
      appended,
      await run(home.store.readArchive("app")),
      await run(home.store.readArchive("web")),
      await run(away.readArchive("app")),
    ]).toEqual([
      '{"id":"i1"}\n',
      [["homebase", "app", ['{"id":"i2"}']]],
      '{"id":"i1"}\n',
      undefined,
      "read app on homebase\n",
    ]);
  });

  test("names the home when it is unreachable", async () => {
    const { store, cores } = fakeStore();
    cores.machines.homebase = "down";
    const error = await fail(store.read(keys.policy()));
    expect([error._tag, error.message]).toEqual([
      "StoreOffline",
      "the state home homebase is unreachable (homebase is unreachable: cannot reach homebase); shared state was not read or written",
    ]);
  });
});

describe("herdr-doc follow", () => {
  test("on the home, notices a write from another machine to a followed document only, never its own", async () => {
    const cores = fakeDocCores("homebase", { strix: "up" });
    const options = {
      home: "homebase",
      prefix: "ct.",
      appendRemote: noRemote,
      readRemote: noRemote,
      stateDir: tempDir("coordinate-herdr-follow-"),
    };
    const home = herdrStore({
      ...options,
      transport: memoryDocTransport(cores),
      subscribe: memoryDocSubscriber(cores),
      self: Effect.succeed("homebase"),
    });
    const away = herdrStore({
      ...options,
      transport: memoryDocTransport({ ...cores, self: "strix", machines: { homebase: "up" } }),
      subscribe: memoryDocSubscriber({ ...cores, self: "strix", machines: { homebase: "up" } }),
      self: Effect.succeed("strix"),
    });
    let notices = 0;
    const followed = await run(
      home.follow?.([keys.backlog("app"), keys.session("s-1")], () => {
        notices += 1;
      }) ?? Effect.succeed(undefined),
    );
    // The fake delivers events after a zero-delay timer, as herdr-core sends them after the reply.
    const delivered = () => new Promise((resolve) => setTimeout(resolve, 0));
    await put(away, keys.backlog("app"), { domain: "app" });
    await put(away, keys.backlog("web"), { domain: "web" });
    await put(away, keys.policy(), { revision: 1 });
    await delivered();
    await put(home, keys.backlog("app"), { domain: "app", by: "home" });
    await delivered();
    followed?.close();
    await put(away, keys.backlog("app"), { domain: "app", again: true });
    await delivered();
    expect([
      notices,
      away.follow === undefined
        ? "no follow"
        : await run(away.follow([keys.backlog("app")], () => {})),
    ]).toEqual([1, undefined]);
  });

  test("reads the subscribe reply, doc events and nothing else from a subscription line", () => {
    expect(
      [
        '{"id":1,"jsonrpc":"2.0","result":{"channel":null,"seq":47417,"terminals":[]}}',
        '{"id":1,"jsonrpc":"2.0","error":{"code":-32601,"data":{"kind":"unknown_method"},"message":"no"}}',
        '{"jsonrpc":"2.0","method":"event","params":{"data":{"name":"cs.b.app","version":2},"seq":47419,"type":"doc"}}',
        '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":47263}}',
        "not json",
      ].map(subscriptionLine),
    ).toEqual([
      { reply: true },
      { reply: false },
      { changed: "cs.b.app", version: 2 },
      undefined,
      undefined,
    ]);
  });
});

// The opt-in run against this Mac's real core, under a short random prefix per run. Herdr cannot
// remove a document, so teardown nulls every name the run wrote and leaves their tombstones.
const realCore = process.env.COORDINATE_HERDR_DOCS === "1";
if (!realCore)
  console.log("herdr-doc real-core suite skipped: set COORDINATE_HERDR_DOCS=1 to run it");
const prefix = `ct${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}.`;
const written = new Set<string>();
const recording: DocTransport = (requests) => {
  for (const request of requests)
    if (request.method === "doc.set") written.add(request.params.name);
  return hcConnectTransport(requests);
};
if (realCore) {
  afterAll(async () => {
    const names = [...written];
    const current = await run(
      recording(names.map((name) => ({ method: "doc.get", params: { name } }))),
    );
    await run(
      hcConnectTransport(
        names.flatMap((name, index) => {
          const reply = current[index];
          if (reply?.ok !== true) return [];
          const { value, version } = reply.result as { value: unknown; version: number };
          return value === null
            ? []
            : [{ method: "doc.set" as const, params: { name, value: null, version } }];
        }),
      ),
    );
    console.log(`herdr-doc real-core suite: nulled ${names.length} documents under ${prefix}`);
  });
}

describe.if(realCore)("herdr-doc real core", () => {
  test("uses a throwaway prefix, never the production one", () => {
    expect([prefix.startsWith("ct"), prefix.length, prefix === "cs."]).toEqual([true, 9, false]);
  });

  test("hears a document set on this core through its own subscription connection", async () => {
    const heard: string[] = [];
    const subscription = hcConnectSubscriber([`${prefix}f*`], (name) => heard.push(name));
    try {
      expect(await subscription.ready).toBe(true);
      const name = `${prefix}fa`;
      await run(recording([{ method: "doc.set", params: { name, value: { n: 1 }, version: 0 } }]));
      // Herdr delivers doc events within tens of milliseconds; give it up to five seconds.
      for (let waited = 0; heard.length === 0 && waited < 5_000; waited += 20) await Bun.sleep(20);
      expect(heard).toEqual([name]);
    } finally {
      subscription.close();
    }
  });
});

let runIndex = 0;
storeConformance(
  "herdr-doc (real core)",
  async () => {
    // Each test gets its own sub-prefix so they cannot see each other's documents.
    runIndex += 1;
    const store = herdrStore({
      home: "local-core",
      prefix: `${prefix}${runIndex.toString(36)}.`,
      appendRemote: noRemote,
      readRemote: noRemote,
      transport: recording,
      self: Effect.succeed("local-core"),
      stateDir: tempDir("coordinate-herdr-real-"),
    });
    const other = herdrStore({
      home: "local-core",
      prefix: `${prefix}${runIndex.toString(36)}.`,
      appendRemote: noRemote,
      readRemote: noRemote,
      transport: recording,
      self: Effect.succeed("local-core"),
      stateDir: tempDir("coordinate-herdr-real-other-"),
    });
    const shared = lockstep(recording);
    const rival = (host: string) =>
      herdrStore({
        home: "local-core",
        prefix: `${prefix}${runIndex.toString(36)}.`,
        appendRemote: noRemote,
        readRemote: noRemote,
        transport: shared,
        self: Effect.succeed("local-core"),
        host,
        stateDir: tempDir("coordinate-herdr-real-rival-"),
      });
    return {
      store,
      interfere: async (key, value) => {
        await put(other, key, value);
      },
      rivals: () => [rival("sim-a"), rival("sim-b")],
      offline: undefined,
    };
  },
  { offline: false },
  realCore,
);
