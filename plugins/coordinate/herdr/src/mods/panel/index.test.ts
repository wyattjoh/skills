import { beforeEach, expect, test } from "bun:test";
import {
  addFinding,
  addItem,
  closeFinding,
  closeItem,
  emptyBacklog,
  updateItem,
} from "../../lib/store.ts";
import type { Backlog, Item } from "../../lib/store.ts";
import {
  context,
  get,
  host,
  ids,
  resetHost,
  settle,
  text,
  typeInto,
} from "@wyattjoh/herdr-dev/test/renderer";
import type { Node } from "@wyattjoh/herdr-dev/test/renderer";

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

const recordAnswer = (backlog: Backlog, id: string, answer: string): Backlog => {
  const updated = updateItem(backlog, {
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
    answer,
    now: NOW,
  });
  if (!updated.ok) throw new Error(updated.reason);
  return updated.backlog;
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

// The breadcrumb trail as it reads, separators included.
const trail = (root: Node) => text(get(root, "breadcrumb"));

// Press a crumb or a page row by its id.
const press = (root: Node, id: string, cx: unknown) => get(root, id).click!({}, cx);
const openPage = (root: Node, page: string, cx: unknown) =>
  get(root, `page-${page}`).click!({}, cx);

const mount = async () => {
  const ctx = context();
  const view = new Panel();
  view.init(undefined, ctx.cx as never);
  await settle();
  return { ctx, view, render: () => view.render(ctx.cx as never) as never };
};

test("separates asked items from status groups and keeps each item row unique", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "focus"))).toBe("Ship the panel tracer");
  expect(text(get(root, "focus-header"))).toBe("Focus");
  expect(ids(root, "focus-card")).toEqual(["focus-card"]);
  expect(ids(root, "waiting-header")).toEqual(["waiting-header"]);
  expect(
    ids(root, "")
      .filter((id) => id.endsWith("-header"))
      .slice(0, 2),
  ).toEqual(["focus-header", "waiting-header"]);
  expect(ids(get(root, "waiting"), "item-")).toEqual(["item-i1"]);
  expect(ids(get(root, "items"), "item-")).toEqual([
    "item-i2",
    "item-i3",
    "item-i4",
    "item-i5",
    "item-i6",
    "item-i7",
    "item-i8",
  ]);
  expect(ids(root, "group-")).toEqual([
    "group-building",
    "group-building-toggle",
    "group-delegated",
    "group-delegated-toggle",
    "group-open",
    "group-open-toggle",
    "group-parked",
    "group-parked-toggle",
    "group-done",
    "group-done-toggle",
    "group-dismissed",
    "group-dismissed-toggle",
  ]);
  expect(text(get(root, "group-open-toggle"))).toBe("Open 2");
  expect(text(get(root, "group-done-toggle"))).toBe("Done 1");
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

test("hides the Waiting on you card when no items have open asks", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(recordAnswer(everyStatus(), "i1", "Coordinate backlog")));
  const { render } = await mount();
  const root = render();
  expect(ids(root, "waiting-header")).toEqual([]);
  expect(text(get(root, "group-waiting-user-toggle"))).toBe("Answered, waiting for coordinator 1");
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
  expect(get(root, "alpha-group-open-body").styles.h).toBe(64);
  expect(get(root, "alpha-group-done-body").styles.h).toBe(0);
  expect(get(root, "alpha-group-dismissed-body").styles.h).toBe(0);
  get(root, "group-done-toggle").click!({}, ctx.cx);
  get(root, "group-open-toggle").click!({}, ctx.cx);
  root = render();
  expect(get(root, "alpha-group-done-body").styles.h).toBe(32);
  expect(get(root, "alpha-group-open-body").styles.h).toBe(0);
  expect(ctx.notified - before).toBe(2);
});

test("tones each group header by its status with the fixture's colors", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(recordAnswer(everyStatus(), "i1", "Coordinate backlog")));
  const { render } = await mount();
  const root = render();
  const tone = (status: string) =>
    (get(root, `group-${status}-toggle`).nodes[0] as { styles: Record<string, unknown> }).styles
      .text_color;
  expect(
    ["waiting-user", "building", "delegated", "open", "parked", "done", "dismissed"].map(tone),
  ).toEqual(["#ef4444", "#3b82f6", "#a855f7", "#737373", "#a3a3a3", "#22c55e", "#ef4444"]);
  const title = (id: string) =>
    (get(root, id).nodes[1] as { styles: Record<string, unknown> }).styles.text_color;
  expect([title("item-i7"), title("item-i8")]).toEqual(["#f5f5f5", "#737373"]);
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
  expect(trail(root)).toBe("Domains › beta");
  expect(text(get(root, "toolbar"))).toBe("Backlog beta");
  expect(text(get(root, "focus"))).toBe("Beta focus");
  expect(text(get(root, "items-empty"))).toBe("No items");
});

