import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { failureOf, runWith } from "./fixture.ts";
import { fleetEvents, foldStatus, parseFleet, readFleet } from "./fleet-monitor.ts";
import { HerdrError } from "./herdr.ts";
import { fakeProc, ok } from "./proc.ts";

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
