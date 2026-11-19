// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div } from "gpui-kit";
import type { Color, Context, Element } from "gpui-kit";
import { Input, h_flex, v_flex } from "gpui-base";
import type { InputState } from "gpui-base";
import {
  BUTTON_STYLE,
  CARD,
  HERDR_ICONS,
  PANEL,
  ROW,
  TEXT,
  brand,
  button,
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
  titleRow,
  toolRow,
  topBar,
  letThrough,
} from "@wyattjoh/herdr-ui";
import type { ButtonStyle, Theme } from "@wyattjoh/herdr-ui";
import type { Backlog, Finding, Item } from "../../lib/store.ts";
import {
  ANSWER,
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
  DelegateRow,
  DelegateState,
  DocumentState,
  DomainSummary,
  ItemGroup,
  ListingState,
  Screen,
} from "./model.ts";

export type { Theme } from "@wyattjoh/herdr-ui";

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
// Tasks panel. The layers mark remains host-owned because herdr-ui does not ship that glyph.
const BACKLOG_ICON = "mods/workspace-chrome/layers.svg";

const toolbar = (t: Theme, domain: string | undefined): Element =>
  topBar(t, {
    content: toolRow({
      id: "toolbar",
      brand: brand(t, { id: "toolbar-brand", icon: BACKLOG_ICON, name: "Backlog" }),
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
    .text_size(TEXT.body)
    .text_color(focus === null ? t.dim : t.foreground)
    .child(focus ?? "No focus set");

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
): Element => {
  const line = delegateLine(rows);
  return listRow(t, {
    id: `item-${item.id}`,
    label: item.id,
    title: item.title,
    titleRole: item.status === "dismissed" ? "dim" : "foreground",
    height: ROW.compact,
    trailing: line === undefined ? [] : [delegateChip(t, item, line)],
    onClick: (cx) => open(item, cx),
  });
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
): Element =>
  groupBlock(t, motionScope, {
    id: `group-${group.status}`,
    label: group.label,
    tone: STATUS_TONES[group.status],
    count: group.items.length,
    rows: group.items.map((item) =>
      itemRow(t, item, delegates.byItem.get(item.id) ?? [], openItem),
    ),
    rowHeight: ROW.compact,
    open,
    first,
    last,
    toggle,
  });

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
            ),
          ),
    ),
  );

const emptyRow = (t: Theme, id: string, label: string): Element => cardNote(t, label).id(id);

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

// Live domain terminals have no item name, so they stay in their own section.
const unfiledCard = (t: Theme, rows: DelegateRow[]): Element[] =>
  rows.length === 0
    ? []
    : [
        cardSection(
          cardHeader(t, "unfiled-header", "Unfiled delegates"),
          card(t, "unfiled").children(
            rows.map((row, index) => delegateRow(t, row, row.depth, index === 0)),
          ),
        ),
      ];

// Closed findings have fixed-height rows, so herdr-ui's generic animated group fits directly.
const closedGroup = (t: Theme, model: PanelModel): Element =>
  groupBlock(t, model.domain ?? "coordinate-panel", {
    id: "group-findings-closed",
    label: "Closed",
    tone: "muted",
    count: model.closed.length,
    rows: model.closed.map((finding) => findingRow(t, finding, model.openFinding)),
    rowHeight: ROW.compact,
    open: model.closedOpen,
    first: false,
    last: true,
    toggle: model.toggleClosed,
  });

// Open findings, one package row each, then the closed ones in the package's collapsible group.
const findingsCard = (t: Theme, model: PanelModel): Element =>
  cardSection(
    cardHeader(t, "findings-header", "Findings"),
    card(t, "findings")
      .children(
        model.findings.length === 0
          ? [emptyRow(t, "findings-empty", "No open findings")]
          : model.findings.map((finding, index) =>
              findingRow(t, finding, model.openFinding, index === 0),
            ),
      )
      .children(model.closed.length === 0 ? [] : [closedGroup(t, model)]),
  );

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
const fact = (t: Theme, id: string, label: string, values: string[]): Element =>
  detailRow(t, id)
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
      el.child(Input.new(answer.input!).h_full().text_size(TEXT.body).text_color(t.foreground)),
    );
  const submit = button(t, {
    id: "ask-answer-submit",
    label: draft.busy ? "Answering…" : "Answer",
    style: enabled ? ANSWER_BUTTON_STYLE : { ...ANSWER_BUTTON_STYLE, background: "raised" },
    onClick: enabled ? (cx) => answer.submit(cx) : undefined,
  });
  return [
    detailRow(t, "ask-answer").child(h_flex().gap(ANSWER.gap).child(field).child(submit)),
    ...(draft.error === undefined
      ? []
      : [
          detailRow(t, "ask-answer-error")
            .text_size(TEXT.label)
            .text_color(role(t, "ansi1"))
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
          .gap(BUTTON_STYLE.gap)
          .items_center()
          .child(div().min_w_0().child(option))
          .when(rec, (el) => el.child(small(t, t.accent, "Recommended"))),
      )
      .when(rec && ask.recReason !== null, (el) =>
        el.child(
          div()
            .id("ask-rec-reason")
            .text_size(TEXT.label)
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
    .children(delegatesCard(t, item, delegates.byItem.get(item.id) ?? []));

// Standing approvals wrap and do not animate, so the package's header, fold chevron and card
// pieces are composed directly instead of using its fixed-row groupBlock.
const standingCard = (t: Theme, backlog: Backlog, model: PanelModel): Element => {
  const open = model.standingOpen;
  const entries = backlog.standingYes;
  const header = cardHeader(t, "standing-header", "Standing yes", open)
    .cursor_pointer()
    .on_click((_event, cx) => model.toggleStanding(cx))
    .child(div().flex_1())
    .child(rowNote(t, String(entries.length)));
  return v_flex()
    .flex_none()
    .gap(CARD.sectionGap)
    .child(header)
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
        ? COUNT_LABELS.map(([key, label]) =>
            rowNote(t, `${row.counts[key]} ${label}`).text_color(
              role(t, row.counts[key] > 0 ? COUNT_TONES[key] : "dim"),
            ),
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
        .when(model.detail !== undefined || model.finding !== undefined, (list) => list.invisible())
        .child(
          paneScrollRegion(
            "panel-scroll",
            domainBody(t, model.domain!, model.doc, model),
            PANEL.padding,
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
