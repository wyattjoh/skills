// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div, svg } from "gpui-kit";
import type { Color, Context, Element, FocusHandle } from "gpui-kit";
import { Input, InputState, Popover, h_flex, v_flex } from "gpui-base";
import { answerInputElement } from "./textarea.ts";
import type { AnswerInputState } from "./textarea.ts";
import {
  BUTTON_STYLE,
  CARD,
  HERDR_ICONS,
  MENU,
  PANEL,
  ROW,
  TEXT,
  menuPanel,
  menuRow,
  button,
  bundledIconPaths,
  card,
  cardHeader,
  cardItem,
  cardNote,
  cardSection,
  crumb,
  crumbBand,
  emptyState,
  errorState,
  groupBlock,
  labelChip,
  listRow,
  loadingState,
  paneScrollRegion,
  panelBody,
  panelFrame,
  role,
  rowNote,
  staticRow,
  titleRow,
  togglePill,
  letThrough,
} from "@wyattjoh/herdr-ui";
import type { ButtonStyle, Theme } from "@wyattjoh/herdr-ui";
import { isDiscussion } from "../../lib/store.ts";
import type { AnsweredAsk, Ask, Backlog, Finding, Item } from "../../lib/store.ts";
import {
  ANSWER,
  ANSWER_CAROUSEL,
  ANSWER_FLOW_SPEED_OPTIONS,
  ANSWER_FLOW_LAYOUT_BASELINE,
  ANSWER_FLOW_LAYOUT_GEOMETRY,
  ANSWER_FLOW_LAYOUT_PROPOSALS,
  ANSWER_FLOW_OUTLINE,
  ASK_OPTION_NUMBER_WIDTH,
  COUNT_TONES,
  DELEGATE_INDENT,
  DELEGATE_ROW_HEIGHT,
  DELEGATE_TONES,
  FINDING_GLYPHS,
  FINDING_STATUS_TONES,
  STATUS_TONES,
} from "./look.ts";
import type { AnswerFlowLayout, AnswerFlowLayoutId } from "./look.ts";
import {
  FINDING_KIND_LABELS,
  FINDING_STATUS_LABELS,
  GROUP_LABELS,
  sameHarnessSelection,
  chosenAnswer,
  delegateLabel,
  delegateLine,
  formatFindingCounts,
  groupFindings,
  rankedOptions,
} from "./model.ts";
import type {
  AnswerDraft,
  Crumb,
  DelegateHarness,
  DelegateJoin,
  DomainPage,
  DelegateRow,
  DelegateState,
  DocumentState,
  DomainSummary,
  HarnessPolicyDraft,
  HarnessPolicyState,
  HarnessSelection,
  ItemGroup,
  ListingState,
  Screen,
} from "./model.ts";
import { layoutAnswerFlowCards } from "./answer-flow.ts";

export type { Theme } from "@wyattjoh/herdr-ui";

const WAITING_PULSE_PERIOD = 1_100;
const WAITING_PULSE_FROM = 0.4;
const WAITING_PULSE_TO = 1;
// Herdr-ui's house glyph is pending, so keep the globe stand-in behind this one-line switch.
const HOME_CRUMB_ICON = bundledIconPaths("coordinate-panel").globe;
const HOME_CRUMB_LABEL = "All domains";

/**
 * What the panel draws: the followed domain, its document, and which groups are open.
 */
export type PanelModel = {
  domain: string | undefined;
  doc: DocumentState;
  listing: ListingState;
  // The breadcrumb trail to the screen shown, and what opens a crumb's screen.
  trail: Crumb[];
  go: (screen: Screen, cx: Context) => void;
  groups: ItemGroup[];
  // The active list page, or undefined while the domain's main list is shown.
  page: DomainPage["kind"] | undefined;
  // The open findings.
  findings: Finding[];
  // The finding whose detail screen is on top of the lists, if any, and the item it came from
  // when the document still has it.
  finding: Finding | undefined;
  origin: Item | undefined;
  openFinding: (finding: Finding, cx: Context) => void;
  // Each item's delegates joined to the live terminals, and the domain's unfiled delegates.
  delegates: DelegateJoin;
  isOpen: (group: ItemGroup) => boolean;
  toggle: (group: ItemGroup, cx: Context) => void;
  // Rows shown by each list and the control that reveals its next page.
  visibleRows: (group: string, total: number) => number;
  loadMore: (group: string, cx: Context) => void;
  // The item whose detail screen is on top of the list, if any.
  detail: Item | undefined;
  open: (item: Item, cx: Context) => void;
  // The answer being written on the open item's ask, when it has one.
  answer: AnswerModel | undefined;
  flow: AnswerFlowModel | undefined;
  openWaiting: (item: Item, cx: Context) => void;
  // Boundary paths can be edited on either card.
  boundary: BoundaryModel;
  harnessPolicy: HarnessPolicyEditorModel;
  openDomain: (domain: string, cx: Context) => void;
};

/**
 * The answer row's state and what its controls do: pick an option, type, and record it.
 */
export type AnswerModel = {
  draft: AnswerDraft;
  // The text field's retained state, absent until the View's init made it.
  input: AnswerInputState | undefined;
  typing: boolean;
  noteInput: AnswerInputState | undefined;
  noteTyping: boolean;
  choose: (option: string, cx: Context) => void;
  discuss: (cx: Context) => void;
  submit: (cx: Context) => void;
};

/** Every question card and the terminal summary mounted by the carousel. */
export type AnswerFlowCardModel = {
  id: string;
  item: Item | undefined;
  kind: "question" | "summary";
  compactHeight: number | undefined;
  expandedHeight: number | undefined;
};

/** The single native transition target and its matching completion-timer duration. */
export type AnswerFlowMotion = {
  targetIndex: number | undefined;
  duration: number;
  exiting: boolean;
};

export type AnswerFlowModel = {
  domain: string;
  cards: AnswerFlowCardModel[];
  currentIndex: number;
  viewport: { width: number; height: number } | undefined;
  ready: boolean;
  motion: AnswerFlowMotion | undefined;
  speedIndex: number;
  speedMenuOpen: boolean;
  speedActiveIndex: number;
  speedTriggerFocus: FocusHandle;
  speedMenuFocus: FocusHandle;
  setSpeedMenuOpen: (open: boolean, cx: Context) => void;
  moveSpeedMenu: (delta: number, cx: Context) => void;
  setSpeedActiveIndex: (index: number, cx: Context) => void;
  setSpeed: (index: number, cx: Context) => void;
  layout: AnswerFlowLayout;
  layoutSelection: AnswerFlowLayout;
  layoutPending: boolean;
  layoutMenuOpen: boolean;
  layoutActiveIndex: number;
  layoutTriggerFocus: FocusHandle;
  layoutMenuFocus: FocusHandle;
  layoutMeasurement: AnswerFlowLayout | undefined;
  layoutMeasurementVersion: number;
  rationaleOpenFor: string | undefined;
  measureViewport: (size: { width: number; height: number }, cx: Context) => void;
  measure: (
    id: string,
    kind: "compact" | "expanded",
    size: { width: number; height: number },
    cx: Context,
  ) => void;
  measureLayout: (
    layoutId: AnswerFlowLayoutId,
    version: number,
    id: string,
    size: { width: number; height: number },
    cx: Context,
  ) => void;
  setLayoutMenuOpen: (open: boolean, cx: Context) => void;
  moveLayoutMenu: (delta: number, cx: Context) => void;
  setLayoutActiveIndex: (index: number, cx: Context) => void;
  activateLayoutMenu: (cx: Context) => void;
  selectLayout: (id: AnswerFlowLayoutId, cx: Context) => void;
  resetLayout: (cx: Context) => void;
  setRationaleOpen: (id: string, open: boolean, cx: Context) => void;
  rationaleFocusFor: (id: string) => FocusHandle | undefined;
  position: number;
  total: number;
  done: boolean;
  answeredCount: number;
  skippedCount: number;
  answer: AnswerModel | undefined;
  answerFor: (id: string) => AnswerModel | undefined;
  back: (cx: Context) => void;
  skip: (cx: Context) => void;
};

export type BoundaryList = "owned" | "adjacent";

export type BoundaryModel = {
  domain: string;
  editing: BoundaryList | undefined;
  input: InputState | undefined;
  busy: boolean;
  hovered: string | undefined;
  error:
    | { domain: string; list: BoundaryList; path: string | undefined; message: string }
    | undefined;
  begin: (list: BoundaryList, cx: Context) => void;
  cancel: (cx: Context) => void;
  remove: (list: BoundaryList, path: string, cx: Context) => void;
  hover: (list: BoundaryList, path: string, hovered: boolean, cx: Context) => void;
};

export type HarnessPolicyEditorModel = {
  scope: "global" | "domain";
  domain: string | undefined;
  state: HarnessPolicyState;
  draft: HarnessPolicyDraft | undefined;
  busy: boolean;
  failure: string | undefined;
  conflict: boolean;
  beginOverride: (cx: Context) => void;
  toggle: (harness: DelegateHarness, cx: Context) => void;
  setDefault: (harness: DelegateHarness | null, cx: Context) => void;
  save: (cx: Context) => void;
  reset: (cx: Context) => void;
  cancel: (cx: Context) => void;
  reload: (cx: Context) => void;
};

/**
 * A titled empty or error state: a medium title over a muted detail.
 * @param t The theme.
 * @param id The element id.
 * @param title What is wrong, briefly.
 * @param detail What to do about it.
 * @returns The element.
 */
export const message = (
  t: Theme,
  id: string,
  title: string,
  detail: string,
  kind: "empty" | "error" | "loading" = "empty",
): Element => {
  if (kind === "error") return errorState(t, { id, title, detail });
  if (kind === "loading") return loadingState(t, title, detail).id(id);
  return emptyState(t, { id, title, detail });
};

// Match Files' plain header row, keeping the domain in the same trailing text slot.
const toolbar = (t: Theme, domain: string | undefined): Element =>
  h_flex()
    .id("toolbar")
    .h(42)
    .flex_none()
    .px(14)
    .gap(8)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .child(div().font_semibold().child("Backlog"))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_right()
        .text_size(12)
        .text_color(t.dim)
        .child(domain ?? ""),
    );

// The breadcrumb band from @wyattjoh/herdr-ui: every crumb but the last opens its screen.
const trailBand = (t: Theme, trail: Crumb[], go: (screen: Screen, cx: Context) => void): Element =>
  crumbBand(
    t,
    trail.map(({ id, label, to, icon }) => {
      const isHome = icon === "home";
      const element = crumb(t, {
        id,
        label,
        icon: isHome ? svg(HOME_CRUMB_ICON).size(BUTTON_STYLE.iconSize).flex_none() : undefined,
        current: to === undefined,
        onClick: to === undefined ? undefined : (cx) => go(to, cx),
        tooltip: isHome ? HOME_CRUMB_LABEL : undefined,
      });
      return isHome ? element.accessibility_label(HOME_CRUMB_LABEL) : element;
    }),
  );

// A detail row gives the focus text the card's inner padding, like every other card row.
const focusHeader = (t: Theme, focus: string | null): Element =>
  detailRow(t, "focus")
    .border_t(0)
    .text_size(TEXT.body)
    .text_color(focus === null ? t.dim : t.foreground)
    .child(focus ?? "No focus set");

