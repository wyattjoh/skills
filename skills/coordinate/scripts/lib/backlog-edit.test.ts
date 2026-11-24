import { describe, expect, it } from "bun:test";
import {
  addBoundary,
  addCheckout,
  addFinding,
  addItem,
  clearEdits,
  closeFinding,
  closeItem,
  editDecision,
  editFinding,
  editItem,
  emptyBacklog,
  recordEdit,
  replaceBoundary,
  RETAINED_EDITS,
  updateItem,
  type ItemUpdate,
} from "./backlog-store/ops.ts";
import { type Backlog, decisionKey, validateBacklog } from "./backlog-store/schema.ts";

const NOW = "2026-11-24T09:00:00.000Z";

const unwrap = <A>(
  result: { ok: true; backlog: Backlog; value: A } | { ok: false; reason: string },
) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};

const update = (id: string, change: Partial<ItemUpdate>): ItemUpdate => ({
  id,
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
  answer: undefined,
  now: NOW,
  ...change,
});

// i1 open with a plain decision, a Markdown one and an answer record.
const decided = (): Backlog => {
  const added = unwrap(
    addItem(emptyBacklog("app", null), { title: "Fix login", now: NOW }),
  ).backlog;
  const withDecisions = unwrap(
    updateItem(added, update("i1", { decided: ["api only"], decidedMarkdown: ["**no** ui"] })),
  ).backlog;
  return unwrap(
    updateItem(
      withDecisions,
      update("i1", { askMarkdown: "Ship it?", optionsMarkdown: ["yes", "no"] }),
    ),
  ).backlog;
};
const answered = (): Backlog =>
  unwrap(updateItem(decided(), update("i1", { answer: "yes" }))).backlog;
const keyOf = (backlog: Backlog, index: number) =>
  decisionKey(backlog.items[0]!.decided[index]!, index);

describe("editDecision", () => {
  it("replaces a decision with Markdown, keeping its date, and deletes one by key", () => {
    const backlog = answered();
    const replaced = unwrap(
      editDecision(backlog, { id: "i1", key: keyOf(backlog, 0), markdown: "api **and** cli\n" }),
    );
    expect([replaced.backlog.items[0]!.decided[0], replaced.value.change]).toEqual([
      { markdown: "api **and** cli", at: backlog.items[0]!.decided[0]!.at },
      { old: "api only", new: "api **and** cli" },
    ]);
    expect(validateBacklog(replaced.backlog).ok).toBe(true);
    const removed = unwrap(
      editDecision(backlog, { id: "i1", key: keyOf(backlog, 1), markdown: null }),
    );
    expect([removed.backlog.items[0]!.decided.length, removed.value.change]).toEqual([
      2,
      { old: "**no** ui", new: null },
    ]);
  });

  it("refuses a stale key, an answer record and an empty value", () => {
    const backlog = answered();
    const staleKey = keyOf(backlog, 1);
    const shifted = unwrap(
      editDecision(backlog, { id: "i1", key: keyOf(backlog, 0), markdown: null }),
    ).backlog;
    expect(editDecision(shifted, { id: "i1", key: staleKey, markdown: null })).toEqual({
      ok: false,
      reason: `i1 has no decision ${staleKey}; it changed since it was read, so reload and try again (its decisions now: ${keyOf(shifted, 0)}, ${keyOf(shifted, 1)})`,
    });
    expect(editDecision(backlog, { id: "i1", key: keyOf(backlog, 2), markdown: "x" })).toEqual({
      ok: false,
      reason: `decision ${keyOf(backlog, 2)} on i1 records an answer or discussion request, which stays as recorded`,
    });
    expect(editDecision(backlog, { id: "i1", key: keyOf(backlog, 0), markdown: "  " })).toEqual({
      ok: false,
      reason: "--md is empty",
    });
    expect(editDecision(backlog, { id: "i9", key: "0:x", markdown: null })).toEqual({
      ok: false,
      reason: "no item i9 in app",
    });
  });

  it("refuses deleting the decision a waiting-user item with no ask waits on", () => {
    const added = unwrap(
      addItem(emptyBacklog("app", null), { title: "Fix login", now: NOW }),
    ).backlog;
    const waiting = unwrap(
      updateItem(added, update("i1", { status: "waiting-user", decided: ["waiting on legal"] })),
    ).backlog;
    expect(editDecision(waiting, { id: "i1", key: keyOf(waiting, 0), markdown: null })).toEqual({
      ok: false,
      reason:
        "i1 is waiting-user on this decision with no ask; change its status before deleting it",
    });
  });
});

