import { expect, test } from "bun:test";
import { FIRST_SYNC, dockSync } from "./model.ts";
import type { Dock, Scope, SyncMemory } from "./model.ts";

// The Backlog column, shown or hidden window-wide.
const column = (shown: boolean): Dock => ({ column: "backlog-column", shown });
const tab = (id: string): Scope => ({ space: "s1", tab: id });
const key = (id: string) => JSON.stringify(["s1", id]);
const settled = (id: string, shown: boolean): SyncMemory => ({
  scope: key(id),
  shown,
  pending: undefined,
});
const hide = { kind: "run", command: "layout.hide", args: { id: "backlog-column" } };
const show = { kind: "run", command: "layout.show", args: { id: "backlog-column" } };
// tab1 opened the panel; tab2 never did.
const opened = [tab("tab1")];
const NOW = 10_000;

test("switching from an open tab to a closed one hides the column on the switch's own sync", () => {
  expect(dockSync(column(true), opened, tab("tab2"), settled("tab1", true), NOW)).toEqual({
    effects: [hide],
    memory: { scope: key("tab2"), shown: false, pending: { want: false, until: NOW + 1_000 } },
  });
});

test("switching from a closed tab to an open one shows the column on the switch's own sync", () => {
  expect(dockSync(column(false), opened, tab("tab1"), settled("tab2", false), NOW)).toEqual({
    effects: [show],
    memory: { scope: key("tab1"), shown: true, pending: { want: true, until: NOW + 1_000 } },
  });
});

test("switching between two closed tabs leaves the hidden column alone", () => {
  expect(dockSync(column(false), opened, tab("tab3"), settled("tab2", false), NOW)).toEqual({
    effects: [],
    memory: settled("tab3", false),
  });
});

test("focus seen first: one hide on the switch, nothing while it lands, nothing once it has", () => {
  const switched = dockSync(column(true), opened, tab("tab2"), settled("tab1", true), NOW);
  expect(switched.effects).toEqual([hide]);
  // A render before the hide reaches layout() asks for nothing more and records nothing.
  const waiting = dockSync(column(true), opened, tab("tab2"), switched.memory, NOW + 100);
  expect(waiting).toEqual({ effects: [], memory: switched.memory });
  const landed = dockSync(column(false), opened, tab("tab2"), waiting.memory, NOW + 200);
  expect(landed).toEqual({ effects: [], memory: settled("tab2", false) });
  expect(dockSync(column(false), opened, tab("tab2"), landed.memory, NOW + 300)).toEqual({
    effects: [],
    memory: settled("tab2", false),
  });
});

test("layout seen first: a column already matching the new tab needs no command", () => {
  expect(dockSync(column(true), opened, tab("tab1"), settled("tab2", true), NOW)).toEqual({
    effects: [],
    memory: settled("tab1", true),
  });
  expect(dockSync(column(false), opened, tab("tab2"), settled("tab1", false), NOW)).toEqual({
    effects: [],
    memory: settled("tab2", false),
  });
});

test("moving away and back before a hide lands keeps the column for the open tab", () => {
  const away = dockSync(column(true), opened, tab("tab2"), settled("tab1", true), NOW);
  expect(away.effects).toEqual([hide]);
  // Back on tab1 with the column still shown: it matches, so nothing runs and nothing is recorded.
  expect(dockSync(column(true), opened, tab("tab1"), away.memory, NOW + 50)).toEqual({
    effects: [],
    memory: settled("tab1", true),
  });
});

test("the first sync adopts a column already shown, with no tab remembered, as this tab's", () => {
  expect(dockSync(column(true), [], tab("tab1"), FIRST_SYNC, NOW)).toEqual({
    effects: [{ kind: "shared", key: "coordinate-panel.dock", value: [tab("tab1")] }],
    memory: settled("tab1", true),
  });
});

test("without a dock or a focused tab there is nothing to sync", () => {
  expect(dockSync(undefined, opened, tab("tab1"), FIRST_SYNC, NOW)).toEqual({
    effects: [],
    memory: FIRST_SYNC,
  });
  expect(dockSync(column(true), opened, undefined, FIRST_SYNC, NOW)).toEqual({
    effects: [],
    memory: FIRST_SYNC,
  });
});
