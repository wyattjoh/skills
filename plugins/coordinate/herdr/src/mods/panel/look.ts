// Coordinate-specific status, glyph and layout data. Shared geometry and rendered look come
// from @wyattjoh/herdr-ui.
import { bundledIconPaths } from "@wyattjoh/herdr-ui";
import type { Finding, ItemStatus } from "../../lib/store.ts";
import type { LiveStatus } from "./model.ts";

/**
 * An Unfiled delegates row's height.
 */
export const DELEGATE_ROW_HEIGHT = 28;

/**
 * Width of the leading column that numbers ask options.
 */
export const ASK_OPTION_NUMBER_WIDTH = 28;

/**
 * How far each nesting level indents an Unfiled delegates row under its parent delegate.
 */
export const DELEGATE_INDENT = 14;

/**
 * Each status group's header tone, as a theme() color name. Herdr's own `done` is blue in its
 * default theme, so Done takes the terminal palette's green instead.
 */
export const STATUS_TONES: Readonly<Record<ItemStatus, string>> = {
  "waiting-user": "blocked",
  building: "working",
  delegated: "ansi4",
  "in-review": "ansi5",
  open: "dim",
  parked: "muted",
  done: "ansi2",
  dismissed: "ansi1",
};

/**
 * The Queued group's header tone: the terminal palette's cyan, which no item status uses.
 */
export const QUEUED_TONE = "ansi6";

/**
 * A Findings page row's title wraps to at most this many lines. gpui-kit has no line clamp, so the
 * title's height is capped at that many line heights and clips its overflow.
 */
export const FINDING_TITLE_MAX_LINES = 2;

/**
 * The line height, in px, of a Findings page row's glyph, id and title, so the glyph and id sit on
 * the title's first line.
 */
export const FINDING_LINE_HEIGHT = 18;

/**
 * Each finding kind's domain glyph and its tone. herdr-ui has no generic issue/opportunity mark.
 */
export const FINDING_GLYPHS: Readonly<Record<Finding["kind"], { glyph: string; tone: string }>> = {
  issue: { glyph: "▲", tone: "ansi1" },
  opportunity: { glyph: "✦", tone: "ansi5" },
};

/**
 * Each finding status's tone on its detail screen, matching the item statuses they mirror.
 */
export const FINDING_STATUS_TONES: Readonly<Record<Finding["status"], string>> = {
  open: "dim",
  acted: "ansi2",
  dismissed: "ansi1",
};

/**
 * A promoted finding's status tone, the delegated tone: its work moved on into an open item.
 */
export const PROMOTED_TONE = "ansi4";

/**
 * Each listing count's tone, used only while the count is nonzero so a domain that needs nothing
 * reads quiet.
 */
export const COUNT_TONES = {
  agents: "ansi4",
  waiting: "blocked",
  delegated: "ansi4",
  open: "foreground",
} as const;

/**
 * Each delegate state's tone as a theme() color name.
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
 * The Answer field's geometry, which has no generic form-field counterpart in herdr-ui.
 */
export const ANSWER = {
  height: 32,
  fieldPaddingX: 10,
  fieldPaddingTop: 4,
  buttonPaddingX: 14,
  radius: 8,
  gap: 8,
} as const;

/** Fixed spacing and selection geometry for the answer flow's Outline question card. */
export const ANSWER_FLOW_OUTLINE = {
  cardSurface: "surface",
  optionSurface: "surface",
  paddingX: 12,
  paddingY: 10,
  markerSize: 14,
  selectedBorderWidth: 2,
} as const;

/** The width of the answer flow's dropdown menus. */
export const ANSWER_FLOW_MENU_WIDTH = 216;

/**
 * The width of an item detail's Change status menu, which lists at most four statuses.
 */
export const STATUS_MENU_WIDTH = 160;

/**
 * The harness policy dialog Herdr opens over the window. A height is a maximum, so it covers the
 * tallest editor state: failure and reload rows above the action row.
 */
export const HARNESS_DIALOG = {
  width: 880,
  height: 620,
} as const;

/**
 * Herdr's own settings icon, as an `svg()` path into its shipped workspace-chrome mod. It is never
 * copied, like the icons herdr-ui lists; herdr-ui has no entry for it.
 */
export const HERDR_SETTINGS_ICON = "mods/workspace-chrome/settings.svg";

/**
 * herdr-ui's bundled globe, copied into this mod's folder: the policy dialog's Global scope, and
 * the stand-in for the All domains crumb.
 */
export const GLOBE_ICON = bundledIconPaths("coordinate-panel").globe;

/**
 * The answer queue's approximated vertical-carousel geometry and motion.
 */
export const ANSWER_CAROUSEL = {
  compactMinHeight: 72,
  compactWidthRatio: 0.9,
  neighborOpacity: 0.58,
  distanceOpacityFalloff: 0.12,
  expandedContentFadeOutRatio: 0.3,
  compactContentFadeInStartRatio: 0.25,
  compactContentFadeInRatio: 0.45,
  compactContentFadeOutRatio: 0.8,
  expandedContentFadeInStartRatio: 0.7,
  expandedContentFadeInRatio: 0.3,
  disabledOpacity: 0.35,
  previewGap: 4,
  gap: 10,
  transitionDuration: 600,
  slowMotionFactor: 5,
  easing: "ease-in-out",
} as const;

/**
 * Named animation speeds in the dropdown's display order.
 */
export const ANSWER_FLOW_SPEED_OPTIONS = [
  { id: "normal", name: "Normal", durationFactor: 1 },
  { id: "slow-1", name: "Slow 1", durationFactor: 1.25 },
  { id: "slow-2", name: "Slow 2", durationFactor: 1.5 },
  { id: "slow-3", name: "Slow 3", durationFactor: 2 },
  { id: "slow-4", name: "Slow 4", durationFactor: 3 },
  { id: "slow-5", name: "Slow 5", durationFactor: ANSWER_CAROUSEL.slowMotionFactor },
  { id: "fast-1", name: "Fast 1", durationFactor: 1 / 1.25 },
  { id: "fast-2", name: "Fast 2", durationFactor: 1 / 1.5 },
  { id: "fast-3", name: "Fast 3", durationFactor: 1 / 2 },
  { id: "fast-4", name: "Fast 4", durationFactor: 1 / 3 },
  { id: "fast-5", name: "Fast 5", durationFactor: 1 / ANSWER_CAROUSEL.slowMotionFactor },
] as const;
