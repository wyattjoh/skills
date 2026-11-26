// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div, svg } from "gpui-kit";
import type { Color, Context, Element, FocusHandle } from "gpui-kit";
import { Input, InputState, Popover, TextView, h_flex, v_flex } from "gpui-base";
import { answerInputElement } from "./textarea.ts";
import type { AnswerInputState } from "./textarea.ts";
import {
  BUTTON_STYLE,
  CARD,
  CHIP,
  HERDR_ICONS,
  MENU,
  PANEL,
  ROW,
  TEXT,
  menuPanel,
  menuRow,
  button,
  card,
  cardHeader,
  cardItem,
  cardNote,
  cardRow,
  cardSection,
  crumb,
  crumbBand,
  emptyState,
  errorState,
  foldChevron,
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
  TONES,
} from "@wyattjoh/herdr-ui";
import type { ButtonStyle, Theme } from "@wyattjoh/herdr-ui";
import { isDiscussion, prose, questionOf } from "../../lib/store.ts";
import type {
  AnsweredAsk,
  Ask,
  Backlog,
  Finding,
  Item,
  ItemStatus,
  Prose,
} from "../../lib/store.ts";
import {
  ANSWER,
  ANSWER_CAROUSEL,
  ANSWER_FLOW_SPEED_OPTIONS,
  HERDR_SETTINGS_ICON,
  ANSWER_FLOW_MENU_WIDTH,
  ANSWER_FLOW_OUTLINE,
  ASK_OPTION_NUMBER_WIDTH,
  COUNT_TONES,
  DELEGATE_INDENT,
  DELEGATE_ROW_HEIGHT,
  DELEGATE_TONES,
  EDIT_CHIN_INSET,
  FINDING_GLYPHS,
  FINDING_LINE_HEIGHT,
  FINDING_STATUS_TONES,
  FINDING_TITLE_MAX_LINES,
  GHOST_FILL,
  GLOBE_ICON,
  PROMOTED_TONE,
  QUEUED_TONE,
  STARTING_TONE,
  STATUS_MENU_WIDTH,
  STATUS_TONES,
} from "./look.ts";
import {
  FINDING_KIND_LABELS,
  GROUP_LABELS,
  OUTBOX_LABEL,
  WIKI_LABEL,
  canDeleteField,
  canDismissItem,
  chosenAnswer,
  editKey,
  editableDecisions,
  delegateLabel,
  delegateLine,
  findingStatusLabel,
  formatFindingCounts,
  groupFindings,
  idLinkTarget,
  inlineMarkdown,
  isWebUrl,
  linkIds,
  linkProse,
  markdownPlain,
  promotedItemId,
  rankedOptions,
  tildePath,
} from "./model.ts";
import type {
  AnswerDraft,
  Crumb,
  DelegateJoin,
  DomainPage,
  DelegateRow,
  DelegateState,
  DocumentState,
  DomainSummary,
  EditTarget,
  ItemGroup,
  ItemOrder,
  ListingState,
  OutboxEvent,
  QueuedEntry,
  Screen,
  WikiPage,
} from "./model.ts";
import { layoutAnswerFlowCards } from "./answer-flow.ts";

export type { Theme } from "@wyattjoh/herdr-ui";

const WAITING_PULSE_PERIOD = 1_100;
const WAITING_PULSE_FROM = 0.4;
const WAITING_PULSE_TO = 1;
// Herdr-ui's house glyph is pending, so keep the globe stand-in behind this one-line switch.
const HOME_CRUMB_ICON = GLOBE_ICON;
const HOME_CRUMB_LABEL = "All domains";

/**
 * What the panel draws: the followed domain, its document, and which groups are open.
 */
/**
 * The shown domain's backlog ids that prose links, and what opens the record one names.
 */
export type IdLinks = {
  known: ReadonlySet<string>;
  open: (id: string, cx: Context) => void;
};

export type PanelModel = {
  domain: string | undefined;
  // The user's home folder, shown as ~ at the start of a displayed path; "" when unknown.
  home: string;
  // The ids prose links to, and what a clicked one opens.
  links: IdLinks;
  doc: DocumentState;
  listing: ListingState;
  // The breadcrumb trail to the screen shown, and what opens a crumb's screen.
  trail: Crumb[];
  go: (screen: Screen, cx: Context) => void;
  groups: ItemGroup[];
  // The order within every group, and what flips it.
  itemOrder: ItemOrder;
  toggleItemOrder: (cx: Context) => void;
  // The domain's capacity queue, which the Queued group's rows read their machine and place from,
  // and its watcher events not yet delivered, for the Outbox row and page.
  queued: QueuedEntry[];
  outbox: OutboxEvent[];
  // The domain wiki's pages in index order, for the Wiki row and page; the open page, while the
  // list still has it, with its Markdown body once read; and what opens a page.
  wiki: WikiPage[];
  wikiPage: { page: WikiPage; body: string | undefined } | undefined;
  openWikiPage: (name: string, cx: Context) => void;
  // The active list page, or undefined while the domain's main list is shown.
  page: DomainPage["kind"] | undefined;
  // The open findings.
  findings: Finding[];
  // The finding whose detail screen is on top of the lists, if any, the item it came from and
  // the item it was promoted into, each while the document still has it.
  finding: Finding | undefined;
  origin: Item | undefined;
  promoted: Item | undefined;
  openFinding: (finding: Finding, cx: Context) => void;
  // Approve and Dismiss on the open finding's detail, absent once it is closed.
  findingActions: FindingActionsModel | undefined;
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
  // The open item's Change status control, absent when the item takes no other status.
  statusChange: StatusChangeModel | undefined;
  // The open item's Start, absent for a done, dismissed or delegated item.
  start: StartModel | undefined;
  // The answer being written on the open item's ask, when it has one.
  answer: AnswerModel | undefined;
  // Whether an answered ask on the open item shows in full, by its index in `answered`, and what
  // its Show all / Show less control does. Answered asks start compact.
  askExpanded: (item: Item, index: number) => boolean;
  toggleAsk: (item: Item, index: number, cx: Context) => void;
  flow: AnswerFlowModel | undefined;
  openWaiting: (item: Item, cx: Context) => void;
  // Boundary paths can be edited on either card.
  boundary: BoundaryModel;
  // Edit and Delete on the shown domain's text fields.
  edit: FieldEditModel;
  openHarnessPolicy: (cx: Context) => void;
  // Focuses the shown domain's coordinator, the terminal its lease names; undefined when there is
  // no lease or its terminal is not live here.
  openCoordinator: ((cx: Context) => void) | undefined;
  openDomain: (domain: string, cx: Context) => void;
  // The domain the focused terminal or space names, shown in the toolbar, and what pressing it
  // does: open that domain's page. Undefined when focus names none.
  current: string | undefined;
  openCurrent: (cx: Context) => void;
  // Whether a domain has a live coordinator: its lease names a terminal Herdr lists live here.
  isActive: (domain: string) => boolean;
};

/**
 * A finding detail's Approve and Dismiss: which one is running, the CLI's last refusal, and what
 * each button does.
 */
export type FindingActionsModel = {
  running: "approve" | "dismiss" | undefined;
  // Whether any finding's action is running; the buttons stay inert until it ends.
  busy: boolean;
  error: string | undefined;
  approve: (cx: Context) => void;
  dismiss: (cx: Context) => void;
};

/**
 * An item detail's Change status control: the statuses it offers, whether its menu is open, which
 * status is being set, the CLI's last refusal, and what the button and each choice do.
 */
export type StatusChangeModel = {
  targets: ItemStatus[];
  open: boolean;
  running: ItemStatus | undefined;
  // Whether any item's status change is running; the control stays inert until it ends.
  busy: boolean;
  error: string | undefined;
  toggle: (cx: Context) => void;
  change: (status: ItemStatus, cx: Context) => void;
};

/**
 * An item detail's Start: when the user's pending request was recorded (from the document),
 * whether `item start` is running, the CLI's last refusal, and what the button does.
 */