const focusCard = (t: Theme, focus: string | null): Element =>
  cardSection(
    cardHeader(t, "focus-header", "Focus"),
    card(t, "focus-card").child(focusHeader(t, focus)),
  );

const delegateTone = (t: Theme, state: DelegateState): Color =>
  role(t, DELEGATE_TONES[state.kind === "live" ? state.status : state.kind]);

// An Unfiled delegate is a static package row with its domain-specific nesting inset and state.
const delegateRow = (t: Theme, row: DelegateRow, indent: number, first: boolean): Element =>
  listRow(t, {
    id: row.source === "ref" ? `ref-${row.key}` : `term-${row.key}`,
    title: row.name,
    height: DELEGATE_ROW_HEIGHT,
    first,
    trailing: [
      div()
        .flex_none()
        .text_size(TEXT.label)
        .text_color(delegateTone(t, row.state))
        .child(delegateLabel(row.state)),
    ],
  }).pl(CARD.paddingX + indent * DELEGATE_INDENT);

const delegateChip = (
  t: Theme,
  item: Item,
  line: NonNullable<ReturnType<typeof delegateLine>>,
): Element => {
  const tone = delegateTone(t, line.state);
  return labelChip(t, {
    id: `delegates-${item.id}`,
    label: line.text,
    icon: HERDR_ICONS.square,
    color: tone,
  }).text_color(tone);
};

// The item id leads the title on the package row; a delegated item's state chip stays at the end.
const itemRow = (
  t: Theme,
  item: Item,
  rows: DelegateRow[],
  open: (item: Item, cx: Context) => void,
  mark: Element | undefined = undefined,
): Element => {
  const line = delegateLine(rows);
  const row = listRow(t, {
    id: `item-${item.id}`,
    label: item.id,
    title: item.title,
    titleRole: item.status === "dismissed" ? "dim" : "foreground",
    ...(mark === undefined ? {} : { mark }),
    height: ROW.compact,
    trailing: line === undefined ? [] : [delegateChip(t, item, line)],
    onClick: (cx) => open(item, cx),
  });
  return row;
};

const statusGroup = (
  t: Theme,
  motionScope: string,
  group: ItemGroup,
  open: boolean,
  first: boolean,
  last: boolean,
  toggle: (cx: Context) => void,
  openItem: (item: Item, cx: Context) => void,
  delegates: DelegateJoin,
  model: PanelModel,
): Element => {
  const id = `group-${group.status}`;
  return groupBlock(t, motionScope, {
    id,
    label: group.label,
    tone: STATUS_TONES[group.status],
    count: group.items.length,
    rows: pagedRows(t, id, group.items, model, ROW.compact, (item) =>
      itemRow(t, item, delegates.byItem.get(item.id) ?? [], openItem),
    ),
    rowHeight: ROW.compact,
    open,
    first,
    last,
    toggle,
  });
};

const waitingHeader = (t: Theme): Element => cardHeader(t, "waiting-header", "Waiting on you");

const waitingAccentMark = (t: Theme, id: string): Element =>
  div()
    .id(id)
    .w(3)
    .h(ROW.compact - 10)
    .flex_none()
    .rounded(2)
    .bg(t.accent)
    .opacity(WAITING_PULSE_FROM)
    .loop("opacity", {
      from: WAITING_PULSE_FROM,
      to: WAITING_PULSE_TO,
      period: WAITING_PULSE_PERIOD,
    });

const waitingItemRow = (t: Theme, item: Item, model: PanelModel): Element =>
  itemRow(
    t,
    item,
    model.delegates.byItem.get(item.id) ?? [],
    model.openWaiting,
    waitingAccentMark(t, `waiting-accent-${item.id}`),
  );

const waitingCard = (t: Theme, model: PanelModel): Element[] => {
  if (model.doc.kind !== "loaded") return [];
  const items = model.doc.backlog.items.filter((item) => item.ask !== null);
  if (items.length === 0) return [];
  return [
    cardSection(
      waitingHeader(t),
      card(t, "waiting").children(
        pagedRows(t, "waiting", items, model, ROW.compact, (item) =>
          waitingItemRow(t, item, model),
        ),
      ),
    ),
  ];
};

const itemsCard = (t: Theme, model: PanelModel): Element =>
  cardSection(
    cardHeader(t, "items-header", "Items"),
    card(t, "items").children(
      model.groups.length === 0
        ? [emptyRow(t, "items-empty", "No items")]
        : model.groups.map((group, index) =>
            statusGroup(
              t,
              model.domain ?? "domains",
              group,
              model.isOpen(group),
              index === 0,
              index === model.groups.length - 1,
              (cx) => model.toggle(group, cx),
              model.open,
              model.delegates,
              model,
            ),
          ),
    ),
  );

const emptyRow = (t: Theme, id: string, label: string): Element => cardNote(t, label).id(id);

const loadMoreRow = (t: Theme, groupId: string, model: PanelModel, rowHeight: number): Element =>
  staticRow(t, `pagination-row-${groupId}`)
    .h(rowHeight)
    .justify_center()
    .child(
      button(t, {
        id: `load-more-${groupId}`,
        label: "Load more",
        onClick: (cx) => model.loadMore(groupId, cx),
      }),
    );

const pagedRows = <T>(
  t: Theme,
  groupId: string,
  rows: readonly T[],
  model: PanelModel,
  rowHeight: number,
  renderRow: (row: T, index: number) => Element,
): Element[] => {
  const visible = model.visibleRows(groupId, rows.length);
  return [
    ...rows.slice(0, visible).map(renderRow),
    ...(visible < rows.length ? [loadMoreRow(t, groupId, model, rowHeight)] : []),
  ];
};

const findingRow = (
  t: Theme,
  finding: Finding,
  open: (finding: Finding, cx: Context) => void,
  first = false,
): Element =>
  listRow(t, {
    id: `finding-${finding.id}`,
    mark: div()
      .flex_none()
      .text_size(TEXT.label)
      .text_color(role(t, FINDING_GLYPHS[finding.kind].tone))
      .child(FINDING_GLYPHS[finding.kind].glyph),
    label: finding.id,
    title: finding.title,
    titleRole: finding.status === "dismissed" ? "dim" : "foreground",
    height: ROW.compact,
    first,
    onClick: (cx) => open(finding, cx),
  });

// Live domain terminals with no item name, shown with their domain-specific nesting.
const unfiledCard = (t: Theme, rows: DelegateRow[], model: PanelModel): Element[] =>
  rows.length === 0
    ? []
    : [
        cardSection(
          cardHeader(t, "unfiled-header", "Unfiled delegates"),
          card(t, "unfiled").children(
            pagedRows(t, "unfiled", rows, model, DELEGATE_ROW_HEIGHT, (row, index) =>
              delegateRow(t, row, row.depth, index === 0),
            ),
          ),
        ),
      ];

// Open findings in one card per non-empty kind, with each kind paged on its own.
const findingsPage = (t: Theme, model: PanelModel): Element => {
  const groups = groupFindings(model.findings);
  if (groups.length === 0)
    return v_flex()
      .id("findings-page")
      .child(emptyRow(t, "findings-empty", "No open findings"));
  return v_flex()
    .id("findings-page")
    .gap(PANEL.sectionGap)
    .children(
      groups.map((group) =>
        cardSection(
          cardHeader(t, `findings-${group.kind}-header`, group.label),
          card(t, `findings-${group.kind}`).children(
            pagedRows(
              t,
              `findings-${group.kind}`,
              group.findings,
              model,
              ROW.compact,
              (finding, index) => findingRow(t, finding, model.openFinding, index === 0),
            ),
          ),
        ),
      ),
    );
};

// A detail card item wraps naturally; herdr-ui owns its padding, gap and separator.
const detailRow = (t: Theme, id: string): Element =>
  cardItem(t, id).text_size(TEXT.body).text_color(t.foreground);

const detailCard = (t: Theme, id: string, name: string, rows: Element[]): Element =>
  cardSection(
    cardHeader(t, `${id}-header`, name),
    card(t, id).children(rows.map((row, index) => (index === 0 ? row.border_t(0) : row))),
  );

const small = (t: Theme, tone: Color, value: string): Element =>
  div().text_size(TEXT.label).text_color(tone).child(value);

// A labelled fact: a muted label, then its values, or None in dim.
const fact = (
  t: Theme,
  id: string,
  label: string,
  values: string[],
  row: (t: Theme, id: string) => Element = detailRow,
): Element =>
  row(t, id)
    .child(small(t, t.muted, label))
    .child(
      values.length === 0
        ? div().text_color(t.dim).child("None")
        : h_flex()
            .id(`${id}-values`)
            .w_full()
            .min_w_0()
            .flex_wrap()
            .gap(BUTTON_STYLE.gap)
            .children(
              values.map((value, index) =>
                div().id(`${id}-value-${index}`).flex_1().min_w_0().child(value),
              ),
            ),
    );

const ANSWER_BUTTON_STYLE: ButtonStyle = {
  ...BUTTON_STYLE,
  height: ANSWER.height,
  paddingX: ANSWER.buttonPaddingX,
  gap: 0,
  radius: ANSWER.radius,
  background: "solid",
  text: "solid_foreground",
  hover: "accent",
};

const HARNESS_LABELS: Readonly<Record<DelegateHarness, string>> = {
  pi: "Pi",
  claude: "Claude Code",
};

