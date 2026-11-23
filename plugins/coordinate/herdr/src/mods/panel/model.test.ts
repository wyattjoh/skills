import { expect, test } from "bun:test";
import { emptyBacklog } from "../../lib/store.ts";
import type { Finding } from "../../lib/store.ts";
import {
  boundaryOutput,
  canDismissItem,
  dismissCommand,
  dismissFindingCommand,
  promoteFindingCommand,
  canTriageFinding,
  cachedDocument,
  changedBacklogDocuments,
  chosenAnswer,
  delegateLabel,
  delegateLine,
  delegateUrgency,
  draftFor,
  formatFindingCounts,
  groupFindings,
  mergeEnded,
  overridingDomains,
  domainOverrides,
  harnessPolicyNotices,
  rebaseHarnessPolicyDraft,
  policyDialogProps,
  policyDialogSpec,
  readDocument,
  trailOf,
} from "./model.ts";
import type {
  DelegateRow,
  DelegateState,
  DocumentState,
  HarnessPolicyDraft,
  HarnessPolicyState,
  HarnessPolicyView,
  HarnessSelection,
} from "./model.ts";

const loaded: DocumentState = { kind: "loaded", backlog: emptyBacklog("alpha", null) };
const invalid: DocumentState = { kind: "invalid", reason: "items must be a list" };
const shown = new Map<string, DocumentState>([
  ["alpha", loaded],
  ["beta", invalid],
]);

const finding = (id: string, kind: Finding["kind"]): Finding => ({
  id,
  kind,
  title: id,
  detail: null,
  path: null,
  from: null,
  status: "open",
  closedAt: null,
  outcome: null,
});

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
    note: "",
    busy: false,
    error: undefined,
  });
  expect(chosenAnswer({ ...draft, discuss: true })).toBe("Discuss");
  expect(chosenAnswer({ ...draft, discuss: true, text: "  compare migrations  " })).toBe("Discuss");
  expect(chosenAnswer({ ...draft, choice: "A", text: "note" })).toBe("A");
  expect(chosenAnswer({ ...draft, text: "custom answer" })).toBe("custom answer");
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

