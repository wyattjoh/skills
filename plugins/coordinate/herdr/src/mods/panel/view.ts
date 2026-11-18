// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div, svg } from "gpui-kit";
import type { Color, Context, Element } from "gpui-kit";
import { Input, h_flex, v_flex } from "gpui-base";
import type { InputState } from "gpui-base";
import { crumb, crumbBand } from "@wyattjoh/herdr-ui";
import type { Backlog, Finding, Item } from "../../lib/store.ts";
import { CONTROL } from "../../lib/look.ts";
import {
  ANSWER,
  DETAIL_LINE_GAP,
  DETAIL_ROW_PADDING_Y,
  BAR_PADDING_Y,
  CARD_GAP,
  CARD_HEADER_HEIGHT,
  CARD_PADDING_X,
  CARD_RADIUS,
  CARD_SECTION_GAP,
  DELEGATE_INDENT,
  DELEGATED_ROW_HEIGHT,
  DELEGATE_ROW_HEIGHT,
  DELEGATE_TONES,
  FINDING_GLYPHS,
  FINDING_STATUS_TONES,
  FOLD_MOTION,
  GROUP_HEADER_HEIGHT,
  ICONS,
  INNER_RADIUS,
  ITEM_ROW_HEIGHT,
  COUNT_TONES,
  LISTING_ROW_HEIGHT,
  PANEL_PADDING,
  STATUS_TONES,
  TEXT_BODY,
  TEXT_SMALL,
} from "./look.ts";
import {
  FINDING_KIND_LABELS,
  FINDING_STATUS_LABELS,
  GROUP_LABELS,
  chosenAnswer,
  delegateLabel,
  delegateLine,
  rankedOptions,
} from "./model.ts";
import type {
  AnswerDraft,
  Crumb,
  DelegateJoin,
  DelegateRow,
  DelegateState,
  DocumentState,
  DomainSummary,
  ItemGroup,
  ListingState,
  Screen,
} from "./model.ts";

/**
 * Theme colors by name.
 */
export type Theme = Record<string, Color>;

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
  // The open findings, and the closed ones in their folded group.
  findings: Finding[];
  closed: Finding[];
  closedOpen: boolean;
  toggleClosed: (cx: Context) => void;
  // Whether the Standing yes card is unfolded, and what folds it.
  standingOpen: boolean;
  toggleStanding: (cx: Context) => void;
  // The finding whose detail screen is on top of the lists, if any, and the item it came from
  // when the document still has it.
  finding: Finding | undefined;
  origin: Item | undefined;
  openFinding: (finding: Finding, cx: Context) => void;
  // Each item's delegates joined to the live terminals, and the domain's unfiled delegates.
  delegates: DelegateJoin;
  isOpen: (group: ItemGroup) => boolean;
  toggle: (group: ItemGroup, cx: Context) => void;
  // The item whose detail screen is on top of the list, if any.
  detail: Item | undefined;
  open: (item: Item, cx: Context) => void;
  // The answer being written on the open item's ask, when it has one.
  answer: AnswerModel | undefined;
  openDomain: (domain: string, cx: Context) => void;
};

/**
 * The answer row's state and what its controls do: pick an option, type, and record it.
 */
export type AnswerModel = {
  draft: AnswerDraft;
  // The text field's retained state, absent until the View's init made it.
  input: InputState | undefined;
  typing: boolean;
  choose: (option: string, cx: Context) => void;
  submit: (cx: Context) => void;
};

/**
 * A titled empty or error state: a medium title over a muted detail.
 * @param t The theme.
 * @param id The element id.
 * @param title What is wrong, briefly.
 * @param detail What to do about it.
 * @returns The element.
 */
export const message = (t: Theme, id: string, title: string, detail: string): Element =>
  v_flex()
    .id(id)
    .gap(4)
    .p(PANEL_PADDING)
    .child(div().text_size(TEXT_BODY).font_medium().text_color(t.foreground).child(title))
    .child(div().text_size(TEXT_SMALL).text_color(t.muted).child(detail));

