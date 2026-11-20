// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div, svg } from "gpui-kit";
import type { Color, Context, Element } from "gpui-kit";
import { Input, InputState, h_flex, v_flex } from "gpui-base";
import { answerInputElement } from "./textarea.ts";
import type { AnswerInputState } from "./textarea.ts";
import {
  BUTTON_STYLE,
  CARD,
  HERDR_ICONS,
  PANEL,
  ROW,
  TEXT,
  brand,
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
  toolRow,
  topBar,
  letThrough,
} from "@wyattjoh/herdr-ui";
import type { ButtonStyle, Theme } from "@wyattjoh/herdr-ui";
import { isDiscussion } from "../../lib/store.ts";
import type { AnsweredAsk, Ask, Backlog, Finding, Item } from "../../lib/store.ts";
import {
  ANSWER,
  ASK_OPTION_NUMBER_WIDTH,
  COUNT_TONES,
  DELEGATE_INDENT,
  DELEGATE_ROW_HEIGHT,
  DELEGATE_TONES,
  FINDING_GLYPHS,
  FINDING_STATUS_TONES,
  STATUS_TONES,
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
  DomainPage,
  DelegateRow,
  DelegateState,
  DocumentState,
  DomainSummary,
  ItemGroup,
  ListingState,
  Screen,
} from "./model.ts";

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
  // Boundary paths can be edited on either card.
  boundary: BoundaryModel;
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
  choose: (option: string, cx: Context) => void;
  discuss: (cx: Context) => void;
  submit: (cx: Context) => void;
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

// The panel's chrome and domain label use the same frame, brand and tool-row pieces as the
// Tasks panel.
const toolbar = (t: Theme, domain: string | undefined): Element =>
  topBar(t, {
    content: toolRow({
      id: "toolbar",
      brand: brand(t, { id: "toolbar-brand", name: "Backlog" }),
      leading: [],
      trailing:
        domain === undefined
          ? []
          : [
              h_flex()
                .id("toolbar-domain")
                .flex_1()
                .min_w_0()
                .h(BUTTON_STYLE.height)
                .items_center()
                .justify_end()
                .child(rowNote(t, domain).min_w_0().truncate().text_right()),
            ],
    }),
  });

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
    model.open,
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

// Open findings, one package row each. Closed findings stay off this page.
const findingsPage = (t: Theme, model: PanelModel): Element => {
  const rows =
    model.findings.length === 0
      ? [emptyRow(t, "findings-empty", "No open findings")]
      : pagedRows(t, "findings-open", model.findings, model, ROW.compact, (finding, index) =>
          findingRow(t, finding, model.openFinding, index === 0),
        );
  return cardSection(
    cardHeader(t, "findings-header", "Findings"),
    card(t, "findings").children(rows),
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
            .flex_wrap()
            .gap(BUTTON_STYLE.gap)
            .children(values.map((value) => div().child(value))),
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

// The answer field is app-specific; the package owns its surrounding card item and button.
const askBodyRow = (t: Theme, id: string): Element => detailRow(t, id).bg(t.surface);

const answerRows = (t: Theme, answer: AnswerModel, prefix = "ask"): Element[] => {
  const { draft } = answer;
  const enabled = chosenAnswer(draft) !== undefined && !draft.busy;
  const field = div()
    .id(`${prefix}-answer-field`)
    .flex_1()
    .min_w(0)
    .min_h(ANSWER.height)
    .px(ANSWER.fieldPaddingX)
    .flex()
    .items_start()
    .rounded(ANSWER.radius)
    .border_1()
    .border_color(answer.typing ? t.accent : t.border)
    .cursor_text()
    .when(answer.input !== undefined, (el) =>
      el.child(
        answerInputElement(answer.input!).h_full().text_size(TEXT.body).text_color(t.foreground),
      ),
    );
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

const askCard = (
  t: Theme,
  id: string,
  ask: Ask,
  answer: AnswerModel | undefined,
  completed: AnsweredAsk | undefined,
  itemTouches: string[] | undefined,
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
  const question = detailRow(t, `${id}-question`)
    .bg(t.popover)
    .rounded_t(CARD.innerRadius)
    .font_medium()
    .child(ask.question);
  const context =
    ask.context === null
      ? []
      : [askBodyRow(t, `${id}-context`).text_color(t.muted).child(ask.context)];
  const touches =
    itemTouches === undefined || itemTouches.length === 0
      ? []
      : [
          fact(t, `${id}-touches`, "Touches", itemTouches, (theme, rowId) =>
            askBodyRow(theme, rowId),
          ),
        ];
  const options = rankedOptions(ask).map(({ option, index, rec }, displayIndex) => {
    const selected = option === picked;
    const chosen = completed !== undefined && option === completed.answer;
    const heading = h_flex()
      .gap(BUTTON_STYLE.gap)
      .items_center()
      .child(div().flex_1().min_w_0().child(option))
      .when(rec, (el) => el.child(small(t, t.accent, "Recommended")))
      .when(chosen, (el) => el.child(small(t, t.done, "Answered")));
    const content = v_flex()
      .id(`${id}-content-${index}`)
      .flex_1()
      .min_w_0()
      .gap(BUTTON_STYLE.gap)
      .child(heading)
      .when(Boolean(ask.optionDetails?.[index]), (el) =>
        el.child(
          div()
            .id(`${id}-detail-${index}`)
            .text_size(TEXT.label)
            .text_color(t.muted)
            .child(ask.optionDetails![index]!),
        ),
      )
      .when(rec && ask.recReason !== null, (el) =>
        el.child(
          div()
            .id(`${id}-rec-reason`)
            .text_size(TEXT.label)
            .text_color(t.muted)
            .child(
              v_flex()
                .gap(BUTTON_STYLE.gap)
                .child(small(t, t.muted, "Why recommended").id(`${id}-rec-reason-label`))
                .child(div().min_w_0().child(ask.recReason!)),
            ),
        ),
      );
    return askBodyRow(t, `${id}-option-${index}`)
      .when(selected, (el) => el.bg(t.selected))
      .when(answer !== undefined && completed === undefined, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(selected ? t.selected : t.hover))
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
              .text_color(t.muted)
              .child(`${displayIndex + 1}.`),
          )
          .child(content),
      );
  });
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
  return [
    detailCard(t, id, completed === undefined ? "Ask" : "Answered ask", [
      question,
      ...context,
      ...touches,
      ...options,
      ...discussion,
      ...completion,
    ]),
  ];
};

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
              .child(div().min_w_0().child(origin.title)),
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
  count: number,
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
        model.findings.length,
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
      pagedRows(t, "domains", listing.domains, model, ROW.list, (row, index) =>
        domainRow(t, row, (cx) => model.openDomain(row.domain, cx), index === 0),
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
          model.page !== undefined || model.detail !== undefined || model.finding !== undefined,
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
          .when(model.detail !== undefined || model.finding !== undefined, (page) =>
            page.invisible(),
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
    .when(model.detail !== undefined, (screens) =>
      screens.child(
        v_flex()
          .id("screen-item")
          .absolute()
          .inset_0()
          .bg(t.surface)
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
          .child(
            paneScrollRegion(
              "finding-scroll",
              findingScreen(t, model.finding!, model),
              PANEL.padding,
            ),
          ),
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