export type StartModel = {
  pending: string | undefined;
  running: boolean;
  // Whether Start or Change status is running on any item; both stay inert until it ends.
  busy: boolean;
  error: string | undefined;
  start: (cx: Context) => void;
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
  // In the answer flow only: leave the question for later, and close its item as dismissed (absent
  // when the item cannot be closed). Outside the flow both are undefined and the card has neither.
  skip: ((cx: Context) => void) | undefined;
  dismiss: ((cx: Context) => void) | undefined;
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
  // The user's home folder, shown as ~ at the start of a displayed path; "" when unknown.
  home: string;
  links: IdLinks;
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
  measureViewport: (size: { width: number; height: number }, cx: Context) => void;
  measure: (
    id: string,
    kind: "compact" | "expanded",
    size: { width: number; height: number },
    cx: Context,
  ) => void;
  position: number;
  total: number;
  done: boolean;
  answeredCount: number;
  skippedCount: number;
  // Answers waiting for Send all and back, whether it is running, and why it last failed.
  queuedCount: number;
  sending: boolean;
  sendError: string | undefined;
  send: (cx: Context) => void;
  answer: AnswerModel | undefined;
  answerFor: (id: string) => AnswerModel | undefined;
  back: (cx: Context) => void;
  skip: (cx: Context) => void;
};

/**
 * Edit and Delete on a record's text fields, each field named by its `editKey`: the field being
 * edited and its editor's state, the list entry waiting on its Delete? confirmation, the field
 * whose save or delete is running, the CLI's last refusal, and what each control does.
 */
export type FieldEditModel = {
  editing: string | undefined;
  input: AnswerInputState | undefined;
  confirming: string | undefined;
  running: string | undefined;
  error: { key: string; message: string } | undefined;
  begin: (target: EditTarget, cx: Context) => void;
  cancel: (cx: Context) => void;
  save: (cx: Context) => void;
  remove: (target: EditTarget, cx: Context) => void;
};

export type BoundaryList = "owned" | "adjacent";

