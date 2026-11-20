import { expect, test } from "bun:test";
import { emptyBacklog } from "../../lib/store.ts";
import {
  boundaryOutput,
  cachedDocument,
  chosenAnswer,
  delegateLabel,
  delegateLine,
  delegateUrgency,
  draftFor,
  mergeEnded,
  readDocument,
  trailOf,
} from "./model.ts";
import type { DelegateRow, DelegateState, DocumentState } from "./model.ts";

const loaded: DocumentState = { kind: "loaded", backlog: emptyBacklog("alpha", null) };
const invalid: DocumentState = { kind: "invalid", reason: "items must be a list" };
const shown = new Map<string, DocumentState>([
  ["alpha", loaded],
  ["beta", invalid],
]);

test("draftFor and chosenAnswer encode an optional Discuss note without changing real answers", () => {
  const ask = {
    question: "Which store?",
    context: null,
    options: ["A"],
    rec: null,
    recReason: null,
    discuss: null,
  };
  const draft = draftFor("alpha\\0i1\\0Which store?", ask, undefined);
  expect(draft).toEqual({
    key: "alpha\\0i1\\0Which store?",
    choice: undefined,
    discuss: false,
    text: "",
    busy: false,
    error: undefined,
  });
  expect(chosenAnswer({ ...draft, discuss: true })).toBe("Discuss");
  expect(chosenAnswer({ ...draft, discuss: true, text: "  compare migrations  " })).toBe(
    "Discuss: compare migrations",
  );
  expect(chosenAnswer({ ...draft, choice: "A" })).toBe("A");
});

test("boundaryOutput accepts the CLI's Boundary JSON and rejects malformed output", () => {
  expect(boundaryOutput('{"owned":["/repo"],"adjacent":["/nearby"]}')).toEqual({
    owned: ["/repo"],
    adjacent: ["/nearby"],
  });
  expect(boundaryOutput('{"owned":[1],"adjacent":[]}')).toBeUndefined();
  expect(boundaryOutput("refused: duplicate path")).toBeUndefined();
});

test("cachedDocument draws a domain's last read state, whatever its kind", () => {
  expect(cachedDocument(shown, "alpha")).toEqual(loaded);
  expect(cachedDocument(shown, "beta")).toEqual(invalid);
});

test("cachedDocument draws loading for a domain not read yet and for the listing", () => {
  expect(cachedDocument(shown, "gamma")).toEqual({ kind: "loading" });
  expect(cachedDocument(shown, undefined)).toEqual({ kind: "loading" });
});

test("readDocument migrates legacy standing approvals to ordered policy ids", () => {
  const legacy = {
    schemaVersion: 1,
    domain: "alpha",
    focus: null,
    legacy: null,
    boundary: { owned: [], adjacent: [] },
    standingYes: [
      { text: "merge docs", at: "2026-11-17" },
      { text: "keep branches local", at: "2026-11-18T08:00:00.000Z" },
    ],
    items: [],
    findings: [],
    nextId: 1,
  };
  expect(readDocument(JSON.stringify(legacy))).toEqual({
    kind: "loaded",
    backlog: {
      ...emptyBacklog("alpha", null),
      policies: [
        { id: "p1", text: "merge docs", at: "2026-11-17" },
        { id: "p2", text: "keep branches local", at: "2026-11-18T08:00:00.000Z" },
      ],
      nextPolicyId: 3,
    },
  });
});