describe("editItem and editFinding", () => {
  it("edits a title as plain text and a closed item's outcome as Markdown", () => {
    const closed = unwrap(
      closeItem(decided(), { id: "i1", outcome: "shipped", dismissed: false, now: NOW }),
    ).backlog;
    const titled = unwrap(editItem(closed, { id: "i1", field: "title", value: " Fix signup " }));
    expect([titled.value.item.title, titled.value.change]).toEqual([
      "Fix signup",
      { old: "Fix login", new: "Fix signup" },
    ]);
    const outcome = unwrap(
      editItem(closed, { id: "i1", field: "outcome", value: "shipped **v2**" }),
    );
    expect([
      outcome.value.item.outcome,
      outcome.value.item.outcomeMarkdown,
      outcome.value.change,
    ]).toEqual([null, "shipped **v2**", { old: "shipped", new: "shipped **v2**" }]);
    expect(validateBacklog(outcome.backlog).ok).toBe(true);
  });

  it("refuses a multi-line or empty title and an open item's outcome", () => {
    const backlog = decided();
    expect([
      editItem(backlog, { id: "i1", field: "title", value: "a\nb" }),
      editItem(backlog, { id: "i1", field: "title", value: " " }),
      editItem(backlog, { id: "i1", field: "outcome", value: "done" }),
    ]).toEqual([
      { ok: false, reason: "--title must be one line" },
      { ok: false, reason: "--title is empty" },
      { ok: false, reason: "i1 is open; only a closed item has an outcome" },
    ]);
  });

  it("edits a finding's title, detail and a closed finding's outcome", () => {
    const added = unwrap(
      addFinding(emptyBacklog("app", null), {
        kind: "issue",
        title: "flaky",
        detail: "fails often",
        path: undefined,
        from: undefined,
        source: undefined,
        now: NOW,
      }),
    ).backlog;
    const detail = unwrap(
      editFinding(added, { id: "f1", field: "detail", value: "**fails** one in ten" }),
    );
    expect([
      detail.value.finding.detail,
      detail.value.finding.detailMarkdown,
      detail.value.change,
    ]).toEqual([null, "**fails** one in ten", { old: "fails often", new: "**fails** one in ten" }]);
    expect(editFinding(added, { id: "f1", field: "outcome", value: "x" })).toEqual({
      ok: false,
      reason: "f1 is open; only a closed finding has an outcome",
    });
    const closed = unwrap(
      closeFinding(added, { id: "f1", outcome: "fixed", dismissed: false, now: NOW }),
    ).backlog;
    const outcome = unwrap(
      editFinding(closed, { id: "f1", field: "outcome", value: "fixed in **v2**" }),
    );
    expect(outcome.value.change).toEqual({ old: "fixed", new: "fixed in **v2**" });
    expect(validateBacklog(outcome.backlog).ok).toBe(true);
  });
});

describe("replaceBoundary", () => {
  it("keeps the path's place and moves its checkouts", () => {
    const one = unwrap(
      addBoundary(emptyBacklog("app", null), { path: "/a", list: "owned" }),
    ).backlog;
    const two = unwrap(addBoundary(one, { path: "/b", list: "owned" })).backlog;
    const checked = unwrap(
      addCheckout(two, { path: "/a", machine: "mini", checkout: "/x/a" }),
    ).backlog;
    const replaced = unwrap(
      replaceBoundary(checked, { list: "owned", from: "/a", to: "/c" }),
    ).backlog;
    expect(replaced.boundary).toEqual({
      owned: ["/c", "/b"],
      adjacent: [],
      checkouts: { "/c": { mini: "/x/a" } },
    });
    expect([
      replaceBoundary(checked, { list: "owned", from: "/a", to: "/b" }),
      replaceBoundary(checked, { list: "adjacent", from: "/a", to: "/c" }),
      replaceBoundary(checked, { list: "owned", from: "/a", to: "rel" }),
    ]).toEqual([
      { ok: false, reason: "/b is already in the Boundary" },
      { ok: false, reason: "/a is not in the adjacent Boundary" },
      { ok: false, reason: "rel is not an absolute path" },
    ]);
  });
});

describe("recordEdit and clearEdits", () => {
  const edit = { record: "i1", field: "title" as const, old: "a", new: "b", at: NOW };

  it("never reuses an id after its edits clear, and drops the key with the last edit", () => {
    const first = recordEdit(emptyBacklog("app", null), edit);
    expect(validateBacklog(first).ok).toBe(true);
    const cleared = unwrap(clearEdits(first, ["c1"]));
    expect([cleared.value, cleared.backlog.edits, cleared.backlog.nextEditId]).toEqual([
      1,
      undefined,
      2,
    ]);
    expect(recordEdit(cleared.backlog, edit).edits).toEqual([{ id: "c2", ...edit }]);
    expect(unwrap(clearEdits(first, ["c9"])).value).toBe(0);
  });

  it("keeps only the newest edits past the cap", () => {
    let backlog = emptyBacklog("app", null);
    for (let index = 0; index < RETAINED_EDITS + 2; index += 1) backlog = recordEdit(backlog, edit);
    expect([backlog.edits?.length, backlog.edits?.[0]?.id, backlog.nextEditId]).toEqual([
      RETAINED_EDITS,
      "c3",
      RETAINED_EDITS + 3,
    ]);
    expect(validateBacklog(backlog).ok).toBe(true);
  });

  it("rejects a malformed edit and an id at or past the counter", () => {
    const backlog = recordEdit(emptyBacklog("app", null), edit);
    expect(
      validateBacklog({
        ...backlog,
        nextEditId: 1,
        edits: [{ ...backlog.edits![0], field: "nope" }],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "edits[0].id c1 is not below nextEditId 1",
        `edits[0].field must be one of title, outcome, decision, detail, policy, focus, owned, adjacent`,
      ],
    });
  });
});