const harnessPolicyCard = (t: Theme, model: HarnessPolicyEditorModel): Element => {
  const id =
    model.scope === "global" ? "harness-policy-global" : `harness-policy-domain-${model.domain}`;
  const title = model.scope === "global" ? "Delegate harness defaults" : "Delegate harness policy";
  const rows: Element[] = [];
  if (model.state.kind === "loading") {
    rows.push(detailRow(t, `${id}-loading`).text_color(t.muted).child("Loading policy…"));
  } else if (model.state.kind === "error") {
    rows.push(
      detailRow(t, `${id}-error`).text_color(role(t, "ansi1")).child(model.state.message),
      detailRow(t, `${id}-reload`).child(
        button(t, {
          id: `${id}-reload-button`,
          label: "Reload policy",
          style: { ...ANSWER_BUTTON_STYLE, background: "raised" },
          onClick: model.busy ? undefined : (cx) => model.reload(cx),
        }),
      ),
    );
  } else {
    const view = model.state.view;
    const domainPolicy = view.domain;
    const original = model.scope === "global" ? view.global.policy : domainPolicy?.effective;
    const selection: HarnessSelection | undefined = model.draft?.selection ?? original;
    if (selection === undefined || (model.scope === "domain" && domainPolicy === null)) {
      rows.push(
        detailRow(t, `${id}-error`)
          .text_color(role(t, "ansi1"))
          .child("Coordinate returned policy data for the wrong scope."),
        detailRow(t, `${id}-reload`).child(
          button(t, {
            id: `${id}-reload-button`,
            label: "Reload policy",
            style: { ...ANSWER_BUTTON_STYLE, background: "raised" },
            onClick: model.busy ? undefined : (cx) => model.reload(cx),
          }),
        ),
      );
    } else {
      const inherited = model.scope === "domain" && domainPolicy?.mode === "inherit";
      const editable = model.scope === "global" || !inherited || model.draft !== undefined;
      const canEdit = editable && !model.busy && !model.conflict;
      const source =
        model.scope === "global"
          ? view.global.source === "legacy"
            ? "Legacy defaults"
            : "Global policy"
          : model.draft !== undefined
            ? "Unsaved domain override"
            : inherited
              ? view.global.source === "legacy"
                ? "Inherited from legacy defaults"
                : "Inherited from global policy"
              : "Domain override";
      rows.push(
        detailRow(t, `${id}-source`)
          .child(small(t, t.muted, "Source"))
          .child(div().text_color(t.dim).child(source)),
      );
      const enabled = h_flex()
        .flex_wrap()
        .gap(BUTTON_STYLE.gap)
        .children([
          ...(["pi", "claude"] as const).map((harness) =>
            togglePill(t, {
              id: `${id}-enabled-${harness}`,
              label: HARNESS_LABELS[harness],
              lit: selection.enabled.includes(harness),
              onClick: canEdit ? (cx) => model.toggle(harness, cx) : undefined,
              tooltip: `Enable or disable ${HARNESS_LABELS[harness]}`,
            }),
          ),
          h_flex()
            .items_center()
            .gap(BUTTON_STYLE.gap)
            .child(
              togglePill(t, {
                id: `${id}-codex-unavailable`,
                label: "Codex",
                lit: false,
                tooltip: "Codex is not available in Coordinate",
              }),
            )
            .child(small(t, t.dim, "Unavailable")),
          ...(selection.enabled.length === 0 ? [small(t, t.dim, "None enabled")] : []),
        ]);
      rows.push(
        detailRow(t, `${id}-enabled`)
          .child(small(t, t.muted, "Enabled"))
          .child(enabled),
      );
      const defaults = h_flex()
        .flex_wrap()
        .gap(BUTTON_STYLE.gap)
        .children([
          togglePill(t, {
            id: `${id}-default-none`,
            label: "No default",
            lit: selection.default === null,
            onClick: canEdit ? (cx) => model.setDefault(null, cx) : undefined,
          }),
          ...(["pi", "claude"] as const).map((harness) => {
            const available = selection.enabled.includes(harness);
            return togglePill(t, {
              id: `${id}-default-${harness}`,
              label: HARNESS_LABELS[harness],
              lit: selection.default === harness,
              onClick: canEdit && available ? (cx) => model.setDefault(harness, cx) : undefined,
              tooltip: available
                ? `${HARNESS_LABELS[harness]} default`
                : `Enable ${HARNESS_LABELS[harness]} before choosing it as the default`,
            });
          }),
        ]);
      rows.push(
        detailRow(t, `${id}-default`)
          .child(small(t, t.muted, "Default"))
          .child(defaults),
      );
      if (model.conflict || model.failure !== undefined) {
        rows.push(
          detailRow(t, `${id}-failure`)
            .text_size(TEXT.label)
            .text_color(role(t, "ansi1"))
            .child(
              model.conflict
                ? "Policy changed while this draft was open. Reload to discard it, then reapply your choices."
                : model.failure!,
            ),
          detailRow(t, `${id}-reload`).child(
            button(t, {
              id: `${id}-reload-button`,
              label: "Reload policy",
              style: { ...ANSWER_BUTTON_STYLE, background: "raised" },
              onClick: model.busy ? undefined : (cx) => model.reload(cx),
            }),
          ),
        );
      }
      if (model.scope === "domain" && inherited && model.draft === undefined) {
        rows.push(
          detailRow(t, `${id}-override`).child(
            button(t, {
              id: `${id}-override-button`,
              label: "Override global",
              style: ANSWER_BUTTON_STYLE,
              onClick: model.busy ? undefined : (cx) => model.beginOverride(cx),
            }),
          ),
        );
      }
      if (model.draft !== undefined) {
        const dirty =
          original !== undefined &&
          ((model.scope === "domain" && domainPolicy?.mode === "inherit") ||
            !sameHarnessSelection(model.draft.selection, original));
        const saveLabel = model.busy
          ? "Saving…"
          : model.scope === "global"
            ? "Save defaults"
            : "Save override";
        rows.push(
          detailRow(t, `${id}-actions`).child(
            h_flex()
              .flex_wrap()
              .gap(BUTTON_STYLE.gap)
              .children([
                button(t, {
                  id: `${id}-save`,
                  label: saveLabel,
                  style:
                    dirty && canEdit
                      ? ANSWER_BUTTON_STYLE
                      : { ...ANSWER_BUTTON_STYLE, background: "raised" },
                  onClick: dirty && canEdit ? (cx) => model.save(cx) : undefined,
                }),
                button(t, {
                  id: `${id}-cancel`,
                  label: "Cancel",
                  style: { ...ANSWER_BUTTON_STYLE, background: "raised" },
                  onClick: model.busy ? undefined : (cx) => model.cancel(cx),
                }),
                ...(model.scope === "domain" && domainPolicy?.mode === "replace"
                  ? [
                      button(t, {
                        id: `${id}-reset`,
                        label: "Reset to global",
                        style: { ...ANSWER_BUTTON_STYLE, background: "raised" },
                        onClick: model.busy || model.conflict ? undefined : (cx) => model.reset(cx),
                      }),
                    ]
                  : []),
              ]),
          ),
        );
      } else if (model.scope === "domain" && domainPolicy?.mode === "replace") {
        rows.push(
          detailRow(t, `${id}-reset-row`).child(
            button(t, {
              id: `${id}-reset-button`,
              label: "Reset to global",
              style: { ...ANSWER_BUTTON_STYLE, background: "raised" },
              onClick: model.busy ? undefined : (cx) => model.reset(cx),
            }),
          ),
        );
      }
    }
  }
  return detailCard(t, id, title, rows);
};

// The answer field is app-specific; the package owns its surrounding card item and button.
const askBodyRow = (t: Theme, id: string): Element => detailRow(t, id).bg(t.surface);

const answerField = (
  t: Theme,
  id: string,
  input: AnswerInputState | undefined,
  typing: boolean,
): Element =>
  div()
    .id(id)
    .flex_1()
    .min_w(0)
    .min_h(ANSWER.height)
    .px(ANSWER.fieldPaddingX)
    .flex()
    .items_start()
    .rounded(ANSWER.radius)
    .border_1()
    .border_color(typing ? t.accent : t.border)
    .cursor_text()
    .when(input !== undefined, (el) =>
      el.child(answerInputElement(input!).h_full().text_size(TEXT.body).text_color(t.foreground)),
    );

const answerRows = (t: Theme, answer: AnswerModel, prefix = "ask"): Element[] => {
  const { draft } = answer;
  const enabled = chosenAnswer(draft) !== undefined && !draft.busy;
  const field = answerField(t, `${prefix}-answer-field`, answer.input, answer.typing);
  const noteField =
    draft.choice === undefined &&
    !draft.discuss &&
    draft.text.trim() !== "" &&
    answer.noteInput !== undefined
      ? [
          askBodyRow(t, `${prefix}-answer-note-field`).child(
            h_flex()
              .gap(ANSWER.gap)
              .child(small(t, t.muted, "Optional note"))
              .child(
                answerField(t, `${prefix}-answer-note-input`, answer.noteInput, answer.noteTyping),
              ),
          ),
        ]
      : [];
  const submit = button(t, {
    id: `${prefix}-answer-submit`,
    label: draft.busy
      ? draft.discuss
        ? "Discussing…"
        : "Answering…"
      : draft.discuss
        ? "Discuss"
        : "Answer",
    style: enabled ? ANSWER_BUTTON_STYLE : { ...ANSWER_BUTTON_STYLE, background: "raised" },
    onClick: enabled ? (cx) => answer.submit(cx) : undefined,
  });
  return [
    askBodyRow(t, `${prefix}-answer`).child(h_flex().gap(ANSWER.gap).child(field).child(submit)),
    ...noteField,
    ...(draft.error === undefined
      ? []
      : [
          askBodyRow(t, `${prefix}-answer-error`)
            .text_size(TEXT.label)
            .text_color(role(t, "ansi1"))
            .child(draft.error),
        ]),
  ];
};

type AnswerFlowAskPresentation = {
  layout: AnswerFlowLayout;
  width: number;
  rationaleKey: string;
  rationaleOpenFor: string | undefined;
  rationaleFocus: FocusHandle | undefined;
  setRationaleOpen: ((open: boolean, cx: Context) => void) | undefined;
};

const answerFlowPrompt = (
  t: Theme,
  id: string,
  ask: Ask,
  layout: AnswerFlowLayout,
  width: number,
): Element => {
  const promptId =
    layout.id === ANSWER_FLOW_LAYOUT_BASELINE.id
      ? `${id}-question-block`
      : `${id}-prompt-${layout.prompt}`;
  const question = div()
    .id(`${id}-question`)
    .min_w_0()
    .font_medium()
    .text_size(TEXT.body)
    .text_color(t.foreground)
    .child(ask.question);
  const context =
    ask.context === null
      ? undefined
      : div()
          .id(`${id}-context`)
          .min_w_0()
          .text_size(
            layout.prompt === "caption" || layout.prompt === "compact" ? TEXT.label : TEXT.body,
          )
          .text_color(t.muted)
          .child(ask.context);
  if (layout.prompt === "block")
    return v_flex()
      .id(promptId)
      .min_w_0()
      .bg(t.popover)
      .rounded(CARD.innerRadius)
      .px(CARD.paddingX)
      .py(CARD.paddingY)
      .child(question)
      .when(context !== undefined, (el) => el.child(context!));
  if (layout.prompt === "split") {
    if (context === undefined || width < ANSWER_FLOW_LAYOUT_GEOMETRY.splitPromptMinWidth)
      return v_flex()
        .id(promptId)
        .min_w_0()
        .px(CARD.paddingX)
        .py(CARD.paddingY)
        .gap(BUTTON_STYLE.gap)
        .child(question)
        .when(context !== undefined, (el) => el.child(context!));
    return h_flex()
      .id(promptId)
      .w_full()
      .min_w_0()
      .items_start()
      .gap(ANSWER_FLOW_LAYOUT_GEOMETRY.choiceGap)
      .px(CARD.paddingX)
      .py(CARD.paddingY)
      .child(div().id(`${id}-question-column`).flex_1().min_w_0().child(question))
      .child(div().id(`${id}-context-column`).flex_1().min_w_0().child(context));
  }
  if (layout.prompt === "context-first")
    return v_flex()
      .id(promptId)
      .min_w_0()
      .px(CARD.paddingX)
      .py(CARD.paddingY)
      .gap(BUTTON_STYLE.gap)
      .when(context !== undefined, (el) => el.child(context!))
      .child(question);
  if (layout.prompt === "band")
    return v_flex()
      .id(promptId)
      .min_w_0()
      .bg(role(t, "surface"))
      .rounded(CARD.innerRadius)
      .px(CARD.paddingX)
      .py(CARD.paddingY)
      .gap(BUTTON_STYLE.gap)
      .child(question)
      .when(context !== undefined, (el) => el.child(context!));
  return v_flex()
    .id(promptId)
    .min_w_0()
    .px(CARD.paddingX)
    .py(CARD.paddingY)
    .gap(layout.prompt === "compact" ? 2 : BUTTON_STYLE.gap)
    .child(question)
    .when(context !== undefined, (el) => el.child(context!));
};

