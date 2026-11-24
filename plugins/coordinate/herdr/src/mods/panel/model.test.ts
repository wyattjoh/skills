import { expect, test } from "bun:test";
import { addItem, emptyBacklog } from "../../lib/store.ts";
import type { Backlog } from "../../lib/store.ts";
import type { Finding } from "../../lib/store.ts";
import {
  answerCommand,
  backlogListCommand,
  boundaryOutput,
  canDismissItem,
  dismissCommand,
  dismissFindingCommand,
  promoteFindingCommand,
  canTriageFinding,
  statusCommand,
  statusTargets,
  cachedDocument,
  changedBacklogDocuments,
  chosenAnswer,
  delegateLabel,
  delegateLine,
  delegateUrgency,
  draftFor,
  findingStatusLabel,
  formatFindingCounts,
  groupFindings,
  groupItems,
  promotedItemId,
  mergeEnded,
  outboxOutput,
  outboxShowCommand,
  queueOutput,
  queueShowCommand,
  overridingDomains,
  domainOverrides,
  harnessPolicyNotices,
  backlogIds,
  idLinkTarget,
  inlineMarkdown,
  isWebUrl,
  linkIds,
  linkProse,
  markdownPlain,
  rebaseHarnessPolicyDraft,
  tildePath,
  policyDialogProps,
  policyDialogSpec,
  readDocument,
  trailOf,
  wikiListCommand,
  wikiListOutput,
  wikiShowCommand,
  wikiShowOutput,
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
  expect(
    boundaryOutput(
      '{"owned":["/repo"],"adjacent":[],"checkouts":{"/repo":{"strix":"/home/me/repo"}}}',
    ),
  ).toEqual({ owned: ["/repo"], adjacent: [], checkouts: { "/repo": { strix: "/home/me/repo" } } });
  expect(
    boundaryOutput('{"owned":["/repo"],"adjacent":[],"checkouts":{"/repo":{"strix":1}}}'),
  ).toBeUndefined();
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

test("offers open, building, in-review and parked minus the item's own, on items not closed", () => {
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
      statusTargets({ ...emptyItem, status } as Parameters<typeof statusTargets>[0]),
    ),
  ).toEqual([
    ["open", "building", "in-review", "parked"],
    ["open", "in-review", "parked"],
    ["open", "building", "in-review", "parked"],
    ["open", "building", "parked"],
    ["building", "in-review", "parked"],
    ["open", "building", "in-review"],
    [],
    [],
  ]);
});

