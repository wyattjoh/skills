import { beforeEach, expect, test } from "bun:test";
import { addFinding, addItem, closeFinding, closeItem, emptyBacklog } from "../../lib/store.ts";
import type { Backlog, Item } from "../../lib/store.ts";
import { context, get, host, ids, resetHost, settle, text } from "../../test/renderer.ts";

const { default: Panel } = await import("./index.ts");
const { LIST_SCRIPT } = await import("./model.ts");

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

// A focused terminal with no fleet.domain label.
const focusPlain = () => {
  host.terminals = [{ address: "t9", state: "live", labels: {} }];
  host.focused = { space: "s1", tab: "tab1", pane: "p1", terminal: "t9" };
};

// Focus moves to the panel's own pane, as a click on it does.
const focusPanel = () => {
  host.focused = { space: "s1", tab: "tab1", pane: "p2", terminal: null };
};

const addIssue = (backlog: Backlog, title: string): Backlog => {
  const added = addFinding(backlog, {
    kind: "issue",
    title,
    detail: undefined,
    path: undefined,
    from: undefined,
  });
  if (!added.ok) throw new Error(added.reason);
  return added.backlog;
};

// beta: one open item and two findings, f3 closed as acted on.
const betaBacklog = (): Backlog => {
  let backlog = add({ ...emptyBacklog("beta", null), focus: "Beta focus" }, "Beta work");
  backlog = addIssue(addIssue(backlog, "Flaky test"), "Stale docs");
  const closed = closeFinding(backlog, { id: "f3", outcome: "fixed", dismissed: false, now: NOW });
  if (!closed.ok) throw new Error(closed.reason);
  return closed.backlog;
};

test("lists every domain with its waiting, delegated, open and findings counts", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { render } = await mount();
  const root = render();
  expect(host.execs).toEqual([
    { command: "sh", args: ["-c", LIST_SCRIPT, "coordinate-panel", `${STATE}/backlogs`] },
  ]);
  expect(ids(root, "domain-")).toEqual(["domain-alpha", "domain-beta"]);
  expect(text(get(root, "domain-alpha"))).toBe("alpha 1 waiting 1 delegated 2 open 0 findings");
  expect(text(get(root, "domain-beta"))).toBe("beta 0 waiting 0 delegated 1 open 1 findings");
});

test("opens a domain from the listing and Back returns to it", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { ctx, render } = await mount();
  focusPanel();
  get(render(), "domain-beta").click!({}, ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  let root = render();
  expect(text(get(root, "crumb"))).toBe("beta");
  expect(text(get(root, "focus"))).toBe("Beta focus");
  get(root, "back").click!({}, ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  root = render();
  expect(ids(root, "domain-")).toEqual(["domain-alpha", "domain-beta"]);
  expect(ids(root, "back")).toEqual([]);
});

test("a focused domain terminal wins over a domain opened from the listing", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { ctx, render } = await mount();
  focusPanel();
  get(render(), "domain-beta").click!({}, ctx.cx);
  await settle();
  focusDomain("alpha");
  ctx.tick(1_000);
  await settle();
  expect(text(get(render(), "crumb"))).toBe("alpha");
  expect(ids(render(), "back")).toEqual([]);
  focusPlain();
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta"]);
});

test("Back from an item opened in a listed domain returns to that domain, then to the listing", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  focusPanel();
  get(render(), "domain-alpha").click!({}, ctx.cx);
  await settle();
  get(render(), "item-i1").click!({}, ctx.cx);
  expect(ids(render(), "screen-item")).toEqual(["screen-item"]);
  get(render(), "back").click!({}, ctx.cx);
  await settle();
  let root = render();
  expect([text(get(root, "crumb")), ids(root, "screen-item"), ids(root, "back")]).toEqual([
    "alpha",
    [],
    ["back"],
  ]);
  get(root, "back").click!({}, ctx.cx);
  await settle();
  root = render();
  expect([text(get(root, "crumb")), ids(root, "domain-")]).toEqual([
    "All domains",
    ["domain-alpha"],
  ]);
});

test("names an invalid or unreadable domain in the listing instead of failing it", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  host.files.set(`${STATE}/backlogs/gamma.json`, "{}");
  host.unreadable.add(`${STATE}/backlogs/gamma.json`);
  const { ctx, render } = await mount();
  const root = render();
  expect(text(get(root, "domain-alpha"))).toBe("alpha Invalid");
  expect(text(get(root, "domain-beta"))).toBe("beta 0 waiting 0 delegated 1 open 1 findings");
  expect(text(get(root, "domain-gamma"))).toBe("gamma Unreadable");
  focusPanel();
  get(root, "domain-alpha").click!({}, ctx.cx);
  await settle();
  expect(text(get(render(), "invalid"))).toBe("alpha's backlog is invalid items must be a list");
});