test("shows a domain's last read at once on returning to it, then its reread", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify({ ...emptyBacklog("beta", null), focus: "Beta focus" }),
  );
  const { ctx, render } = await mount();
  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Beta focus");
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), focus: "Fresh alpha focus" }));
  focusDomain("alpha");
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  ctx.tick(1_000);
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  await settle();
  expect(text(get(render(), "focus"))).toBe("Fresh alpha focus");
});

test("a failed reread replaces the domain's last read", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  focusPlain();
  ctx.tick(1_000);
  await settle();
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  focusDomain("alpha");
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  ctx.tick(1_000);
  await settle();
  expect(text(get(render(), "invalid"))).toBe("alpha's backlog is invalid items must be a list");
});

test("keeps its domain while a pane with no terminal, such as the panel, has focus", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  host.focused = { space: "s1", tab: "tab1", pane: "p2", terminal: null };
  expect(trail(render())).toBe("Domains › alpha");
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

test("lists every domain with only its nonzero waiting, delegated and open counts", async () => {
  focusPlain();
  const alpha = everyStatus();
  host.files.set(DOC, JSON.stringify(alpha));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { render } = await mount();
  const root = render();
  expect(host.execs).toEqual([
    { command: "sh", args: ["-c", LIST_SCRIPT, "coordinate-panel", `${STATE}/backlogs`] },
  ]);
  expect(ids(root, "domain-")).toEqual(["domain-alpha", "domain-beta"]);
  expect(text(get(root, "domain-alpha"))).toBe("alpha 1 waiting 1 delegated 2 open");
  expect(text(get(root, "domain-beta"))).toBe("beta 1 open");
});

test("hides count notes when a domain has no counts", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(emptyBacklog("beta", null)));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "domain-alpha"))).toBe("alpha");
  expect(text(get(root, "domain-beta"))).toBe("beta");
});

test("counts each referenced live delegate once and ignores unmatched terminals", async () => {
  focusPlain();
  const alpha = everyStatus();
  const ref = alpha.items.find((item) => item.id === "i3")?.delegates[0];
  if (ref === undefined) throw new Error("Expected alpha to have a delegate ref");
  host.files.set(
    DOC,
    JSON.stringify(
      add(alpha, "Another delegated item", {
        status: "delegated",
        delegates: [ref],
      }),
    ),
  );
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify(
      add(emptyBacklog("beta", null), "Beta work", {
        status: "delegated",
        delegates: [
          {
            name: "impl",
            session: "s-beta",
            branch: null,
            worktree: null,
            brief: "/b.md",
            report: "/r.md",
          },
        ],
      }),
    ),
  );
  host.terminals.push(
    { address: "t2", state: "live", labels: { "fleet.session": "s-1" } },
    {
      address: "t3",
      state: "live",
      labels: { "fleet.session": "s-unrelated" },
    },
  );
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "domain-alpha"))).toBe("alpha 1 agents 1 waiting 2 delegated 2 open");
  expect(text(get(root, "domain-beta"))).toBe("beta 1 delegated");
});

test("lists only names the CLI could have written, sorted, whatever order the folder gives", async () => {
  focusPlain();
  for (const name of ["beta", "my domain", "Upper", "alpha", ".hidden"])
    host.files.set(`${STATE}/backlogs/${name}.json`, JSON.stringify(betaBacklog()));
  const { render } = await mount();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta"]);
});