const toolbar = (t: Theme): Element =>
  h_flex()
    .id("toolbar")
    .flex_none()
    .px(PANEL_PADDING)
    .py(BAR_PADDING_Y)
    .gap(CONTROL.gap)
    .bg(t.chrome)
    .child(
      h_flex()
        .h(CONTROL.height)
        .items_center()
        .text_size(TEXT_SMALL)
        .font_medium()
        .text_color(t.muted)
        .child("Backlog"),
    );

// The breadcrumb band from @wyattjoh/herdr-ui: every crumb but the last opens its screen.
const trailBand = (t: Theme, trail: Crumb[], go: (screen: Screen, cx: Context) => void): Element =>
  crumbBand(
    t,
    trail.map(({ id, label, to }) =>
      crumb(t, {
        id,
        label,
        current: to === undefined,
        onClick: to === undefined ? undefined : (cx) => go(to, cx),
      }),
    ),
  );

const focusHeader = (t: Theme, focus: string | null): Element =>
  div()
    .id("focus")
    .text_size(TEXT_BODY)
    .text_color(focus === null ? t.dim : t.foreground)
    .child(focus ?? "No focus set");

const card = (t: Theme, id: string): Element =>
  v_flex()
    .id(id)
    .flex_none()
    .bg(t.canvas)
    .border(1)
    .border_color(t.input)
    .rounded(CARD_RADIUS)
    .overflow_hidden();

const cardHeader = (t: Theme, id: string, name: string): Element =>
  h_flex()
    .id(id)
    .flex_none()
    .h(CARD_HEADER_HEIGHT)
    .px(CARD_PADDING_X)
    .items_center()
    .child(div().text_size(TEXT_BODY).font_medium().text_color(t.muted).child(name));

const cardRow = (t: Theme, id: string, hover: Color): Element =>
  h_flex()
    .id(id)
    .flex_none()
    .px(CARD_PADDING_X)
    .gap(7)
    .items_center()
    .border_t(1)
    .border_color(t.border)
    .hover((s) => s.bg(hover));

const delegateTone = (t: Theme, state: DelegateState): Color =>
  t[DELEGATE_TONES[state.kind === "live" ? state.status : state.kind]];

// A delegate line: its name, then its live status, ended or gone in that state's tone. A ref
// is keyed by its session, a terminal by its address; indent counts nesting levels.
const delegateRow = (t: Theme, row: DelegateRow, indent: number): Element =>
  cardRow(t, row.source === "ref" ? `ref-${row.key}` : `term-${row.key}`, t.hover)
    .h(DELEGATE_ROW_HEIGHT)
    .pl(CARD_PADDING_X + indent * DELEGATE_INDENT)
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(TEXT_SMALL)
        .text_color(t.foreground)
        .child(row.name),
    )
    .child(
      div()
        .flex_none()
        .text_size(TEXT_SMALL)
        .text_color(delegateTone(t, row.state))
        .child(delegateLabel(row.state)),
    );

// The height of an item's row: two lines for an item with delegates, else one.
const itemRowHeight = (rows: DelegateRow[]): number =>
  delegateLine(rows) === undefined ? ITEM_ROW_HEIGHT : DELEGATED_ROW_HEIGHT;

// An item row: its id and title, and for an item with delegates a second line under the title
// naming its delegate and state (or the most urgent state and the count) in that state's tone.
const itemRow = (
  t: Theme,
  item: Item,
  rows: DelegateRow[],
  open: (item: Item, cx: Context) => void,
): Element => {
  const line = delegateLine(rows);
  const title = div()
    .min_w_0()
    .truncate()
    .text_size(TEXT_BODY)
    .text_color(item.status === "dismissed" ? t.dim : t.foreground)
    .child(item.title);
  return cardRow(t, `item-${item.id}`, t.hover)
    .h(itemRowHeight(rows))
    .cursor_pointer()
    .on_click((_event, cx) => open(item, cx))
    .child(div().flex_none().text_size(TEXT_SMALL).text_color(t.muted).child(item.id))
    .child(
      line === undefined
        ? title.flex_1()
        : v_flex()
            .flex_1()
            .min_w_0()
            .child(title)
            .child(
              div()
                .id(`delegates-${item.id}`)
                .min_w_0()
                .truncate()
                .text_size(TEXT_SMALL)
                .text_color(delegateTone(t, line.state))
                .child(line.text),
            ),
    );
};