export type BoundaryModel = {
  domain: string;
  editing: BoundaryList | undefined;
  input: InputState | undefined;
  busy: boolean;
  error:
    | { domain: string; list: BoundaryList; path: string | undefined; message: string }
    | undefined;
  begin: (list: BoundaryList, cx: Context) => void;
  cancel: (cx: Context) => void;
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

// A live coordinator's mark: the label chip's color dot, in the success tone.
const activeDot = (t: Theme): Element =>
  div()
    .size(CHIP.dotSize)
    .flex_none()
    .rounded(CHIP.dotSize / 2)
    .bg(role(t, TONES.success));

// The focused domain's name, muted like a crumb, before Open coordinator: it opens that domain's
// page, with the live-coordinator dot beside it.
const currentDomain = (t: Theme, model: PanelModel): Element[] =>
  model.current === undefined
    ? []
    : [
        h_flex()
          .min_w_0()
          .text_color(t.muted)
          .child(
            crumb(t, {
              id: "toolbar-domain",
              label: model.current,
              icon: model.isActive(model.current) ? activeDot(t) : undefined,
              onClick: model.openCurrent,
            }),
          ),
      ];

// Match Files' plain header row, with the harness policy cog in the trailing slot, the focused
// domain's name before it.
const toolbar = (t: Theme, model: PanelModel): Element => {
  const { openHarnessPolicy, openCoordinator } = model;
  return h_flex()
    .id("toolbar")
    .h(42)
    .flex_none()
    .px(14)
    .gap(8)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .child(div().font_semibold().child("Backlog"))
    .child(div().flex_1())
    .children(currentDomain(t, model))
    .children(
      openCoordinator === undefined
        ? []
        : [
            button(t, {
              id: "coordinator-open",
              label: "Open coordinator",
              labelled: false,
              icon: HERDR_ICONS.terminal,
              onClick: openCoordinator,
            }),
          ],
    )
    .child(
      button(t, {
        id: "harness-policy-open",
        label: "Delegate harness policy",
        labelled: false,
        icon: HERDR_SETTINGS_ICON,
        onClick: openHarnessPolicy,
      }),
    );
};

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

// A prose field: native Markdown for its Markdown sibling (inline fields on one line), else its
// plain text exactly as before.
const proseChild = (
  t: Theme,
  id: string,
  value: Prose,
  links: IdLinks,
  options: { inline?: boolean; size?: number; color?: Color } = {},
): Element | string => {
  const shown = linkProse(value, links.known);
  return shown.markdown
    ? linkedMarkdown(id, options.inline ? inlineMarkdown(shown.value) : shown.value, links)
        .selectable()
        .text_size(options.size ?? TEXT.body)
        .text_color(options.color ?? t.foreground)
    : shown.value;
};

// A prose field with the shown domain's ids linked, for a caller that draws plain text itself.
const linkedProse = (value: Prose | null, links: IdLinks): Prose | null =>
  value === null ? null : linkProse(value, links.known);

// Native Markdown whose links open in the panel: an id link opens its record, a web link the
// system browser, and anything else nothing.
const linkedMarkdown = (id: string, markdown: string, links: IdLinks) =>
  TextView.markdown(id, markdown).on_link_click((url, cx) => {
    const target = idLinkTarget(url);
    if (target !== undefined) links.open(target, cx);
    else if (isWebUrl(url)) cx.open_url(url);
  });

// A detail row gives the focus text the card's inner padding, like every other card row.
const focusHeader = (t: Theme, links: IdLinks, focus: Prose | null): Element =>
  detailRow(t, "focus")
    .border_t(0)
    .text_size(TEXT.body)
    .text_color(focus === null ? t.dim : t.foreground)
    .child(
      focus === null
        ? "No focus set"
        : proseChild(t, "focus-markdown", focus, links, { inline: true }),
    );

const focusCard = (t: Theme, links: IdLinks, focus: Prose | null, edit: FieldEditModel): Element =>
  cardSection(
    cardHeader(t, "focus-header", "Focus"),
    card(t, "focus-card").children(
      editableRows(t, edit, { kind: "focus" }, focusHeader(t, links, focus)),
    ),
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
      ...(row.machine === undefined ? [] : [small(t, t.muted, row.machine).flex_none()]),
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

// An item with a pending start request reads Starting, in the building tone, until the request
// clears; the row stays in its stored status's group.
const startingChip = (t: Theme, item: Item): Element =>
  labelChip(t, {
    id: `starting-${item.id}`,
    label: "Starting",
    icon: HERDR_ICONS.clock,
    color: role(t, STARTING_TONE),
  }).text_color(role(t, STARTING_TONE));

// The item id leads the title on the package row; a Starting or delegated item's chip stays at the
// end.
const itemRow = (
  t: Theme,
  item: Item,
  rows: DelegateRow[],
  open: (item: Item, cx: Context) => void,
  mark: Element | undefined = undefined,
  note: Element | undefined = undefined,
): Element => {
  const line = delegateLine(rows);
  const row = listRow(t, {
    id: `item-${item.id}`,
    label: item.id,
    title: item.title,
    titleRole: item.status === "dismissed" ? "dim" : "foreground",
    ...(mark === undefined ? {} : { mark }),
    height: ROW.compact,
    trailing: [
      ...(note === undefined ? [] : [note]),
      ...(item.startRequested === undefined ? [] : [startingChip(t, item)]),
      ...(line === undefined ? [] : [delegateChip(t, item, line)]),
    ],
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
  const queued = new Map(model.queued.map((entry) => [entry.item, entry] as const));
  return groupBlock(t, motionScope, {
    id,
    label: group.label,
    tone: group.status === "queued" ? QUEUED_TONE : STATUS_TONES[group.status],
    count: group.items.length,
    rows: pagedRows(t, id, group.items, model, ROW.compact, (item) => {
      const entry = group.status === "queued" ? queued.get(item.id) : undefined;
      return itemRow(
        t,
        item,
        delegates.byItem.get(item.id) ?? [],
        openItem,
        undefined,
        entry === undefined ? undefined : queuedNote(t, entry),
      );
    }),
    rowHeight: ROW.compact,
    open,
    first,
    last,
    toggle,
  });
};

// A Queued row's target machine and its place in that machine's queue.
const queuedNote = (t: Theme, entry: QueuedEntry): Element =>
  rowNote(t, `${entry.machine} · #${entry.position}`).id(`queued-${entry.item}`);

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

// Herdr ships no sort or arrow icon, so the order button is a text glyph, like Boundary's "+".
const ITEM_ORDER_BUTTONS: Readonly<Record<ItemOrder, { glyph: string; label: string }>> = {
  newest: { glyph: "↓", label: "Newest first" },
  oldest: { glyph: "↑", label: "Oldest first" },
};

const itemsHeader = (t: Theme, model: PanelModel): Element => {
  const { glyph, label } = ITEM_ORDER_BUTTONS[model.itemOrder];
  return cardHeader(t, "items-header", "Items")
    .child(div().flex_1())
    .child(
      button(t, {
        id: "items-order",
        label: glyph,
        tooltip: label,
        onClick: (cx) => model.toggleItemOrder(cx),
      }).accessibility_label(label),
    );
};

const itemsCard = (t: Theme, model: PanelModel): Element =>
  cardSection(
    itemsHeader(t, model),
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

// listRow fixes its height and truncates its title to one line, so a finding row is a card row
// whose title wraps to FINDING_TITLE_MAX_LINES and clips. A one-line row keeps ROW.compact.
const findingRow = (
  t: Theme,
  finding: Finding,
  open: (finding: Finding, cx: Context) => void,
  first = false,
): Element =>
  cardRow(t, `finding-${finding.id}`, t.hover, first)
    .items_start()
    .min_h(ROW.compact)
    .py((ROW.compact - FINDING_LINE_HEIGHT) / 2)
    .on_click((_event, cx) => open(finding, cx))
    .child(
      div()
        .flex_none()
        .text_size(TEXT.label)
        .line_height(`${FINDING_LINE_HEIGHT}px`)
        .text_color(role(t, FINDING_GLYPHS[finding.kind].tone))
        .child(FINDING_GLYPHS[finding.kind].glyph),
    )
    .child(
      div()
        .flex_none()
        .text_size(TEXT.label)
        .line_height(`${FINDING_LINE_HEIGHT}px`)
        .text_color(t.muted)
        .child(finding.id),
    )
    .child(
      div()
        .flex_1()
        .min_w_0()
        .whitespace_normal()
        .text_size(TEXT.body)
        .line_height(`${FINDING_LINE_HEIGHT}px`)
        .max_h(FINDING_LINE_HEIGHT * FINDING_TITLE_MAX_LINES)
        .overflow_hidden()
        .text_ellipsis()
        .text_color(role(t, finding.status === "dismissed" ? "dim" : "foreground"))
        .child(finding.title),
    );

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

// A labelled fact: a muted label, then its values one per row at full width (paths are long, so
// never side by side), or None in dim.
const fact = (
  t: Theme,
  id: string,
  label: string,
  values: (string | Element)[],
  row: (t: Theme, id: string) => Element = detailRow,
): Element =>
  row(t, id)
    .child(small(t, t.muted, label))
    .child(
      values.length === 0
        ? div().text_color(t.dim).child("None")
        : v_flex()
            .id(`${id}-values`)
            .w_full()
            .min_w_0()
            .gap(BUTTON_STYLE.gap)
            .children(
              values.map((value, index) =>
                div().id(`${id}-value-${index}`).w_full().min_w_0().child(value),
              ),
            ),
    );

// A fact's values for one prose field: none, or its Markdown or text.
const proseValues = (
  t: Theme,
  links: IdLinks,
  id: string,
  text: string | null,
  markdown: string | undefined,
): (string | Element)[] => {
  const value = prose(text, markdown);
  return value === null ? [] : [proseChild(t, id, value, links)];
};

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

// The answer field is app-specific; the package owns its surrounding card item and button.
const askBodyRow = (t: Theme, id: string): Element => detailRow(t, id).bg(t.surface);

// A quieter button for the actions beside Answer: the raised fill with the ordinary ink.
const ANSWER_SECONDARY_BUTTON_STYLE: ButtonStyle = {
  ...ANSWER_BUTTON_STYLE,
  background: "raised",
  text: "foreground",
  hover: "hover",
};

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
    .pt(ANSWER.fieldPaddingTop)
    .rounded(ANSWER.radius)
    .border_1()
    .border_color(typing ? t.accent : t.border)
    .cursor_text()
    // The textarea draws its text from its top edge, so the field pads the top by the amount that
    // centers one line in the field's height, and grows with the text past one row.
    .when(input !== undefined, (el) =>
      el.child(answerInputElement(input!).w_full().text_size(TEXT.body).text_color(t.foreground)),
    );

// A ghost button: the panel button's metrics and hover fill with no fill or border at rest.
const ghostButton = (t: Theme, options: Parameters<typeof button>[1]): Element =>
  button(t, { ...options, style: BUTTON_STYLE }).bg(GHOST_FILL);

// A field's chin: a full-width bar ruled off from the field above it, holding the field's ghost
// buttons at its right end. Displayed, it shows Delete (on a list entry) then Edit; while the
// editor is open, Cancel then Save; while a delete asks, Delete? with Cancel then Delete. A running
// save or delete keeps every button inert.
const editChin = (t: Theme, edit: FieldEditModel, target: EditTarget): Element => {
  const key = editKey(target);
  const busy = edit.running !== undefined;
  const buttons =
    edit.editing === key
      ? [
          ghostButton(t, {
            id: `editor-${key}-cancel`,
            label: "Cancel",
            onClick: busy ? undefined : (cx) => edit.cancel(cx),
          }),
          ghostButton(t, {
            id: `editor-${key}-save`,
            label: edit.running === key ? "Saving…" : "Save",
            onClick: busy ? undefined : (cx) => edit.save(cx),
          }),
        ]
      : edit.confirming === key
        ? [
            small(t, t.muted, edit.running === key ? "Deleting…" : "Delete?").id(
              `delete-ask-${key}`,
            ),
            ghostButton(t, {
              id: `delete-cancel-${key}`,
              label: "Cancel",
              onClick: busy ? undefined : (cx) => edit.cancel(cx),
            }),
            ghostButton(t, {
              id: `delete-confirm-${key}`,
              label: "Delete",
              onClick: busy ? undefined : (cx) => edit.remove(target, cx),
            }),
          ]
        : [
            ...(canDeleteField(target)
              ? [
                  ghostButton(t, {
                    id: `delete-${key}`,
                    label: "Delete",
                    icon: HERDR_ICONS.close,
                    labelled: false,
                    tooltip: "Delete",
                    onClick: busy ? undefined : (cx) => edit.remove(target, cx),
                  }),
                ]
              : []),
            ghostButton(t, {
              id: `edit-${key}`,
              label: "Edit",
              tooltip: "Edit",
              onClick: busy ? undefined : (cx) => edit.begin(target, cx),
            }),
          ];
  return staticRow(t, `edit-chin-${key}`)
    .w_full()
    .h(BUTTON_STYLE.height + EDIT_CHIN_INSET * 2)
    .justify_end()
    .gap(BUTTON_STYLE.gap)
    .children(buttons);
};

// The CLI's last refusal for a field, on its own row above the field's chin.
const editErrorRows = (t: Theme, edit: FieldEditModel, key: string): Element[] =>
  edit.error?.key === key
    ? [
        detailRow(t, `edit-error-row-${key}`).child(
          div()
            .id(`edit-error-${key}`)
            .text_size(TEXT.label)
            .text_color(role(t, "ansi1"))
            .child(edit.error.message),
        ),
      ]
    : [];

// The open editor in place of a field: the multi-line field (the answer field's), any refusal,
// then the chin with Cancel and Save.
const fieldEditorRows = (t: Theme, edit: FieldEditModel, target: EditTarget): Element[] => {
  const key = editKey(target);
  return [
    detailRow(t, `editor-${key}`)
      .flex_col()
      .items_stretch()
      .child(answerField(t, `editor-${key}-field`, edit.input, true)),
    ...editErrorRows(t, edit, key),
    editChin(t, edit, target),
  ];
};

// A field's display row, any refusal, then its chin; or its editor while it is being edited.
const editableRows = (
  t: Theme,
  edit: FieldEditModel,
  target: EditTarget,
  row: Element,
): Element[] => {
  const key = editKey(target);
  if (edit.editing === key) return fieldEditorRows(t, edit, target);
  return [row, ...editErrorRows(t, edit, key), editChin(t, edit, target)];
};

// One element for a slot that takes a single child: the row itself, or the rows stacked.
const oneOf = (id: string, rows: Element[]): Element =>
  rows.length === 1 ? rows[0]! : v_flex().id(id).w_full().children(rows);

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
  const inFlow = answer.skip !== undefined;
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
  const secondary = (id: string, label: string, onClick: ((cx: Context) => void) | undefined) =>
    button(t, {
      id: `${prefix}-answer-${id}`,
      label,
      style: ANSWER_SECONDARY_BUTTON_STYLE,
      onClick: draft.busy ? undefined : onClick,
    });
  // In the flow the text field has its own full-width row, then one right-aligned row of buttons:
  // Answer, Skip and, where the item can be closed, Dismiss.
  const inputRows = inFlow
    ? [
        askBodyRow(t, `${prefix}-answer`).child(field),
        askBodyRow(t, `${prefix}-answer-actions`).child(
          h_flex()
            .gap(ANSWER.gap)
            .justify_end()
            .child(submit)
            .child(secondary("skip", "Skip", answer.skip))
            .when(answer.dismiss !== undefined, (el) =>
              el.child(secondary("dismiss", "Dismiss", answer.dismiss)),
            ),
        ),
      ]
    : [
        askBodyRow(t, `${prefix}-answer`).child(
          h_flex().gap(ANSWER.gap).child(field).child(submit),
        ),
      ];
  return [
    ...inputRows,
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

const questionChild = (t: Theme, links: IdLinks, id: string, ask: Ask): Element | string =>
  proseChild(
    t,
    id,
    prose(ask.question, ask.questionMarkdown) ?? { markdown: false, value: "" },
    links,
    {
      inline: true,
    },
  );

// The answer flow's question card: a block prompt, then choices ruled off from each other that take
// the selected fill and a check when picked, and the recommendation's reason inline under its choice.
// No part of an ask card has its own border or rounded corners; the card's outline holds them all.
const answerFlowPrompt = (t: Theme, links: IdLinks, id: string, ask: Ask): Element => {
  const question = div()
    .id(`${id}-question`)
    .min_w_0()
    .font_medium()
    .text_size(TEXT.body)
    .text_color(t.foreground)
    .child(questionChild(t, links, `${id}-question-markdown`, ask));
  const contextProse = prose(ask.context, ask.contextMarkdown);
  const context =
    contextProse === null
      ? undefined
      : div()
          .id(`${id}-context`)
          .min_w_0()
          .text_size(TEXT.body)
          .text_color(t.muted)
          .child(proseChild(t, `${id}-context-markdown`, contextProse, links, { color: t.muted }));
  return v_flex()
    .id(`${id}-question-block`)
    .min_w_0()
    .bg(t.popover)
    .px(CARD.paddingX)
    .py(CARD.paddingY)
    .child(question)
    .when(context !== undefined, (el) => el.child(context!));
};

const answerFlowOptionStyle = (row: Element, t: Theme, selected: boolean): Element =>
  row
    .w_full()
    .min_w_0()
    .px(ANSWER_FLOW_OUTLINE.paddingX)
    .py(ANSWER_FLOW_OUTLINE.paddingY)
    .gap(BUTTON_STYLE.gap)
    .bg(selected ? t.selected : role(t, ANSWER_FLOW_OUTLINE.optionSurface))
    .text_color(t.foreground)
    .border_t(1)
    .border_color(t.border)
    .when(selected, (el) => el.font_semibold());

const answerChild = (
  t: Theme,
  links: IdLinks,
  id: string,
  answered: AnsweredAsk,
): Element | string =>
  proseChild(
    t,
    id,
    prose(answered.answer, answered.answerMarkdown) ?? { markdown: false, value: "" },
    links,
    { inline: true },
  );

// An answered ask's answer line: the answer as prose, then when it was given.
const answerRow = (t: Theme, links: IdLinks, id: string, answered: AnsweredAsk): Element =>
  askBodyRow(t, `${id}-answer`)
    .child(small(t, t.muted, "Answer"))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .child(answerChild(t, links, `${id}-answer-markdown`, answered)),
    )
    .child(small(t, t.muted, answered.answeredAt));

// An answered ask's note row, when the answer carried one.
const answerNoteRows = (t: Theme, links: IdLinks, id: string, answered: AnsweredAsk): Element[] => {
  const note = prose(answered.note, answered.noteMarkdown);
  return note === null
    ? []
    : [
        askBodyRow(t, `${id}-answer-note`)
          .child(small(t, t.muted, "Note"))
          .child(
            div()
              .flex_1()
              .min_w_0()
              .child(proseChild(t, `${id}-answer-note-markdown`, note, links)),
          ),
      ];
};

const askCardRows = (
  t: Theme,
  links: IdLinks,
  id: string,
  ask: Ask,
  answer: AnswerModel | undefined,
  completed: AnsweredAsk | undefined,
  itemTouches: string[] | undefined,
  flowHeader = false,
): Element[] => {
  // Notes do not replace the picked option; completed cards have no active draft.
  const picked =
    completed !== undefined
      ? completed.answer
      : answer === undefined
        ? ask.rec
        : answer.draft.discuss
          ? undefined
          : answer.draft.choice;
  const question = flowHeader
    ? answerFlowPrompt(t, links, id, ask)
    : detailRow(t, `${id}-question`)
        .bg(t.popover)
        .font_medium()
        .child(questionChild(t, links, `${id}-question-markdown`, ask));
  const contextProse = prose(ask.context, ask.contextMarkdown);
  const context =
    !flowHeader && contextProse !== null
      ? [
          askBodyRow(t, `${id}-context`)
            .text_color(t.muted)
            .child(
              proseChild(t, `${id}-context-markdown`, contextProse, links, { color: t.muted }),
            ),
        ]
      : [];
  const reasonProse = prose(ask.recReason, ask.recReasonMarkdown);
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
    const detailProse = prose(ask.optionDetails?.[index], ask.optionDetailsMarkdown?.[index]);
    const detail =
      detailProse === null
        ? undefined
        : div()
            .id(`${id}-detail-${index}`)
            .min_w_0()
            .text_size(TEXT.label)
            .text_color(tagTone ?? t.muted)
            .child(
              proseChild(t, `${id}-detail-${index}-markdown`, detailProse, links, {
                size: TEXT.label,
                color: tagTone ?? t.muted,
              }),
            );
    const inlineReason =
      rec && reasonProse !== null
        ? div()
            .id(`${id}-rec-reason`)
            .min_w_0()
            .bg(t.popover)
            .px(CARD.paddingX)
            .py(CARD.paddingY)
            .text_size(TEXT.label)
            .text_color(t.muted)
            .child(
              v_flex()
                .gap(BUTTON_STYLE.gap)
                .child(small(t, t.muted, "Why recommended").id(`${id}-rec-reason-label`))
                .child(
                  div()
                    .min_w_0()
                    .child(
                      proseChild(t, `${id}-rec-reason-markdown`, reasonProse!, links, {
                        size: TEXT.label,
                        color: t.muted,
                      }),
                    ),
                ),
            )
        : undefined;
    const content = v_flex()
      .id(`${id}-content-${index}`)
      .flex_1()
      .min_w_0()
      .gap(BUTTON_STYLE.gap)
      .child(heading)
      .when(detail !== undefined, (el) => el.child(detail!))
      .when(inlineReason !== undefined, (el) => el.child(inlineReason!));
    const row = flowHeader ? v_flex().id(optionId) : askBodyRow(t, optionId);
    const styled = flowHeader
      ? answerFlowOptionStyle(row, t, selected)
      : row.when(selected, (el) => el.bg(t.selected));
    const selectionCue = flowHeader
      ? selected
        ? svg(HERDR_ICONS.circleCheck)
            .id(`${optionId}-selection-marker`)
            .size(ANSWER_FLOW_OUTLINE.markerSize)
            .flex_none()
            .text_color(t.foreground)
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
              flowHeader ? (selected ? t.selected : t.hover) : selected ? t.selected : t.hover,
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
  const discussNote =
    ask.discuss === null
      ? null
      : linkedProse(prose(ask.discuss.note, ask.discuss.noteMarkdown), links);
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
                    .when(discussNote !== null, (el) =>
                      el.child(
                        discussNote!.markdown
                          ? v_flex()
                              .id(`${id}-discuss-note`)
                              .gap(BUTTON_STYLE.gap)
                              .child(small(t, t.muted, "Note"))
                              .child(
                                proseChild(t, `${id}-discuss-note-markdown`, discussNote!, links, {
                                  size: TEXT.label,
                                  color: t.muted,
                                }),
                              )
                          : small(t, t.muted, `Note: ${discussNote!.value}`).id(
                              `${id}-discuss-note`,
                            ),
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
      : completed.answer !== undefined && completed.options.includes(completed.answer)
        ? [
            askBodyRow(t, `${id}-answered-at`)
              .child(small(t, t.muted, "Answered"))
              .child(div().child(completed.answeredAt)),
          ]
        : [answerRow(t, links, id, completed)];
  if (completed !== undefined) completion.push(...answerNoteRows(t, links, id, completed));
  return [question, ...context, ...touches, ...optionItems, ...discussion, ...completion];
};

// A full-width row on an answered ask card's bottom edge that shows or hides the rest of the card,
// with the document card's chevron and Show less label.
const askRevealRow = (
  t: Theme,
  id: string,
  expanded: boolean,
  toggle: (cx: Context) => void,
): Element =>
  cardRow(t, `${id}-reveal`)
    .h(BUTTON_STYLE.height)
    .justify_center()
    .gap(BUTTON_STYLE.gap)
    .text_size(BUTTON_STYLE.textSize)
    .text_color(t.muted)
    .on_click((_event, cx) => toggle(cx))
    .child(
      svg(expanded ? HERDR_ICONS.chevronDown : HERDR_ICONS.chevronRight).size(
        BUTTON_STYLE.iconSize,
      ),
    )
    .child(expanded ? "Show less" : "Show all");

const askCard = (
  t: Theme,
  links: IdLinks,
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
    askCardRows(t, links, id, ask, answer, completed, itemTouches),
  ),
];

// An answered ask starts compact, its question, context and answer line (with its note) above its
// reveal row; expanded, it is the full answered card with the same row below.
const answeredAskCard = (
  t: Theme,
  links: IdLinks,
  id: string,
  answered: AnsweredAsk,
  expanded: boolean,
  toggle: (cx: Context) => void,
): Element => {
  const rows = askCardRows(t, links, id, answered, undefined, answered, undefined);
  const contextRows = prose(answered.context, answered.contextMarkdown) === null ? 0 : 1;
  const shown = expanded
    ? rows
    : [
        ...rows.slice(0, 1 + contextRows),
        answerRow(t, links, id, answered),
        ...answerNoteRows(t, links, id, answered),
      ];
  return detailCard(t, id, "Answered ask", [...shown, askRevealRow(t, id, expanded, toggle)]);
};

const askCards = (
  t: Theme,
  links: IdLinks,
  item: Item,
  answer: AnswerModel | undefined,
  home: string,
  expanded: (index: number) => boolean,
  toggle: (index: number, cx: Context) => void,
): Element[] => {
  const touches = item.touches.map((path) => tildePath(path, home));
  const cards =
    item.ask === null ? [] : askCard(t, links, "ask", item.ask, answer, undefined, touches);
  for (let index = item.answered.length - 1; index >= 0; index -= 1) {
    cards.push(
      answeredAskCard(
        t,
        links,
        `ask-answered-${index}`,
        item.answered[index]!,
        expanded(index),
        (cx) => toggle(index, cx),
      ),
    );
  }
  return cards;
};

// A coordinator's decisions have Edit and Delete; answer records stay read-only.
const decidedCard = (t: Theme, links: IdLinks, item: Item, edit: FieldEditModel): Element[] => {
  const keys = new Map(editableDecisions(item).map(({ entry, key }) => [entry, key]));
  const decisions = item.decided.filter((entry) => !isDiscussion(entry.text));
  return decisions.length === 0
    ? []
    : [
        detailCard(
          t,
          "decided",
          "Decided",
          decisions.flatMap((entry, index) => {
            const row = detailRow(t, `decided-${index}`)
              .child(
                div().child(
                  proseChild(
                    t,
                    `decided-${index}-markdown`,
                    prose(entry.text, entry.markdown) ?? { markdown: false, value: "" },
                    links,
                  ),
                ),
              )
              .child(small(t, t.dim, entry.at.slice(0, 10)));
            const key = keys.get(entry);
            return key === undefined
              ? [row]
              : editableRows(t, edit, { kind: "decision", id: item.id, key }, row);
          }),
        ),
      ];
};

// A record's title row, then its editor while it is being edited, any refusal, and its chin.
const editableTitle = (
  t: Theme,
  edit: FieldEditModel,
  target: EditTarget,
  title: Element,
): Element[] => {
  const key = editKey(target);
  return edit.editing === key
    ? [title, ...fieldEditorRows(t, edit, target)]
    : [title, ...editErrorRows(t, edit, key), editChin(t, edit, target)];
};

// A delegate's labelled path: the label, then the path on its own full-width row.
const delegatePath = (t: Theme, id: string, label: string, path: string, home: string): Element =>
  v_flex()
    .id(id)
    .w_full()
    .min_w_0()
    .child(small(t, t.muted, label))
    .child(small(t, t.foreground, tildePath(path, home)).id(`${id}-path`).w_full().min_w_0());

const delegatesCard = (t: Theme, item: Item, rows: DelegateRow[], home: string): Element[] =>
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
                  .children(ref.machine === undefined ? [] : [small(t, t.muted, ref.machine)])
                  .children(
                    rows
                      .filter((row) => row.source === "ref" && row.key === ref.session)
                      .slice(0, 1)
                      .map((row) => small(t, delegateTone(t, row.state), delegateLabel(row.state))),
                  ),
              )
              .child(delegatePath(t, `delegate-${ref.session}-brief`, "Brief", ref.brief, home))
              .child(delegatePath(t, `delegate-${ref.session}-report`, "Report", ref.report, home)),
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

// An item a finding names (the one it came from, or the one it was promoted into): a link to
// its detail while the document has it, else its id as the finding names it.
const itemLink = (
  t: Theme,
  linkId: string,
  id: string,
  linked: Item | undefined,
  open: (item: Item, cx: Context) => void,
): Element =>
  linked === undefined
    ? div().child(id)
    : h_flex()
        .id(linkId)
        .gap(CARD.rowGap)
        .cursor_pointer()
        .text_color(t.accent)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_event, cx) => open(linked, cx))
        .child(div().flex_none().child(linked.id))
        .child(div().flex_1().min_w_0().child(linked.title));

// The item a finding came from, linked as itemLink does, or None.
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
        : itemLink(t, "fact-origin-link", from, origin, open),
    );

// A finding's status in its own card above Details, in its status tone; a promoted finding's
// status is followed by the item it was promoted into.
const findingStatusCard = (
  t: Theme,
  finding: Finding,
  promotedId: string | undefined,
  model: PanelModel,
): Element =>
  detailCard(t, "finding-state", "Status", [
    detailRow(t, "finding-state-row").child(
      h_flex()
        .id("finding-state-line")
        .w_full()
        .min_w_0()
        .gap(CARD.rowGap)
        .items_center()
        .child(
          div()
            .id("finding-status")
            .flex_none()
            .text_color(
              role(
                t,
                promotedId === undefined ? FINDING_STATUS_TONES[finding.status] : PROMOTED_TONE,
              ),
            )
            .child(findingStatusLabel(finding)),
        )
        .when(promotedId !== undefined, (el) =>
          el.child(
            div()
              .id("finding-promoted")
              .flex_1()
              .min_w_0()
              .child(itemLink(t, "finding-promoted-link", promotedId!, model.promoted, model.open)),
          ),
        ),
    ),
  ]);

// The scroll viewport is supplied by herdr-ui at the screen boundary. This content stays
// mounted below the list so its own viewport retains position while the user navigates back.
// Its status sits in a card of its own, so the title row has no status column. A promoted
// finding's outcome is the item beside its status, so it shows no Outcome row as well.
const findingScreen = (t: Theme, finding: Finding, model: PanelModel): Element => {
  const promotedId = promotedItemId(finding);
  return v_flex()
    .id("finding")
    .gap(PANEL.sectionGap)
    .children(
      editableTitle(
        t,
        model.edit,
        { kind: "finding", id: finding.id, field: "title" },
        titleRow(t, { id: "finding-title", identifier: finding.id, title: finding.title }),
      ),
    )
    .child(findingStatusCard(t, finding, promotedId, model))
    .child(
      detailCard(t, "finding-facts", "Details", [
        fact(t, "fact-kind", "Kind", [FINDING_KIND_LABELS[finding.kind]]),
        ...editableRows(
          t,
          model.edit,
          { kind: "finding", id: finding.id, field: "detail" },
          fact(
            t,
            "fact-detail",
            "Detail",
            proseValues(
              t,
              model.links,
              "fact-detail-markdown",
              finding.detail,
              finding.detailMarkdown,
            ),
          ),
        ),
        fact(
          t,
          "fact-path",
          "Path",
          finding.path === null ? [] : [tildePath(finding.path, model.home)],
        ),
        originFact(t, finding.from, model.origin, model.open),
        ...(finding.closedAt === null
          ? []
          : [fact(t, "fact-closed", "Closed", [finding.closedAt.slice(0, 10)])]),
        ...(finding.status === "open" ||
        prose(finding.outcome, finding.outcomeMarkdown) === null ||
        promotedId !== undefined
          ? []
          : editableRows(
              t,
              model.edit,
              { kind: "finding", id: finding.id, field: "outcome" },
              fact(
                t,
                "fact-outcome",
                "Outcome",
                proseValues(
                  t,
                  model.links,
                  "fact-outcome-markdown",
                  finding.outcome,
                  finding.outcomeMarkdown,
                ),
              ),
            )),
      ]),
    )
    .when(model.findingActions !== undefined, (el) =>
      el.children(findingActionRows(t, model.findingActions!)),
    );
};

// Approve and Dismiss, right-aligned like the answer flow's actions, then any refusal.
const findingActionRows = (t: Theme, actions: FindingActionsModel): Element[] => {
  const { busy } = actions;
  return [
    h_flex()
      .id("finding-actions")
      .gap(ANSWER.gap)
      .justify_end()
      .child(
        button(t, {
          id: "finding-actions-approve",
          label: actions.running === "approve" ? "Approving…" : "Approve",
          style: ANSWER_BUTTON_STYLE,
          onClick: busy ? undefined : (cx) => actions.approve(cx),
        }),
      )
      .child(
        button(t, {
          id: "finding-actions-dismiss",
          label: actions.running === "dismiss" ? "Dismissing…" : "Dismiss",
          style: ANSWER_SECONDARY_BUTTON_STYLE,
          onClick: busy ? undefined : (cx) => actions.dismiss(cx),
        }),
      ),
    ...(actions.error === undefined
      ? []
      : [
          div()
            .id("finding-action-error")
            .text_size(TEXT.label)
            .text_color(role(t, "ansi1"))
            .child(actions.error),
        ]),
  ];
};

// Start's label: running, then a pending request (the button is inert until it clears), then idle.
const startLabel = (start: StartModel): string =>
  start.running ? "Starting…" : start.pending === undefined ? "Start" : "Start requested";

// Start and Change status, right-aligned like a finding's actions, Start first as the primary
// action. Change status's menu is plain state drawn in the flow below the buttons (not a Popover,
// which also reacts to its trigger's press), then any refusal.
const itemActionRows = (
  t: Theme,
  change: StatusChangeModel | undefined,
  start: StartModel | undefined,
): Element[] => [
  h_flex()
    .id("item-actions")
    .gap(ANSWER.gap)
    .justify_end()
    .when(start !== undefined, (el) => {
      const enabled = !start!.busy && start!.pending === undefined;
      return el.child(
        button(t, {
          id: "item-actions-start",
          label: startLabel(start!),
          style: enabled ? ANSWER_BUTTON_STYLE : { ...ANSWER_BUTTON_STYLE, background: "raised" },
          onClick: enabled ? (cx) => start!.start(cx) : undefined,
        }),
      );
    })
    .when(change !== undefined, (el) =>
      el.child(
        button(t, {
          id: "item-actions-status",
          label:
            change!.running === undefined
              ? "Change status"
              : `Moving to ${GROUP_LABELS[change!.running]}…`,
          icon: HERDR_ICONS.chevronDown,
          style: ANSWER_SECONDARY_BUTTON_STYLE,
          onClick: change!.busy ? undefined : (cx) => change!.toggle(cx),
        }),
      ),
    ),
  ...(start?.error === undefined
    ? []
    : [
        div()
          .id("item-start-error")
          .text_size(TEXT.label)
          .text_color(role(t, "ansi1"))
          .child(start.error),
      ]),
  ...(change === undefined ? [] : statusMenuRows(t, change)),
];

// Change status's open menu, then its refusal.
const statusMenuRows = (t: Theme, change: StatusChangeModel): Element[] => {
  const { busy } = change;
  return [
    ...(change.open && !busy
      ? [
          h_flex()
            .id("item-status-menu")
            .justify_end()
            .child(
              menuPanel(t, STATUS_MENU_WIDTH, MENU.padding)
                .id("item-status-options")
                .role("menu")
                .accessibility_label("Change status")
                .children(
                  change.targets.map((status, index) =>
                    menuRow(t, {
                      id: `item-status-option-${status}`,
                      label: GROUP_LABELS[status],
                      onClick: (cx) => change.change(status, cx),
                    })
                      .role("menu_item")
                      .set_position(index + 1, change.targets.length),
                  ),
                ),
            ),
        ]
      : []),
    ...(change.error === undefined
      ? []
      : [
          div()
            .id("item-status-error")
            .text_size(TEXT.label)
            .text_color(role(t, "ansi1"))
            .child(change.error),
        ]),
  ];
};

const detailScreen = (t: Theme, item: Item, model: PanelModel): Element =>
  v_flex()
    .id("detail")
    .gap(PANEL.sectionGap)
    .children(
      editableTitle(
        t,
        model.edit,
        { kind: "item", id: item.id, field: "title" },
        detailHead(
          t,
          "detail",
          item.id,
          item.title,
          item.startRequested === undefined ? GROUP_LABELS[item.status] : "Starting",
          role(t, item.startRequested === undefined ? STATUS_TONES[item.status] : STARTING_TONE),
        ),
      ),
    )
    .children(
      askCards(
        t,
        model.links,
        item,
        model.answer,
        model.home,
        (index) => model.askExpanded(item, index),
        (index, cx) => model.toggleAsk(item, index, cx),
      ),
    )
    .child(
      detailCard(t, "facts", "Details", [
        fact(t, "fact-due", "Due", item.due === null ? [] : [item.due]),
        ...(item.ask === null || item.touches.length === 0
          ? [
              fact(
                t,
                "fact-touches",
                "Touches",
                item.touches.map((path) => tildePath(path, model.home)),
              ),
            ]
          : []),
        fact(t, "fact-created", "Created", [item.createdAt.slice(0, 10)]),
        ...(item.startRequested === undefined
          ? []
          : [fact(t, "fact-start", "Start requested", [item.startRequested.at.slice(0, 10)])]),
        ...((item.status === "done" || item.status === "dismissed") && item.closedAt !== null
          ? [fact(t, "fact-closed", "Closed", [item.closedAt.slice(0, 10)])]
          : []),
        ...(prose(item.outcome, item.outcomeMarkdown) === null
          ? []
          : editableRows(
              t,
              model.edit,
              { kind: "item", id: item.id, field: "outcome" },
              fact(
                t,
                "fact-outcome",
                "Outcome",
                proseValues(
                  t,
                  model.links,
                  "fact-outcome-markdown",
                  item.outcome,
                  item.outcomeMarkdown,
                ),
              ),
            )),
      ]),
    )
    .children(decidedCard(t, model.links, item, model.edit))
    .children(delegatesCard(t, item, model.delegates.byItem.get(item.id) ?? [], model.home))
    .when(model.statusChange !== undefined || model.start !== undefined, (el) =>
      el.children(itemActionRows(t, model.statusChange, model.start)),
    );

const answerFlowKey = (
  event: { key: string; keystroke: string },
  key: "down" | "up" | "enter" | "space" | "escape",
) => {
  const pressed = [event.key.toLowerCase(), event.keystroke.toLowerCase()];
  return pressed.some(
    (value) => value === key || value === `arrow${key}` || (key === "space" && value === " "),
  );
};

const ANSWER_FLOW_SPEED_MENU_MAX_HEIGHT = 200;

const flowSpeedMenu = (t: Theme, flow: AnswerFlowModel): Element =>
  menuPanel(t, ANSWER_FLOW_MENU_WIDTH, MENU.padding)
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

// A question answered in this flow, reached again with Back: the answer on record, read-only.
const flowAnsweredRows = (
  t: Theme,
  links: IdLinks,
  item: Item,
  detailPrefix: string,
): Element[] => {
  const answered = item.answered.at(-1);
  const answer =
    answered === undefined
      ? null
      : linkedProse(prose(answered.answer, answered.answerMarkdown), links);
  const rows = [
    detailRow(t, `${detailPrefix}-answered`)
      .border_t(0)
      .child(
        answer === null
          ? "Answered"
          : answer.markdown
            ? h_flex()
                .gap(BUTTON_STYLE.gap)
                .child("Answered:")
                .child(
                  proseChild(t, `${detailPrefix}-answered-markdown`, answer, links, {
                    inline: true,
                  }),
                )
            : `Answered: ${answer.value}`,
      ),
  ];
  const note =
    answered === undefined ? null : linkedProse(prose(answered.note, answered.noteMarkdown), links);
  if (note !== null)
    rows.push(
      detailRow(t, `${detailPrefix}-answered-note`)
        .text_color(t.muted)
        .child(
          note.markdown
            ? v_flex()
                .gap(BUTTON_STYLE.gap)
                .child("Note:")
                .child(
                  proseChild(t, `${detailPrefix}-answered-note-markdown`, note, links, {
                    color: t.muted,
                  }),
                )
            : `Note: ${note.value}`,
        ),
    );
  return rows;
};

const flowAskCard = (
  t: Theme,
  links: IdLinks,
  item: Item | undefined,
  answer: AnswerModel | undefined,
  detailPrefix: string,
  askPrefix: string,
  home: string,
): Element[] => {
  if (item === undefined)
    return [
      detailRow(t, `${detailPrefix}-missing`)
        .border_t(0)
        .text_color(t.muted)
        .child("Question unavailable. Go back to the domain."),
    ];
  if (item.ask === null) return flowAnsweredRows(t, links, item, detailPrefix);
  const touches = item.touches.map((path) => tildePath(path, home));
  return askCardRows(t, links, askPrefix, item.ask, answer, undefined, touches, true).map(
    (row, index) => (index === 0 ? row.border_t(0) : row),
  );
};

const flowCounts = (flow: AnswerFlowModel): string =>
  [
    ...(flow.queuedCount > 0 ? [`${flow.queuedCount} queued`] : []),
    `${flow.answeredCount} answered`,
    `${flow.skippedCount} skipped`,
  ].join(", ");

const flowDoneRows = (t: Theme, flow: AnswerFlowModel, prefix: string): Element[] => [
  detailRow(t, `${prefix}-count`)
    .border_t(0)
    .child(`${flowCounts(flow)}.`),
];

// A truncated caption holds no rich text, so a Markdown question shows as plain text there.
const captionOf = (ask: Ask | undefined): string => {
  if (ask === undefined) return "Answered";
  return ask.questionMarkdown === undefined
    ? questionOf(ask) || "Answered"
    : markdownPlain(ask.questionMarkdown);
};

const flowPreviewBody = (
  t: Theme,
  flow: AnswerFlowModel,
  cardModel: AnswerFlowModel["cards"][number],
  id: string,
): Element => {
  const subtitle =
    cardModel.kind === "summary"
      ? flowCounts(flow)
      : captionOf(cardModel.item?.ask ?? cardModel.item?.answered.at(-1));
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
  skip: () => {},
  dismiss: canDismissItem(item) ? () => {} : undefined,
});

const flowExpandedBody = (
  t: Theme,
  flow: AnswerFlowModel,
  cardModel: AnswerFlowModel["cards"][number],
  contentId: string,
  detailPrefix: string,
  askPrefix: string,
  measurement: boolean,
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
        : flowAskCard(t, flow.links, item, answer, detailPrefix, askPrefix, flow.home),
    );
};