test("opens a domain from the listing and the Domains crumb returns to it", async () => {
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
  expect(trail(root)).toBe("Domains › beta");
  expect(text(get(root, "focus"))).toBe("Beta focus");
  press(root, "crumb-domains", ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  root = render();
  expect(ids(root, "domain-")).toEqual(["domain-alpha", "domain-beta"]);
  expect(trail(root)).toBe("Domains");
  expect(get(root, "crumb-domains").click).toBe(undefined);
  expect([text(get(root, "toolbar")), ids(root, "toolbar-domain")]).toEqual(["Backlog", []]);
});

test("the Domains crumb lists every domain while focus names one, until focus moves", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  host.files.set(`${STATE}/backlogs/gamma.json`, JSON.stringify(betaBacklog()));
  const { ctx, render } = await mount();
  press(render(), "crumb-domains", ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta", "domain-gamma"]);
  get(render(), "domain-beta").click!({}, ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  expect([trail(render()), text(get(render(), "focus"))]).toEqual(["Domains › beta", "Beta focus"]);
  host.terminals = [
    {
      address: "t9",
      state: "live",
      labels: { "fleet.role": "coordinator", "fleet.domain": "gamma" },
    },
  ];
  host.focused = { space: "s1", tab: "tab1", pane: "p9", terminal: "t9" };
  ctx.tick(1_000);
  await settle();
  expect(trail(render())).toBe("Domains › gamma");
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
  expect(trail(render())).toBe("Domains › alpha");
  focusPlain();
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta"]);
});

test("the trail from an item opened in a listed domain returns to that domain, then to the listing", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  focusPanel();
  get(render(), "domain-alpha").click!({}, ctx.cx);
  await settle();
  get(render(), "item-i1").click!({}, ctx.cx);
  expect(ids(render(), "screen-item")).toEqual(["screen-item"]);
  expect(trail(render())).toBe("Domains › alpha › Items › i1");
  press(render(), "crumb-domain-alpha", ctx.cx);
  await settle();
  let root = render();
  expect([trail(root), ids(root, "screen-item")]).toEqual(["Domains › alpha", []]);
  press(root, "crumb-domains", ctx.cx);
  await settle();
  root = render();
  expect([trail(root), ids(root, "domain-")]).toEqual(["Domains", ["domain-alpha"]]);
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
  expect(text(get(root, "domain-beta"))).toBe("beta 1 open");
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

test("shows page buttons on the main list and lists only open findings on the Findings page", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  let root = render();
  expect(ids(root, "page-")).toEqual(["page-standing", "page-findings", "page-boundary"]);
  expect(
    ["page-standing", "page-findings", "page-boundary"].map((id) => text(get(root, id))),
  ).toEqual(["Standing yes 0", "Findings 2", "Boundary 0"]);
  expect(ids(root, "finding-")).toEqual([]);

  openPage(root, "findings", ctx.cx);
  root = render();
  expect(trail(root)).toBe("Domains › alpha › Findings");
  expect(text(get(root, "findings-header"))).toBe("Findings");
  expect(ids(root, "finding-")).toEqual(["finding-f2", "finding-f3"]);
  expect(text(get(root, "finding-f2"))).toBe("▲ f2 Flaky watcher test");
  expect(text(get(root, "finding-f3"))).toBe("✦ f3 Share the validator");
  const glyph = (id: string) =>
    (get(root, id).nodes[0] as { styles: Record<string, unknown> }).styles.text_color;
  expect([glyph("finding-f2"), glyph("finding-f3")]).toEqual(["#ef4444", "#f97316"]);
});

test("says so on the Findings page when no finding is open", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
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
      optionDetails: ["Long form for the tab", "Short and clear", "A neutral alternative"],
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
      optionDetails: ["", "Blocked means unavailable"],
      rec: null,
      recReason: null,
    },
  });
  return backlog;
};

test("opens an item's detail with the recommended option first, labelled and not yet picked", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  const root = render();
  expect(text(get(root, "detail-title"))).toBe("i1 Name the panel Waiting on you");
  expect(text(get(root, "detail-status"))).toBe("Waiting on you");
  expect(get(root, "detail-status").styles.text_color).toBe("#ef4444");
  expect(text(get(root, "ask-question"))).toBe("Which title?");
  expect(text(get(root, "ask-context"))).toBe("It shows in the tab row");
  expect(ids(root, "ask-option-")).toEqual(["ask-option-1", "ask-option-0", "ask-option-2"]);
  expect(text(get(root, "ask-option-1"))).toBe("Backlog Recommended Short and clear fits the pill");
  expect(text(get(root, "ask-detail-1"))).toBe("Short and clear");
  expect(get(root, "ask-detail-1").styles.text_color).toBe("#a3a3a3");
  expect(text(get(root, "ask-detail-0"))).toBe("Long form for the tab");
  expect(text(get(root, "ask-detail-2"))).toBe("A neutral alternative");
  expect([get(root, "ask-option-1").styles.bg, get(root, "ask-option-0").styles.bg]).toEqual([
    undefined,
    undefined,
  ]);
  expect(text(get(root, "ask-rec-reason"))).toBe("fits the pill");
  expect(text(get(root, "decided-0"))).toBe("Keep it read-only 2026-11-16");
  expect(text(get(root, "fact-touches"))).toBe("Touches skills herdr-finbar");
  expect(text(get(root, "fact-due"))).toBe("Due 2026-11-20");
  expect(text(get(root, "delegate-s-9"))).toBe(
    "impl-name gone Brief /briefs/name.md Report /reports/name.md",
  );
  expect(text(get(root, "fact-created"))).toBe("Created 2026-11-17");
  expect(ids(root, "fact-closed")).toEqual([]);
  expect(trail(root)).toBe("Domains › alpha › Items › i1");
  expect(get(root, "crumb-item-i1").click).toBe(undefined);
});