// A status group: a popover header band with its label in the status tone, the fold chevron
// and the count, then its rows, whose height eases to their total or to nothing. The first
// band rounds the card's top corners; the last group rounds the bottom while it is folded.
const groupBlock = (
  t: Theme,
  group: ItemGroup,
  open: boolean,
  first: boolean,
  last: boolean,
  toggle: (cx: Context) => void,
  openItem: (item: Item, cx: Context) => void,
  delegates: DelegateJoin,
): Element => {
  const rowsOf = (item: Item) => delegates.byItem.get(item.id) ?? [];
  const height = group.items.reduce((sum, item) => sum + itemRowHeight(rowsOf(item)), 0);
  return v_flex()
    .id(`group-${group.status}`)
    .child(
      cardRow(t, `fold-${group.status}`, t.raised)
        .h(GROUP_HEADER_HEIGHT)
        .bg(t.popover)
        .cursor_pointer()
        .text_size(TEXT_SMALL)
        .when(first, (el) => el.border_t(0).rounded_t(INNER_RADIUS))
        .when(last && !open, (el) => el.rounded_b(INNER_RADIUS))
        .on_click((_event, cx) => toggle(cx))
        .child(div().font_medium().text_color(t[STATUS_TONES[group.status]]).child(group.label))
        .child(
          svg(open ? ICONS.groupOpen : ICONS.groupClosed)
            .size(12)
            .flex_none()
            .text_color(t.dim),
        )
        .child(div().text_color(t.dim).child(String(group.items.length))),
    )
    .child(
      v_flex()
        .id(`rows-${group.status}`)
        .overflow_hidden()
        .h(open ? height : 0)
        .transition("height", FOLD_MOTION)
        .children(group.items.map((item) => itemRow(t, item, rowsOf(item), openItem))),
    );
};

const itemsCard = (t: Theme, model: PanelModel): Element =>
  v_flex()
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(cardHeader(t, "items-header", "Items"))
    .child(
      card(t, "items").children(
        model.groups.length === 0
          ? [emptyRow(t, "items-empty", "No items")]
          : model.groups.map((group, index) =>
              groupBlock(
                t,
                group,
                model.isOpen(group),
                index === 0,
                index === model.groups.length - 1,
                (cx) => model.toggle(group, cx),
                model.open,
                model.delegates,
              ),
            ),
      ),
    );

const emptyRow = (t: Theme, id: string, label: string): Element =>
  div().id(id).px(CARD_PADDING_X).py(8).text_size(TEXT_SMALL).text_color(t.dim).child(label);

const findingRow = (
  t: Theme,
  finding: Finding,
  open: (finding: Finding, cx: Context) => void,
): Element =>
  cardRow(t, `finding-${finding.id}`, t.hover)
    .h(ITEM_ROW_HEIGHT)
    .cursor_pointer()
    .on_click((_event, cx) => open(finding, cx))
    .child(
      div()
        .flex_none()
        .text_size(TEXT_SMALL)
        .text_color(t[FINDING_GLYPHS[finding.kind].tone])
        .child(FINDING_GLYPHS[finding.kind].glyph),
    )
    .child(div().flex_none().text_size(TEXT_SMALL).text_color(t.muted).child(finding.id))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(TEXT_BODY)
        .text_color(finding.status === "dismissed" ? t.dim : t.foreground)
        .child(finding.title),
    );

// Live domain terminals no item names, nested under their parents like an item's delegates.
const unfiledCard = (t: Theme, rows: DelegateRow[]): Element[] =>
  rows.length === 0
    ? []
    : [
        v_flex()
          .flex_none()
          .gap(CARD_SECTION_GAP)
          .child(cardHeader(t, "unfiled-header", "Unfiled delegates"))
          .child(
            card(t, "unfiled").children(
              rows.map((row, index) =>
                delegateRow(t, row, row.depth).when(index === 0, (el) => el.border_t(0)),
              ),
            ),
          ),
      ];