const flowExpandedContent = (
  t: Theme,
  flow: AnswerFlowModel,
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
        cardModel,
        `${contentId}-body`,
        detailPrefix,
        askPrefix,
        measurement,
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
          cardModel,
          `${expandedId}-content`,
          `${expandedId}-detail`,
          `${expandedId}-ask`,
          flow.motion !== undefined || cardModel.id !== activeId,
        ),
      );
    return [compact, expanded];
  });
};

const flowCarouselCard = (
  t: Theme,
  flow: AnswerFlowModel,
  cardModel: AnswerFlowModel["cards"][number],
  placement: ReturnType<typeof layoutAnswerFlowCards>[number],
): Element => {
  const transition = flowTransition(flow);
  const busy = (flow.answer?.draft.busy === true || flow.sending) && placement.expanded;
  const canNavigate =
    flow.ready &&
    flow.motion === undefined &&
    flow.answer?.draft.busy !== true &&
    !flow.sending &&
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
        cardModel,
        `answer-flow-expanded-content-${cardModel.id}`,
        `answer-flow-detail-${cardModel.id}`,
        `answer-flow-ask-${cardModel.id}`,
        false,
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
        // A card taller than the window scrolls its body natively beneath its header.
        .when(placement.scrolls, (el) => el.flex_1().min_h_0().overflow_y_scroll())
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

// Shown while answers are queued: the send's error over the count and Send all and back.
const flowFooter = (t: Theme, flow: AnswerFlowModel): Element =>
  v_flex()
    .id("answer-flow-footer")
    .flex_none()
    .px(PANEL.padding)
    .pb(PANEL.sectionGap)
    .gap(ANSWER.gap)
    .when(flow.sendError !== undefined, (el) =>
      el.child(
        div()
          .id("answer-flow-send-error")
          .text_size(TEXT.label)
          .text_color(role(t, "ansi1"))
          .child(flow.sendError!),
      ),
    )
    .child(
      h_flex()
        .id("answer-flow-send-row")
        .gap(ANSWER.gap)
        .items_center()
        .justify_end()
        .child(small(t, t.muted, `${flow.queuedCount} queued`))
        .child(
          button(t, {
            id: "answer-flow-send",
            label: flow.sending ? "Sending…" : "Send all and back",
            style: ANSWER_BUTTON_STYLE,
            onClick: flow.sending || flow.motion !== undefined ? undefined : (cx) => flow.send(cx),
          }),
        ),
    );

const answerFlowScreen = (t: Theme, flow: AnswerFlowModel): Element =>
  v_flex()
    .id("answer-flow-queue-page")
    .flex_1()
    .min_h_0()
    .min_w_0()
    .child(flowHeader(t, flow))
    .child(answerFlowCarousel(t, flow))
    .when(flow.queuedCount > 0, (el) => el.child(flowFooter(t, flow)));

// Policy text wraps, so use the package's card pieces instead of fixed-height groupBlock.
const policiesPage = (t: Theme, backlog: Backlog, model: PanelModel): Element => {
  const entries = backlog.policies;
  return cardSection(
    cardHeader(t, "policies-header", "Policies"),
    card(t, "policies").children(
      entries.length === 0
        ? [emptyRow(t, "policies-empty", "None")]
        : pagedRows(t, "policies", entries, model, ROW.list, (entry, index) =>
            oneOf(
              `entry-policy-${entry.id}`,
              editableRows(
                t,
                model.edit,
                { kind: "policy", id: entry.id },
                detailRow(t, `policy-${entry.id}`)
                  .when(index === 0, (row) => row.border_t(0))
                  .child(
                    div().child(
                      proseChild(
                        t,
                        `policy-${entry.id}-markdown`,
                        prose(entry.text, entry.markdown) ?? { markdown: false, value: "" },
                        model.links,
                      ),
                    ),
                  )
                  .when(entry.wiki !== undefined, (row) =>
                    row.child(policyWiki(t, entry.id, entry.wiki!, model)),
                  )
                  .child(small(t, t.dim, entry.at.slice(0, 10))),
              ),
            ),
          ),
    ),
  );
};

// A policy's wiki citation: a link to the page while the domain wiki lists it, else plain text
// (a shared-wiki page, or a failed read).
const policyWiki = (t: Theme, id: string, name: string, model: PanelModel): Element => {
  const label = `wiki: [[${name}]]`;
  if (!model.wiki.some((page) => page.name === name))
    return small(t, t.dim, label).id(`policy-wiki-${id}`);
  return div()
    .id(`policy-wiki-${id}`)
    .text_size(TEXT.label)
    .cursor_pointer()
    .text_color(t.accent)
    .hover((s) => s.text_color(t.foreground))
    .on_click((_event, cx) => model.openWikiPage(name, cx))
    .child(label);
};

// One wiki page in the list: its name and type on a line, its description wrapping beneath.
const wikiRow = (t: Theme, page: WikiPage, model: PanelModel, first: boolean): Element =>
  cardRow(t, `wiki-row-${page.name}`, t.hover, first)
    .items_start()
    .min_h(ROW.list)
    .on_click((_event, cx) => model.openWikiPage(page.name, cx))
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .py(CARD.rowGap)
        .child(
          h_flex()
            .gap(CARD.rowGap)
            .child(div().flex_none().text_size(TEXT.body).text_color(t.foreground).child(page.name))
            .child(rowNote(t, page.type)),
        )
        .child(small(t, t.muted, page.description).whitespace_normal()),
    );