test("keeps an ask without a recommendation in its own order, with nothing highlighted", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i2").click!({}, ctx.cx);
  const root = render();
  expect(ids(root, "ask-option-")).toEqual(["ask-option-0", "ask-option-1"]);
  expect(text(get(root, "ask-option-0"))).toBe("ansi3");
  expect(text(get(root, "ask-option-1"))).toBe("blocked Blocked means unavailable");
  expect(ids(root, "ask-detail-")).toEqual(["ask-detail-1"]);
  expect([get(root, "ask-option-0").styles.bg, get(root, "ask-option-1").styles.bg]).toEqual([
    undefined,
    undefined,
  ]);
  expect(ids(root, "ask-rec-reason")).toEqual([]);
  expect(text(get(root, "fact-touches"))).toBe("Touches None");
  expect(text(get(root, "fact-due"))).toBe("Due None");
  expect(ids(root, "delegate-")).toEqual([]);
});

// The document after the CLI recorded an answer to i1's ask.
const answered = (answer: string): Backlog => recordAnswer(withAsk(), "i1", answer);

const answerArgs = (id: string, answer: string) => [
  "-u",
  "HC_TERMINAL_ID",
  "bun",
  "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
  "item",
  "answer",
  "--domain",
  "alpha",
  "--",
  id,
  answer,
];

test("answers with a picked option through the CLI, then shows the item as it reloads", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  expect([
    text(get(render(), "ask-answer-submit")),
    get(render(), "ask-answer-submit").styles.bg,
  ]).toEqual(["Answer", "#404040"]);
  get(render(), "ask-option-0").click!({}, ctx.cx);
  expect(get(render(), "ask-answer-submit").styles.bg).toBe("#ffffff");
  const picked = render();
  expect([get(picked, "ask-option-0").styles.bg, get(picked, "ask-option-1").styles.bg]).toEqual([
    "#2563eb",
    undefined,
  ]);
  expect(host.execs).toEqual([]);
  host.files.set(DOC, JSON.stringify(answered("Coordinate backlog")));
  get(picked, "ask-answer-submit").click!({}, ctx.cx);
  expect(text(get(render(), "ask-answer-submit"))).toBe("Answering…");
  await settle();
  expect(host.execs).toEqual([
    { command: "/usr/bin/env", args: answerArgs("i1", "Coordinate backlog") },
  ]);
  const root = render();
  expect(ids(root, "ask-")).toEqual([]);
  expect(text(get(root, "decided-1"))).toBe('Re "Which title?": Coordinate backlog 2026-11-17');
  press(root, "crumb-items", ctx.cx);
  const list = render();
  expect(ids(get(list, "waiting"), "item-")).toEqual(["item-i2"]);
  expect(text(get(list, "group-waiting-user-toggle"))).toBe("Answered, waiting for coordinator 1");
  expect(ids(list, "item-")).toEqual(["item-i2", "item-i1"]);
});

test("answers with typed text over the picked option, a leading dash kept as one argument", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  typeInto(host.inputs[0]!, "  -call it Board ", ctx.cx);
  const typed = render();
  expect(ids(typed, "ask-option-").map((id) => get(typed, id).styles.bg)).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  get(typed, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    { command: "/usr/bin/env", args: answerArgs("i1", "-call it Board") },
  ]);
});

test("shows the CLI's message and keeps the draft when recording fails or cannot start", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  get(render(), "ask-option-1").click!({}, ctx.cx);
  host.execExit = { code: 1, stderr: "refused: i1 has no ask to answer\n" };
  get(render(), "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  const refused = render();
  expect([
    text(get(refused, "ask-answer-error")),
    text(get(refused, "ask-answer-submit")),
    get(refused, "ask-option-1").styles.bg,
  ]).toEqual(["refused: i1 has no ask to answer", "Answer", "#2563eb"]);
  host.execExit = undefined;
  host.execRejects = new Error("no such file: bun");
  get(refused, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(text(get(render(), "ask-answer-error"))).toBe(
    "could not run coordinate: Error: no such file: bun",
  );
  expect(host.execs.length).toBe(2);
});

test("keeps Answer inert until an option is picked or text typed", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i2").click!({}, ctx.cx);
  const empty = get(render(), "ask-answer-submit");
  expect([empty.styles.bg, empty.click]).toEqual(["#404040", undefined]);
  host.inputs[0]!.handlers.get("submit")!({}, ctx.cx);
  typeInto(host.inputs[0]!, "   ", ctx.cx);
  expect(get(render(), "ask-answer-submit").click).toBe(undefined);
  expect(host.execs).toEqual([]);
});

