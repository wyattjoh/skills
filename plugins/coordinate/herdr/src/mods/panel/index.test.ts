import { beforeEach, expect, test } from "bun:test";
import { addItem, closeItem, emptyBacklog } from "../../lib/store.ts";
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