// The domain wiki's pages in index order; each opens its page.
const wikiListPage = (t: Theme, model: PanelModel): Element =>
  cardSection(
    cardHeader(t, "wiki-header", "Wiki pages"),
    card(t, "wiki").children(
      model.wiki.length === 0
        ? [emptyRow(t, "wiki-empty", "None")]
        : pagedRows(t, "wiki", model.wiki, model, ROW.list, (page, index) =>
            wikiRow(t, page, model, index === 0),
          ),
    ),
  );

// A wiki page: its frontmatter as facts, then its body as native Markdown once read. A body
// that failed to read, or is empty, shows no card.
const wikiPageScreen = (
  t: Theme,
  links: IdLinks,
  wikiPage: { page: WikiPage; body: string | undefined },
  home: string,
): Element => {
  const { page, body } = wikiPage;
  return v_flex()
    .id("wiki-page")
    .gap(PANEL.sectionGap)
    .child(titleRow(t, { id: "wiki-page-title", identifier: page.type, title: page.name }))
    .child(
      detailCard(t, "wiki-page-facts", "Details", [
        fact(t, "wiki-fact-description", "Description", [
          proseChild(
            t,
            "wiki-fact-description-markdown",
            { markdown: false, value: page.description },
            links,
          ),
        ]),
        fact(t, "wiki-fact-type", "Type", [page.type]),
        fact(t, "wiki-fact-created", "Created", [page.created]),
        fact(t, "wiki-fact-updated", "Updated", [page.updated]),
        fact(
          t,
          "wiki-fact-covers",
          "Covers",
          page.covers.map((cover) => `${tildePath(cover.place, home)}: ${cover.globs.join(", ")}`),
        ),
        fact(
          t,
          "wiki-fact-sources",
          "Sources",
          page.sources.map((source, index) =>
            proseChild(
              t,
              `wiki-fact-sources-${index}-markdown`,
              { markdown: false, value: source },
              links,
            ),
          ),
        ),
        fact(t, "wiki-fact-supersedes", "Supersedes", page.supersedes),
      ]),
    )
    .when(body !== undefined && body.trim() !== "", (el) =>
      el.child(
        detailCard(t, "wiki-page-body", "Page", [
          detailRow(t, "wiki-page-body-row").child(
            linkedMarkdown(
              `wiki-page-markdown-${page.name}`,
              linkIds(body!, links.known, true) ?? body!,
              links,
            )
              .selectable()
              .text_size(TEXT.body)
              .text_color(t.foreground),
          ),
        ]),
      ),
    );
};