test("relists the domains when the watched backlogs folder changes", async () => {
  focusPlain();
  const { render } = await mount();
  expect(ids(render(), "no-backlogs")).toEqual(["no-backlogs"]);
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  host.watches[0]!.fire([`${STATE}/backlogs/beta.json`]);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-beta"]);
});

test("shows an empty state when there are no backlogs", async () => {
  focusPlain();
  const { render } = await mount();
  expect(text(get(render(), "no-backlogs"))).toBe(
    "No backlogs yet Run coordinate start <domain> to create one.",
  );
});

test("shows why the backlogs folder can't be listed", async () => {
  focusPlain();
  host.execExit = { code: 1, stderr: "sh: permission denied\n" };
  let mounted = await mount();
  expect(text(get(mounted.render(), "listing-error"))).toBe(
    "Couldn't list the backlogs sh: permission denied",
  );
  host.execExit = undefined;
  host.execRejects = new Error("cannot start sh: program not found");
  mounted = await mount();
  expect(text(get(mounted.render(), "listing-error"))).toBe(
    "Couldn't list the backlogs Error: cannot start sh: program not found",
  );
});

test("shows why there is nothing to draw for a focused domain", async () => {
  focusDomain("alpha");
  let mounted = await mount();
  expect(text(get(mounted.render(), "missing"))).toBe(
    "No backlog for alpha Run coordinate start alpha to create it.",
  );
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  mounted = await mount();
  expect(text(get(mounted.render(), "invalid"))).toBe(
    "alpha's backlog is invalid items must be a list",
  );
  host.unreadable.add(DOC);
  mounted = await mount();
  expect(text(get(mounted.render(), "unreadable"))).toBe(
    "Couldn't read alpha's backlog Error: permission denied: " + DOC,
  );
});

test("starts nothing under herdr-app check", async () => {
  host.checking = true;
  focusDomain("alpha");
  const { ctx } = await mount();
  expect([ctx.timers.length, host.reads.length, host.watches.length, host.execs.length]).toEqual([
    0, 0, 0, 0,
  ]);
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
    "impl-name gone Brief /briefs/name.md Report /reports/name.md",
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

const ref = (name: string, session: string) => ({
  name,
  session,
  branch: null,
  worktree: null,
  brief: `/briefs/${name}.md`,
  report: `/reports/${name}.md`,
});

// A live delegate terminal in alpha, running the given session.
const agent = (
  address: string,
  session: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  address,
  state: "live",
  status,
  name: `agent-${address}`,
  parent: "t1",
  labels: { "fleet.domain": "alpha", "fleet.session": session, "fleet.task": `task ${address}` },
  ...extra,
});

const ENDED = `${STATE}/ended`;

const statusOf = (root: unknown, id: string) => {
  const node = get(root as never, id).nodes[1] as { styles: Record<string, unknown> };
  return [text(node), node.styles.text_color];
};

test("joins each delegate to its live terminal by session and tones its status", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-w", "working"),
    agent("t3", "s-i", "idle"),
    agent("t4", "s-b", "blocked"),
    agent("t5", "s-d", "done"),
    agent("t6", "s-e", "error"),
  );
  const backlog = add(emptyBacklog("alpha", null), "Fan out", {
    status: "delegated",
    delegates: ["s-w", "s-i", "s-b", "s-d", "s-e"].map((session) => ref(`d${session}`, session)),
  });
  host.files.set(DOC, JSON.stringify(backlog));
  const { render } = await mount();
  const root = render();
  expect(ids(root, "ref-")).toEqual(["ref-s-w", "ref-s-i", "ref-s-b", "ref-s-d", "ref-s-e"]);
  expect(text(get(root, "ref-s-w"))).toBe("ds-w working");
  expect(
    ["ref-s-w", "ref-s-i", "ref-s-b", "ref-s-d", "ref-s-e"].map((id) => statusOf(root, id)),
  ).toEqual([
    ["working", "working"],
    ["idle", "idle"],
    ["blocked", "blocked"],
    ["done", "done"],
    ["error", "ansi1"],
  ]);
  expect(get(root, "rows-delegated").styles.h).toBe(32 + 5 * 28);
});

