import { describe, expect, it } from "bun:test";
import { coordinatorMissing } from "./strix-fixture.ts";

// The strix suite's coordinator scenario skips naming what strix lacks; this reads its probe.
describe("coordinatorMissing", () => {
  it("names nothing when strix reaches the home's store, finds bun and has a current skill", () => {
    const probe = [
      "route=ok",
      "bun=/home/me/.local/share/mise/shims/bun",
      "skill=/home/me/.claude/skills/coordinate",
      "prefix=yes",
    ].join("\n");
    expect(coordinatorMissing(probe, "finbar")).toEqual([]);
  });

  it("names each missing prerequisite in order", () => {
    const probe = [
      'route={"jsonrpc":"2.0","id":1,"error":{"code":-32602,"data":{"kind":"machine_unknown"}}}',
      "bun=",
      "skill=",
      "prefix=no",
    ].join("\n");
    expect(coordinatorMissing(probe, "finbar")).toEqual([
      'a Herdr route to finbar\'s store ({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"data":{"kind":"machine_unknown"}}})',
      "bun on its login PATH",
      "the coordinate skill (no link at ~/.claude/skills/coordinate, ~/.pi/agent/skills/coordinate or ~/.agents/skills/coordinate)",
    ]);
  });

  it("names a skill that predates state_prefix, which the scenario needs to keep off cs. documents", () => {
    const probe = [
      "route=ok",
      "bun=/usr/bin/bun",
      "skill=/home/me/.claude/skills/coordinate",
      "prefix=no",
    ].join("\n");
    expect(coordinatorMissing(probe, "finbar")).toEqual([
      "a coordinate skill that knows state_prefix (/home/me/.claude/skills/coordinate predates it)",
    ]);
  });

  it("names every prerequisite when the probe printed nothing it can read", () => {
    expect(coordinatorMissing("hc: command not found", "finbar")).toEqual([
      "a Herdr route to finbar's store (no answer)",
      "bun on its login PATH",
      "the coordinate skill (no link at ~/.claude/skills/coordinate, ~/.pi/agent/skills/coordinate or ~/.agents/skills/coordinate)",
    ]);
  });
});
