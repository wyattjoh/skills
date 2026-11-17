import { beforeEach, expect, test } from "bun:test";
import { addFinding, addItem, closeFinding, closeItem, emptyBacklog } from "../../lib/store.ts";
import type { Backlog, Item } from "../../lib/store.ts";
import { context, get, host, ids, resetHost, settle, text } from "../../test/renderer.ts";

const { default: Panel } = await import("./index.ts");

const STATE = "/Users/test/.local/state/coordinate";
const DOC = `${STATE}/backlogs/alpha.json`;
const NOW = "2026-11-17T12:00:00.000Z";

beforeEach(resetHost);

// A coordinator terminal labelled with its domain, focused.
const focusDomain = (domain: string) => {
  host.terminals = [
    {
      address: "t1",
      state: "live",
      labels: { "fleet.role": "coordinator", "fleet.domain": domain },
    },
  ];
  host.focused = { space: "s1", tab: "tab1", pane: "p1", terminal: "t1" };
};

const add = (backlog: Backlog, title: string, patch: Partial<Item> = {}): Backlog => {
  const added = addItem(backlog, { title, now: NOW });
  if (!added.ok) throw new Error(added.reason);
  const id = added.value.id;
  return {
    ...added.backlog,
    items: added.backlog.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
};

const close = (backlog: Backlog, id: string, dismissed: boolean): Backlog => {
  const closed = closeItem(backlog, { id, outcome: "wrapped up", dismissed, now: NOW });
  if (!closed.ok) throw new Error(closed.reason);
  return closed.backlog;
};

// One item in every status: i1 waiting-user, i2 building, i3 delegated, i4 and i5 open,
// i6 parked, i7 done, i8 dismissed.
const everyStatus = (): Backlog => {
  let backlog: Backlog = { ...emptyBacklog("alpha", null), focus: "Ship the panel tracer" };
  backlog = add(backlog, "Pick a name", {
    status: "waiting-user",
    ask: {
      question: "Which name?",
      context: null,
      options: ["a", "b"],
      rec: "a",
      recReason: "shorter",
    },
  });
  backlog = add(backlog, "Build the store", { status: "building" });
  backlog = add(backlog, "Write the panel", {
    status: "delegated",
    delegates: [
      {
        name: "impl",
        session: "s-1",
        branch: null,
        worktree: null,
        brief: "/b.md",
        report: "/r.md",
      },
    ],
  });
  backlog = add(backlog, "Sketch the toggle");
  backlog = add(backlog, "Sketch the listing");
  backlog = add(backlog, "Retention", { status: "parked" });
  backlog = add(backlog, "Old work");
  backlog = add(backlog, "Abandoned work");
  backlog = close(backlog, "i7", false);
  return close(backlog, "i8", true);
};

const find = (
  backlog: Backlog,
  kind: "issue" | "opportunity",
  title: string,
  from: string | undefined = undefined,
): Backlog => {
  const added = addFinding(backlog, { kind, title, detail: undefined, path: undefined, from });
  if (!added.ok) throw new Error(added.reason);
  return added.backlog;
};

// Open findings f2 (issue) and f3 (opportunity, from i1), and f4, an issue already acted on.
const withFindings = (): Backlog => {
  let backlog = add(emptyBacklog("alpha", null), "Base work");
  backlog = find(backlog, "issue", "Flaky watcher test");
  backlog = find(backlog, "opportunity", "Share the validator", "i1");
  backlog = find(backlog, "issue", "Old crash");
  const closed = closeFinding(backlog, { id: "f4", outcome: "fixed", dismissed: false, now: NOW });
  if (!closed.ok) throw new Error(closed.reason);
  return closed.backlog;
};

const mount = async () => {
  const ctx = context();
  const view = new Panel();
  view.init(undefined, ctx.cx as never);
  await settle();
  return { ctx, view, render: () => view.render(ctx.cx as never) as never };
};

test("groups the focused domain's items by status, in routing order, with counts", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "focus"))).toBe("Ship the panel tracer");
  expect(ids(root, "group-")).toEqual([
    "group-waiting-user",
    "group-building",
    "group-delegated",
    "group-open",
    "group-parked",
    "group-done",
    "group-dismissed",
  ]);
  expect(text(get(root, "fold-waiting-user"))).toBe("Waiting on you 1");
  expect(text(get(root, "fold-open"))).toBe("Open 2");
  expect(text(get(root, "fold-done"))).toBe("Done 1");
  expect(ids(root, "item-")).toEqual([
    "item-i1",
    "item-i2",
    "item-i3",
    "item-i4",
    "item-i5",
    "item-i6",
    "item-i7",
    "item-i8",
  ]);
});

