// What the Backlog toggle reads from the layout and shared values, and the commands and shared
// writes that open or close the docked panel for the focused tab. No gpui-kit or herdr import.
import { isRecord } from "../../lib/store.ts";

/**
 * The panel mod the toggle opens and closes.
 */
export const PANEL_MOD = "coordinate-panel";

/**
 * The key command keys.json sends as "coordinate-toggle.toggle".
 */
export const TOGGLE_COMMAND = "toggle";

/**
 * The shared key listing the tabs the docked panel is open in.
 */
export const DOCK_SETTING = "coordinate-panel.dock";

// At most this many tabs are remembered; the oldest falls off first.
const SCOPE_LIMIT = 64;

/**
 * A tab, by its space and tab ids.
 */
export type Scope = { space: string; tab: string };

/**
 * The layout column the panel is docked in, and whether it is shown now.
 */
export type Dock = { column: string; shown: boolean };

/**
 * One thing the toggle does: run a Herdr command or set a shared value.
 */
export type ToggleAction =
  | { kind: "run"; command: string; args: Record<string, unknown> }
  | { kind: "shared"; key: string; value: Scope[] };

type Node = Record<string, unknown>;

const named = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const childrenOf = (node: Node): Node[] =>
  Array.isArray(node.children) ? node.children.filter(isRecord) : [];

/**
 * The column holding the panel's docked block. A panel docked in no column, docked in more than
 * one, or only floating has no dock the toggle can open.
 * @param tree The shown layout (layout()), checked rather than trusted.
 * @returns The dock, or undefined.
 */
export const panelDock = (tree: unknown): Dock | undefined => {
  const found: (Dock | undefined)[] = [];
  const visit = (node: Node, column: Dock | undefined) => {
    const content = node.content;
    if (isRecord(content) && content.mod === PANEL_MOD) found.push(column);
    const id = named(node.id);
    const own =
      node.type === "column" && id !== undefined
        ? { column: id, shown: (column?.shown ?? true) && node.hidden !== true }
        : column;
    for (const child of childrenOf(node)) visit(child, own);
  };
  if (isRecord(tree)) visit(tree, undefined);
  const [first] = found;
  if (first === undefined || found.some((dock) => dock?.column !== first.column)) return undefined;
  return first;
};

/**
 * The tab of the current window context.
 * @param focused focused(), checked rather than trusted.
 * @returns The tab, or undefined.
 */
export const scopeOf = (focused: unknown): Scope | undefined => {
  if (!isRecord(focused)) return undefined;
  const space = named(focused.space);
  const tab = named(focused.tab);
  return space === undefined || tab === undefined ? undefined : { space, tab };
};

/**
 * The tabs a shared value lists, dropping anything malformed.
 * @param value shared(DOCK_SETTING).
 * @returns The tabs.
 */
export const readScopes = (value: unknown): Scope[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const scope = scopeOf(entry);
        return scope === undefined ? [] : [scope];
      })
    : [];

const same = (a: Scope, b: Scope) => a.space === b.space && a.tab === b.tab;

/**
 * Whether the shared value lists this tab as open.
 * @param value shared(DOCK_SETTING).
 * @param scope The tab.
 * @returns True when the panel is open there.
 */
export const openIn = (value: unknown, scope: Scope): boolean =>
  readScopes(value).some((entry) => same(entry, scope));

const mark = (value: unknown, scope: Scope, open: boolean): ToggleAction[] => {
  if (openIn(value, scope) === open) return [];
  const others = readScopes(value).filter((entry) => !same(entry, scope));
  const next = open ? [...others, scope].slice(-SCOPE_LIMIT) : others;
  return [{ kind: "shared", key: DOCK_SETTING, value: next }];
};

const showOrHide = (dock: Dock, show: boolean): ToggleAction => ({
  kind: "run",
  command: show ? "layout.show" : "layout.hide",
  args: { id: dock.column },
});

/**
 * What the toggle remembers between syncs: the tab it last saw, whether the panel was shown
 * there, and a show or hide it asked for that the layout has not reflected yet.
 */
export type SyncMemory = {
  scope: string | undefined;
  shown: boolean;
  pending: { want: boolean; until: number } | undefined;
};

/**
 * Memory before the first sync.
 */
export const FIRST_SYNC: SyncMemory = { scope: undefined, shown: false, pending: undefined };

// How long a requested show or hide may take to reach layout() before the toggle reads the
// column's state as the person's own choice.
const RESTORE_MS = 1_000;

/**
 * Keep the docked panel per tab. A layout column is window-wide, so on moving to another tab the
 * toggle shows or hides the column to match that tab's remembered state; a show or hide made on
 * the same tab some other way (a layout.toggle key) is remembered as that tab's state.
 * @param dock The panel's dock, if any.
 * @param value shared(DOCK_SETTING).
 * @param scope The focused tab, if any.
 * @param memory What the previous sync saw.
 * @param now The current time in ms.
 * @returns The effects to apply and the memory for the next sync.
 */
export const dockSync = (
  dock: Dock | undefined,
  value: unknown,
  scope: Scope | undefined,
  memory: SyncMemory,
  now: number,
): { effects: ToggleAction[]; memory: SyncMemory } => {
  if (dock === undefined || scope === undefined) return { effects: [], memory };
  const key = JSON.stringify([scope.space, scope.tab]);
  const settled = (shown: boolean): SyncMemory => ({ scope: key, shown, pending: undefined });
  if (memory.scope !== key) {
    // The first sync ever adopts a panel already shown as open on this tab.
    if (memory.scope === undefined && dock.shown && readScopes(value).length === 0)
      return { effects: mark(value, scope, true), memory: settled(true) };
    const open = openIn(value, scope);
    if (open === dock.shown) return { effects: [], memory: settled(open) };
    return {
      effects: [showOrHide(dock, open)],
      memory: { scope: key, shown: open, pending: { want: open, until: now + RESTORE_MS } },
    };
  }
  let last = memory;
  if (last.pending !== undefined) {
    if (dock.shown !== last.pending.want && now < last.pending.until)
      return { effects: [], memory };
    last = settled(last.pending.want);
  }
  if (dock.shown === last.shown) return { effects: [], memory: last };
  return { effects: mark(value, scope, dock.shown), memory: settled(dock.shown) };
};

/**
 * What one press of the pill or cmd-alt-b does: close the panel when its column is shown,
 * otherwise show it, and record the tab's new state.
 * @param dock The panel's dock, if any.
 * @param value shared(DOCK_SETTING).
 * @param scope The focused tab, if any.
 * @returns The effects, none when there is no dock or tab.
 */
export const toggleEffects = (
  dock: Dock | undefined,
  value: unknown,
  scope: Scope | undefined,
): ToggleAction[] => {
  if (dock === undefined || scope === undefined) return [];
  const open = !dock.shown;
  return [showOrHide(dock, open), ...mark(value, scope, open)];
};