const answerFlowOptionStyle = (
  row: Element,
  t: Theme,
  selected: boolean,
  layout: AnswerFlowLayout,
): Element => {
  if (layout.choices === "outline")
    return row
      .w_full()
      .min_w_0()
      .px(ANSWER_FLOW_OUTLINE.paddingX)
      .py(ANSWER_FLOW_OUTLINE.paddingY)
      .gap(BUTTON_STYLE.gap)
      .bg(role(t, ANSWER_FLOW_OUTLINE.optionSurface))
      .text_color(t.foreground)
      .border_1()
      .border_color(selected ? t.accent : t.border)
      .rounded(CARD.innerRadius)
      .when(selected, (el) =>
        el.border(ANSWER_FLOW_OUTLINE.selectedBorderWidth).border_color(t.accent).font_semibold(),
      );

  const cell = layout.choices === "tiles" || layout.choices === "grid";
  const compact = layout.choices === "compact";
  const sized = cell ? row.flex_1() : row.w_full();
  const styled = sized
    .min_w_0()
    .px(compact ? 8 : CARD.paddingX)
    .py(compact ? 6 : CARD.paddingY)
    .gap(BUTTON_STYLE.gap)
    .text_color(t.foreground);
  if (layout.choices === "tiles" || layout.choices === "grid")
    return styled
      .bg(role(t, "surface"))
      .border_1()
      .border_color(selected ? t.accent : t.border)
      .rounded(CARD.innerRadius)
      .when(selected, (el) =>
        el.border(ANSWER_FLOW_OUTLINE.selectedBorderWidth).border_color(t.accent).font_semibold(),
      );
  if (layout.choices === "spaced")
    return styled
      .bg(role(t, "surface"))
      .rounded(CARD.innerRadius)
      .when(selected, (el) =>
        el.border(ANSWER_FLOW_OUTLINE.selectedBorderWidth).border_color(t.accent).font_semibold(),
      );
  return styled.when(selected, (el) =>
    el
      .bg(role(t, "selected"))
      .border(ANSWER_FLOW_OUTLINE.selectedBorderWidth)
      .border_color(t.accent)
      .rounded(CARD.innerRadius)
      .font_semibold(),
  );
};

const answerFlowGrid = (
  id: string,
  items: Element[],
  width: number,
  minimumWidth: number,
  maximumColumns: number,
  rowPrefix: "tile" | "grid",
): Element => {
  const gap = ANSWER_FLOW_LAYOUT_GEOMETRY.choiceGap;
  const columns = Math.max(
    1,
    Math.min(maximumColumns, Math.floor((width + gap) / (minimumWidth + gap))),
  );
  const rows: Element[] = [];
  for (let start = 0; start < items.length; start += columns) {
    rows.push(
      h_flex()
        .id(`${id}-option-${rowPrefix}-row-${rows.length}`)
        .w_full()
        .min_w_0()
        .items_stretch()
        .gap(gap)
        .children(items.slice(start, start + columns)),
    );
  }
  return v_flex()
    .id(`${id}-options-${rowPrefix === "tile" ? "tiles" : "grid"}`)
    .w_full()
    .min_w_0()
    .gap(gap)
    .children(rows);
};

const answerFlowOptions = (
  t: Theme,
  id: string,
  items: Element[],
  layout: AnswerFlowLayout,
  width: number,
): Element[] => {
  if (layout.choices === "outline") return items;
  if (layout.choices === "tiles")
    return [answerFlowGrid(id, items, width, ANSWER_FLOW_LAYOUT_GEOMETRY.tileMinWidth, 3, "tile")];
  if (layout.choices === "grid")
    return [answerFlowGrid(id, items, width, ANSWER_FLOW_LAYOUT_GEOMETRY.gridMinWidth, 2, "grid")];
  if (layout.choices === "grouped")
    return [
      v_flex()
        .id(`${id}-options-grouped`)
        .w_full()
        .min_w_0()
        .bg(role(t, "surface"))
        .rounded(CARD.innerRadius)
        .border_1()
        .border_color(t.border)
        .overflow_hidden()
        .children(
          items.map((item, index) =>
            index === 0 ? item : item.border_t(1).border_color(t.border),
          ),
        ),
    ];
  if (layout.choices === "rows")
    return [
      v_flex()
        .id(`${id}-options-rows`)
        .w_full()
        .min_w_0()
        .gap(ANSWER_FLOW_LAYOUT_GEOMETRY.choiceGap)
        .children(items),
    ];
  const rows = items.map((item, index) =>
    index === 0 ? item : item.border_t(1).border_color(t.border),
  );
  if (layout.choices === "spaced")
    return [
      v_flex()
        .id(`${id}-options-spaced`)
        .w_full()
        .min_w_0()
        .gap(ANSWER_FLOW_LAYOUT_GEOMETRY.choiceGap)
        .children(items),
    ];
  if (layout.choices === "compact")
    return [v_flex().id(`${id}-options-compact`).w_full().min_w_0().children(rows)];
  if (layout.choices === "quiet")
    return [
      v_flex().id(`${id}-options-quiet`).w_full().min_w_0().gap(BUTTON_STYLE.gap).children(items),
    ];
  return [v_flex().id(`${id}-options-${layout.choices}`).w_full().min_w_0().children(rows)];
};

const answerFlowRationaleShelf = (t: Theme, id: string, reason: string): Element =>
  v_flex()
    .id(`${id}-rec-reason-shelf`)
    .w_full()
    .min_w_0()
    .gap(BUTTON_STYLE.gap)
    .bg(t.popover)
    .rounded(CARD.innerRadius)
    .px(CARD.paddingX)
    .py(CARD.paddingY)
    .text_size(TEXT.label)
    .text_color(t.muted)
    .child(small(t, t.muted, "Why recommended").id(`${id}-rec-reason-shelf-label`))
    .child(div().min_w_0().child(reason));

const answerFlowRationalePopover = (
  t: Theme,
  id: string,
  reason: string,
  open: boolean,
  focus: FocusHandle | undefined,
  onOpenChange: ((open: boolean, cx: Context) => void) | undefined,
): Element => {
  const trigger = togglePill(t, {
    id: `${id}-rec-reason-disclosure-trigger`,
    label: "Why recommended",
    icon: HERDR_ICONS.chevronDown,
    lit: open,
    tooltip: open ? "Hide recommendation rationale" : "Show recommendation rationale",
    onClick: onOpenChange === undefined ? undefined : (cx) => onOpenChange(!open, cx),
  })
    .role("button")
    .accessibility_label(open ? "Hide recommendation rationale" : "Show recommendation rationale")
    .when(focus !== undefined, (el) => el.tab_index(0).track_focus(focus!))
    .on_key_down((event, cx) => {
      if (answerFlowKey(event, "enter") || answerFlowKey(event, "space")) {
        onOpenChange?.(!open, cx);
        cx.stop_propagation();
      } else if (open && answerFlowKey(event, "escape")) {
        onOpenChange?.(false, cx);
        cx.stop_propagation();
      }
    });
  const content = v_flex()
    .id(`${id}-rec-reason-popover-content`)
    .w(ANSWER_FLOW_LAYOUT_GEOMETRY.rationaleWidth)
    .min_w_0()
    .gap(BUTTON_STYLE.gap)
    .bg(t.popover)
    .rounded(CARD.innerRadius)
    .border_1()
    .border_color(t.border)
    .px(CARD.paddingX)
    .py(CARD.paddingY)
    .text_size(TEXT.label)
    .text_color(t.muted)
    .child(small(t, t.muted, "Why recommended"))
    .child(div().min_w_0().text_color(t.foreground).child(reason));
  return Popover.new(`${id}-rec-reason-popover`)
    .id(`${id}-rec-reason-disclosure`)
    .open(open)
    .on_open_change((next, cx) => onOpenChange?.(next, cx))
    .trigger(trigger)
    .when(open, (el) => el.content(content));
};

