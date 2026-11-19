import { beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  context,
  get,
  host,
  resetHost,
  sendCommand,
  settle,
  text,
} from "@wyattjoh/herdr-dev/test/renderer";

const { default: Toggle } = await import("./index.ts");

beforeEach(resetHost);

// A layout with the tab row's pill and a right column docking the Backlog panel.
const docked = (shown: boolean) => ({
  type: "row",
  children: [
    { type: "block", id: "toggle", content: { mod: "coordinate-toggle" } },
    {
      type: "column",
      id: "backlog-column",
      hidden: !shown,
      children: [{ type: "block", id: "backlog", content: { mod: "coordinate-panel" } }],
    },
  ],
});

const focusTab = (tab: string) => {
  host.focused = { space: "s1", tab, pane: "p1", terminal: "t1" };
};

const mount = async () => {
  const ctx = context();
  const view = new Toggle();
  view.init(undefined, ctx.cx as never);
  await settle();
  return { ctx, view, render: () => view.render(ctx.cx as never) as never };
};

test("clicking the pill with the panel hidden shows its column and remembers the tab", async () => {
  host.layout = docked(false);
  focusTab("tab1");
  const { ctx, render } = await mount();

  const pill = get(render(), "coordinate-toggle-button");
  expect(text(pill)).toBe("Backlog");
  pill.click!({}, ctx.cx);

  expect(host.runs).toEqual([{ command: "layout.show", args: { id: "backlog-column" } }]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab1" }]);
});

test("clicking the pill with the panel shown hides its column and forgets the tab", async () => {
  host.layout = docked(true);
  host.shared.set("coordinate-panel.dock", [
    { space: "s1", tab: "tab0" },
    { space: "s1", tab: "tab1" },
  ]);
  focusTab("tab1");
  const { ctx, render } = await mount();

  const pill = get(render(), "coordinate-toggle-button");
  expect(pill.styles.bg).toBe("#2563eb");
  pill.click!({}, ctx.cx);

  expect(host.runs).toEqual([{ command: "layout.hide", args: { id: "backlog-column" } }]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab0" }]);
});

test("the pill is dim and inert when the layout docks no Backlog panel", async () => {
  host.layout = {
    type: "row",
    children: [{ type: "block", content: { mod: "coordinate-toggle" } }],
  };
  focusTab("tab1");
  const { render } = await mount();

  const pill = get(render(), "coordinate-toggle-button");
  expect(pill.styles.text_color).toBe("#737373");
  expect(pill.click).toBe(undefined);
});

test("the panel follows each tab's own open state as focus moves between tabs, on the render the move causes", async () => {
  host.layout = docked(false);
  focusTab("tab1");
  const { ctx, render } = await mount();
  get(render(), "coordinate-toggle-button").click!({}, ctx.cx);
  host.layout = docked(true);
  host.runs = [];

  // tab2 never opened the panel, so moving there hides it.
  focusTab("tab2");
  render();
  expect(host.runs).toEqual([{ command: "layout.hide", args: { id: "backlog-column" } }]);
  host.layout = docked(false);

  // Back on tab1 it shows again.
  host.runs = [];
  focusTab("tab1");
  render();
  expect(host.runs).toEqual([{ command: "layout.show", args: { id: "backlog-column" } }]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab1" }]);
});

test("a switch away and back before its sync task runs leaves the open tab's column alone", async () => {
  host.layout = docked(true);
  host.shared.set("coordinate-panel.dock", [{ space: "s1", tab: "tab1" }]);
  focusTab("tab1");
  const { view, render } = await mount();
  render();

  // A context whose tasks wait, as Herdr's run after the render that spawned them.
  const queued: (() => unknown)[] = [];
  const deferred = { spawn: (body: (cx: unknown) => unknown) => queued.push(() => body(deferred)) };
  focusTab("tab2");
  view.render(deferred as never);
  focusTab("tab1");
  view.render(deferred as never);
  for (const body of queued) await body();

  expect(host.runs).toEqual([]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab1" }]);
});

test("cmd-alt-b in keys.json reaches the toggle's command loop and toggles like a click", async () => {
  const keys = (await Bun.file(new URL("../../../keys.json", import.meta.url)).json()) as {
    global: Record<string, string>;
  };
  expect(keys).toEqual({ global: { "cmd-alt-b": "coordinate-toggle.toggle" } });

  host.layout = docked(false);
  focusTab("tab1");
  await mount();
  sendCommand(keys.global["cmd-alt-b"]!.slice("coordinate-toggle.".length));
  await settle();

  expect(host.runs).toEqual([{ command: "layout.show", args: { id: "backlog-column" } }]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab1" }]);
  // The loop waits for the next command.
  expect(host.commandReaders.length).toBe(1);
});

test("an unknown command does nothing", async () => {
  host.layout = docked(false);
  focusTab("tab1");
  await mount();
  sendCommand("focus");
  await settle();

  expect(host.runs).toEqual([]);
  expect(host.commandReaders.length).toBe(1);
});

test("under herdr-app check it starts no command loop or timer", async () => {
  host.checking = true;
  host.layout = docked(false);
  const { ctx } = await mount();

  expect(host.commandReaders.length).toBe(0);
  expect(ctx.timers.length).toBe(0);
});

test("under herdr-app check a render shows, hides and records nothing", async () => {
  host.checking = true;
  host.layout = docked(true);
  focusTab("tab1");
  const { render } = await mount();
  render();

  expect(host.runs).toEqual([]);
  expect(host.shared.get("coordinate-panel.dock")).toBe(undefined);
});

test("the toggle starts no timer, so only renders match the column to the tab", async () => {
  host.layout = docked(false);
  focusTab("tab1");
  const { ctx } = await mount();

  expect(ctx.timers.length).toBe(0);
});

test("the first sync adopts a panel already shown, with no tab remembered, as open on this tab", async () => {
  host.layout = docked(true);
  focusTab("tab1");
  const { render } = await mount();
  render();

  expect(host.runs).toEqual([]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab1" }]);
});

test("hiding the column some other way on the same tab is remembered for that tab", async () => {
  host.layout = docked(true);
  host.shared.set("coordinate-panel.dock", [{ space: "s1", tab: "tab1" }]);
  focusTab("tab1");
  const { render } = await mount();
  render();

  host.layout = docked(false);
  render();

  expect(host.runs).toEqual([]);
  expect(host.shared.get("coordinate-panel.dock")).toEqual([]);
});

test("a hide the layout has not applied yet is not read as the person reopening the panel", async () => {
  setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
  try {
    host.layout = docked(true);
    host.shared.set("coordinate-panel.dock", [{ space: "s1", tab: "tab1" }]);
    focusTab("tab1");
    const { render } = await mount();
    render();
    focusTab("tab2");
    render();
    expect(host.runs).toEqual([{ command: "layout.hide", args: { id: "backlog-column" } }]);

    // Still shown half a second later: the hide is in flight, so tab2 stays closed.
    setSystemTime(new Date("2026-11-17T12:00:00.500Z"));
    render();
    expect(host.shared.get("coordinate-panel.dock")).toEqual([{ space: "s1", tab: "tab1" }]);

    // Still shown after the window: now it counts as the person's choice for tab2.
    setSystemTime(new Date("2026-11-17T12:00:01.500Z"));
    render();
    expect(host.shared.get("coordinate-panel.dock")).toEqual([
      { space: "s1", tab: "tab1" },
      { space: "s1", tab: "tab2" },
    ]);
  } finally {
    setSystemTime();
  }
});