test("folds Done and Dismissed by default and toggles a group from its header", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  const before = ctx.notified;
  let root = render();
  expect(get(root, "rows-open").styles.h).toBe(64);
  expect(get(root, "rows-done").styles.h).toBe(0);
  expect(get(root, "rows-dismissed").styles.h).toBe(0);
  get(root, "fold-done").click!({}, ctx.cx);
  get(root, "fold-open").click!({}, ctx.cx);
  root = render();
  expect(get(root, "rows-done").styles.h).toBe(32);
  expect(get(root, "rows-open").styles.h).toBe(0);
  expect(ctx.notified - before).toBe(2);
});

test("tones each group header by its status with theme token names", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  const root = render();
  const tone = (status: string) =>
    (get(root, `fold-${status}`).nodes[0] as { styles: Record<string, unknown> }).styles.text_color;
  expect(
    ["waiting-user", "building", "delegated", "open", "parked", "done", "dismissed"].map(tone),
  ).toEqual(["blocked", "working", "ansi4", "dim", "muted", "ansi2", "ansi1"]);
  const title = (id: string) =>
    (get(root, id).nodes[1] as { styles: Record<string, unknown> }).styles.text_color;
  expect([title("item-i7"), title("item-i8")]).toEqual(["foreground", "dim"]);
});

test("rereads the document when the watched backlogs folder changes", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  expect(host.watches.map((watch) => watch.path)).toEqual([`${STATE}/backlogs`]);
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), focus: "Watched change" }));
  host.watches[0]!.fire([DOC]);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Watched change");
  expect(host.watches.map((watch) => watch.path)).toEqual([
    `${STATE}/backlogs`,
    `${STATE}/backlogs`,
  ]);
});

test("rereads the document on the slow timer and rearms a reclaimed watch", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  host.watches[0]!.fire([]);
  await settle();
  expect(host.watches).toHaveLength(1);
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), focus: "Timer change" }));
  ctx.tick(30_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Timer change");
  expect(host.watches).toHaveLength(2);
});

test("follows focus to another domain's document", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify({ ...emptyBacklog("beta", null), focus: "Beta focus" }),
  );
  const { ctx, render } = await mount();
  focusDomain("beta");
  expect(text(get(render(), "loading"))).toBe("Loading… Reading beta's backlog.");
  ctx.tick(1_000);
  await settle();
  const root = render();
  expect(text(get(root, "crumb"))).toBe("beta");
  expect(text(get(root, "focus"))).toBe("Beta focus");
  expect(text(get(root, "items-empty"))).toBe("No items");
});

test("keeps its domain while a pane with no terminal, such as the panel, has focus", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  host.focused = { space: "s1", tab: "tab1", pane: "p2", terminal: null };
  expect(text(get(render(), "crumb"))).toBe("alpha");
});

test("reads the state folder from the coordinate config", async () => {
  focusDomain("alpha");
  host.files.set(
    "/Users/test/.config/coordinate/config.json",
    JSON.stringify({ state_dir: "~/state" }),
  );
  host.files.set("/Users/test/state/backlogs/alpha.json", JSON.stringify(everyStatus()));
  const { render } = await mount();
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  expect(host.watches.map((watch) => watch.path)).toEqual(["/Users/test/state/backlogs"]);
});

test("shows why there is nothing to draw", async () => {
  host.terminals = [{ address: "t9", state: "live", labels: {} }];
  host.focused = { space: "s1", tab: "tab1", pane: "p1", terminal: "t9" };
  let mounted = await mount();
  expect(text(get(mounted.render(), "no-domain"))).toBe(
    "No domain focused Focus a coordinator or one of its delegates to see its backlog.",
  );
  focusDomain("alpha");
  mounted = await mount();
  expect(text(get(mounted.render(), "missing"))).toBe(
    "No backlog for alpha Run coordinate start alpha to create it.",
  );
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  mounted = await mount();
  expect(text(get(mounted.render(), "invalid"))).toBe(
    "Couldn't read the backlog items must be a list",
  );
});

test("starts nothing under herdr-app check", async () => {
  host.checking = true;
  focusDomain("alpha");
  const { ctx } = await mount();
  expect([ctx.timers.length, host.reads.length, host.watches.length]).toEqual([0, 0, 0]);
});

test("lists open findings under the Items card with kind glyphs in their tones", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { render } = await mount();
  const root = render();
  expect(ids(root, "").filter((id) => id.endsWith("-header"))).toEqual([
    "items-header",
    "findings-header",
  ]);
  expect(text(get(root, "findings-header"))).toBe("Findings");
  expect(ids(root, "finding-")).toEqual(["finding-f2", "finding-f3"]);
  expect(text(get(root, "finding-f2"))).toBe("▲ f2 Flaky watcher test");
  expect(text(get(root, "finding-f3"))).toBe("✦ f3 Share the validator");
  const glyph = (id: string) =>
    (get(root, id).nodes[0] as { styles: Record<string, unknown> }).styles.text_color;
  expect([glyph("finding-f2"), glyph("finding-f3")]).toEqual(["ansi1", "ansi5"]);
});