test("trailOf links domain pages and record details back to their parent screens", () => {
  const lists = { kind: "domain", domain: "skills" } as const;
  const findings = { kind: "findings", domain: "skills" } as const;
  expect(trailOf({ kind: "domains" })).toEqual([
    { id: "crumb-domains", label: "Domains", to: undefined },
  ]);
  expect(trailOf(lists)).toEqual([
    { id: "crumb-domains", label: "Domains", to: { kind: "domains" } },
    { id: "crumb-domain-skills", label: "skills", to: undefined },
  ]);
  expect(
    [{ kind: "policies", domain: "skills" }, findings, { kind: "boundary", domain: "skills" }].map(
      (screen) => trailOf(screen).at(-1),
    ),
  ).toEqual([
    { id: "crumb-policies", label: "Policies", to: undefined },
    { id: "crumb-findings", label: "Findings", to: undefined },
    { id: "crumb-boundary", label: "Boundary", to: undefined },
  ]);
  expect(trailOf({ kind: "item", domain: "skills", id: "i4" })).toEqual([
    { id: "crumb-domains", label: "Domains", to: { kind: "domains" } },
    { id: "crumb-domain-skills", label: "skills", to: lists },
    { id: "crumb-items", label: "Items", to: lists },
    { id: "crumb-item-i4", label: "i4", to: undefined },
  ]);
  expect(trailOf({ kind: "finding", domain: "skills", id: "f5" })).toEqual([
    { id: "crumb-domains", label: "Domains", to: { kind: "domains" } },
    { id: "crumb-domain-skills", label: "skills", to: lists },
    { id: "crumb-findings", label: "Findings", to: findings },
    { id: "crumb-finding-f5", label: "f5", to: undefined },
  ]);
});

test("mergeEnded keeps known records, lays each lookup over them and drops a vanished one", () => {
  const known = new Map<string, string | null>([
    ["s-a", "2026-11-16"],
    ["s-b", null],
    ["s-c", "2026-11-14"],
  ]);
  const merged = mergeEnded(known, [
    ["s-b", "2026-11-17"],
    ["s-c", undefined],
    ["s-d", null],
  ]);
  expect([...merged]).toEqual([
    ["s-a", "2026-11-16"],
    ["s-b", "2026-11-17"],
    ["s-d", null],
  ]);
  expect([...known]).toEqual([
    ["s-a", "2026-11-16"],
    ["s-b", null],
    ["s-c", "2026-11-14"],
  ]);
});

const live = (status: "working" | "idle" | "blocked" | "done" | "error" | "unknown") =>
  ({ kind: "live", status }) as const;

test("delegateUrgency ranks asking, failed, working, resting, gone, then ended", () => {
  const states: DelegateState[] = [
    live("blocked"),
    live("error"),
    live("working"),
    live("idle"),
    live("done"),
    live("unknown"),
    { kind: "gone" },
    { kind: "ended", at: "2026-11-16" },
  ];
  expect(states.map(delegateUrgency)).toEqual([0, 1, 2, 3, 3, 3, 4, 5]);
});

test("delegateLabel names a live status, gone, and ended with or without its date", () => {
  expect(
    [
      live("working"),
      { kind: "gone" } as const,
      { kind: "ended", at: "2026-11-16" } as const,
      { kind: "ended", at: null } as const,
    ].map(delegateLabel),
  ).toEqual(["working", "gone", "ended 2026-11-16", "ended"]);
});

const row = (
  name: string,
  state: DelegateState,
  source: "ref" | "terminal" = "ref",
): DelegateRow => ({
  source,
  key: name,
  name,
  depth: source === "ref" ? 0 : 1,
  state,
});

test("delegateLine shows one state without a count, or counts refs by the most urgent state", () => {
  expect(delegateLine([])).toBe(undefined);
  expect(
    delegateLine([row("impl", live("working")), row("review", live("blocked"), "terminal")]),
  ).toEqual({
    text: "working",
    state: live("working"),
  });
  expect(delegateLine([row("a", live("blocked"))])).toEqual({
    text: "blocked",
    state: live("blocked"),
  });
  expect(delegateLine([row("a", { kind: "ended", at: "2026-11-16" })])).toEqual({
    text: "ended",
    state: { kind: "ended", at: "2026-11-16" },
  });
  expect(
    delegateLine([row("a", live("idle")), row("b", live("error")), row("c", live("working"))]),
  ).toEqual({ text: "error ×3", state: live("error") });
  expect(
    delegateLine([row("a", { kind: "ended", at: "2026-11-16" }), row("b", { kind: "gone" })]),
  ).toEqual({ text: "gone ×2", state: { kind: "gone" } });
  expect(
    delegateLine([
      row("a", { kind: "ended", at: null }),
      row("b", { kind: "ended", at: "2026-11-15" }),
    ]),
  ).toEqual({
    text: "ended ×2",
    state: { kind: "ended", at: null },
  });
});