test("the Items crumb returns to the list, which stayed mounted under the detail to keep its scroll", async () => {
  focusDomain("alpha");
  const original = JSON.stringify(withAsk());
  host.files.set(DOC, original);
  const { ctx, render } = await mount();
  let root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  get(root, "item-i1").click!({}, ctx.cx);
  root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(true);
  expect(ids(get(root, "screen-list"), "panel-scroll")).toEqual([
    "panel-scroll-frame",
    "panel-scroll",
  ]);
  expect(ids(root, "screen-item")).toEqual(["screen-item"]);
  press(root, "crumb-items", ctx.cx);
  root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  expect(ids(root, "screen-item")).toEqual([]);
  expect(trail(root)).toBe("Domains › alpha");
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
  expect(trail(root)).toBe("Domains › alpha");
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

test("counts nested and unfiled live delegate rows on the Domains listing", async () => {
  focusPlain();
  const backlog = add(emptyBacklog("alpha", null), "Reviewed work", {
    status: "delegated",
    delegates: [ref("review", "s-review")],
  });
  host.files.set(DOC, JSON.stringify(backlog));
  host.terminals.push(
    agent("t2", "s-review", "working"),
    agent("t3", "s-child", "idle", { parent: "t2" }),
    agent("t4", "s-unfiled", "working"),
  );
  const { render } = await mount();
  expect(text(get(render(), "domain-alpha"))).toBe("alpha 3 agents 1 delegated");
});

const ENDED = `${STATE}/ended`;

const statusOf = (root: unknown, id: string) => {
  const node = get(root as never, id).nodes[1] as { styles: Record<string, unknown> };
  return [text(node), node.styles.text_color];
};

// An item row's delegate chip: its text and its tone.
const lineOf = (root: unknown, id: string) => {
  const node = get(root as never, `delegates-${id}`);
  return [text(node), node.styles.text_color];
};

test("shows a delegated item's status chip at the right edge of its one-line row", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-w", "working"),
    agent("t3", "s-i", "idle"),
    agent("t4", "s-b", "blocked"),
    agent("t5", "s-d", "done"),
    agent("t6", "s-e", "error"),
  );
  let backlog = emptyBacklog("alpha", null);
  for (const session of ["s-w", "s-i", "s-b", "s-d", "s-e"])
    backlog = add(backlog, `Run ${session}`, {
      status: "delegated",
      delegates: [ref(`d${session}`, session)],
    });
  backlog = add(backlog, "Plain work");
  host.files.set(DOC, JSON.stringify(backlog));
  const { render } = await mount();
  const root = render();
  expect(["i1", "i2", "i3", "i4", "i5"].map((id) => lineOf(root, id))).toEqual([
    ["working", "#3b82f6"],
    ["idle", "#737373"],
    ["blocked", "#ef4444"],
    ["done", "#22c55e"],
    ["error", "#ef4444"],
  ]);
  expect(text(get(root, "item-i1"))).toBe("i1 Run s-w working");
  expect(ids(root, "ref-")).toEqual([]);
  expect(ids(root, "item-i6")).toEqual(["item-i6"]);
  expect([get(root, "item-i1").styles.h, get(root, "item-i6").styles.h]).toEqual([32, 32]);
  expect(get(root, "alpha-group-delegated-body").styles.h).toBe(5 * 32);
});

test("with two or more delegates, shows the most urgent state and the count", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-w", "working"),
    agent("t3", "s-i", "idle"),
    agent("t4", "s-b", "blocked"),
  );
  let backlog = add(emptyBacklog("alpha", null), "Fan out", {
    status: "delegated",
    delegates: [ref("a", "s-w"), ref("b", "s-i"), ref("c", "s-b")],
  });
  backlog = add(backlog, "Pair", {
    status: "delegated",
    delegates: [ref("d", "s-i"), ref("e", "s-w")],
  });
  host.files.set(DOC, JSON.stringify(backlog));
  const { render } = await mount();
  const root = render();
  expect([lineOf(root, "i1"), lineOf(root, "i2")]).toEqual([
    ["blocked ×3", "#ef4444"],
    ["working ×2", "#3b82f6"],
  ]);
});