test("changedBacklogDocuments selects direct JSON files and recognizes a full-refresh path", () => {
  expect(
    changedBacklogDocuments(
      [
        "/state/backlogs/alpha.json",
        "/state/backlogs/alpha.archive.jsonl",
        "/state/backlogs/nested/beta.json",
        "/else/gamma.json",
      ],
      "/state/backlogs",
    ),
  ).toEqual({ all: false, domains: ["alpha"] });
  expect(changedBacklogDocuments(["/state/backlogs"], "/state/backlogs")).toEqual({
    all: true,
    domains: [],
  });
  expect(
    changedBacklogDocuments(["C:\\state\\backlogs\\beta.json"], "C:\\state\\backlogs"),
  ).toEqual({ all: false, domains: ["beta"] });
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

test("trailOf links the home icon and domain, then leaves the current page or record inert", () => {
  const domains = { kind: "domains" } as const;
  const lists = { kind: "domain", domain: "skills" } as const;
  const findings = { kind: "findings", domain: "skills" } as const;
  const home = { id: "crumb-home", label: "", to: domains, icon: "home" };
  expect(trailOf(domains)).toEqual([{ ...home, to: undefined }]);
  expect(trailOf(lists)).toEqual([
    home,
    { id: "crumb-domain-skills", label: "skills", to: undefined, icon: undefined },
  ]);
  expect(
    [{ kind: "policies", domain: "skills" }, findings, { kind: "boundary", domain: "skills" }].map(
      (screen) => trailOf(screen),
    ),
  ).toEqual([
    [
      home,
      { id: "crumb-domain-skills", label: "skills", to: lists, icon: undefined },
      { id: "crumb-policies", label: "Policies", to: undefined, icon: undefined },
    ],
    [
      home,
      { id: "crumb-domain-skills", label: "skills", to: lists, icon: undefined },
      { id: "crumb-findings", label: "Findings", to: undefined, icon: undefined },
    ],
    [
      home,
      { id: "crumb-domain-skills", label: "skills", to: lists, icon: undefined },
      { id: "crumb-boundary", label: "Boundary", to: undefined, icon: undefined },
    ],
  ]);
  expect(trailOf({ kind: "item", domain: "skills", id: "i4" })).toEqual([
    home,
    { id: "crumb-domain-skills", label: "skills", to: lists, icon: undefined },
    { id: "crumb-item-i4", label: "i4", to: undefined, icon: undefined },
  ]);
  expect(trailOf({ kind: "finding", domain: "skills", id: "f5" })).toEqual([
    home,
    { id: "crumb-domain-skills", label: "skills", to: lists, icon: undefined },
    {
      id: "crumb-findings",
      label: "Findings",
      to: { kind: "findings", domain: "skills" },
      icon: undefined,
    },
    { id: "crumb-finding-f5", label: "f5", to: undefined, icon: undefined },
  ]);
});

test("groups open findings by kind and formats singular and plural counts", () => {
  const findings = [
    ...Array.from({ length: 5 }, (_, index) => finding(`i${index + 1}`, "issue")),
    ...Array.from({ length: 2 }, (_, index) => finding(`o${index + 1}`, "opportunity")),
  ];
  expect(
    groupFindings(findings).map((group) => [
      group.kind,
      group.label,
      group.findings.map((record) => record.id),
    ]),
  ).toEqual([
    ["issue", "Issues", ["i1", "i2", "i3", "i4", "i5"]],
    ["opportunity", "Opportunities", ["o1", "o2"]],
  ]);
  expect(groupFindings([finding("i1", "issue")])).toEqual([
    { kind: "issue", label: "Issues", findings: [finding("i1", "issue")] },
  ]);
  expect(formatFindingCounts(findings)).toBe("5 issues · 2 opportunities");
  expect(formatFindingCounts([finding("i1", "issue"), finding("o1", "opportunity")])).toBe(
    "1 issue · 1 opportunity",
  );
  expect(formatFindingCounts([])).toBe("0 issues · 0 opportunities");
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

test("reads the harness policy dialog's props and rejects everything else", () => {
  expect(policyDialogProps({ harnessPolicy: { domain: null }, overlay: "o1" })).toEqual({
    domain: undefined,
    overlay: "o1",
  });
  expect(policyDialogProps({ harnessPolicy: { domain: "alpha" }, overlay: "o1" })).toEqual({
    domain: "alpha",
    overlay: "o1",
  });
  const rejected = [
    undefined,
    null,
    "alpha",
    {},
    { overlay: "o1" },
    { harnessPolicy: { domain: null } },
    { harnessPolicy: { domain: null }, overlay: "" },
    { harnessPolicy: { domain: null }, overlay: 3 },
    { harnessPolicy: { domain: "../escape" }, overlay: "o1" },
    { harnessPolicy: { domain: 7 }, overlay: "o1" },
    { harnessPolicy: { domain: undefined }, overlay: "o1" },
  ].map((props) => policyDialogProps(props));
  expect(rejected).toEqual(Array.from({ length: 11 }, () => undefined));
});

test("opens the harness policy editor as a frameless, full-window dialog of this mod", () => {
  expect(policyDialogSpec(undefined)).toEqual({
    mod: "coordinate-panel",
    kind: "dialog",
    modal: true,
    frame: "none",
    width: 1,
    height: 1,
    props: { harnessPolicy: { domain: null } },
  });
  expect(policyDialogSpec("alpha").props).toEqual({ harnessPolicy: { domain: "alpha" } });
});

const emptyItem = { id: "i1", title: "t" };

test("builds the dismiss call and says which items can be dismissed", () => {
  expect(dismissCommand("/Users/test", "alpha", "i3")).toEqual({
    command: "/usr/bin/env",
    args: [
      "-u",
      "HC_TERMINAL_ID",
      "bun",
      "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
      "item",
      "close",
      "--domain",
      "alpha",
      "--dismissed",
      "--outcome",
      "Dismissed from the answer flow",
      "--",
      "i3",
    ],
  });
  const statuses = [
    "waiting-user",
    "building",
    "delegated",
    "in-review",
    "open",
    "parked",
    "done",
    "dismissed",
  ] as const;
  expect(
    statuses.map((status) =>
      canDismissItem({ ...emptyItem, status } as Parameters<typeof canDismissItem>[0]),
    ),
  ).toEqual([true, true, true, true, true, true, false, false]);
});

test("builds the finding promote and dismiss calls and says which findings can be triaged", () => {
  const cli = [
    "-u",
    "HC_TERMINAL_ID",
    "bun",
    "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
  ];
  expect(promoteFindingCommand("/Users/test", "alpha", "f3")).toEqual({
    command: "/usr/bin/env",
    args: [...cli, "finding", "promote", "--domain", "alpha", "--", "f3"],
  });
  expect(dismissFindingCommand("/Users/test", "alpha", "f3")).toEqual({
    command: "/usr/bin/env",
    args: [
      ...cli,
      "finding",
      "close",
      "--domain",
      "alpha",
      "--dismissed",
      "--outcome",
      "Dismissed from the Backlog panel",
      "--",
      "f3",
    ],
  });
  const statuses = ["open", "acted", "dismissed"] as const;
  expect(
    statuses.map((status) =>
      canTriageFinding({ id: "f1", status } as Parameters<typeof canTriageFinding>[0]),
    ),
  ).toEqual([true, false, false]);
});

const LEGACY: HarnessSelection = { enabled: ["pi", "claude"], default: null };

test("overridingDomains keeps the domains read as replace, in order, and drops failed reads", () => {
  const reads: [string, HarnessPolicyState][] = [
    [
      "alpha",
      {
        kind: "loaded",
        view: {
          schemaVersion: 1,
          revision: 1,
          path: "/s/delegate-harness-policy.json",
          global: { source: "legacy", policy: LEGACY },
          domain: {
            name: "alpha",
            mode: "replace",
            override: LEGACY,
            effective: LEGACY,
          },
        },
      },
    ],
    [
      "beta",
      {
        kind: "loaded",
        view: {
          schemaVersion: 1,
          revision: 1,
          path: "/s/delegate-harness-policy.json",
          global: { source: "legacy", policy: LEGACY },
          domain: {
            name: "beta",
            mode: "inherit",
            override: null,
            effective: LEGACY,
          },
        },
      },
    ],
    ["gamma", { kind: "error", message: "could not run coordinate" }],
    [
      "delta",
      {
        kind: "loaded",
        view: {
          schemaVersion: 1,
          revision: 1,
          path: "/s/delegate-harness-policy.json",
          global: { source: "legacy", policy: LEGACY },
          domain: {
            name: "delta",
            mode: "replace",
            override: LEGACY,
            effective: LEGACY,
          },
        },
      },
    ],
  ];
  expect(overridingDomains(reads)).toEqual(["alpha", "delta"]);
  expect(domainOverrides(reads)).toEqual([
    ["alpha", LEGACY],
    ["delta", LEGACY],
  ]);
});

const domainDraft = (selection: HarnessSelection, inherit = false): HarnessPolicyDraft => ({
  domain: "alpha",
  revision: 4,
  inherit,
  selection,
});

test("harnessPolicyNotices warns on a re-enable, notes a frozen copy of global, and lists kept harnesses on global", () => {
  const claudeOnly: HarnessSelection = { enabled: ["claude"], default: "claude" };
  const view: HarnessPolicyView = {
    schemaVersion: 1,
    revision: 4,
    path: "/s/delegate-harness-policy.json",
    global: { source: "configured", policy: claudeOnly },
    domain: { name: "alpha", mode: "replace", override: LEGACY, effective: LEGACY },
  };
  expect(harnessPolicyNotices(view, domainDraft(LEGACY), [])).toEqual([
    { kind: "reenabled", harnesses: ["pi"] },
  ]);
  expect(harnessPolicyNotices(view, domainDraft(claudeOnly), [])).toEqual([{ kind: "frozen" }]);
  expect(
    harnessPolicyNotices(view, domainDraft({ enabled: ["claude"], default: null }), []),
  ).toEqual([]);
  expect(harnessPolicyNotices(view, domainDraft(LEGACY, true), [])).toEqual([]);

  const globalDraft: HarnessPolicyDraft = {
    domain: undefined,
    revision: 4,
    inherit: false,
    selection: claudeOnly,
  };
  expect(
    harnessPolicyNotices({ ...view, domain: null }, globalDraft, [
      ["alpha", LEGACY],
      ["beta", claudeOnly],
    ]),
  ).toEqual([{ kind: "kept", domain: "alpha", harnesses: ["pi"] }]);
  expect(
    harnessPolicyNotices({ ...view, domain: null }, { ...globalDraft, selection: LEGACY }, [
      ["alpha", LEGACY],
    ]),
  ).toEqual([]);
});

const globalView = (revision: number, policy: HarnessSelection): HarnessPolicyView => ({
  schemaVersion: 1,
  revision,
  path: "/s/delegate-harness-policy.json",
  global: { source: "configured", policy },
  domain: null,
});

test("rebaseHarnessPolicyDraft carries a draft onto a newer revision only when its scope is unchanged", () => {
  const base = globalView(2, LEGACY);
  const draft = {
    domain: undefined,
    revision: 2,
    inherit: false,
    selection: { enabled: ["claude"], default: null },
  } satisfies HarnessPolicyDraft;
  const moved = globalView(3, LEGACY);
  expect(rebaseHarnessPolicyDraft({ base, draft }, moved)).toEqual({
    base: moved,
    draft: { ...draft, revision: 3 },
  });
  const changed = globalView(3, { enabled: ["pi"], default: null });
  expect(rebaseHarnessPolicyDraft({ base, draft }, changed)).toEqual({ base, draft });
});

test("readDocument keeps a policy's wiki citation and rejects an empty one", () => {
  const cited = {
    ...emptyBacklog("alpha", null),
    policies: [
      { id: "p1", text: "poll every 5s", at: "2026-11-23", wiki: "poll-interval" },
      { id: "p2", text: "plain", at: "2026-11-23" },
    ],
    nextPolicyId: 3,
  };
  expect(readDocument(JSON.stringify(cited))).toEqual({ kind: "loaded", backlog: cited });
  const empty = { ...cited, policies: [{ id: "p1", text: "rule", at: "2026-11-23", wiki: "" }] };
  expect(readDocument(JSON.stringify(empty))).toEqual({
    kind: "invalid",
    reason: "policies[0].wiki must be a non-empty string",
  });
});