// The closed findings as a folded group, its band and fold drawn as an Items status group's.
// It rounds the card's bottom corners while it is folded, being the card's last band.
const closedGroup = (t: Theme, model: PanelModel): Element => {
  const open = model.closedOpen;
  return v_flex()
    .id("group-findings-closed")
    .child(
      cardRow(t, "fold-findings-closed", t.raised)
        .h(GROUP_HEADER_HEIGHT)
        .bg(t.popover)
        .cursor_pointer()
        .text_size(TEXT_SMALL)
        .when(!open, (el) => el.rounded_b(INNER_RADIUS))
        .on_click((_event, cx) => model.toggleClosed(cx))
        .child(div().font_medium().text_color(t.muted).child("Closed"))
        .child(
          svg(open ? ICONS.groupOpen : ICONS.groupClosed)
            .size(12)
            .flex_none()
            .text_color(t.dim),
        )
        .child(div().text_color(t.dim).child(String(model.closed.length))),
    )
    .child(
      v_flex()
        .id("rows-findings-closed")
        .overflow_hidden()
        .h(open ? model.closed.length * ITEM_ROW_HEIGHT : 0)
        .transition("height", FOLD_MOTION)
        .children(model.closed.map((finding) => findingRow(t, finding, model.openFinding))),
    );
};

// Open findings, one fixed row each, then the closed ones in a folded group. The first row
// drops its rule so it sits flush with the card's top edge, as the first group band does in the
// Items card.
const findingsCard = (t: Theme, model: PanelModel): Element =>
  v_flex()
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(cardHeader(t, "findings-header", "Findings"))
    .child(
      card(t, "findings")
        .children(
          model.findings.length === 0
            ? [emptyRow(t, "findings-empty", "No open findings")]
            : model.findings.map((finding, index) =>
                findingRow(t, finding, model.openFinding).when(index === 0, (el) => el.border_t(0)),
              ),
        )
        .children(model.closed.length === 0 ? [] : [closedGroup(t, model)]),
    );

// A detail card's row: wrapping text, so its height follows its content.
const detailRow = (t: Theme, id: string): Element =>
  v_flex()
    .id(id)
    .flex_none()
    .px(CARD_PADDING_X)
    .py(DETAIL_ROW_PADDING_Y)
    .gap(DETAIL_LINE_GAP)
    .border_t(1)
    .border_color(t.border)
    .text_size(TEXT_BODY)
    .text_color(t.foreground);

const detailCard = (t: Theme, id: string, name: string, rows: Element[]): Element =>
  v_flex()
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(cardHeader(t, `${id}-header`, name))
    .child(card(t, id).children(rows.map((row, index) => (index === 0 ? row.border_t(0) : row))));

const small = (t: Theme, tone: Color, value: string): Element =>
  div().text_size(TEXT_SMALL).text_color(tone).child(value);

// A labelled fact: a muted label, then its values, or None in dim.
const fact = (t: Theme, id: string, label: string, values: string[]): Element =>
  detailRow(t, id)
    .child(small(t, t.muted, label))
    .child(
      values.length === 0
        ? div().text_color(t.dim).child("None")
        : h_flex()
            .flex_wrap()
            .gap(CONTROL.gap)
            .children(values.map((value) => div().child(value))),
    );

// The answer row: a text field beside an Answer button that is solid once there is an answer,
// as the Changes panel's commit row is, and the CLI's error under it when recording failed.
const answerRows = (t: Theme, answer: AnswerModel): Element[] => {
  const { draft } = answer;
  const enabled = chosenAnswer(draft) !== undefined && !draft.busy;
  const field = div()
    .id("ask-answer-field")
    .flex_1()
    .min_w(0)
    .h(ANSWER.height)
    .px(ANSWER.fieldPaddingX)
    .flex()
    .items_center()
    .rounded(ANSWER.radius)
    .border_1()
    .border_color(answer.typing ? t.accent : t.border)
    .cursor_text()
    .when(answer.input !== undefined, (el) =>
      el.child(Input.new(answer.input!).h_full().text_size(TEXT_BODY).text_color(t.foreground)),
    );
  const submit = div()
    .id("ask-answer-submit")
    .flex_none()
    .h(ANSWER.height)
    .px(ANSWER.buttonPaddingX)
    .flex()
    .items_center()
    .rounded(ANSWER.radius)
    .text_size(TEXT_SMALL)
    .bg(enabled ? t.solid : t.raised)
    .text_color(enabled ? t.solid_foreground : t.dim)
    .when(enabled, (el) => el.cursor_pointer().on_click((_event, cx) => answer.submit(cx)))
    .child(draft.busy ? "Answering…" : "Answer");
  return [
    detailRow(t, "ask-answer").child(h_flex().gap(ANSWER.gap).child(field).child(submit)),
    ...(draft.error === undefined
      ? []
      : [
          detailRow(t, "ask-answer-error")
            .text_size(TEXT_SMALL)
            .text_color(t.ansi1)
            .child(draft.error),
        ]),
  ];
};

