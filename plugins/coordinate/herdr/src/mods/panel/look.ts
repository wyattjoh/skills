// How the panel looks, as theme() color names and sizes. The metrics follow the Tasks Herdr
// panel's chrome, copied here so the two panels read as one family.
import type { Finding, ItemStatus } from "../../lib/store.ts";

/**
 * The panel's padding on every side.
 */
export const PANEL_PADDING = 12;

/**
 * The tool bar's padding above and below its controls.
 */
export const BAR_PADDING_Y = 6;

/**
 * A tool bar control's height.
 */
export const BAR_CONTROL_HEIGHT = 26;

/**
 * The domain crumb band's height.
 */
export const CRUMB_HEIGHT = 36;

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
 * A tool bar button: its padding, the gap between icon and label, radius and icon size, the
 * Tasks panel's button metrics.
 */
export const BUTTON = { paddingX: 8, gap: 5, radius: 6, iconSize: 14 } as const;

/**
 * The gap between a detail card's rows of text.
 */
export const DETAIL_LINE_GAP = 2;

/**
 * Vertical padding inside a detail card's rows, which wrap and so have no fixed height.
 */
export const DETAIL_ROW_PADDING_Y = 6;

/**
 * Herdr's shipped fold chevrons and the Back chevron the Tasks panel uses.
 */
export const ICONS = {
  back: "mods/workspace-chrome/chevron-left.svg",
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