// Each event's kind and attributes head its row; its fields and action text wrap beneath.
const outboxRow = (t: Theme, event: OutboxEvent, first: boolean, home: string): Element => {
  const attrs = Object.entries(event.attrs).map(
    ([name, value]) => `${name}=${tildePath(value, home)}`,
  );
  const fields = Object.entries(event.fields).flatMap(([name, value]) =>
    (typeof value === "string" ? [value] : value).map(
      (entry) => `${name}: ${tildePath(entry, home)}`,
    ),
  );
  return detailRow(t, `outbox-${event.id}`)
    .when(first, (row) => row.border_t(0))
    .child(div().child(`e${event.id} ${event.kind}`))
    .when(attrs.length > 0, (row) =>
      row.child(small(t, t.dim, attrs.join(" ")).id(`outbox-attrs-${event.id}`)),
    )
    .children(
      fields.map((field, index) => small(t, t.dim, field).id(`outbox-field-${event.id}-${index}`)),
    )
    .when(event.text !== "", (row) =>
      row.child(div().id(`outbox-text-${event.id}`).child(event.text)),
    );
};

// The watcher's events not yet delivered to the coordinator, oldest first. Event text wraps, so
// this uses the card pieces as Policies does.
const outboxPage = (t: Theme, model: PanelModel): Element =>
  cardSection(
    cardHeader(t, "outbox-header", "Undelivered watcher events"),
    card(t, "outbox").children(
      model.outbox.length === 0
        ? [emptyRow(t, "outbox-empty", "None")]
        : pagedRows(t, "outbox", model.outbox, model, ROW.list, (event, index) =>
            outboxRow(t, event, index === 0, model.home),
          ),
    ),
  );

