import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { failureOf, runWith, tempDir } from "./fixture.ts";
import {
  fleetEvents,
  fleetSummary,
  foldStatus,
  joinFleet,
  parseFleet,
  readFleet,
  readLeaseFleet,
} from "./fleet-watch.ts";
import { HerdrError } from "./herdr.ts";
import { fakeDocCores, memoryDocTransport } from "./herdr-docs-fake.ts";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { takeLease } from "./lease.ts";
import { fakeProc, ok } from "./proc.ts";
import { herdrStore } from "./state-herdr.ts";
import { keys, runCommand } from "./state-store.ts";

const snapshot = (entries: Array<[string, string]>) => new Map(entries);

describe("foldStatus", () => {
  it("folds idle and done into settled and a missing status into unknown", () => {
    expect([
      foldStatus("idle"),
      foldStatus("done"),
      foldStatus("blocked"),
      foldStatus(undefined),
    ]).toEqual(["settled", "settled", "blocked", "unknown"]);
  });
});

describe("parseFleet", () => {
  it("reads machines and terminals and skips excluded addresses", async () => {
    const text = JSON.stringify({
      machines: [{ name: "strix", state: "connected" }],
      terminals: [
        { address: "t1", status: "idle" },
        { address: "t2", status: "working" },
        { address: "t3" },
        { address: "me", status: "working" },
      ],
    });
    const fleet = await Effect.runPromise(parseFleet(text, new Set(["me"])));
    expect([...fleet]).toEqual([
      ["m:strix", "connected"],
      ["t:t1", "settled"],
      ["t:t2", "working"],
      ["t:t3", "unknown"],
    ]);
  });
});

describe("fleetEvents", () => {
  const context = { domains: new Map<string, string>(), machine: "mac" };

  it("reports settling, other changes, arrival and departure as events, and stays silent on working", () => {
    const previous = snapshot([
      ["t:a", "working"],
      ["t:b", "settled"],
      ["t:c", "working"],
      ["t:gone", "settled"],
      ["m:strix", "connected"],
    ]);
    const current = snapshot([
      ["t:a", "settled"],
      ["t:b", "working"],
      ["t:c", "blocked"],
      ["t:strix/t4", "working"],
      ["m:strix", "disconnected"],
    ]);
    const domains = new Map([
      ["a", "app"],
      ["c", "ops"],
      ["gone", "web"],
    ]);
    expect(fleetEvents(previous, current, { domains, machine: "mac" })).toEqual([
      {
        kind: "fleet-settled",
        attrs: { source: "terminal", address: "a", domain: "app", machine: "mac", from: "working" },
        fields: {},
        text: "read its last output and backlog; relay a new ask or result, or report stranded work",
      },
      {
        kind: "fleet-state",
        attrs: {
          source: "terminal",
          address: "c",
          domain: "ops",
          machine: "mac",
          from: "working",
          to: "blocked",
        },
        fields: {},
        text: "relay its question, options and recommendation, and leave the answer to the user",
      },
      {
        kind: "fleet-arrived",
        attrs: { source: "terminal", address: "strix/t4", machine: "strix", state: "working" },
        fields: {},
        text: "verify it with hc get (domain, tab, harness) before trusting it",
      },
      {
        kind: "fleet-state",
        attrs: { source: "machine", machine: "strix", from: "connected", to: "disconnected" },
        fields: {},
        text: "its coordinators may read as departed until it reconnects; rediscover the fleet",
      },
      {
        kind: "fleet-departed",
        attrs: { source: "terminal", address: "gone", domain: "web", machine: "mac" },
        fields: {},
        text: "hc get says why; an arrival with the same domain and tab is a harness handoff, otherwise report it and ask whether to spawn it again",
      },
    ]);
  });

  it("names a lease's domain, holder and machine, and a new holder as a state change", () => {
    const previous = snapshot([
      ["l:app", "t1"],
      ["l:web", "homebase/t7"],
    ]);
    const current = snapshot([
      ["l:app", "t2"],
      ["l:ops", "nigelsheldon/t4"],
    ]);
    expect(
      fleetEvents(previous, current, context).map((event) => [event.kind, event.attrs]),
    ).toEqual([
      [
        "fleet-state",
        { source: "lease", domain: "app", address: "t2", machine: "mac", from: "t1", to: "t2" },
      ],
      [
        "fleet-arrived",
        { source: "lease", domain: "ops", address: "nigelsheldon/t4", machine: "nigelsheldon" },
      ],
      [
        "fleet-departed",
        { source: "lease", domain: "web", address: "homebase/t7", machine: "homebase" },
      ],
    ]);
  });

  it("produces nothing for an unchanged fleet", () => {
    const fleet = snapshot([["t:a", "settled"]]);
    expect(fleetEvents(fleet, fleet, context)).toEqual([]);
  });
});