test("shows a delegate with an ended record as ended and one with neither as gone", async () => {
  focusDomain("alpha");
  let backlog = add(emptyBacklog("alpha", null), "Finished work", {
    status: "delegated",
    delegates: [ref("closer", "s-end")],
  });
  backlog = add(backlog, "Lost work", {
    status: "delegated",
    delegates: [ref("lost", "s-lost")],
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
  expect([lineOf(root, "i1"), lineOf(root, "i2")]).toEqual([
    ["ended", "#737373"],
    ["gone", "#eab308"],
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
  expect(lineOf(render(), "i1")).toEqual(["working", "#3b82f6"]);
  host.terminals = host.terminals.filter((terminal) => terminal.address !== "t2");
  host.files.set(`${ENDED}/s-w.json`, JSON.stringify({ ended_at: "2026-11-17T10:00:00.000Z" }));
  expect(lineOf(render(), "i1")).toEqual(["gone", "#eab308"]);
  ctx.tick(1_000);
  await settle();
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
  ctx.tick(1_000);
  await settle();
  expect(host.reads.filter((path) => path.startsWith(ENDED))).toEqual([`${ENDED}/s-w.json`]);
});

test("draws no row for a child terminal under a delegate, whose own state names the item's", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-impl", "idle"),
    agent("t3", "s-review", "blocked", { name: "review", parent: "t2" }),
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
  expect(ids(get(root, "alpha-group-delegated-body"), "")).toEqual([
    "alpha-group-delegated-body",
    "item-i1",
    "delegates-i1",
  ]);
  expect(lineOf(root, "i1")).toEqual(["idle", "#737373"]);
  expect(get(root, "alpha-group-delegated-body").styles.h).toBe(32);
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
    ["blocked", "#ef4444"],
    24,
  ]);
  expect(trail(root)).toBe("Domains › alpha");
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

test("opens an open finding's detail with its fields, and its origin opens the item", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f3").click!({}, ctx.cx);
  let root = render();
  expect(ids(root, "screen-finding")).toEqual(["screen-finding"]);
  expect(get(root, "screen-list").styles.invisible).toBe(true);
  expect(trail(root)).toBe("Domains › alpha › Findings › f3");
  expect(text(get(root, "finding-title"))).toBe("f3 Share the validator Open");
  expect([
    text(get(root, "finding-status")),
    get(root, "finding-status").styles.text_color,
  ]).toEqual(["Open", "#737373"]);
  expect(
    ["fact-kind", "fact-detail", "fact-path", "fact-origin"].map((id) => text(get(root, id))),
  ).toEqual(["Kind Opportunity", "Detail None", "Path None", "Origin i1 Base work"]);
  expect([ids(root, "fact-outcome"), ids(root, "fact-closed")]).toEqual([[], []]);
  get(root, "fact-origin-link").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "screen-finding"), ids(root, "screen-item")]).toEqual([[], ["screen-item"]]);
  expect(trail(root)).toBe("Domains › alpha › Items › i1");
});

test("the Findings crumb returns from a finding detail to its page", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f3").click!({}, ctx.cx);
  let root = render();
  expect(trail(root)).toBe("Domains › alpha › Findings › f3");
  press(root, "crumb-findings", ctx.cx);
  root = render();
  expect([ids(root, "screen-finding"), ids(root, "screen-page"), trail(root)]).toEqual([
    [],
    ["screen-page"],
    "Domains › alpha › Findings",
  ]);
  expect(ids(root, "finding-")).toEqual(["finding-f2", "finding-f3"]);
});

test("a finding that leaves the document falls back to the lists", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f2").click!({}, ctx.cx);
  host.files.set(DOC, JSON.stringify({ ...withFindings(), findings: [] }));
  host.watches.at(-1)!.fire([DOC]);
  await settle();
  const root = render();
  expect([ids(root, "screen-finding"), trail(root)]).toEqual([[], "Domains › alpha › Findings"]);
});

test("shows a closed item's closing date beside its creation date", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  get(render(), "group-done-toggle").click!({}, ctx.cx);
  get(render(), "item-i7").click!({}, ctx.cx);
  const root = render();
  expect(["fact-created", "fact-closed", "fact-outcome"].map((id) => text(get(root, id)))).toEqual([
    "Created 2026-11-17",
    "Closed 2026-11-17",
    "Outcome wrapped up",
  ]);
});

test("opens Standing yes and Boundary from count rows on the main list", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify({
      ...emptyBacklog("alpha", null),
      legacy: "/old/backlog.md",
      boundary: { owned: ["skills/coordinate", "plugins/coordinate"], adjacent: [] },
      standingYes: [
        { text: "Merge doc fixes", at: NOW },
        { text: "Rebase local branches", at: "2026-11-15T09:00:00.000Z" },
      ],
    }),
  );
  const { ctx, render } = await mount();
  let root = render();
  expect([text(get(root, "page-standing")), text(get(root, "page-boundary"))]).toEqual([
    "Standing yes 2",
    "Boundary 2",
  ]);
  expect(ids(root, "standing-")).toEqual([]);
  expect(ids(root, "boundary-")).toEqual([]);

  openPage(root, "standing", ctx.cx);
  root = render();
  expect(trail(root)).toBe("Domains › alpha › Standing yes");
  expect(["standing-0", "standing-1"].map((id) => text(get(root, id)))).toEqual([
    "Merge doc fixes 2026-11-17",
    "Rebase local branches 2026-11-15",
  ]);
  press(root, "crumb-domain-alpha", ctx.cx);
  root = render();
  expect([ids(root, "screen-page"), trail(root)]).toEqual([[], "Domains › alpha"]);

  openPage(root, "boundary", ctx.cx);
  root = render();
  expect(trail(root)).toBe("Domains › alpha › Boundary");
  expect(ids(root, "boundary-")).toEqual([
    "boundary-owned-header",
    "boundary-alpha-owned-add",
    "boundary-owned",
    "boundary-alpha-owned-skills/coordinate",
    "boundary-alpha-owned-plugins/coordinate",
    "boundary-adjacent-header",
    "boundary-alpha-adjacent-add",
    "boundary-adjacent",
    "boundary-alpha-adjacent-empty",
  ]);
  expect(
    ["boundary-owned-header", "boundary-adjacent-header"].map((id) => text(get(root, id))),
  ).toEqual(["Owned +", "Adjacent +"]);
  expect(
    [
      "boundary-alpha-owned-skills/coordinate",
      "boundary-alpha-owned-plugins/coordinate",
      "boundary-alpha-adjacent-empty",
    ].map((id) => text(get(root, id))),
  ).toEqual(["skills/coordinate", "plugins/coordinate", "None"]);
});