const askCardRows = (
  t: Theme,
  id: string,
  ask: Ask,
  answer: AnswerModel | undefined,
  completed: AnsweredAsk | undefined,
  itemTouches: string[] | undefined,
  presentation?: AnswerFlowAskPresentation,
): Element[] => {
  const flowHeader = presentation !== undefined;
  const layout = presentation?.layout ?? ANSWER_FLOW_LAYOUT_BASELINE;
  // Notes do not replace the picked option; completed cards have no active draft.
  const picked =
    completed !== undefined
      ? completed.answer
      : answer === undefined
        ? ask.rec
        : answer.draft.discuss
          ? undefined
          : answer.draft.choice;
  const question =
    presentation === undefined
      ? detailRow(t, `${id}-question`)
          .bg(t.popover)
          .rounded_t(CARD.innerRadius)
          .font_medium()
          .child(ask.question)
      : answerFlowPrompt(t, id, ask, layout, presentation.width);
  const context =
    presentation === undefined && ask.context !== null
      ? [askBodyRow(t, `${id}-context`).text_color(t.muted).child(ask.context)]
      : [];
  const touches =
    itemTouches === undefined || itemTouches.length === 0
      ? []
      : [
          fact(t, `${id}-touches`, "Touches", itemTouches, (theme, rowId) =>
            askBodyRow(theme, rowId),
          ),
        ];
  const optionItems = rankedOptions(ask).map(({ option, index, rec }, displayIndex) => {
    const optionId = `${id}-option-${index}`;
    const selected = option === picked;
    const chosen = completed !== undefined && option === completed.answer;
    const selectedText = flowHeader && selected ? t.foreground : t.muted;
    const tagTone = selected && flowHeader ? selectedText : undefined;
    const heading = h_flex()
      .gap(BUTTON_STYLE.gap)
      .items_center()
      .child(div().flex_1().min_w_0().child(option))
      .when(rec, (el) => el.child(small(t, tagTone ?? t.accent, "Recommended")))
      .when(chosen, (el) => el.child(small(t, tagTone ?? t.done, "Answered")));
    const detailText = ask.optionDetails?.[index];
    const detail =
      detailText === undefined || detailText === ""
        ? undefined
        : div()
            .id(`${id}-detail-${index}`)
            .min_w_0()
            .text_size(TEXT.label)
            .text_color(tagTone ?? t.muted)
            .child(detailText);
    const detailSideBySide =
      presentation !== undefined &&
      layout.choices === "side-details" &&
      presentation.width >= ANSWER_FLOW_LAYOUT_GEOMETRY.sideDetailsMinWidth &&
      detail !== undefined;
    const inlineReason =
      rec && ask.recReason !== null && (presentation === undefined || layout.rationale === "inline")
        ? div()
            .id(`${id}-rec-reason`)
            .min_w_0()
            .bg(t.popover)
            .rounded(CARD.innerRadius)
            .px(CARD.paddingX)
            .py(CARD.paddingY)
            .text_size(TEXT.label)
            .text_color(t.muted)
            .child(
              v_flex()
                .gap(BUTTON_STYLE.gap)
                .child(small(t, t.muted, "Why recommended").id(`${id}-rec-reason-label`))
                .child(div().min_w_0().child(ask.recReason!)),
            )
        : undefined;
    const content = v_flex()
      .id(`${id}-content-${index}`)
      .flex_1()
      .min_w_0()
      .gap(BUTTON_STYLE.gap)
      .when(detailSideBySide, (el) =>
        el.child(
          h_flex()
            .id(`${id}-detail-side-by-side-${index}`)
            .w_full()
            .min_w_0()
            .items_start()
            .gap(ANSWER_FLOW_LAYOUT_GEOMETRY.choiceGap)
            .child(v_flex().flex_1().min_w_0().child(heading))
            .child(detail!.flex_1().min_w_0()),
        ),
      )
      .when(!detailSideBySide, (el) =>
        el.child(heading).when(detail !== undefined, (nested) => nested.child(detail!)),
      )
      .when(inlineReason !== undefined, (el) => el.child(inlineReason!));
    const row = flowHeader ? v_flex().id(optionId) : askBodyRow(t, optionId);
    const styled = flowHeader
      ? answerFlowOptionStyle(row, t, selected, layout)
      : row.when(selected, (el) => el.bg(t.selected));
    const selectionCue = flowHeader
      ? selected
        ? svg(HERDR_ICONS.circleCheck)
            .id(`${optionId}-selection-marker`)
            .size(ANSWER_FLOW_OUTLINE.markerSize)
            .flex_none()
            .text_color(t.accent)
        : div()
            .id(`${optionId}-selection-marker`)
            .w(ANSWER_FLOW_OUTLINE.markerSize)
            .h(ANSWER_FLOW_OUTLINE.markerSize)
            .flex_none()
      : undefined;
    return styled
      .when(answer !== undefined && completed === undefined, (el) =>
        el
          .cursor_pointer()
          .hover((style) =>
            style.bg(
              flowHeader
                ? selected
                  ? layout.choices === "outline" ||
                    layout.choices === "tiles" ||
                    layout.choices === "grid" ||
                    layout.choices === "spaced"
                    ? role(t, "surface")
                    : role(t, "selected")
                  : t.hover
                : selected
                  ? t.selected
                  : t.hover,
            ),
          )
          .on_click((_event, cx) => answer!.choose(option, cx)),
      )
      .child(
        h_flex()
          .gap(BUTTON_STYLE.gap)
          .items_start()
          .child(
            div()
              .id(`${id}-number-${index}`)
              .w(ASK_OPTION_NUMBER_WIDTH)
              .flex_shrink_0()
              .text_color(selected && flowHeader ? selectedText : t.muted)
              .child(`${displayIndex + 1}.`),
          )
          .when(flowHeader, (el) => el.child(selectionCue!))
          .child(content),
      );
  });
  const options =
    presentation === undefined
      ? optionItems
      : answerFlowOptions(t, id, optionItems, layout, presentation.width);
  const rationale =
    presentation === undefined || ask.rec === null || ask.recReason === null
      ? []
      : layout.rationale === "shelf"
        ? [answerFlowRationaleShelf(t, id, ask.recReason)]
        : layout.rationale === "popover"
          ? [
              answerFlowRationalePopover(
                t,
                id,
                ask.recReason,
                presentation.rationaleOpenFor === presentation.rationaleKey,
                presentation.rationaleFocus,
                presentation.setRationaleOpen,
              ),
            ]
          : [];
  const discussion =
    completed === undefined
      ? [
          askBodyRow(t, `${id}-discuss`)
            .when(answer?.draft.discuss === true, (el) => el.bg(t.selected))
            .when(answer !== undefined, (el) =>
              el
                .cursor_pointer()
                .hover((style) => style.bg(answer?.draft.discuss === true ? t.selected : t.hover))
                .on_click((_event, cx) => answer!.discuss(cx)),
            )
            .child(
              h_flex()
                .gap(BUTTON_STYLE.gap)
                .items_start()
                .child(
                  div()
                    .id(`${id}-discuss-number`)
                    .w(ASK_OPTION_NUMBER_WIDTH)
                    .flex_shrink_0()
                    .text_color(t.muted)
                    .child(`${ask.options.length + 1}.`),
                )
                .child(
                  v_flex()
                    .id(`${id}-discuss-content`)
                    .flex_1()
                    .min_w_0()
                    .gap(BUTTON_STYLE.gap)
                    .child(
                      h_flex()
                        .gap(BUTTON_STYLE.gap)
                        .items_center()
                        .child(div().flex_1().min_w_0().child("Discuss"))
                        .when(ask.discuss !== null, (el) =>
                          el.child(small(t, t.accent, "In discussion").id(`${id}-discuss-tag`)),
                        ),
                    )
                    .when(answer?.draft.discuss === true, (el) =>
                      el.child(small(t, t.muted, "Optional note").id(`${id}-discuss-detail`)),
                    )
                    .when(ask.discuss !== null && ask.discuss.note !== "", (el) =>
                      el.child(
                        small(t, t.muted, `Note: ${ask.discuss!.note}`).id(`${id}-discuss-note`),
                      ),
                    ),
                ),
            ),
        ]
      : [];
  const completion =
    completed === undefined
      ? answer === undefined
        ? []
        : answerRows(t, answer, id)
      : completed.options.includes(completed.answer)
        ? [
            askBodyRow(t, `${id}-answered-at`)
              .child(small(t, t.muted, "Answered"))
              .child(div().child(completed.answeredAt)),
          ]
        : [
            askBodyRow(t, `${id}-answer`)
              .child(small(t, t.muted, "Answer"))
              .child(div().flex_1().min_w_0().child(completed.answer))
              .child(small(t, t.muted, completed.answeredAt)),
          ];
  if (completed !== undefined && completed.note !== null && completed.note !== "")
    completion.push(
      askBodyRow(t, `${id}-answer-note`)
        .child(small(t, t.muted, "Note"))
        .child(div().flex_1().min_w_0().child(completed.note)),
    );
  return [question, ...context, ...touches, ...options, ...rationale, ...discussion, ...completion];
};

const askCard = (
  t: Theme,
  id: string,
  ask: Ask,
  answer: AnswerModel | undefined,
  completed: AnsweredAsk | undefined,
  itemTouches: string[] | undefined,
): Element[] => [
  detailCard(
    t,
    id,
    completed === undefined ? "Ask" : "Answered ask",
    askCardRows(t, id, ask, answer, completed, itemTouches),
  ),
];

const askCards = (t: Theme, item: Item, answer: AnswerModel | undefined): Element[] => {
  const cards =
    item.ask === null ? [] : askCard(t, "ask", item.ask, answer, undefined, item.touches);
  for (let index = item.answered.length - 1; index >= 0; index -= 1) {
    const answered = item.answered[index]!;
    cards.push(...askCard(t, `ask-answered-${index}`, answered, undefined, answered, undefined));
  }
  return cards;
};

const decidedCard = (t: Theme, item: Item): Element[] => {
  const decisions = item.decided.filter((entry) => !isDiscussion(entry.text));
  return decisions.length === 0
    ? []
    : [
        detailCard(
          t,
          "decided",
          "Decided",
          decisions.map((entry, index) =>
            detailRow(t, `decided-${index}`)
              .child(div().child(entry.text))
              .child(small(t, t.dim, entry.at.slice(0, 10))),
          ),
        ),
      ];
};

const delegatesCard = (t: Theme, item: Item, rows: DelegateRow[]): Element[] =>
  item.delegates.length === 0
    ? []
    : [
        detailCard(
          t,
          "delegates",
          "Delegates",
          item.delegates.map((ref) =>
            detailRow(t, `delegate-${ref.session}`)
              .child(
                h_flex()
                  .gap(BUTTON_STYLE.gap)
                  .items_center()
                  .child(div().font_medium().child(ref.name))
                  .children(
                    rows
                      .filter((row) => row.source === "ref" && row.key === ref.session)
                      .slice(0, 1)
                      .map((row) => small(t, delegateTone(t, row.state), delegateLabel(row.state))),
                  ),
              )
              .child(
                h_flex()
                  .gap(BUTTON_STYLE.gap)
                  .child(small(t, t.muted, "Brief"))
                  .child(small(t, t.foreground, ref.brief)),
              )
              .child(
                h_flex()
                  .gap(BUTTON_STYLE.gap)
                  .child(small(t, t.muted, "Report"))
                  .child(small(t, t.foreground, ref.report)),
              ),
          ),
        ),
      ];

// A record's key, title and status use the package's page-title row and trailing slot.
const detailHead = (
  t: Theme,
  prefix: string,
  id: string,
  title: string,
  status: string,
  tone: Color,
): Element =>
  titleRow(t, {
    id: `${prefix}-title`,
    trailingId: `${prefix}-status-slot`,
    identifier: id,
    title,
    trailing: div().id(`${prefix}-status`).text_size(TEXT.label).text_color(tone).child(status),
  });

// The item a finding came from: a link to its detail while the document has it, else its id
// as the finding names it, or None.
const originFact = (
  t: Theme,
  from: string | null,
  origin: Item | undefined,
  open: (item: Item, cx: Context) => void,
): Element =>
  detailRow(t, "fact-origin")
    .child(small(t, t.muted, "Origin"))
    .child(
      from === null
        ? div().text_color(t.dim).child("None")
        : origin === undefined
          ? div().child(from)
          : h_flex()
              .id("fact-origin-link")
              .gap(CARD.rowGap)
              .cursor_pointer()
              .text_color(t.accent)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_event, cx) => open(origin, cx))
              .child(div().flex_none().child(origin.id))
              .child(div().flex_1().min_w_0().child(origin.title)),
    );

// The scroll viewport is supplied by herdr-ui at the screen boundary. This content stays
// mounted below the list so its own viewport retains position while the user navigates back.
const findingScreen = (t: Theme, finding: Finding, model: PanelModel): Element =>
  v_flex()
    .id("finding")
    .gap(PANEL.sectionGap)
    .child(
      detailHead(
        t,
        "finding",
        finding.id,
        finding.title,
        FINDING_STATUS_LABELS[finding.status],
        role(t, FINDING_STATUS_TONES[finding.status]),
      ),
    )
    .child(
      detailCard(t, "finding-facts", "Details", [
        fact(t, "fact-kind", "Kind", [FINDING_KIND_LABELS[finding.kind]]),
        fact(t, "fact-detail", "Detail", finding.detail === null ? [] : [finding.detail]),
        fact(t, "fact-path", "Path", finding.path === null ? [] : [finding.path]),
        originFact(t, finding.from, model.origin, model.open),
        ...(finding.closedAt === null
          ? []
          : [fact(t, "fact-closed", "Closed", [finding.closedAt.slice(0, 10)])]),
        ...(finding.status === "open" || finding.outcome === null
          ? []
          : [fact(t, "fact-outcome", "Outcome", [finding.outcome])]),
      ]),
    );

const detailScreen = (
  t: Theme,
  item: Item,
  delegates: DelegateJoin,
  answer: AnswerModel | undefined,
): Element =>
  v_flex()
    .id("detail")
    .gap(PANEL.sectionGap)
    .child(
      detailHead(
        t,
        "detail",
        item.id,
        item.title,
        GROUP_LABELS[item.status],
        role(t, STATUS_TONES[item.status]),
      ),
    )
    .children(askCards(t, item, answer))
    .child(
      detailCard(t, "facts", "Details", [
        fact(t, "fact-due", "Due", item.due === null ? [] : [item.due]),
        ...(item.ask === null || item.touches.length === 0
          ? [fact(t, "fact-touches", "Touches", item.touches)]
          : []),
        fact(t, "fact-created", "Created", [item.createdAt.slice(0, 10)]),
        ...((item.status === "done" || item.status === "dismissed") && item.closedAt !== null
          ? [fact(t, "fact-closed", "Closed", [item.closedAt.slice(0, 10)])]
          : []),
        ...(item.outcome === null ? [] : [fact(t, "fact-outcome", "Outcome", [item.outcome])]),
      ]),
    )
    .children(decidedCard(t, item))
    .children(delegatesCard(t, item, delegates.byItem.get(item.id) ?? []));

