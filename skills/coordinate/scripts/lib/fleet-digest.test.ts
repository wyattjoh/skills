import { describe, expect, it } from "bun:test";
import { emptyBacklog } from "./backlog-store/ops.ts";
import type { Backlog, Item } from "./backlog-store/schema.ts";
import { backlogDigest, digestDelta, lastMessage, sameDigest } from "./fleet-digest.ts";

const item = (id: string, status: Item["status"], question?: string): Item => ({
  id,
  title: id,
  status,
  touches: [],
  decided: [],
  ask:
    question === undefined
      ? null
      : { question, context: null, options: [], rec: null, recReason: null, discuss: null },
  answered: [],
  due: null,
  delegates: [],
  createdAt: "2026-11-25T00:00:00.000Z",
  closedAt: null,
  outcome: null,
});

const backlog = (items: Item[], focus: string | null = null): Backlog => ({
  ...emptyBacklog("app", null),
  focus,
  items,
});

describe("backlogDigest", () => {
  it("keeps asks, statuses, focus and sorted live delegates", () => {
    expect(
      backlogDigest(
        backlog([item("i1", "open"), item("i2", "waiting-user", "Ship it?")], "Fix login"),
        ["b", "a", "b"],
      ),
    ).toEqual({
      asks: { i2: "Ship it?" },
      statuses: { i1: "open", i2: "waiting-user" },
      focus: "Fix login",
      delegates: ["a", "b"],
    });
  });
});

describe("sameDigest and digestDelta", () => {
  const before = backlogDigest(
    backlog([item("i1", "open"), item("i2", "waiting-user", "Ship it?")], "A"),
    ["fix-a"],
  );

  it("matches an unchanged digest, never a missing one", () => {
    expect(sameDigest(before, structuredClone(before))).toBe(true);
    expect(sameDigest(undefined, before)).toBe(false);
    expect(sameDigest(before, undefined)).toBe(false);
  });

  it("names each change since the last wake", () => {
    const after = backlogDigest(
      backlog([item("i1", "building"), item("i2", "open"), item("i3", "waiting-user", "Which?")]),
      ["fix-b"],
    );
    expect(digestDelta(before, after)).toEqual([
      "i1 open -> building",
      "i2 waiting-user -> open",
      "i3 added, waiting-user",
      "i3 asks: Which?",
      "i2 ask answered or withdrawn",
      "focus cleared",
      "delegate fix-b started",
      "delegate fix-a ended",
    ]);
    expect(digestDelta(undefined, after)).toEqual([]);
  });
});

describe("lastMessage", () => {
  it("keeps the last Claude Code message and drops tool calls, timing and the prompt box", () => {
    const screen = [
      "⏺ An earlier message.",
      "",
      '❯ <hc from="t1">a prompt</hc>',
      "",
      "⏺ Write(.scratch/brief.md)",
      "  ⎿  Wrote 49 lines to .scratch/brief.md",
      "",
      "⏺ I started a delegate on i4.",
      "",
      "  - Next: wait for its report.",
      "",
      "✻ Baked for 8s · done 8:30 PM",
      "",
      "─".repeat(40),
      "❯ ",
      "─".repeat(40),
      "  ⏵⏵ auto mode on",
    ].join("\n");
    expect(lastMessage(screen)).toBe("I started a delegate on i4. - Next: wait for its report.");
  });

  it("keeps the last lines of a screen without message markers, and cuts a long message", () => {
    expect(lastMessage("one\n\ntwo\n")).toBe("one two");
    expect(lastMessage(`⏺ ${"x".repeat(2000)}`)).toBe(`${"x".repeat(1500)}…`);
    expect(lastMessage("")).toBe("");
  });
});