test("builds the status change call", () => {
  expect(statusCommand("/Users/test", "alpha", "i6", "open")).toEqual({
    command: "/usr/bin/env",
    args: [
      "-u",
      "HC_TERMINAL_ID",
      "bun",
      "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
      "item",
      "update",
      "--domain",
      "alpha",
      "--status",
      "open",
      "--",
      "i6",
    ],
  });
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

const closed = (status: Finding["status"], outcome: string | null): Finding => ({
  ...finding("f1", "issue"),
  status,
  outcome,
});

test("a finding acted on with the CLI's promote outcome is Promoted into that item; others keep their label", () => {
  const findings = [
    closed("acted", "promoted to i5"),
    closed("acted", "fixed"),
    closed("acted", "promoted to i5 and fixed"),
    closed("acted", null),
    closed("dismissed", "promoted to i5"),
    closed("open", null),
  ];
  expect(findings.map(promotedItemId)).toEqual([
    "i5",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(findings.map(findingStatusLabel)).toEqual([
    "Promoted",
    "Acted on",
    "Acted on",
    "Acted on",
    "Dismissed",
    "Open",
  ]);
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

test("builds the read-only queue and outbox reads as the panel, outside a Herdr terminal", () => {
  const prefix = [
    "-u",
    "HC_TERMINAL_ID",
    "bun",
    "/home/me/.claude/skills/coordinate/scripts/coordinate.ts",
  ];
  expect([queueShowCommand("/home/me", "alpha"), outboxShowCommand("/home/me", "alpha")]).toEqual([
    { command: "/usr/bin/env", args: [...prefix, "queue", "show", "--domain", "alpha", "--json"] },
    {
      command: "/usr/bin/env",
      args: [...prefix, "watch", "outbox", "--domain", "alpha", "--json"],
    },
  ]);
});

test("queueOutput accepts the CLI's queue JSON for the asked domain and rejects anything else", () => {
  const entry = { item: "i2", machine: "local", order: 1, position: 1 };
  const json = (value: unknown) => JSON.stringify(value);
  expect(queueOutput(json({ domain: "alpha", entries: [entry] }), "alpha")).toEqual([entry]);
  expect(
    [
      json({ domain: "beta", entries: [entry] }),
      json({ domain: "alpha", events: [] }),
      json({ domain: "alpha", entries: [{ ...entry, item: "f1" }] }),
      json({ domain: "alpha", entries: [{ ...entry, position: 0 }] }),
      json({ schemaVersion: 1, revision: 1 }),
      "not json",
    ].map((text) => queueOutput(text, "alpha")),
  ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("outboxOutput keeps each event's attrs, string and list fields, and text", () => {
  const event = {
    id: "4",
    kind: "settled",
    attrs: { delegate: "fix" },
    fields: { title: "Fix it", wiki: ["a", "b"] },
    text: "verify",
  };
  const json = (value: unknown) => JSON.stringify(value);
  expect(outboxOutput(json({ domain: "alpha", events: [event] }), "alpha")).toEqual([event]);
  expect(
    [
      json({ domain: "beta", events: [event] }),
      json({ domain: "alpha", events: [{ ...event, attrs: { n: 1 } }] }),
      json({ domain: "alpha", events: [{ ...event, fields: { wiki: [1] } }] }),
      json({ domain: "alpha", events: [{ ...event, kind: "" }] }),
    ].map((text) => outboxOutput(text, "alpha")),
  ).toEqual([undefined, undefined, undefined, undefined]);
});

test("groupItems moves open queued items into Queued, right after Delegated", () => {
  let backlog: Backlog = emptyBacklog("alpha", null);
  for (const title of ["One", "Two", "Three"]) {
    const added = addItem(backlog, { title, now: "2026-11-23T00:00:00.000Z" });
    if (!added.ok) throw new Error(added.reason);
    backlog = added.backlog;
  }
  const queued = [
    { item: "i3", machine: "local", order: 1, position: 1 },
    { item: "i1", machine: "box", order: 2, position: 1 },
    { item: "i7", machine: "local", order: 3, position: 2 },
  ];
  expect(
    groupItems(backlog, queued).map((group) => [
      group.status,
      group.label,
      group.items.map((item) => item.id),
    ]),
  ).toEqual([
    ["queued", "Queued", ["i3", "i1"]],
    ["open", "Open", ["i2"]],
  ]);
  expect(groupItems(backlog).map((group) => group.status)).toEqual(["open"]);
});

const order = (groups: ReturnType<typeof groupItems>) =>
  groups.map((group) => [group.status, group.items.map((item) => item.id)]);

test("groupItems sorts every group newest first by default, or oldest first, ties by id number", () => {
  let backlog: Backlog = emptyBacklog("alpha", null);
  const created = [
    "2026-11-02T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-03T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
    "2026-11-01T00:00:00.000Z",
  ];
  for (const [index, now] of created.entries()) {
    const added = addItem(backlog, { title: `Item ${index + 1}`, now });
    if (!added.ok) throw new Error(added.reason);
    backlog = added.backlog;
  }
  backlog = {
    ...backlog,
    items: backlog.items.map((item) =>
      item.id === "i3" || item.id === "i5" ? { ...item, status: "parked" } : item,
    ),
  };
  expect(order(groupItems(backlog))).toEqual([
    ["open", ["i1", "i10", "i9", "i8", "i7", "i6", "i4", "i2"]],
    ["parked", ["i3", "i5"]],
  ]);
  expect(order(groupItems(backlog, [], "oldest"))).toEqual([
    ["open", ["i2", "i4", "i6", "i7", "i8", "i9", "i10", "i1"]],
    ["parked", ["i5", "i3"]],
  ]);
});

test("keeps inline Markdown on one line by joining lines and escaping a leading block marker", () => {
  expect(
    [
      "Ship `v2`\nnow",
      "# heading",
      "> quote",
      "- item",
      "* item",
      "1. first",
      "2) second",
      "***",
      "```js",
      "| a | b |",
      "-1 degrees",
      "**Ship** now",
      "__init__ runs",
      "- - -",
    ].map(inlineMarkdown),
  ).toEqual([
    "Ship `v2` now",
    "\\# heading",
    "\\> quote",
    "\\- item",
    "\\* item",
    "1\\. first",
    "2\\) second",
    "\\***",
    "\\```js",
    "\\| a | b |",
    "-1 degrees",
    "**Ship** now",
    "__init__ runs",
    "\\- - -",
  ]);
});

test("reads inline Markdown as plain text for a truncated caption", () => {
  expect(markdownPlain("Use `json` **now**, see [docs](https://x.test) or *this* snake_case")).toBe(
    "Use json now, see docs or this snake_case",
  );
});

test("wikiListOutput keeps each page's frontmatter, with a cover's repo or root as its place", () => {
  const meta = {
    name: "poll-interval",
    description: "Why 5s",
    type: "decision",
    covers: [
      { repo: "github.com/acme/widgets", globs: ["src/*.ts"] },
      { root: "~/.config/herdr", globs: ["*.toml"] },
    ],
    created: "2026-11-20",
    updated: "2026-11-21",
    sources: ["item:i1"],
    supersedes: [],
  };
  const json = (value: unknown) => JSON.stringify(value);
  const listing = (pages: unknown[]) =>
    json({ domain: "alpha", path: "/s/wiki/alpha", lastLint: null, pages, invalid: [] });
  expect(wikiListOutput(listing([meta]), "alpha")).toEqual([
    {
      ...meta,
      covers: [
        { place: "github.com/acme/widgets", globs: ["src/*.ts"] },
        { place: "~/.config/herdr", globs: ["*.toml"] },
      ],
    },
  ]);
  expect(wikiListOutput(listing([]), "alpha")).toEqual([]);
  expect(
    [
      json({ domain: "beta", pages: [meta] }),
      json({ domain: "alpha", events: [] }),
      listing([{ ...meta, name: "" }]),
      listing([{ ...meta, sources: [1] }]),
      listing([{ ...meta, covers: [{ globs: ["x"] }] }]),
      listing([{ ...meta, covers: [{ repo: "r", globs: "x" }] }]),
      "not json",
    ].map((text) => wikiListOutput(text, "alpha")),
  ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

test("wikiShowOutput returns the asked page's body and rejects anything else", () => {
  const page = {
    domain: "alpha",
    name: "a",
    file: "/s/a.md",
    meta: null,
    errors: [],
    body: "# A\n",
  };
  const json = (value: unknown) => JSON.stringify(value);
  expect(wikiShowOutput(json(page), "alpha", "a")).toBe("# A\n");
  expect(
    [
      json({ ...page, domain: "beta" }),
      json({ ...page, name: "b" }),
      json({ ...page, body: null }),
      "not json",
    ].map((text) => wikiShowOutput(text, "alpha", "a")),
  ).toEqual([undefined, undefined, undefined, undefined]);
});

test("the wiki reads run the CLI's read-only wiki list and show for the domain", () => {
  expect(wikiListCommand("/Users/test", "alpha").args.slice(-5)).toEqual([
    "wiki",
    "list",
    "--domain",
    "alpha",
    "--json",
  ]);
  expect(wikiShowCommand("/Users/test", "alpha", "-odd").args.slice(-7)).toEqual([
    "wiki",
    "show",
    "--domain",
    "alpha",
    "--json",
    "--",
    "-odd",
  ]);
});

test("trailOf runs through the Wiki page to an open wiki page", () => {
  expect(
    trailOf({ kind: "wiki-page", domain: "alpha", name: "poll-interval" }).map((crumb) => [
      crumb.id,
      crumb.label,
      crumb.to,
    ]),
  ).toEqual([
    ["crumb-home", "", { kind: "domains" }],
    ["crumb-domain-alpha", "alpha", { kind: "domain", domain: "alpha" }],
    ["crumb-wiki", "Wiki", { kind: "wiki", domain: "alpha" }],
    ["crumb-wiki-page-poll-interval", "poll-interval", undefined],
  ]);
});

test("tildePath shows only a whole leading home folder as ~", () => {
  const home = "/Users/wyatt.johnson";
  expect(
    [
      "/Users/wyatt.johnson",
      "/Users/wyatt.johnson/Code/skills",
      "/Users/wyatt.johnson2/Code/skills",
      "/opt/Users/wyatt.johnson/x",
      "skills/coordinate",
    ].map((path) => tildePath(path, home)),
  ).toEqual([
    "~",
    "~/Code/skills",
    "/Users/wyatt.johnson2/Code/skills",
    "/opt/Users/wyatt.johnson/x",
    "skills/coordinate",
  ]);
  expect(tildePath("/Users/wyatt.johnson/Code", `${home}/`)).toBe("~/Code");
});

test("tildePath leaves paths unchanged without a usable home folder", () => {
  expect([tildePath("/Users/me/a", ""), tildePath("/etc/hosts", "/")]).toEqual([
    "/Users/me/a",
    "/etc/hosts",
  ]);
});

const KNOWN = new Set(["i42", "f13", "p8"]);
const link = (id: string, label = id) => "[" + label + "](coordinate-panel:" + id + ")";

test("links whole-token known ids in plain text and leaves joined or unknown tokens alone", () => {
  expect(linkIds("see i42, f13 and p8.", KNOWN, false)).toBe(
    "see " + link("i42") + "\\, " + link("f13") + " and " + link("p8") + "\\.",
  );
  expect(linkIds("api42 i42x ui-i42 i42_b i7 f1", KNOWN, false)).toBe(undefined);
  expect(linkIds("(i42)", KNOWN, false)).toBe("\\(" + link("i42") + "\\)");
});

test("keeps plain text's punctuation, line breaks and leading spaces when it links", () => {
  expect(linkIds("*i42* [x]\n  two\n\nthree", KNOWN, false)).toBe(
    "\\*" + link("i42") + "\\* \\[x\\]  \n\u{a0}\u{a0}two\n\nthree",
  );
});

test("links ids in Markdown prose but not in fenced code, links, autolinks or URLs", () => {
  const source = [
    "Fix i42 now",
    "```ts",
    "const i42 = 1;",
    "```",
    "[i42](https://x.test/i42) <https://x.test/f13> https://x.test/p8 <b title=i42>",
    "~~~",
    "p8",
    "~~~",
    "after f13",
  ].join("\n");
  expect(linkIds(source, KNOWN, true)).toBe(
    [
      "Fix " + link("i42") + " now",
      "```ts",
      "const i42 = 1;",
      "```",
      "[i42](https://x.test/i42) <https://x.test/f13> https://x.test/p8 <b title=i42>",
      "~~~",
      "p8",
      "~~~",
      "after " + link("f13"),
    ].join("\n"),
  );
});

test("links an inline code span that is exactly a known id, and no other span", () => {
  const source = "`i42` ` i42 ` `i42 = 1` ``p8`` `i7`";
  expect(linkIds(source, KNOWN, true)).toBe(
    link("i42", "`i42`") +
      " " +
      link("i42", "` i42 `") +
      " `i42 = 1` " +
      link("p8", "``p8``") +
      " `i7`",
  );
});

test("returns nothing for Markdown with no known id, and is stable on its own output", () => {
  expect(linkIds("**bold** `i42`", new Set(), true)).toBe(undefined);
  const once = linkIds("see i42 and \\i42", KNOWN, true)!;
  expect(once).toBe("see " + link("i42") + " and \\i42");
  expect(linkIds(once, KNOWN, true)).toBe(undefined);
});

test("linkProse turns linked plain prose into Markdown and leaves the rest as it was", () => {
  expect(linkProse({ markdown: false, value: "i42" }, KNOWN)).toEqual({
    markdown: true,
    value: link("i42"),
  });
  expect(linkProse({ markdown: false, value: "none" }, KNOWN)).toEqual({
    markdown: false,
    value: "none",
  });
  expect(linkProse({ markdown: true, value: "**p8**" }, KNOWN)).toEqual({
    markdown: true,
    value: "**" + link("p8") + "**",
  });
});

test("reads the record an in-panel link opens, and nothing from any other URL", () => {
  expect(
    [
      "coordinate-panel:i42",
      "coordinate-panel://f13",
      "coordinate-panel://p8/",
      "https://x.test/i42",
      "coordinate-panel:x1",
    ].map(idLinkTarget),
  ).toEqual(["i42", "f13", "p8", undefined, undefined]);
  expect(
    ["https://x.test", "http://a.b/c", "coordinate-panel:i1", "mailto:a@b"].map(isWebUrl),
  ).toEqual([true, true, false, false]);
});

test("collects every item, finding and policy id, closed ones included", () => {
  let backlog = emptyBacklog("alpha", null);
  const added = addItem(backlog, { title: "a", now: "2026-11-23T00:00:00.000Z" });
  if (!added.ok) throw new Error(added.reason);
  backlog = {
    ...added.backlog,
    policies: [{ id: "p1", text: "x", at: "2026-11-23" }],
  };
  expect([...backlogIds(backlog)]).toEqual(["i1", "p1"]);
});

test("keeps an id joined by an escaped - or _ plain, so a second pass links nothing new", () => {
  expect(linkIds("i42\\-b i42\\_c", KNOWN, true)).toBe(undefined);
  const once = linkProse({ markdown: false, value: "i42-b and i7 then f13" }, KNOWN);
  expect(once).toEqual({ markdown: true, value: "i42\\-b and i7 then " + link("f13") });
  expect(linkProse(once, KNOWN)).toEqual(once);
});

test("passes the hc the build baked to every CLI call, and nothing when none was baked", () => {
  const home = "/Users/test";
  const cli = "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts";
  expect(backlogListCommand(home, "alpha").args.slice(0, 4)).toEqual([
    "-u",
    "HC_TERMINAL_ID",
    "bun",
    cli,
  ]);
  const scope = globalThis as { COORDINATE_HC?: string };
  scope.COORDINATE_HC = "/Users/test/.local/bin/hc";
  try {
    expect([
      backlogListCommand(home, "alpha").args.slice(0, 5),
      answerCommand(home, "alpha", "i1", "a", undefined).args.slice(0, 5),
    ]).toEqual([
      ["-u", "HC_TERMINAL_ID", "COORDINATE_HC=/Users/test/.local/bin/hc", "bun", cli],
      ["-u", "HC_TERMINAL_ID", "COORDINATE_HC=/Users/test/.local/bin/hc", "bun", cli],
    ]);
  } finally {
    delete scope.COORDINATE_HC;
  }
});