const answerFlowKey = (
  event: { key: string; keystroke: string },
  key: "down" | "up" | "enter" | "space" | "escape",
) => {
  const pressed = [event.key.toLowerCase(), event.keystroke.toLowerCase()];
  return pressed.some(
    (value) => value === key || value === `arrow${key}` || (key === "space" && value === " "),
  );
};

const flowLayoutMenu = (t: Theme, flow: AnswerFlowModel): Element => {
  const resetIndex = ANSWER_FLOW_LAYOUT_PROPOSALS.length;
  const menuCount = resetIndex + 1;
  const proposalRows = ANSWER_FLOW_LAYOUT_PROPOSALS.map((layout, index) =>
    menuRow(t, {
      id: `answer-flow-layout-option-${layout.id}`,
      label: layout.name,
      selected: index === flow.layoutActiveIndex,
      checked: layout.id === flow.layoutSelection.id,
      tooltip: layout.description,
      onClick: (cx) => flow.selectLayout(layout.id, cx),
    })
      .role("menu_item")
      .accessibility_label(`${layout.name}: ${layout.description}`)
      .set_position(index + 1, menuCount)
      .when(index === flow.layoutActiveIndex, (el) =>
        el.aria_active_descendant().border_1().border_color(t.accent),
      )
      .on_hover((hovered, cx) => {
        if (hovered) flow.setLayoutActiveIndex(index, cx);
      }),
  );
  const reset = menuRow(t, {
    id: "answer-flow-layout-reset",
    label: "Reset to Outline",
    selected: flow.layoutActiveIndex === resetIndex,
    tooltip: "Restore the initial Outline layout",
    onClick: flow.resetLayout,
  })
    .role("menu_item")
    .set_position(menuCount, menuCount)
    .when(flow.layoutActiveIndex === resetIndex, (el) =>
      el.aria_active_descendant().border_1().border_color(t.accent),
    )
    .on_hover((hovered, cx) => {
      if (hovered) flow.setLayoutActiveIndex(resetIndex, cx);
    });
  return menuPanel(t, ANSWER_FLOW_LAYOUT_GEOMETRY.menuWidth, MENU.padding)
    .id("answer-flow-layout-options")
    .role("menu")
    .accessibility_label("Answer card layout")
    .tab_index(0)
    .track_focus(flow.layoutMenuFocus)
    .on_key_down((event, cx) => {
      if (answerFlowKey(event, "down")) flow.moveLayoutMenu(1, cx);
      else if (answerFlowKey(event, "up")) flow.moveLayoutMenu(-1, cx);
      else if (answerFlowKey(event, "enter") || answerFlowKey(event, "space"))
        flow.activateLayoutMenu(cx);
      else if (answerFlowKey(event, "escape")) flow.setLayoutMenuOpen(false, cx);
      else return;
      cx.stop_propagation();
    })
    .children([
      ...proposalRows,
      div().id("answer-flow-layout-separator").h(1).flex_none().bg(t.border),
      reset,
    ]);
};

const flowLayoutSelector = (t: Theme, flow: AnswerFlowModel): Element => {
  const selection = flow.layoutSelection;
  const trigger = togglePill(t, {
    id: "answer-flow-layout-trigger",
    label: "Layout",
    icon: HERDR_ICONS.chevronDown,
    lit:
      flow.layoutMenuOpen ||
      flow.layout.id !== ANSWER_FLOW_LAYOUT_BASELINE.id ||
      selection.id !== ANSWER_FLOW_LAYOUT_BASELINE.id,
    tooltip: `Answer card layout: ${selection.name}${flow.layoutPending ? " (applying)" : ""}`,
    onClick: (cx) => {
      if (!flow.layoutMenuOpen) flow.setLayoutMenuOpen(true, cx);
    },
  })
    .role("button")
    .accessibility_label(`Answer card layout: ${selection.name}`)
    .tab_index(0)
    .track_focus(flow.layoutTriggerFocus)
    .on_key_down((event, cx) => {
      if (
        answerFlowKey(event, "down") ||
        answerFlowKey(event, "enter") ||
        answerFlowKey(event, "space")
      ) {
        flow.setLayoutMenuOpen(true, cx);
        cx.stop_propagation();
      }
    });
  return Popover.new("answer-flow-layout-popover")
    .id("answer-flow-layout-popover")
    .open(flow.layoutMenuOpen)
    .on_open_change((open, cx) => flow.setLayoutMenuOpen(open, cx))
    .trigger(trigger)
    .when(flow.layoutMenuOpen, (el) => el.content(flowLayoutMenu(t, flow)));
};

const ANSWER_FLOW_SPEED_MENU_MAX_HEIGHT = 200;

const flowSpeedMenu = (t: Theme, flow: AnswerFlowModel): Element =>
  menuPanel(t, ANSWER_FLOW_LAYOUT_GEOMETRY.menuWidth, MENU.padding)
    .id("answer-flow-speed-options")
    .role("menu")
    .accessibility_label("Animation speed")
    .tab_index(0)
    .max_h(ANSWER_FLOW_SPEED_MENU_MAX_HEIGHT)
    .overflow_y_scroll()
    .track_focus(flow.speedMenuFocus)
    .on_key_down((event, cx) => {
      if (answerFlowKey(event, "down")) flow.moveSpeedMenu(1, cx);
      else if (answerFlowKey(event, "up")) flow.moveSpeedMenu(-1, cx);
      else if (answerFlowKey(event, "enter") || answerFlowKey(event, "space"))
        flow.setSpeed(flow.speedActiveIndex, cx);
      else if (answerFlowKey(event, "escape")) flow.setSpeedMenuOpen(false, cx);
      else return;
      cx.stop_propagation();
    })
    .children(
      ANSWER_FLOW_SPEED_OPTIONS.map((option, index) =>
        menuRow(t, {
          id: `answer-flow-speed-option-${option.id}`,
          label: option.name,
          selected: flow.speedActiveIndex === index,
          checked: flow.speedIndex === index,
          onClick: (cx) => flow.setSpeed(index, cx),
        })
          .role("menu_item")
          .set_position(index + 1, ANSWER_FLOW_SPEED_OPTIONS.length)
          .when(flow.speedActiveIndex === index, (el) =>
            el.aria_active_descendant().border_1().border_color(t.accent),
          )
          .on_hover((hovered, cx) => {
            if (hovered) flow.setSpeedActiveIndex(index, cx);
          }),
      ),
    );

const flowSpeedSelector = (t: Theme, flow: AnswerFlowModel): Element => {
  const name = ANSWER_FLOW_SPEED_OPTIONS[flow.speedIndex]?.name ?? "Normal";
  const trigger = togglePill(t, {
    id: "answer-flow-speed-trigger",
    label: `Speed: ${name}`,
    icon: HERDR_ICONS.chevronDown,
    lit: flow.speedMenuOpen || flow.speedIndex !== 0,
    tooltip: `Animation speed: ${name}`,
    onClick: (cx) => flow.setSpeedMenuOpen(!flow.speedMenuOpen, cx),
  })
    .role("button")
    .accessibility_label(`Animation speed: ${name}`)
    .tab_index(0)
    .track_focus(flow.speedTriggerFocus)
    .on_key_down((event, cx) => {
      if (
        answerFlowKey(event, "down") ||
        answerFlowKey(event, "enter") ||
        answerFlowKey(event, "space")
      ) {
        flow.setSpeedMenuOpen(true, cx);
        cx.stop_propagation();
      }
    });
  return Popover.new("answer-flow-speed-popover")
    .id("answer-flow-speed-popover")
    .open(flow.speedMenuOpen)
    .on_open_change((open, cx) => flow.setSpeedMenuOpen(open, cx))
    .trigger(trigger)
    .when(flow.speedMenuOpen, (el) => el.content(flowSpeedMenu(t, flow)));
};

const flowHeader = (t: Theme, flow: AnswerFlowModel): Element =>
  h_flex()
    .id(`answer-flow-header-${flow.domain}`)
    .h(CARD.headerHeight)
    .flex_none()
    .px(PANEL.padding)
    .gap(CARD.headerGap)
    .items_center()
    .child(
      div()
        .id("answer-flow-progress")
        .flex_1()
        .min_w_0()
        .font_semibold()
        .text_size(TEXT.body)
        .text_color(t.foreground)
        .child(flow.done ? "Done" : `Question ${flow.position} of ${flow.total}`),
    )
    .child(flowLayoutSelector(t, flow))
    .child(flowSpeedSelector(t, flow));

const flowCardHeader = (
  t: Theme,
  cardModel: AnswerFlowModel["cards"][number],
  id: string,
): Element =>
  titleRow(t, {
    id,
    identifier: cardModel.kind === "question" ? cardModel.id : undefined,
    title:
      cardModel.item?.title ??
      (cardModel.kind === "summary" ? "All caught up" : "Question unavailable"),
  }).px(CARD.paddingX);

const flowAskCard = (
  t: Theme,
  flow: AnswerFlowModel,
  layout: AnswerFlowLayout,
  width: number,
  item: Item | undefined,
  answer: AnswerModel | undefined,
  detailPrefix: string,
  askPrefix: string,
  measurement: boolean,
  interactive: boolean,
): Element[] => {
  if (item === undefined)
    return [
      detailRow(t, `${detailPrefix}-missing`)
        .border_t(0)
        .text_color(t.muted)
        .child("Question unavailable. Go back to the domain."),
    ];
  if (item.ask === null)
    return [
      detailRow(t, `${detailPrefix}-already-answered`)
        .border_t(0)
        .text_color(t.muted)
        .child("This question was answered outside this flow."),
    ];
  return askCardRows(t, askPrefix, item.ask, answer, undefined, item.touches, {
    layout,
    width,
    rationaleKey: item.id,
    rationaleOpenFor: measurement || !interactive ? undefined : flow.rationaleOpenFor,
    rationaleFocus: interactive ? flow.rationaleFocusFor(item.id) : undefined,
    setRationaleOpen: interactive
      ? (open, cx) => flow.setRationaleOpen(item.id, open, cx)
      : undefined,
  }).map((row, index) => (index === 0 ? row.border_t(0) : row));
};

const flowDoneRows = (t: Theme, flow: AnswerFlowModel, prefix: string): Element[] => [
  detailRow(t, `${prefix}-count`)
    .border_t(0)
    .child(`${flow.answeredCount} answered, ${flow.skippedCount} skipped.`),
];

const flowPreviewBody = (
  t: Theme,
  flow: AnswerFlowModel,
  cardModel: AnswerFlowModel["cards"][number],
  id: string,
): Element => {
  const subtitle =
    cardModel.kind === "summary"
      ? `${flow.answeredCount} answered, ${flow.skippedCount} skipped`
      : (cardModel.item?.ask?.question ?? "Already answered");
  return v_flex()
    .id(id)
    .w_full()
    .min_w_0()
    .px(CARD.paddingX)
    .py(CARD.paddingY)
    .gap(ANSWER_CAROUSEL.previewGap)
    .child(
      div()
        .id(`${id}-question`)
        .text_size(TEXT.caption)
        .text_color(t.muted)
        .truncate()
        .child(subtitle),
    );
};

