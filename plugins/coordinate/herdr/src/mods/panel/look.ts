// Coordinate-specific status, glyph and layout data. Shared geometry and rendered look come
// from @wyattjoh/herdr-ui.
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
  open: "dim",
  parked: "muted",
  done: "ansi2",
  dismissed: "ansi1",
};

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
  buttonPaddingX: 14,
  radius: 8,
  gap: 8,
} as const;
