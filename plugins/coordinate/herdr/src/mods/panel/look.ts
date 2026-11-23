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

/** Fixed spacing and selection geometry for the initial Outline answer-flow layout. */
export const ANSWER_FLOW_OUTLINE = {
  cardSurface: "surface",
  optionSurface: "surface",
  paddingX: 12,
  paddingY: 10,
  markerSize: 14,
  selectedBorderWidth: 2,
} as const;

/** The starting layout, kept separate from the ten selectable proposals. */
export const ANSWER_FLOW_LAYOUT_BASELINE = {
  id: "outline",
  name: "Outline",
  prompt: "block",
  choices: "outline",
  rationale: "inline",
} as const;

/** Ten new answer-flow arrangements, composed by the shared prompt and choice renderer. */
export const ANSWER_FLOW_LAYOUT_PROPOSALS = [
  {
    id: "quiet-lines",
    name: "Quiet Lines",
    description: "Plain prompt with ruled choices and an inline recommendation.",
    prompt: "plain",
    choices: "dividers",
    rationale: "inline",
  },
  {
    id: "soft-tiles",
    name: "Soft Tiles",
    description: "Stacked prompt with responsive answer tiles.",
    prompt: "block",
    choices: "tiles",
    rationale: "inline",
  },
  {
    id: "split-prompt",
    name: "Split Prompt",
    description: "Question and context split when wide, stacked when narrow.",
    prompt: "split",
    choices: "rows",
    rationale: "shelf",
  },
  {
    id: "shared-set",
    name: "Shared Set",
    description: "Choices share one surface with dividers.",
    prompt: "plain",
    choices: "grouped",
    rationale: "inline",
  },
  {
    id: "two-up",
    name: "Two-Up",
    description: "Two-column choices when wide, one column when narrow.",
    prompt: "caption",
    choices: "grid",
    rationale: "shelf",
  },
  {
    id: "context-first",
    name: "Context First",
    description: "Context leads the question, followed by compact choices.",
    prompt: "context-first",
    choices: "compact",
    rationale: "inline",
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "Question band above softly separated answer rows.",
    prompt: "band",
    choices: "spaced",
    rationale: "shelf",
  },
  {
    id: "side-notes",
    name: "Side Notes",
    description: "Option details sit beside choices at wide widths.",
    prompt: "plain",
    choices: "side-details",
    rationale: "inline",
  },
  {
    id: "rationale-shelf",
    name: "Rationale Shelf",
    description: "A shared choice set followed by a rationale surface.",
    prompt: "compact",
    choices: "grouped",
    rationale: "shelf",
  },
  {
    id: "why-on-demand",
    name: "Why on Demand",
    description: "Recommendation rationale opens in a compact popover.",
    prompt: "block",
    choices: "quiet",
    rationale: "popover",
  },
] as const;

export type AnswerFlowLayoutProposal = (typeof ANSWER_FLOW_LAYOUT_PROPOSALS)[number];
export type AnswerFlowLayout = typeof ANSWER_FLOW_LAYOUT_BASELINE | AnswerFlowLayoutProposal;
export type AnswerFlowLayoutId = AnswerFlowLayout["id"];

export const answerFlowLayoutFor = (id: AnswerFlowLayoutId): AnswerFlowLayout =>
  id === ANSWER_FLOW_LAYOUT_BASELINE.id
    ? ANSWER_FLOW_LAYOUT_BASELINE
    : (ANSWER_FLOW_LAYOUT_PROPOSALS.find((layout) => layout.id === id) ??
      ANSWER_FLOW_LAYOUT_BASELINE);

/** Geometry shared by the answer-flow layout picker and responsive choice arrangements. */
export const ANSWER_FLOW_LAYOUT_GEOMETRY = {
  menuWidth: 216,
  choiceGap: 8,
  tileMinWidth: 144,
  gridMinWidth: 188,
  splitPromptMinWidth: 440,
  sideDetailsMinWidth: 460,
  rationaleWidth: 280,
} as const;

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