const flowPreviewCard = (
  t: Theme,
  flow: AnswerFlowModel,
  cardModel: AnswerFlowModel["cards"][number],
  id: string,
): Element =>
  card(t, id)
    .w_full()
    .min_h(ANSWER_CAROUSEL.compactMinHeight)
    .child(flowCardHeader(t, cardModel, `${id}-header`))
    .child(flowPreviewBody(t, flow, cardModel, `${id}-body`));

const flowTransition = (flow: AnswerFlowModel) => ({
  duration: flow.motion?.duration ?? 0,
  easing: ANSWER_CAROUSEL.easing,
});

// Crossfade compact and full content during the box resize, with a small overlap to avoid a blank card.
const flowContentTransition = (flow: AnswerFlowModel, incoming: boolean, expanding: boolean) => {
  const duration = flow.motion?.duration;
  if (duration === undefined) return flowTransition(flow);
  if (expanding) {
    return incoming
      ? {
          duration: Math.max(1, Math.round(duration * ANSWER_CAROUSEL.expandedContentFadeInRatio)),
          delay: Math.round(duration * ANSWER_CAROUSEL.expandedContentFadeInStartRatio),
          easing: ANSWER_CAROUSEL.easing,
        }
      : {
          duration: Math.max(1, Math.round(duration * ANSWER_CAROUSEL.compactContentFadeOutRatio)),
          easing: "ease-in" as const,
        };
  }
  return incoming
    ? {
        duration: Math.max(1, Math.round(duration * ANSWER_CAROUSEL.compactContentFadeInRatio)),
        delay: Math.round(duration * ANSWER_CAROUSEL.compactContentFadeInStartRatio),
        easing: "ease-out" as const,
      }
    : {
        duration: Math.max(1, Math.round(duration * ANSWER_CAROUSEL.expandedContentFadeOutRatio)),
        easing: "ease-in" as const,
      };
};

const flowMeasurementAnswer = (item: Item): AnswerModel => ({
  draft: {
    key: `answer-flow-measure-${item.id}`,
    choice: undefined,
    discuss: false,
    text: "",
    note: "",
    busy: false,
    error: undefined,
  },
  input: undefined,
  typing: false,
  noteInput: undefined,
  noteTyping: false,
  choose: () => {},
  discuss: () => {},
  submit: () => {},
});

const flowExpandedBody = (
  t: Theme,
  flow: AnswerFlowModel,
  layout: AnswerFlowLayout,
  width: number,
  cardModel: AnswerFlowModel["cards"][number],
  contentId: string,
  detailPrefix: string,
  askPrefix: string,
  measurement: boolean,
  interactive: boolean,
): Element => {
  const item = cardModel.item;
  const answer =
    cardModel.kind === "question" && item !== undefined && item.ask !== null
      ? measurement
        ? flowMeasurementAnswer(item)
        : (flow.answerFor(cardModel.id) ?? flowMeasurementAnswer(item))
      : undefined;
  return v_flex()
    .id(contentId)
    .w_full()
    .min_w_0()
    .children(
      cardModel.kind === "summary"
        ? flowDoneRows(t, flow, detailPrefix)
        : flowAskCard(
            t,
            flow,
            layout,
            width,
            item,
            answer,
            detailPrefix,
            askPrefix,
            measurement,
            interactive,
          ),
    );
};

const flowExpandedContent = (
  t: Theme,
  flow: AnswerFlowModel,
  layout: AnswerFlowLayout,
  width: number,
  cardModel: AnswerFlowModel["cards"][number],
  contentId: string,
  detailPrefix: string,
  askPrefix: string,
  measurement: boolean,
): Element =>
  card(t, contentId)
    .bg(role(t, ANSWER_FLOW_OUTLINE.cardSurface))
    .w_full()
    .min_w_0()
    .child(flowCardHeader(t, cardModel, `${contentId}-header`))
    .child(
      flowExpandedBody(
        t,
        flow,
        layout,
        width,
        cardModel,
        `${contentId}-body`,
        detailPrefix,
        askPrefix,
        measurement,
        false,
      ),
    );

const flowMeasurementCards = (t: Theme, flow: AnswerFlowModel): Element[] => {
  if (flow.viewport === undefined) return [];
  const expandedWidth = flow.viewport.width * ANSWER_CAROUSEL.compactWidthRatio;
  const compactWidth = Math.max(1, expandedWidth - 2 * PANEL.padding);
  const activeIndex = flow.motion?.targetIndex ?? flow.currentIndex;
  const activeId = flow.cards[activeIndex]?.id;
  const measurementPrefix = "answer-flow-measure";
  return flow.cards.flatMap((cardModel) => {
    const compactId = `${measurementPrefix}-compact-${cardModel.id}`;
    const expandedId = `${measurementPrefix}-expanded-${cardModel.id}`;
    const compact = div()
      .id(compactId)
      .absolute()
      .top(0)
      .left(-10_000)
      .w(compactWidth)
      .opacity(0)
      .on_size_change((size, cx) => flow.measure(cardModel.id, "compact", size, cx))
      .child(flowPreviewCard(t, flow, cardModel, `${compactId}-preview`));
    const expanded = div()
      .id(expandedId)
      .absolute()
      .top(0)
      .left(-10_000)
      .w(expandedWidth)
      .opacity(0)
      .on_size_change((size, cx) => flow.measure(cardModel.id, "expanded", size, cx))
      .child(
        flowExpandedContent(
          t,
          flow,
          flow.layout,
          expandedWidth,
          cardModel,
          `${expandedId}-content`,
          `${expandedId}-detail`,
          `${expandedId}-ask`,
          flow.motion !== undefined || cardModel.id !== activeId,
        ),
      );
    const measurements: Element[] = [compact, expanded];
    const candidateLayout = flow.layoutMeasurement;
    if (candidateLayout !== undefined && cardModel.kind === "question") {
      const version = flow.layoutMeasurementVersion;
      const candidateId = `answer-flow-layout-measure-${version}-expanded-${cardModel.id}`;
      measurements.push(
        div()
          .id(candidateId)
          .absolute()
          .top(0)
          .left(-10_000)
          .w(expandedWidth)
          .opacity(0)
          .on_size_change((size, cx) =>
            flow.measureLayout(candidateLayout.id, version, cardModel.id, size, cx),
          )
          .child(
            flowExpandedContent(
              t,
              flow,
              candidateLayout,
              expandedWidth,
              cardModel,
              `${candidateId}-content`,
              `${candidateId}-detail`,
              `${candidateId}-ask`,
              cardModel.id !== activeId,
            ),
          ),
      );
    }
    return measurements;
  });
};

const flowCarouselCard = (
  t: Theme,
  flow: AnswerFlowModel,
  cardModel: AnswerFlowModel["cards"][number],
  placement: ReturnType<typeof layoutAnswerFlowCards>[number],
): Element => {
  const transition = flowTransition(flow);
  const busy = flow.answer?.draft.busy === true && placement.expanded;
  const canNavigate =
    flow.ready &&
    flow.motion === undefined &&
    flow.answer?.draft.busy !== true &&
    Math.abs(placement.index - flow.currentIndex) === 1;
  const navigate = placement.index < flow.currentIndex ? flow.back : flow.skip;
  const wasExpanded =
    flow.motion === undefined ? placement.expanded : placement.index === flow.currentIndex;
  const changesFocus = wasExpanded !== placement.expanded;
  const compactId = `answer-flow-preview-${cardModel.id}`;
  const compactLayer = div()
    .id(`answer-flow-compact-layer-${cardModel.id}`)
    .absolute()
    .top(0)
    .left(0)
    .w_full()
    .overflow_hidden()
    .opacity(placement.expanded ? 0 : 1)
    .transition(
      "opacity",
      changesFocus
        ? flowContentTransition(flow, !placement.expanded, placement.expanded)
        : transition,
    )
    .child(flowPreviewBody(t, flow, cardModel, compactId));
  const expandedLayer = div()
    .id(`answer-flow-expanded-layer-${cardModel.id}`)
    .relative()
    .w_full()
    .min_w_0()
    .opacity(placement.expanded ? 1 : 0)
    .transition(
      "opacity",
      changesFocus
        ? flowContentTransition(flow, placement.expanded, placement.expanded)
        : transition,
    )
    .child(
      flowExpandedBody(
        t,
        flow,
        flow.layout,
        placement.width,
        cardModel,
        `answer-flow-expanded-content-${cardModel.id}`,
        `answer-flow-detail-${cardModel.id}`,
        `answer-flow-ask-${cardModel.id}`,
        false,
        true,
      ),
    );
  return card(t, `answer-flow-card-${cardModel.id}`)
    .absolute()
    .left(placement.left)
    .top(placement.top)
    .w(placement.width)
    .h(placement.height)
    .min_w_0()
    .when(placement.expanded, (el) => el.bg(role(t, ANSWER_FLOW_OUTLINE.cardSurface)))
    .opacity(busy ? ANSWER_CAROUSEL.disabledOpacity : placement.opacity)
    .transition("left", transition)
    .transition("top", transition)
    .transition("width", transition)
    .transition("height", transition)
    .transition("opacity", transition)
    .when(canNavigate, (el) =>
      el
        .cursor_pointer()
        .hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => navigate(cx)),
    )
    .child(flowCardHeader(t, cardModel, `answer-flow-header-${cardModel.id}`))
    .child(
      v_flex()
        .id(`answer-flow-body-${cardModel.id}`)
        .relative()
        .w_full()
        .min_w_0()
        .children([compactLayer, expandedLayer]),
    );
};

const answerFlowCarousel = (t: Theme, flow: AnswerFlowModel): Element => {
  let cards: Element[] = [];
  if (flow.ready && flow.viewport !== undefined) {
    const activeIndex = flow.motion?.targetIndex ?? flow.currentIndex;
    const placements = layoutAnswerFlowCards(
      flow.cards.map((cardModel) => ({
        id: cardModel.id,
        compactHeight: cardModel.compactHeight!,
        expandedHeight: cardModel.expandedHeight!,
      })),
      {
        activeIndex,
        viewportWidth: flow.viewport.width,
        viewportHeight: flow.viewport.height,
        gap: ANSWER_CAROUSEL.gap,
        compactWidthRatio: ANSWER_CAROUSEL.compactWidthRatio,
        compactNeighborInset: PANEL.padding,
        neighborOpacity: ANSWER_CAROUSEL.neighborOpacity,
        distanceOpacityFalloff: ANSWER_CAROUSEL.distanceOpacityFalloff,
        exiting: flow.motion?.exiting ?? false,
      },
    );
    cards = placements.map((placement) =>
      flowCarouselCard(t, flow, flow.cards[placement.index]!, placement),
    );
  }
  return v_flex()
    .id("answer-flow-carousel")
    .flex_1()
    .min_h_0()
    .min_w_0()
    .px(PANEL.padding)
    .py(PANEL.sectionGap)
    .child(
      div()
        .id("answer-flow-track")
        .relative()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .overflow_hidden()
        .on_size_change((size, cx) => flow.measureViewport(size, cx))
        .children([...cards, ...flowMeasurementCards(t, flow)]),
    );
};

const answerFlowScreen = (t: Theme, flow: AnswerFlowModel): Element =>
  v_flex()
    .id("answer-flow-queue-page")
    .flex_1()
    .min_h_0()
    .min_w_0()
    .child(flowHeader(t, flow))
    .child(answerFlowCarousel(t, flow));

