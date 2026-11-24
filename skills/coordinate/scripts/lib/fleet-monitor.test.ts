import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { failureOf, runWith } from "./fixture.ts";
import {
  fleetEvents,
  foldStatus,
  monitorFleet,
  parseFleet,
  readFleet,
  readLeaseFleet,
} from "./fleet-monitor.ts";
import { HerdrError } from "./herdr.ts";
import { fakeDocCores, memoryDocTransport } from "./herdr-docs-fake.ts";
import { emptyBacklog } from "./backlog-store/ops.ts";
import { takeLease } from "./lease.ts";
import { fakeProc, ok } from "./proc.ts";
import { herdrStore } from "./state-herdr.ts";
import { keys, runCommand } from "./state-store.ts";
import { tempDir } from "./fixture.ts";

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
  it("reports settling, other changes, arrival and departure, and stays silent on working", () => {
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
      ["t:new", "working"],
      ["m:strix", "disconnected"],
    ]);
    expect(fleetEvents(previous, current)).toEqual([
      "settled t:a (working->settled)",
      "state t:c working->blocked",
      "arrived t:new=working",
      "state m:strix connected->disconnected",
      "departed t:gone",
    ]);
  });

  it("produces nothing for an unchanged fleet", () => {
    const fleet = snapshot([["t:a", "settled"]]);
    expect(fleetEvents(fleet, fleet)).toEqual([]);
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

describe("monitorFleet with leases", () => {
  it("reports coordinators arriving and leaving by lease, keeping the last good leases through a failed read", async () => {
    const fake = fakeProc(() =>
      ok(JSON.stringify({ terminals: [{ address: "t3", status: "idle" }] })),
    );
    const readings: Array<Array<[string, string]> | "down"> = [
      [["l:app", "t1"]],
      [
        ["l:app", "t1"],
        ["l:ops", "nigelsheldon/t4"],
      ],
      "down",
      [["l:ops", "nigelsheldon/t4"]],
    ];
    let read = 0;
    const leases = Effect.suspend(() => {
      const reading = readings[Math.min(read, readings.length - 1)];
      read += 1;
      return reading === "down" || reading === undefined
        ? Effect.fail(new Error("homebase is unreachable"))
        : Effect.succeed(new Map(reading));
    });
    const lines: string[] = [];
    await runWith(
      monitorFleet({
        intervalMs: 1,
        durationMs: 300,
        exclude: new Set(),
        emit: (line) => Effect.sync(() => void lines.push(line)),
        leases: { read: leases, everyMs: 0, home: "homebase" },
      }),
      fake.layer,
    );
    expect([read >= readings.length, lines]).toEqual([
      true,
      ["arrived l:ops=nigelsheldon/t4", "departed l:app", "monitor expired"],
    ]);
  });

  it("prints blind naming the home after three failed lease reads in a row, and clears it on the next good read", async () => {
    const fake = fakeProc(() =>
      ok(JSON.stringify({ terminals: [{ address: "t3", status: "idle" }] })),
    );
    const readings: Array<Array<[string, string]> | "down"> = [
      [["l:app", "t1"]],
      "down",
      "down",
      [["l:app", "t1"]],
      "down",
      "down",
      "down",
      "down",
      [
        ["l:app", "t1"],
        ["l:ops", "nigelsheldon/t4"],
      ],
    ];
    let read = 0;
    const leases = Effect.suspend(() => {
      const reading = readings[Math.min(read, readings.length - 1)];
      read += 1;
      return reading === "down" || reading === undefined
        ? Effect.fail(new Error("homebase is unreachable"))
        : Effect.succeed(new Map(reading));
    });
    const lines: string[] = [];
    await runWith(
      monitorFleet({
        intervalMs: 1,
        durationMs: 300,
        exclude: new Set(),
        emit: (line) => Effect.sync(() => void lines.push(line)),
        leases: { read: leases, everyMs: 0, home: "homebase" },
      }),
      fake.layer,
    );
    expect([read >= readings.length, lines]).toEqual([
      true,
      [
        "blind: state home homebase unreachable 3 times: homebase is unreachable; lease entries are from the last good read",
        "blind cleared: state home homebase readable again",
        "arrived l:ops=nigelsheldon/t4",
        "monitor expired",
      ],
    ]);
  });

  it("leaves out the manager's own lease and a coordinator this core already lists", async () => {
    const fake = fakeProc(() =>
      ok(JSON.stringify({ terminals: [{ address: "t3", status: "idle" }] })),
    );
    const readings: Array<Array<[string, string]>> = [
      [],
      [
        ["l:manager", "t9"],
        ["l:app", "t3"],
        ["l:ops", "nigelsheldon/t4"],
      ],
    ];
    let read = 0;
    const leases = Effect.suspend(() => {
      const reading = readings[Math.min(read, readings.length - 1)] ?? [];
      read += 1;
      return Effect.succeed(new Map(reading));
    });
    const lines: string[] = [];
    await runWith(
      monitorFleet({
        intervalMs: 1,
        durationMs: 200,
        exclude: new Set(["t9"]),
        emit: (line) => Effect.sync(() => void lines.push(line)),
        leases: { read: leases, everyMs: 0, home: "homebase" },
      }),
      fake.layer,
    );
    expect(lines).toEqual(["arrived l:ops=nigelsheldon/t4", "monitor expired"]);
  });
});