test("shows a hovered X on boundary rows and runs rm with the row path and domain", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify({
      ...emptyBacklog("alpha", null),
      boundary: { owned: ["plugins/coordinate"], adjacent: [] },
    }),
  );
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  let root = render();
  expect(ids(root, "boundary-alpha-owned-remove-")).toEqual([]);
  const hover = get(root, "boundary-alpha-owned-plugins/coordinate").styles.on_hover;
  if (typeof hover !== "function") throw new Error("boundary row has no hover handler");
  (hover as (hovering: boolean, cx: unknown) => void)(true, ctx.cx);
  root = render();
  const remove = get(root, "boundary-alpha-owned-remove-plugins/coordinate");
  expect((remove.nodes[0] as Node).styles.asset).toBe("mods/workspace-chrome/x.svg");
  expect(remove.calls).toContain("on_click");
  remove.click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    {
      command: "/usr/bin/env",
      args: [
        "-u",
        "HC_TERMINAL_ID",
        "bun",
        "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
        "backlog",
        "boundary",
        "rm",
        "plugins/coordinate",
        "--domain",
        "alpha",
        "--json",
      ],
    },
  ]);
  expect(host.reads).toContain(DOC);
});

test("Escape cancels an inline boundary input", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  get(render(), "boundary-alpha-owned-add").click!({}, ctx.cx);
  const field = get(render(), "boundary-alpha-owned-input");
  const keyDown = (field.nodes[0] as Node).styles.on_key_down;
  if (typeof keyDown !== "function") throw new Error("boundary input has no key handler");
  (keyDown as (event: { keystroke: string }, cx: unknown) => void)({ keystroke: "escape" }, ctx.cx);
  expect(ids(render(), "boundary-alpha-owned-input")).toEqual([]);
  expect(host.execs).toEqual([]);
});

test("opens the Adjacent inline input and adds with --adjacent and the focused domain", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  get(render(), "boundary-alpha-adjacent-add").click!({}, ctx.cx);
  const root = render();
  expect(get(root, "boundary-alpha-adjacent-input")).toBeDefined();
  const input = host.inputs.at(-1)!;
  typeInto(input, "/tmp/new-adjacent-path", ctx.cx);
  input.handlers.get("submit")?.({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    {
      command: "/usr/bin/env",
      args: [
        "-u",
        "HC_TERMINAL_ID",
        "bun",
        "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
        "backlog",
        "boundary",
        "add",
        "/tmp/new-adjacent-path",
        "--adjacent",
        "--domain",
        "alpha",
        "--json",
      ],
    },
  ]);
  expect(host.reads).toContain(DOC);
});

test("shows the boundary CLI refusal on the card and refuses a blank path locally", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  get(render(), "boundary-alpha-owned-add").click!({}, ctx.cx);
  const input = host.inputs.at(-1)!;
  input.handlers.get("submit")?.({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([]);
  expect(text(get(render(), "boundary-alpha-owned-error"))).toBe("refused: path must not be blank");

  typeInto(input, "/tmp/duplicate-boundary-path", ctx.cx);
  host.execExit = { code: 1, stderr: "refused: duplicate path" };
  input.handlers.get("submit")?.({}, ctx.cx);
  await settle();
  expect(host.execs.length).toBe(1);
  expect(text(get(render(), "boundary-alpha-owned-error-/tmp/duplicate-boundary-path"))).toBe(
    "refused: duplicate path",
  );
});

test("shows None on an empty Standing yes page", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "standing", ctx.cx);
  expect(text(get(render(), "standing-empty"))).toBe("None");
});

test("keeps a domain's ended records while another domain's are looked up", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Alpha work", {
        status: "delegated",
        delegates: [ref("closer", "s-a")],
      }),
    ),
  );
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify(
      add(emptyBacklog("beta", null), "Beta work", {
        status: "delegated",
        delegates: [ref("other", "s-b")],
      }),
    ),
  );
  host.files.set(`${ENDED}/s-a.json`, JSON.stringify({ ended_at: "2026-11-16T08:00:00.000Z" }));
  host.files.set(`${ENDED}/s-b.json`, JSON.stringify({ ended_at: "2026-11-15T08:00:00.000Z" }));
  const { ctx, render } = await mount();
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
  focusDomain("alpha");
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
});