// Policy text wraps, so use the package's card pieces instead of fixed-height groupBlock.
const policiesPage = (t: Theme, backlog: Backlog, model: PanelModel): Element => {
  const entries = backlog.policies;
  return cardSection(
    cardHeader(t, "policies-header", "Policies"),
    card(t, "policies").children(
      entries.length === 0
        ? [emptyRow(t, "policies-empty", "None")]
        : pagedRows(t, "policies", entries, model, ROW.list, (entry, index) =>
            detailRow(t, `policy-${entry.id}`)
              .when(index === 0, (row) => row.border_t(0))
              .child(div().child(entry.text))
              .child(small(t, t.dim, entry.at.slice(0, 10))),
          ),
    ),
  );
};

// The paths the domain owns and those next to it, in separate editable cards.
const boundaryCard = (t: Theme, boundary: Backlog["boundary"], model: BoundaryModel): Element[] => {
  const section = (list: BoundaryList, label: string, paths: string[]) => {
    const id = `boundary-${list}`;
    const rows = paths.map((path, index) => {
      const hovered = model.hovered === `${model.domain}\\0${list}\\0${path}`;
      const row = listRow(t, {
        id: `boundary-${model.domain}-${list}-${path}`,
        title: path,
        first: index === 0,
        height: ROW.list,
        trailing: hovered
          ? [
              button(t, {
                id: `boundary-${model.domain}-${list}-remove-${path}`,
                label: "Remove path",
                icon: HERDR_ICONS.close,
                labelled: false,
                tooltip: "Remove path",
                onClick: model.busy ? undefined : (cx) => model.remove(list, path, cx),
              }),
            ]
          : [],
      });
      return row.on_hover((hovering, cx) => model.hover(list, path, hovering, cx));
    });
    if (paths.length === 0)
      rows.push(
        detailRow(t, `boundary-${model.domain}-${list}-empty`).child(
          div().text_color(t.dim).child("None"),
        ),
      );
    if (model.editing === list && model.input !== undefined) {
      const field = div()
        .id(`boundary-${model.domain}-${list}-input`)
        .flex_1()
        .min_w(0)
        .h(ANSWER.height)
        .px(ANSWER.fieldPaddingX)
        .flex()
        .items_center()
        .rounded(ANSWER.radius)
        .border_1()
        .border_color(t.border)
        .cursor_text()
        .child(
          Input.new(model.input)
            .h_full()
            .text_size(TEXT.body)
            .text_color(t.foreground)
            .on_key_down((event, cx) => {
              if (event.keystroke === "escape") model.cancel(cx);
            }),
        );
      rows.push(detailRow(t, `boundary-${model.domain}-${list}-edit`).child(field));
    }
    const error =
      model.error?.domain === model.domain && model.error.list === list ? model.error : undefined;
    if (error !== undefined)
      rows.push(
        detailRow(
          t,
          `boundary-${model.domain}-${list}-error${error.path === undefined ? "" : `-${error.path}`}`,
        )
          .text_size(TEXT.label)
          .text_color(role(t, "ansi1"))
          .child(error.message),
      );
    const header = cardHeader(t, `${id}-header`, label)
      .child(div().flex_1())
      .child(
        button(t, {
          id: `boundary-${model.domain}-${list}-add`,
          label: "+",
          tooltip: "Add path",
          onClick: model.busy ? undefined : (cx) => model.begin(list, cx),
        }),
      );
    return cardSection(
      header,
      card(t, id).children(rows.map((row, index) => (index === 0 ? row.border_t(0) : row))),
    );
  };
  return [
    section("owned", "Owned", boundary.owned),
    section("adjacent", "Adjacent", boundary.adjacent),
  ];
};

const sectionRow = (
  t: Theme,
  id: string,
  label: string,
  count: number | string,
  screen: DomainPage,
  model: PanelModel,
): Element =>
  listRow(t, {
    id,
    title: label,
    height: ROW.list,
    trailing: [rowNote(t, String(count))],
    onClick: (cx) => model.go(screen, cx),
  });

const sectionLinks = (t: Theme, domain: string, backlog: Backlog, model: PanelModel): Element =>
  cardSection(
    cardHeader(t, "lists-header", "Lists"),
    card(t, "lists").children([
      sectionRow(
        t,
        "page-policies",
        "Policies",
        backlog.policies.length,
        { kind: "policies", domain },
        model,
      ),
      sectionRow(
        t,
        "page-findings",
        "Findings",
        formatFindingCounts(model.findings),
        { kind: "findings", domain },
        model,
      ),
      sectionRow(
        t,
        "page-boundary",
        "Boundary",
        backlog.boundary.owned.length + backlog.boundary.adjacent.length,
        { kind: "boundary", domain },
        model,
      ),
    ]),
  );

const domainPage = (t: Theme, backlog: Backlog, model: PanelModel): Element => {
  let content: Element;
  switch (model.page) {
    case "policies":
      content = policiesPage(t, backlog, model);
      break;
    case "findings":
      content = findingsPage(t, model);
      break;
    case "boundary":
      content = v_flex()
        .gap(PANEL.sectionGap)
        .children(boundaryCard(t, backlog.boundary, model.boundary));
      break;
    default:
      content = message(t, "page-unavailable", "Page unavailable", "Return to the domain list.");
  }
  return v_flex().id("domain-page").gap(PANEL.sectionGap).child(content);
};

const domainBody = (t: Theme, domain: string, doc: DocumentState, model: PanelModel): Element => {
  if (doc.kind === "loading")
    return message(t, "loading", "Loading…", `Reading ${domain}'s backlog.`, "loading");
  if (doc.kind === "missing")
    return message(
      t,
      "missing",
      `No backlog for ${domain}`,
      `Run coordinate start ${domain} to create it.`,
    );
  if (doc.kind === "invalid")
    return message(t, "invalid", `${domain}'s backlog is invalid`, doc.reason, "error");
  if (doc.kind === "unreadable")
    return message(t, "unreadable", `Couldn't read ${domain}'s backlog`, doc.reason, "error");
  return v_flex()
    .id("domain")
    .gap(PANEL.sectionGap)
    .child(focusCard(t, doc.backlog.focus))
    .children([...waitingCard(t, model), itemsCard(t, model)])
    .children(unfiledCard(t, model.delegates.unfiled, model))
    .child(sectionLinks(t, domain, doc.backlog, model))
    .when(
      model.page === undefined &&
        model.detail === undefined &&
        model.finding === undefined &&
        model.flow === undefined,
      (body) => body.child(harnessPolicyCard(t, model.harnessPolicy)),
    );
};

const COUNT_LABELS = [
  ["agents", "agents"],
  ["waiting", "waiting"],
  ["delegated", "delegated"],
  ["open", "open"],
] as const;

const domainRow = (
  t: Theme,
  row: DomainSummary,
  open: (cx: Context) => void,
  first: boolean,
): Element =>
  listRow(t, {
    id: `domain-${row.domain}`,
    title: row.domain,
    height: ROW.list,
    first,
    onClick: (cx) => open(cx),
    trailing:
      row.kind === "loaded"
        ? COUNT_LABELS.filter(([key]) => row.counts[key] > 0).map(([key, label]) =>
            rowNote(t, `${row.counts[key]} ${label}`).text_color(role(t, COUNT_TONES[key])),
          )
        : [
            rowNote(t, row.kind === "invalid" ? "Invalid" : "Unreadable").text_color(
              role(t, "ansi1"),
            ),
          ],
  });

const listingBody = (t: Theme, listing: ListingState, model: PanelModel): Element => {
  let domains: Element;
  if (listing.kind === "loading") {
    domains = message(t, "loading", "Loading…", "Listing the backlogs.", "loading");
  } else if (listing.kind === "unreadable") {
    domains = message(t, "listing-error", "Couldn't list the backlogs", listing.reason, "error");
  } else if (listing.domains.length === 0) {
    domains = message(
      t,
      "no-backlogs",
      "No backlogs yet",
      "Run coordinate start <domain> to create one.",
    );
  } else {
    domains = cardSection(
      cardHeader(t, "domains-header", "Domains"),
      card(t, "domains").children(
        listing.domains.map((row, index) =>
          domainRow(t, row, (cx) => model.openDomain(row.domain, cx), index === 0),
        ),
      ),
    );
  }
  return v_flex()
    .gap(PANEL.sectionGap)
    .child(harnessPolicyCard(t, model.harnessPolicy))
    .child(domains);
};

const domainScreens = (t: Theme, model: PanelModel): Element =>
  v_flex()
    .id("screens")
    .relative()
    .flex_1()
    .min_h_0()
    .child(
      v_flex()
        .id("screen-list")
        .absolute()
        .inset_0()
        .when(
          model.page !== undefined ||
            model.detail !== undefined ||
            model.finding !== undefined ||
            model.flow !== undefined,
          (list) => list.invisible(),
        )
        .child(
          paneScrollRegion(
            "panel-scroll",
            domainBody(t, model.domain!, model.doc, model),
            PANEL.padding,
          ),
        ),
    )
    .when(model.page !== undefined, (screens) =>
      screens.child(
        v_flex()
          .id("screen-page")
          .absolute()
          .inset_0()
          .bg(t.surface)
          .when(
            model.detail !== undefined || model.finding !== undefined || model.flow !== undefined,
            (page) => page.invisible(),
          )
          .child(
            paneScrollRegion(
              "page-scroll",
              model.doc.kind === "loaded"
                ? domainPage(t, model.doc.backlog, model)
                : domainBody(t, model.domain!, model.doc, model),
              PANEL.padding,
            ),
          ),
      ),
    )
    .when(model.detail !== undefined && model.flow === undefined, (screens) =>
      screens.child(
        v_flex()
          .id("screen-item")
          .absolute()
          .inset_0()
          .bg(t.surface)
          .when(model.flow !== undefined, (detail) => detail.invisible())
          .child(
            paneScrollRegion(
              "detail-scroll",
              detailScreen(t, model.detail!, model.delegates, model.answer),
              PANEL.padding,
            ),
          ),
      ),
    )
    .when(model.finding !== undefined, (screens) =>
      screens.child(
        v_flex()
          .id("screen-finding")
          .absolute()
          .inset_0()
          .bg(t.surface)
          .when(model.flow !== undefined, (finding) => finding.invisible())
          .child(
            paneScrollRegion(
              "finding-scroll",
              findingScreen(t, model.finding!, model),
              PANEL.padding,
            ),
          ),
      ),
    )
    .when(model.flow !== undefined, (screens) =>
      screens.child(
        v_flex()
          .id("screen-answer-flow")
          .absolute()
          .inset_0()
          .bg(t.surface)
          .child(answerFlowScreen(t, model.flow!)),
      ),
    );

/**
 * The whole panel: the package frame and toolbar, the breadcrumb trail, then either the domain's
 * screens or the all-domains listing when no domain is focused or opened.
 * @param t The theme.
 * @param model What to draw.
 * @returns The element.
 */
export const panel = (t: Theme, model: PanelModel): Element =>
  panelFrame(t, "coordinate-panel")
    .text_color(t.foreground)
    .text_size(13)
    .child(toolbar(t, model.domain))
    .child(trailBand(t, model.trail, model.go))
    .child(
      panelBody({
        hold: letThrough,
        content:
          model.domain === undefined
            ? paneScrollRegion("panel-scroll", listingBody(t, model.listing, model), PANEL.padding)
            : domainScreens(t, model),
      }),
    );
