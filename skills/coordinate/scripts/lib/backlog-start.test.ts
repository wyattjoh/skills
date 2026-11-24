import { describe, expect, it } from "bun:test";
import {
  addItem,
  closeItem,
  emptyBacklog,
  fileDelegate,
  type ItemUpdate,
  requestStart,
  updateItem,
} from "./backlog-store/ops.ts";
import { renderBacklog } from "./backlog-store/render.ts";
import { type Backlog, canStartItem, type Item, validateBacklog } from "./backlog-store/schema.ts";

const NOW = "2026-11-23T09:00:00.000Z";
const LATER = "2026-11-23T10:00:00.000Z";

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

const ref = {
  name: "fix-a",
  session: "s-1",
  branch: null,
  worktree: null,
  brief: "",
  report: "",
};

// i1 open, ready for a start request.
const oneItem = (): Backlog =>
  unwrap(addItem(emptyBacklog("app", null), { title: "Fix login", now: NOW })).backlog;
const item = (backlog: Backlog, id = "i1"): Item | undefined =>
  backlog.items.find((entry) => entry.id === id);
const started = (): Backlog => unwrap(requestStart(oneItem(), { id: "i1", now: NOW })).backlog;

describe("requestStart", () => {
  it("records the request with its time and keeps a pending one as it was", () => {
    const first = unwrap(requestStart(oneItem(), { id: "i1", now: NOW }));
    expect([first.value.requested, first.value.item.startRequested]).toEqual([true, { at: NOW }]);
    expect(validateBacklog(first.backlog).ok).toBe(true);
    const again = unwrap(requestStart(first.backlog, { id: "i1", now: LATER }));
    expect([again.value.requested, again.value.item.startRequested]).toEqual([false, { at: NOW }]);
    expect(again.backlog).toBe(first.backlog);
  });

  it("refuses a done, dismissed or delegated item and an unknown id", () => {
    const done = unwrap(
      closeItem(oneItem(), { id: "i1", outcome: "shipped", dismissed: false, now: NOW }),
    ).backlog;
    const dismissed = unwrap(
      closeItem(oneItem(), { id: "i1", outcome: "dropped", dismissed: true, now: NOW }),
    ).backlog;
    const delegated = unwrap(fileDelegate(oneItem(), { id: "i1", ref })).backlog;
    expect(
      [done, dismissed, delegated, oneItem()].map((backlog, index) =>
        requestStart(backlog, { id: index === 3 ? "i9" : "i1", now: NOW }),
      ),
    ).toEqual([
      { ok: false, reason: "i1 is done, so there is nothing to start" },
      { ok: false, reason: "i1 is dismissed, so there is nothing to start" },
      { ok: false, reason: "i1 is delegated, so there is nothing to start" },
      { ok: false, reason: "no item i9 in app" },
    ]);
  });

  it("names the statuses the Start button is offered for", () => {
    expect(
      (
        [
          "open",
          "building",
          "in-review",
          "parked",
          "waiting-user",
          "delegated",
          "done",
          "dismissed",
        ] as const
      ).map((status) => canStartItem({ status })),
    ).toEqual([true, true, true, true, true, false, false, false]);
  });
});

describe("a pending start request", () => {
  it("clears when the status changes, an ask is set, a delegate is filed, or the item closes", () => {
    const moved = unwrap(updateItem(started(), update("i1", { status: "building" }))).backlog;
    const asked = unwrap(
      updateItem(started(), update("i1", { ask: "Which provider?", options: ["A", "B"] })),
    ).backlog;
    const filed = unwrap(fileDelegate(started(), { id: "i1", ref })).backlog;
    const closed = unwrap(
      closeItem(started(), { id: "i1", outcome: "shipped", dismissed: false, now: NOW }),
    ).backlog;
    expect([moved, asked, filed, closed].map((backlog) => item(backlog)?.startRequested)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("clears when a coordinator sets the status the item already has", () => {
    const building = unwrap(updateItem(oneItem(), update("i1", { status: "building" }))).backlog;
    const requested = unwrap(requestStart(building, { id: "i1", now: NOW })).backlog;
    const kept = unwrap(updateItem(requested, update("i1", { status: "building" }))).backlog;
    expect([item(kept)?.status, item(kept)?.startRequested]).toEqual(["building", undefined]);
  });

  it("stays through an answer that leaves the status alone", () => {
    const asked = unwrap(
      updateItem(oneItem(), update("i1", { ask: "Which provider?", options: ["A", "B"] })),
    ).backlog;
    const requested = unwrap(requestStart(asked, { id: "i1", now: NOW })).backlog;
    const answered = unwrap(updateItem(requested, update("i1", { answer: "A" }))).backlog;
    expect(item(answered)?.startRequested).toEqual({ at: NOW });
  });

  it("stays through an update that keeps the status, such as a decision", () => {
    const decided = unwrap(updateItem(started(), update("i1", { decided: ["use SSO"] }))).backlog;
    expect(item(decided)?.startRequested).toEqual({ at: NOW });
  });

  it("is shown by backlog show and validated only when present", () => {
    expect(
      renderBacklog(started())
        .split("\n")
        .filter((line) => line.includes("start")),
    ).toEqual([`  - start requested ${NOW}, not yet acted on`]);
    const bad = { ...started(), items: [{ ...item(started()), startRequested: { at: "" } }] };
    expect(validateBacklog(bad)).toEqual({
      ok: false,
      errors: ["items[0].startRequested.at must be a non-empty string"],
    });
    const notObject = { ...started(), items: [{ ...item(started()), startRequested: "soon" }] };
    expect(validateBacklog(notObject)).toEqual({
      ok: false,
      errors: ["items[0].startRequested must be an object"],
    });
  });
});