test("shows a delegate with an ended record as ended and one with neither as gone", async () => {
  focusDomain("alpha");
  const backlog = add(emptyBacklog("alpha", null), "Finished work", {
    status: "delegated",
    delegates: [ref("closer", "s-end"), ref("lost", "s-lost")],
  });
  const original = JSON.stringify(backlog);
  host.files.set(DOC, original);
  const record = JSON.stringify({
    name: "closer",
    session: "s-end",
    ended_at: "2026-11-16T08:00:00.000Z",
  });
  host.files.set(`${ENDED}/s-end.json`, record);
  const { render } = await mount();
  const root = render();
  expect([statusOf(root, "ref-s-end"), statusOf(root, "ref-s-lost")]).toEqual([
    ["ended 2026-11-16", "dim"],
    ["gone", "ansi3"],
  ]);
  expect(host.reads.filter((path) => path.startsWith(ENDED))).toEqual([
    `${ENDED}/s-end.json`,
    `${ENDED}/s-lost.json`,
  ]);
  expect([...host.files.entries()]).toEqual([
    [DOC, original],
    [`${ENDED}/s-end.json`, record],
  ]);
  expect([host.execs, host.runs]).toEqual([[], []]);
});

test("looks up the ended record once a delegate's terminal goes away", async () => {
  focusDomain("alpha");
  host.terminals.push(agent("t2", "s-w", "working"));
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Running work", {
        status: "delegated",
        delegates: [ref("runner", "s-w")],
      }),
    ),
  );
  const { ctx, render } = await mount();
  expect(statusOf(render(), "ref-s-w")).toEqual(["working", "working"]);
  host.terminals = host.terminals.filter((terminal) => terminal.address !== "t2");
  host.files.set(`${ENDED}/s-w.json`, JSON.stringify({ ended_at: "2026-11-17T10:00:00.000Z" }));
  expect(statusOf(render(), "ref-s-w")).toEqual(["gone", "ansi3"]);
  ctx.tick(1_000);
  await settle();
  expect(statusOf(render(), "ref-s-w")).toEqual(["ended 2026-11-17", "dim"]);
  ctx.tick(1_000);
  await settle();
  expect(host.reads.filter((path) => path.startsWith(ENDED))).toEqual([`${ENDED}/s-w.json`]);
});

test("nests a child review under the delegate that started it", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-impl", "idle"),
    agent("t3", "s-review", "working", { name: "review", parent: "t2" }),
  );
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Build it", {
        status: "delegated",
        delegates: [ref("impl", "s-impl")],
      }),
    ),
  );
  const { render } = await mount();
  const root = render();
  expect(ids(get(root, "rows-delegated"), "")).toEqual([
    "rows-delegated",
    "item-i1",
    "ref-s-impl",
    "term-t3",
  ]);
  expect(text(get(root, "term-t3"))).toBe("review working");
  expect([get(root, "ref-s-impl").styles.pl, get(root, "term-t3").styles.pl]).toEqual([24, 38]);
  expect(get(root, "rows-delegated").styles.h).toBe(32 + 2 * 28);
  expect(ids(root, "unfiled")).toEqual([]);
});

test("lists live domain terminals no item names under Unfiled delegates", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-old", "idle", { name: "old-impl" }),
    agent("t3", "s-old-review", "blocked", { name: "old-review", parent: "t2" }),
    agent("t4", "s-other", "working", {
      name: "elsewhere",
      labels: { "fleet.domain": "beta", "fleet.session": "s-other" },
    }),
    agent("t5", "s-done", "done", { state: "finished" }),
  );
  host.files.set(DOC, JSON.stringify(add(emptyBacklog("alpha", null), "Base work")));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "unfiled-header"))).toBe("Unfiled delegates");
  expect(ids(get(root, "unfiled"), "term-")).toEqual(["term-t2", "term-t3"]);
  expect(text(get(root, "term-t2"))).toBe("old-impl idle");
  expect([statusOf(root, "term-t3"), get(root, "term-t3").styles.pl]).toEqual([
    ["blocked", "blocked"],
    24,
  ]);
  expect(ids(root, "").filter((id) => id.endsWith("-header"))).toEqual([
    "items-header",
    "unfiled-header",
    "findings-header",
  ]);
});

test("shows each delegate's live status on the item's detail screen", async () => {
  focusDomain("alpha");
  host.terminals.push(agent("t2", "s-w", "blocked"));
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Blocked work", {
        status: "delegated",
        delegates: [ref("runner", "s-w")],
      }),
    ),
  );
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  expect(text(get(render(), "delegate-s-w"))).toBe(
    "runner blocked Brief /briefs/runner.md Report /reports/runner.md",
  );
});