test("names the shown domain at the right end of the tool bar, dim and truncating", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  const name = get(render(), "toolbar-domain").nodes[0] as Node;
  expect([get(render(), "toolbar-domain").styles.flex_1, name.styles]).toEqual([
    true,
    {
      flex_none: true,
      min_w_0: true,
      truncate: true,
      text_right: true,
      text_size: 12,
      text_color: "#737373",
    },
  ]);
  expect(text(name)).toBe("alpha");
});

test("reveals item rows ten at a time and resets pagination when the domain changes", async () => {
  const manyItems = (domain: string, count: number) => {
    let backlog = emptyBacklog(domain, null);
    for (let index = 1; index <= count; index++) backlog = add(backlog, `Work ${index}`);
    return backlog;
  };
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(manyItems("alpha", 25)));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(manyItems("beta", 15)));
  const { ctx, render } = await mount();
  let root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-group-open"],
  ]);
  get(root, "load-more-group-open").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([
    20,
    ["load-more-group-open"],
  ]);
  get(root, "load-more-group-open").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([25, []]);

  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect([ids(render(), "item-").length, ids(render(), "load-more-")]).toEqual([
    10,
    ["load-more-group-open"],
  ]);
  focusDomain("alpha");
  ctx.tick(1_000);
  await settle();
  expect([ids(render(), "item-").length, ids(render(), "load-more-")]).toEqual([
    10,
    ["load-more-group-open"],
  ]);
});

test("paginates open findings while leaving closed findings off the Findings page", async () => {
  let backlog = emptyBacklog("alpha", null);
  for (let index = 1; index <= 25; index++) backlog = find(backlog, "issue", `Finding ${index}`);
  const allIds = backlog.findings.map((finding) => finding.id);
  for (const id of allIds.slice(0, 12)) {
    const closed = closeFinding(backlog, {
      id,
      outcome: "fixed",
      dismissed: false,
      now: NOW,
    });
    if (!closed.ok) throw new Error(closed.reason);
    backlog = closed.backlog;
  }
  const openIds = allIds.slice(12).map((id) => `finding-${id}`);
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  let root = render();
  expect([ids(root, "finding-"), ids(root, "load-more-")]).toEqual([
    openIds.slice(0, 10),
    ["load-more-findings-open"],
  ]);

  get(root, "load-more-findings-open").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "finding-"), ids(root, "load-more-")]).toEqual([openIds, []]);
});

test("paginates Unfiled delegates while preserving nested rows", async () => {
  focusDomain("alpha");
  host.terminals.push(
    ...Array.from({ length: 9 }, (_, index) => agent(`t${index + 2}`, `s${index + 2}`, "idle")),
    agent("t11", "s11", "idle"),
    agent("t12", "s12", "working", { parent: "t11" }),
  );
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  let root = render();
  expect([ids(get(root, "unfiled"), "term-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-unfiled"],
  ]);
  get(root, "load-more-unfiled").click!({}, ctx.cx);
  root = render();
  expect([ids(get(root, "unfiled"), "term-").length, ids(root, "load-more-")]).toEqual([11, []]);
});

test("paginates Standing yes entries ten at a time", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify({
      ...emptyBacklog("alpha", null),
      standingYes: Array.from({ length: 12 }, (_, index) => ({
        text: `Decision ${index + 1}`,
        at: NOW,
      })),
    }),
  );
  const { ctx, render } = await mount();
  openPage(render(), "standing", ctx.cx);
  let root = render();
  const standingRows = () => ids(root, "standing-").filter((id) => id !== "standing-header");
  expect([standingRows().length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-standing-yes"],
  ]);
  get(root, "load-more-standing-yes").click!({}, ctx.cx);
  root = render();
  expect([standingRows().length, ids(root, "load-more-")]).toEqual([12, []]);
});

test("paginates the Domains listing ten rows at a time", async () => {
  for (let index = 1; index <= 12; index++) {
    const domain = `domain-${index}`;
    host.files.set(`${STATE}/backlogs/${domain}.json`, JSON.stringify(emptyBacklog(domain, null)));
  }
  const { ctx, render } = await mount();
  let root = render();
  expect([ids(root, "domain-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-domains"],
  ]);
  get(root, "load-more-domains").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "domain-").length, ids(root, "load-more-")]).toEqual([12, []]);
});

test("paginates the Done status group ten rows at a time", async () => {
  let backlog = emptyBacklog("alpha", null);
  for (let index = 1; index <= 12; index++) {
    backlog = add(backlog, `Work ${index}`);
    backlog = close(backlog, `i${index}`, false);
  }
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, render } = await mount();
  get(render(), "group-done-toggle").click!({}, ctx.cx);
  let root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-group-done"],
  ]);
  get(root, "load-more-group-done").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([12, []]);
});
