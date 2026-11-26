import { Effect } from "effect";
import { L } from "./fleet.ts";
import * as hc from "./herdr.ts";

/** The longest focus a tab title keeps before it is cut at a word. */
export const TAB_FOCUS_LIMIT = 40;

const plain = (markdown: string): string =>
  markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Cut a focus line to a tab's length, at a word when one ends close enough.
 * @param focus Focus text.
 * @returns At most `TAB_FOCUS_LIMIT` characters plus an ellipsis.
 */
export const shortFocus = (focus: string): string => {
  const text = plain(focus);
  if (text.length <= TAB_FOCUS_LIMIT) return text;
  const cut = text.slice(0, TAB_FOCUS_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space >= TAB_FOCUS_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/u, "")}…`;
};

/**
 * A coordinator's tab title: `<Domain> · <short focus>`, or `<Domain> · No active focus`.
 * @param domain Domain.
 * @param focus Focus line (plain text or inline Markdown), or null.
 * @returns The title.
 */
export const coordinatorTabTitle = (domain: string, focus: string | null): string => {
  const short = focus === null ? "" : shortFocus(focus);
  return `${domain.charAt(0).toUpperCase()}${domain.slice(1)} · ${short === "" ? "No active focus" : short}`;
};

/**
 * Rename the domain's coordinator tab to match its focus: this terminal's tab when it is that
 * coordinator, otherwise the tab of the domain's coordinator this machine lists. Renames tabs only,
 * and a coordinator on another machine keeps its title.
 * @param domain Domain.
 * @param focus New focus, or null when cleared.
 * @param self This terminal's address, or null outside a Herdr terminal.
 * @returns The renamed tab and its title, or undefined when no tab was found or renamed.
 */
export const renameCoordinatorTab = Effect.fn("renameCoordinatorTab")(function* (
  domain: string,
  focus: string | null,
  self: string | null = process.env.HC_TERMINAL_ID ?? null,
) {
  const isCoordinator = (terminal: hc.Terminal | undefined) =>
    terminal?.live === true &&
    terminal.labels[L.role] === "coordinator" &&
    terminal.labels[L.domain] === domain;
  let terminal = self ? yield* hc.get(self) : undefined;
  if (!isCoordinator(terminal)) {
    const listed = yield* hc.list([`${L.role}=coordinator`, `${L.domain}=${domain}`]);
    const local = listed.find((entry) => entry.live && !entry.address.includes("/"));
    terminal = local === undefined ? undefined : yield* hc.get(local.address);
  }
  const tab = isCoordinator(terminal) ? terminal?.labels["herdr.tab"] : undefined;
  if (tab === undefined) return undefined;
  const title = coordinatorTabTitle(domain, focus);
  yield* hc.appDo("tab.rename", { id: tab, name: title });
  return { tab, title };
});
