// How the panel looks, as theme() color names and sizes. The metrics follow the Tasks Herdr
// panel's chrome, copied here so the two panels read as one family; the tool bar's control
// metrics, which the Backlog pill shares, are src/lib/look.ts's CONTROL.
import type { Finding, ItemStatus } from "../../lib/store.ts";
import type { LiveStatus } from "./model.ts";

/**
 * The panel's padding on every side.
 */
export const PANEL_PADDING = 12;

/**
 * The tool bar's padding above and below its controls.
 */
export const BAR_PADDING_Y = 6;

/**
 * A card's radius.
 */
export const CARD_RADIUS = 8;

/**
 * The radius inside a card's 1px outline, which its first and last bands round to.
 */
export const INNER_RADIUS = CARD_RADIUS - 1;

/**
 * The gap between cards.
 */
export const CARD_GAP = 10;

/**
 * The gap between a card's title and its body.
 */
export const CARD_SECTION_GAP = 2;

/**
 * A card title's height.
 */
export const CARD_HEADER_HEIGHT = 24;

/**
 * Horizontal padding inside cards, their titles and their rows.
 */
export const CARD_PADDING_X = 10;

/**
 * A status group's header band height.
 */
export const GROUP_HEADER_HEIGHT = 28;

/**
 * An item row's height. Rows are fixed so a group's open height is known without measuring,
 * which the fold animates to and from.
 */
export const ITEM_ROW_HEIGHT = 32;

/**
 * An all-domains listing row's height, the Tasks panel's listing row.
 */
export const LISTING_ROW_HEIGHT = 34;

/**
 * A group folds in 200ms.
 */
export const FOLD_MOTION = { duration: 200, easing: "ease-out" } as const;

/**
 * Text size of rows, the focus line and message titles.
 */
export const TEXT_BODY = 13;

/**
 * Text size of labels, crumbs, group headers, counts and empties.
 */
export const TEXT_SMALL = 12;

/**
 * The gap between a detail card's rows of text.
 */
export const DETAIL_LINE_GAP = 2;

/**
 * Vertical padding inside a detail card's rows, which wrap and so have no fixed height.
 */
export const DETAIL_ROW_PADDING_Y = 6;

/**
 * Herdr's shipped fold chevrons.
 */
export const ICONS = {
  groupOpen: "mods/files/chevron-down.svg",
  groupClosed: "mods/files/chevron-right.svg",
} as const;

/**
 * Each status group's header tone, as a theme() color name. Herdr's own `done` is blue in its
 * default theme, so Done takes the terminal palette's green instead.
 */
export const STATUS_TONES: Readonly<Record<ItemStatus, string>> = {
  "waiting-user": "blocked",
  building: "working",
  delegated: "ansi4",
  open: "dim",
  parked: "muted",
  done: "ansi2",
  dismissed: "ansi1",
};

/**
 * Each finding kind's glyph and its tone, as a theme() color name.
 */
export const FINDING_GLYPHS: Readonly<Record<Finding["kind"], { glyph: string; tone: string }>> = {
  issue: { glyph: "▲", tone: "ansi1" },
  opportunity: { glyph: "✦", tone: "ansi5" },
};

/**
 * Each finding status's tone on its detail screen, as a theme() color name, matching the item
 * statuses they mirror: open as Open, acted on as Done, dismissed as Dismissed.
 */
export const FINDING_STATUS_TONES: Readonly<Record<Finding["status"], string>> = {
  open: "dim",
  acted: "ansi2",
  dismissed: "ansi1",
};

/**
 * Each listing count's tone, as a theme() color name, used only while the count is nonzero so
 * a domain that needs nothing reads quiet.
 */
export const COUNT_TONES = {
  waiting: "blocked",
  delegated: "ansi4",
  open: "foreground",
  findings: "foreground",
} as const;

/**
 * A delegated item's row height: the title, then the line naming its delegate and state.
 */
export const DELEGATED_ROW_HEIGHT = 48;

/**
 * An Unfiled delegates row's height.
 */
export const DELEGATE_ROW_HEIGHT = 28;

/**
 * How far each nesting level indents an Unfiled delegates row under its parent delegate.
 */
export const DELEGATE_INDENT = 14;

/**
 * Each delegate state's tone, as a theme() color name: Herdr's own agent tokens for live
 * statuses (it has no error token, so error takes the palette's red), a quiet dim for a
 * delegate that ended, and a warning yellow for one that is gone with no record.
 */
export const DELEGATE_TONES: Readonly<Record<LiveStatus | "ended" | "gone", string>> = {
  working: "working",
  idle: "idle",
  blocked: "blocked",
  done: "done",
  error: "ansi1",
  unknown: "unknown",
  ended: "dim",
  gone: "ansi3",
};

/**
 * The answer row under an ask: the shipped Changes panel's commit row, a text field beside a
 * solid button, at the same height, padding and radius.
 */
export const ANSWER = {
  height: 32,
  fieldPaddingX: 10,
  buttonPaddingX: 14,
  radius: 8,
  gap: 8,
} as const;