describe("joinFleet", () => {
  it("adds only leases for coordinators this core does not list, never the excluded one", () => {
    const labelled = snapshot([["t:t3", "settled"]]);
    const leases = snapshot([
      ["l:manager", "t9"],
      ["l:app", "t3"],
      ["l:ops", "nigelsheldon/t4"],
    ]);
    expect([...joinFleet(labelled, leases, new Set(["t9"]))]).toEqual([
      ["t:t3", "settled"],
      ["l:ops", "nigelsheldon/t4"],
    ]);
  });
});

describe("fleetSummary", () => {
  it("lists terminals with their domain, leases and machines", () => {
    const fleet = snapshot([
      ["m:strix", "connected"],
      ["t:t3", "settled"],
      ["t:t5", "working"],
      ["l:ops", "nigelsheldon/t4"],
    ]);
    expect(fleetSummary(fleet, new Map([["t3", "app"]]))).toEqual([
      "machine strix [connected]",
      "app t3 [settled]",
      "? t5 [working]",
      "ops nigelsheldon/t4 [lease]",
    ]);
    expect(fleetSummary(undefined, new Map())).toEqual([]);
  });
});

describe("readFleet", () => {
  it("asks hc for coordinators only", async () => {
    const fake = fakeProc(() =>
      ok(JSON.stringify({ terminals: [{ address: "t1", status: "done" }] })),
    );
    const fleet = await runWith(readFleet(new Set()), fake.layer);
    expect([...fleet]).toEqual([["t:t1", "settled"]]);
    expect(fake.calls.map((call) => call.argv)).toEqual([
      ["hc", "ls", "--json", "--label", "fleet.role=coordinator"],
    ]);
  });

  it("fails with HerdrError on unreadable output", async () => {
    const fake = fakeProc(() => ok("not json"));
    const failure = await failureOf(readFleet(new Set()), fake.layer);
    expect(failure instanceof HerdrError).toBe(true);
  });
});

const T0 = Date.parse("2026-11-23T12:00:00.000Z");

const noRemote = () => Effect.die(new Error("no archive in this test"));

describe("readLeaseFleet", () => {
  it("names every live coordinator by domain, on any machine, as the manager's machine does", async () => {
    const cores = fakeDocCores("strix", { homebase: "up" });
    const store = herdrStore({
      home: "homebase",
      prefix: "ct.",
      appendRemote: noRemote,
      readRemote: noRemote,
      transport: memoryDocTransport(cores),
      self: Effect.succeed("strix"),
      stateDir: tempDir("coordinate-fleet-leases-"),
    });
    const leased = async (
      domain: string,
      machine: string | undefined,
      address: string,
      at = T0,
    ) => {
      await Effect.runPromise(
        runCommand(store, keys.backlog(domain), () =>
          Effect.succeed({ write: true as const, next: emptyBacklog(domain, null), value: domain }),
        ),
      );
      if (machine !== undefined)
        await Effect.runPromise(takeLease(store, domain, { machine, address }, at));
    };
    await leased("app", "strix", "t1");
    await leased("ops", "nigelsheldon", "t4");
    await leased("web", "homebase", "t7");
    await leased("lab", "homebase", "t2", T0 - 600_000);
    await leased("docs", undefined, "");
    const fleet = await Effect.runPromise(readLeaseFleet(store, "strix", T0));
    expect([...fleet]).toEqual([
      ["l:app", "t1"],
      ["l:ops", "nigelsheldon/t4"],
      ["l:web", "homebase/t7"],
    ]);
  });
});