const askCard = (t: Theme, item: Item, answer: AnswerModel | undefined): Element[] => {
  const ask = item.ask;
  if (ask === null) return [];
  // The picked option is highlighted until text is typed, which then answers instead.
  const picked =
    answer === undefined ? ask.rec : answer.draft.text.trim() === "" ? answer.draft.choice : null;
  const question = detailRow(t, "ask-question").font_medium().child(ask.question);
  const context =
    ask.context === null
      ? []
      : [detailRow(t, "ask-context").text_color(t.muted).child(ask.context)];
  const options = rankedOptions(ask).map(({ option, index, rec }) =>
    detailRow(t, `ask-option-${index}`)
      .when(option === picked, (el) => el.bg(t.selected))
      .when(answer !== undefined, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(option === picked ? t.selected : t.hover))
          .on_click((_event, cx) => answer!.choose(option, cx)),
      )
      .child(
        h_flex()
          .gap(CONTROL.gap)
          .items_center()
          .child(div().min_w_0().child(option))
          .when(rec, (el) => el.child(small(t, t.accent, "Recommended"))),
      )
      .when(rec && ask.recReason !== null, (el) =>
        el.child(
          div()
            .id("ask-rec-reason")
            .text_size(TEXT_SMALL)
            .text_color(t.muted)
            .child(ask.recReason!),
        ),
      ),
  );
  return [
    detailCard(t, "ask", "Ask", [
      question,
      ...context,
      ...options,
      ...(answer === undefined ? [] : answerRows(t, answer)),
    ]),
  ];
};

const decidedCard = (t: Theme, item: Item): Element[] =>
  item.decided.length === 0
    ? []
    : [
        detailCard(
          t,
          "decided",
          "Decided",
          item.decided.map((entry, index) =>
            detailRow(t, `decided-${index}`)
              .child(div().child(entry.text))
              .child(small(t, t.dim, entry.at.slice(0, 10))),
          ),
        ),
      ];

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
                  .gap(CONTROL.gap)
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
                  .gap(CONTROL.gap)
                  .child(small(t, t.muted, "Brief"))
                  .child(small(t, t.foreground, ref.brief)),
              )
              .child(
                h_flex()
                  .gap(CONTROL.gap)
                  .child(small(t, t.muted, "Report"))
                  .child(small(t, t.foreground, ref.report)),
              ),
          ),
        ),
      ];

// A detail screen's head: the record's id and title, and its status in the status's tone.
const detailHead = (
  t: Theme,
  prefix: string,
  id: string,
  title: string,
  status: string,
  tone: Color,
): Element =>
  v_flex()
    .gap(DETAIL_LINE_GAP)
    .child(
      h_flex()
        .id(`${prefix}-title`)
        .gap(7)
        .child(div().flex_none().text_size(TEXT_SMALL).text_color(t.muted).child(id))
        .child(
          div().min_w_0().text_size(TEXT_BODY).font_medium().text_color(t.foreground).child(title),
        ),
    )
    .child(div().id(`${prefix}-status`).text_size(TEXT_SMALL).text_color(tone).child(status));

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
              .gap(7)
              .cursor_pointer()
              .text_color(t.accent)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_event, cx) => open(origin, cx))
              .child(div().flex_none().child(origin.id))
              .child(div().min_w_0().child(origin.title)),
    );