// The paths the domain owns and those next to it, in separate editable cards.
const boundaryCard = (
  t: Theme,
  boundary: Backlog["boundary"],
  model: BoundaryModel,
  edit: FieldEditModel,
  home: string,
): Element[] => {
  const section = (list: BoundaryList, label: string, paths: string[]) => {
    const id = `boundary-${list}`;
    const rows = paths.flatMap((path, index) => {
      const target: EditTarget = { kind: "boundary", list, path };
      const key = editKey(target);
      if (edit.editing === key) return fieldEditorRows(t, edit, target);
      // An owned repo's checkouts on other machines, by machine name, beside its path.
      const checkouts = Object.entries(list === "owned" ? (boundary.checkouts?.[path] ?? {}) : {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([machine, checkout]) =>
          rowNote(t, `${machine}: ${tildePath(checkout, home)}`).id(
            `boundary-${model.domain}-${list}-${path}-on-${machine}`,
          ),
        );
      const row = listRow(t, {
        id: `boundary-${model.domain}-${list}-${path}`,
        title: tildePath(path, home),
        first: index === 0,
        height: ROW.list,
        trailing: checkouts,
      });
      return [row, ...editErrorRows(t, edit, key), editChin(t, edit, target)];
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

// A Lists row: the name, its count or summary just beside it in the dim note style, and a
// right-pointing chevron at the far right, like a collapsed group's. The whole row opens the list.
const sectionRow = (
  t: Theme,
  id: string,
  label: string,
  count: number | string,
  screen: DomainPage,
  model: PanelModel,
): Element =>
  cardRow(t, id, t.hover)
    .h(ROW.list)
    .on_click((_event, cx) => model.go(screen, cx))
    .child(div().flex_none().truncate().text_size(TEXT.body).text_color(t.foreground).child(label))
    .child(rowNote(t, String(count)))
    .child(div().flex_1())
    .child(foldChevron(t, false));

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
      sectionRow(
        t,
        "page-outbox",
        OUTBOX_LABEL,
        model.outbox.length,
        { kind: "outbox", domain },
        model,
      ),
      sectionRow(t, "page-wiki", WIKI_LABEL, model.wiki.length, { kind: "wiki", domain }, model),
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
        .children(boundaryCard(t, backlog.boundary, model.boundary, model.edit, model.home));
      break;
    case "outbox":
      content = outboxPage(t, model);
      break;
    case "wiki":
      content = wikiListPage(t, model);
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
    .child(
      focusCard(t, model.links, prose(doc.backlog.focus, doc.backlog.focusMarkdown), model.edit),
    )
    .children([...waitingCard(t, model), itemsCard(t, model)])
    .children(unfiledCard(t, model.delegates.unfiled, model))
    .child(sectionLinks(t, domain, doc.backlog, model));
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
  active: boolean,
): Element =>
  listRow(t, {
    id: `domain-${row.domain}`,
    title: row.domain,
    mark: active ? activeDot(t) : undefined,
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
  if (listing.kind === "loading")
    return message(t, "loading", "Loading…", "Listing the backlogs.", "loading");
  if (listing.kind === "unreadable")
    return message(t, "listing-error", "Couldn't list the backlogs", listing.reason, "error");
  if (listing.domains.length === 0)
    return message(
      t,
      "no-backlogs",
      "No backlogs yet",
      "Run coordinate start <domain> to create one.",
    );
  return cardSection(
    cardHeader(t, "domains-header", "Domains"),
    card(t, "domains").children(
      listing.domains.map((row, index) =>
        domainRow(
          t,
          row,
          (cx) => model.openDomain(row.domain, cx),
          index === 0,
          model.isActive(row.domain),
        ),
      ),
    ),
  );
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
            model.wikiPage !== undefined ||
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
            model.detail !== undefined ||
              model.finding !== undefined ||
              model.wikiPage !== undefined ||
              model.flow !== undefined,
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
            paneScrollRegion("detail-scroll", detailScreen(t, model.detail!, model), PANEL.padding),
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
    .when(model.wikiPage !== undefined, (screens) =>
      screens.child(
        v_flex()
          .id("screen-wiki-page")
          .absolute()
          .inset_0()
          .bg(t.surface)
          .when(model.flow !== undefined, (page) => page.invisible())
          .child(
            paneScrollRegion(
              "wiki-page-scroll",
              wikiPageScreen(t, model.links, model.wikiPage!, model.home),
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
    .child(toolbar(t, model))
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