test("says so when no finding is open", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  expect(text(get(render(), "findings-empty"))).toBe("No open findings");
});

// i1 waits on the user with an ask whose recommended option is not listed first; i2 has no rec.
const withAsk = (): Backlog => {
  let backlog = add(emptyBacklog("alpha", null), "Name the panel", {
    status: "waiting-user",
    touches: ["skills", "herdr-finbar"],
    due: "2026-11-20",
    decided: [{ text: "Keep it read-only", at: "2026-11-16T09:00:00.000Z" }],
    ask: {
      question: "Which title?",
      context: "It shows in the tab row",
      options: ["Coordinate backlog", "Backlog", "Queue"],
      rec: "Backlog",
      recReason: "fits the pill",
    },
    delegates: [
      {
        name: "impl-name",
        session: "s-9",
        branch: "wyattjoh/name",
        worktree: null,
        brief: "/briefs/name.md",
        report: "/reports/name.md",
      },
    ],
  });
  backlog = add(backlog, "Pick a tone", {
    status: "waiting-user",
    ask: {
      question: "Which tone?",
      context: null,
      options: ["ansi3", "blocked"],
      rec: null,
      recReason: null,
    },
  });
  return backlog;
};

test("opens an item's read-only detail with the recommended option first and highlighted", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  const root = render();
  expect(text(get(root, "detail-title"))).toBe("i1 Name the panel");
  expect(text(get(root, "detail-status"))).toBe("Waiting on you");
  expect(get(root, "detail-status").styles.text_color).toBe("blocked");
  expect(text(get(root, "ask-question"))).toBe("Which title?");
  expect(text(get(root, "ask-context"))).toBe("It shows in the tab row");
  expect(ids(root, "ask-option-")).toEqual(["ask-option-1", "ask-option-0", "ask-option-2"]);
  expect(text(get(root, "ask-option-1"))).toBe("Backlog Recommended fits the pill");
  expect(get(root, "ask-option-1").styles.bg).toBe("selected");
  expect(get(root, "ask-option-0").styles.bg).toBe(undefined);
  expect(text(get(root, "ask-rec-reason"))).toBe("fits the pill");
  expect(text(get(root, "decided-0"))).toBe("Keep it read-only 2026-11-16");
  expect(text(get(root, "fact-touches"))).toBe("Touches skills herdr-finbar");
  expect(text(get(root, "fact-due"))).toBe("Due 2026-11-20");
  expect(text(get(root, "delegate-s-9"))).toBe(
    "impl-name Brief /briefs/name.md Report /reports/name.md",
  );
  expect(text(get(root, "back"))).toBe("Back");
});

test("keeps an ask without a recommendation in its own order, with nothing highlighted", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i2").click!({}, ctx.cx);
  const root = render();
  expect(ids(root, "ask-option-")).toEqual(["ask-option-0", "ask-option-1"]);
  expect(text(get(root, "ask-option-0"))).toBe("ansi3");
  expect([get(root, "ask-option-0").styles.bg, get(root, "ask-option-1").styles.bg]).toEqual([
    undefined,
    undefined,
  ]);
  expect(ids(root, "ask-rec-reason")).toEqual([]);
  expect(text(get(root, "fact-touches"))).toBe("Touches None");
  expect(text(get(root, "fact-due"))).toBe("Due None");
  expect(ids(root, "delegate-")).toEqual([]);
});

test("Back returns to the list, which stayed mounted under the detail to keep its scroll", async () => {
  focusDomain("alpha");
  const original = JSON.stringify(withAsk());
  host.files.set(DOC, original);
  const { ctx, render } = await mount();
  let root = render();
  expect(ids(root, "back")).toEqual([]);
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  get(root, "item-i1").click!({}, ctx.cx);
  root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(true);
  expect(ids(get(root, "screen-list"), "panel-scroll")).toEqual(["panel-scroll"]);
  expect(ids(root, "screen-item")).toEqual(["screen-item"]);
  get(root, "back").click!({}, ctx.cx);
  root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  expect(ids(root, "screen-item")).toEqual([]);
  expect(ids(root, "back")).toEqual([]);
  expect(host.files.get(DOC)).toBe(original);
});

test("falls back to the list when the open item leaves the document or focus changes domain", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "screen-item")).toEqual([]);
  focusDomain("alpha");
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "screen-item")).toEqual([]);
  get(render(), "item-i2").click!({}, ctx.cx);
  host.files.set(DOC, JSON.stringify({ ...withAsk(), items: withAsk().items.slice(0, 1) }));
  host.watches.at(-1)!.fire([DOC]);
  await settle();
  const root = render();
  expect(ids(root, "screen-item")).toEqual([]);
  expect(text(get(root, "crumb"))).toBe("alpha");
});