// The detail of one finding, in its own scroll area like an item's. Nothing on it acts on the
// finding; its origin opens the item it came from.
const findingScreen = (t: Theme, finding: Finding, model: PanelModel): Element =>
  v_flex()
    .id("finding-scroll")
    .size_full()
    .overflow_y_scrollbar()
    .p(PANEL_PADDING)
    .child(
      v_flex()
        .id("finding")
        .gap(CARD_GAP)
        .child(
          detailHead(
            t,
            "finding",
            finding.id,
            finding.title,
            FINDING_STATUS_LABELS[finding.status],
            t[FINDING_STATUS_TONES[finding.status]],
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
        ),
    );

// The detail of one item, in its own scroll area so the list's keeps its place. Its ask is the
// one thing on it that can be acted on.
const detailScreen = (
  t: Theme,
  item: Item,
  delegates: DelegateJoin,
  answer: AnswerModel | undefined,
): Element =>
  v_flex()
    .id("detail-scroll")
    .size_full()
    .overflow_y_scrollbar()
    .p(PANEL_PADDING)
    .child(
      v_flex()
        .id("detail")
        .gap(CARD_GAP)
        .child(
          detailHead(
            t,
            "detail",
            item.id,
            item.title,
            GROUP_LABELS[item.status],
            t[STATUS_TONES[item.status]],
          ),
        )
        .children(askCard(t, item, answer))
        .child(
          detailCard(t, "facts", "Details", [
            fact(t, "fact-due", "Due", item.due === null ? [] : [item.due]),
            fact(t, "fact-touches", "Touches", item.touches),
            fact(t, "fact-created", "Created", [item.createdAt.slice(0, 10)]),
            ...((item.status === "done" || item.status === "dismissed") && item.closedAt !== null
              ? [fact(t, "fact-closed", "Closed", [item.closedAt.slice(0, 10)])]
              : []),
            ...(item.outcome === null ? [] : [fact(t, "fact-outcome", "Outcome", [item.outcome])]),
          ]),
        )
        .children(decidedCard(t, item))
        .children(delegatesCard(t, item, delegates.byItem.get(item.id) ?? [])),
    );

// The standing approvals the domain records, each with the date it was given.
// The standing approvals the domain records, each with the date it was given. It starts
// folded, as the Closed findings do: its header carries the fold chevron and the count, and
// the card under it shows only while it is open (its rows wrap, so it does not ease).
const standingCard = (t: Theme, backlog: Backlog, model: PanelModel): Element => {
  const open = model.standingOpen;
  const entries = backlog.standingYes;
  return v_flex()
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(
      cardHeader(t, "standing-header", "Standing yes")
        .gap(7)
        .cursor_pointer()
        .text_size(TEXT_SMALL)
        .on_click((_event, cx) => model.toggleStanding(cx))
        .child(
          svg(open ? ICONS.groupOpen : ICONS.groupClosed)
            .size(12)
            .flex_none()
            .text_color(t.dim),
        )
        .child(div().text_color(t.dim).child(String(entries.length))),
    )
    .when(open, (el) =>
      el.child(
        card(t, "standing").children(
          entries.length === 0
            ? [emptyRow(t, "standing-empty", "None")]
            : entries.map((entry, index) =>
                detailRow(t, `standing-${index}`)
                  .when(index === 0, (row) => row.border_t(0))
                  .child(div().child(entry.text))
                  .child(small(t, t.dim, entry.at.slice(0, 10))),
              ),
        ),
      ),
    );
};

// The paths the domain owns and those next to it.
const boundaryCard = (t: Theme, backlog: Backlog): Element =>
  detailCard(t, "boundary", "Boundary", [
    fact(t, "boundary-owned", "Owned", backlog.boundary.owned),
    fact(t, "boundary-adjacent", "Adjacent", backlog.boundary.adjacent),
  ]);

const domainBody = (t: Theme, domain: string, doc: DocumentState, model: PanelModel): Element => {
  if (doc.kind === "loading")
    return message(t, "loading", "Loading…", `Reading ${domain}'s backlog.`);
  if (doc.kind === "missing")
    return message(
      t,
      "missing",
      `No backlog for ${domain}`,
      `Run coordinate start ${domain} to create it.`,
    );
  if (doc.kind === "invalid")
    return message(t, "invalid", `${domain}'s backlog is invalid`, doc.reason);
  if (doc.kind === "unreadable")
    return message(t, "unreadable", `Couldn't read ${domain}'s backlog`, doc.reason);
  return v_flex()
    .id("domain")
    .gap(CARD_GAP)
    .child(focusHeader(t, doc.backlog.focus))
    .child(itemsCard(t, model))
    .children(unfiledCard(t, model.delegates.unfiled))
    .child(findingsCard(t, model))
    .child(standingCard(t, doc.backlog, model))
    .child(boundaryCard(t, doc.backlog));
};

const COUNT_LABELS = [
  ["waiting", "waiting"],
  ["delegated", "delegated"],
  ["open", "open"],
  ["findings", "findings"],
] as const;

const domainRow = (t: Theme, row: DomainSummary, open: (cx: Context) => void): Element =>
  cardRow(t, `domain-${row.domain}`, t.hover)
    .h(LISTING_ROW_HEIGHT)
    .cursor_pointer()
    .on_click((_event, cx) => open(cx))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(TEXT_BODY)
        .text_color(t.foreground)
        .child(row.domain),
    )
    .children(
      row.kind === "loaded"
        ? COUNT_LABELS.map(([key, label]) =>
            div()
              .flex_none()
              .text_size(TEXT_SMALL)
              .text_color(row.counts[key] > 0 ? t[COUNT_TONES[key]] : t.dim)
              .child(`${row.counts[key]} ${label}`),
          )
        : [
            div()
              .flex_none()
              .text_size(TEXT_SMALL)
              .text_color(t.ansi1)
              .child(row.kind === "invalid" ? "Invalid" : "Unreadable"),
          ],
    );

const listingBody = (t: Theme, listing: ListingState, model: PanelModel): Element => {
  if (listing.kind === "loading") return message(t, "loading", "Loading…", "Listing the backlogs.");
  if (listing.kind === "unreadable")
    return message(t, "listing-error", "Couldn't list the backlogs", listing.reason);
  if (listing.domains.length === 0)
    return message(
      t,
      "no-backlogs",
      "No backlogs yet",
      "Run coordinate start <domain> to create one.",
    );
  return v_flex()
    .id("listing")
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(cardHeader(t, "domains-header", "Domains"))
    .child(
      card(t, "domains").children(
        listing.domains.map((row, index) =>
          domainRow(t, row, (cx) => model.openDomain(row.domain, cx)).when(index === 0, (el) =>
            el.border_t(0),
          ),
        ),
      ),
    );
};

const scroll = (body: Element): Element =>
  v_flex()
    .id("panel-scroll")
    .flex_1()
    .min_h_0()
    .overflow_y_scrollbar()
    .p(PANEL_PADDING)
    .child(body);

/**
 * The whole panel: tool bar, the breadcrumb trail, then either the domain's screens or the
 * all-domains listing when no domain is focused or opened.
 * @param t The theme.
 * @param model What to draw.
 * @returns The element.
 */
export const panel = (t: Theme, model: PanelModel): Element =>
  v_flex()
    .id("coordinate-panel")
    .size_full()
    .bg(t.surface)
    .child(toolbar(t))
    .child(trailBand(t, model.trail, model.go))
    .when(model.domain === undefined, (el) =>
      el.child(scroll(listingBody(t, model.listing, model))),
    )
    .when(model.domain !== undefined, (el) =>
      el.child(
        // Screens stack as the Tasks panel's do: the lists stay mounted, invisible, under an
        // item's or finding's detail, so their scroll area keeps its position for the trail.
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
              .when(model.detail !== undefined || model.finding !== undefined, (list) =>
                list.invisible(),
              )
              .child(
                v_flex()
                  .id("panel-scroll")
                  .size_full()
                  .overflow_y_scrollbar()
                  .p(PANEL_PADDING)
                  .child(domainBody(t, model.domain!, model.doc, model)),
              ),
          )
          .when(model.detail !== undefined, (screens) =>
            screens.child(
              v_flex()
                .id("screen-item")
                .absolute()
                .inset_0()
                .bg(t.surface)
                .child(detailScreen(t, model.detail!, model.delegates, model.answer)),
            ),
          )
          .when(model.finding !== undefined, (screens) =>
            screens.child(
              v_flex()
                .id("screen-finding")
                .absolute()
                .inset_0()
                .bg(t.surface)
                .child(findingScreen(t, model.finding!, model)),
            ),
          ),
      ),
    );
