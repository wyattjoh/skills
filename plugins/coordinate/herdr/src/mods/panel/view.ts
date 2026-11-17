// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div, svg } from "gpui-kit";
import type { Color, Context, Element } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import type { Finding, Item } from "../../lib/store.ts";
import { CONTROL } from "../../lib/look.ts";
import {
  DETAIL_LINE_GAP,
  DETAIL_ROW_PADDING_Y,
  BAR_PADDING_Y,
  CARD_GAP,
  CARD_HEADER_HEIGHT,
  CARD_PADDING_X,
  CARD_RADIUS,
  CARD_SECTION_GAP,
  CRUMB_HEIGHT,
  DELEGATE_INDENT,
  DELEGATE_ROW_HEIGHT,
  DELEGATE_TONES,
  FINDING_GLYPHS,
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
import { GROUP_LABELS, rankedOptions } from "./model.ts";
import type {
  DelegateJoin,
  DelegateRow,
  DelegateState,
  DocumentState,
  DomainSummary,
  ItemGroup,
  ListingState,
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
  // Whether the domain was opened from the listing, so Back can return to it.
  picked: boolean;
  groups: ItemGroup[];
  findings: Finding[];
  // Each item's delegates joined to the live terminals, and the domain's unfiled delegates.
  delegates: DelegateJoin;
  isOpen: (group: ItemGroup) => boolean;
  toggle: (group: ItemGroup, cx: Context) => void;
  // The item whose detail screen is on top of the list, if any.
  detail: Item | undefined;
  open: (item: Item, cx: Context) => void;
  openDomain: (domain: string, cx: Context) => void;
  back: (cx: Context) => void;
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

// The Tasks panel's tool bar button: an icon and a label on the bar's fill.
const button = (t: Theme, id: string, icon: string, label: string, run: (cx: Context) => void) =>
  h_flex()
    .id(id)
    .h(CONTROL.height)
    .px(CONTROL.paddingX)
    .gap(CONTROL.gap)
    .flex_none()
    .items_center()
    .rounded(CONTROL.radius)
    .cursor_pointer()
    .text_size(CONTROL.textSize)
    .bg(t.chrome)
    .text_color(t.muted)
    .hover((s) => s.bg(t.hover))
    .on_click((_event, cx) => run(cx))
    .child(svg(icon).size(CONTROL.iconSize))
    .child(label);

const toolbar = (t: Theme, back: ((cx: Context) => void) | undefined): Element =>
  h_flex()
    .id("toolbar")
    .flex_none()
    .px(PANEL_PADDING)
    .py(BAR_PADDING_Y)
    .gap(CONTROL.gap)
    .bg(t.chrome)
    .when(back !== undefined, (el) => el.child(button(t, "back", ICONS.back, "Back", back!)))
    .child(
      h_flex()
        .h(CONTROL.height)
        .items_center()
        .text_size(TEXT_SMALL)
        .font_medium()
        .text_color(t.muted)
        .child("Backlog"),
    );

const crumb = (t: Theme, domain: string): Element =>
  h_flex()
    .id("crumb")
    .flex_none()
    .h(CRUMB_HEIGHT)
    .px(PANEL_PADDING)
    .items_center()
    .border_t(1)
    .border_b(1)
    .border_color(t.border)
    .text_size(TEXT_SMALL)
    .text_color(t.muted)
    .child(domain);

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

const delegateLabel = (state: DelegateState): string => {
  if (state.kind === "live") return state.status;
  if (state.kind === "gone") return "gone";
  return state.at === null ? "ended" : `ended ${state.at}`;
};

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

const itemRow = (t: Theme, item: Item, open: (item: Item, cx: Context) => void): Element =>
  cardRow(t, `item-${item.id}`, t.hover)
    .h(ITEM_ROW_HEIGHT)
    .cursor_pointer()
    .on_click((_event, cx) => open(item, cx))
    .child(div().flex_none().text_size(TEXT_SMALL).text_color(t.muted).child(item.id))
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(TEXT_BODY)
        .text_color(item.status === "dismissed" ? t.dim : t.foreground)
        .child(item.title),
    );

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
  const delegateCount = group.items.reduce((sum, item) => sum + rowsOf(item).length, 0);
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
        .h(open ? group.items.length * ITEM_ROW_HEIGHT + delegateCount * DELEGATE_ROW_HEIGHT : 0)
        .transition("height", FOLD_MOTION)
        .children(
          group.items.flatMap((item) => [
            itemRow(t, item, openItem),
            ...rowsOf(item).map((row) => delegateRow(t, row, row.depth + 1)),
          ]),
        ),
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

const findingRow = (t: Theme, finding: Finding): Element =>
  cardRow(t, `finding-${finding.id}`, t.hover)
    .h(ITEM_ROW_HEIGHT)
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
        .text_color(t.foreground)
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

// Open findings, one fixed row each. The first row drops its rule so it sits flush with the
// card's top edge, as the first group band does in the Items card.
const findingsCard = (t: Theme, findings: Finding[]): Element =>
  v_flex()
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(cardHeader(t, "findings-header", "Findings"))
    .child(
      card(t, "findings").children(
        findings.length === 0
          ? [emptyRow(t, "findings-empty", "No open findings")]
          : findings.map((finding, index) =>
              findingRow(t, finding).when(index === 0, (el) => el.border_t(0)),
            ),
      ),
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

const askCard = (t: Theme, item: Item): Element[] => {
  const ask = item.ask;
  if (ask === null) return [];
  const question = detailRow(t, "ask-question").font_medium().child(ask.question);
  const context =
    ask.context === null
      ? []
      : [detailRow(t, "ask-context").text_color(t.muted).child(ask.context)];
  const options = rankedOptions(ask).map(({ option, index, rec }) =>
    detailRow(t, `ask-option-${index}`)
      .when(rec, (el) => el.bg(t.selected))
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
  return [detailCard(t, "ask", "Ask", [question, ...context, ...options])];
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

// The read-only detail of one item, in its own scroll area so the list's keeps its place.
const detailScreen = (t: Theme, item: Item, delegates: DelegateJoin): Element =>
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
          v_flex()
            .gap(DETAIL_LINE_GAP)
            .child(
              h_flex()
                .id("detail-title")
                .gap(7)
                .child(div().flex_none().text_size(TEXT_SMALL).text_color(t.muted).child(item.id))
                .child(
                  div()
                    .min_w_0()
                    .text_size(TEXT_BODY)
                    .font_medium()
                    .text_color(t.foreground)
                    .child(item.title),
                ),
            )
            .child(
              div()
                .id("detail-status")
                .text_size(TEXT_SMALL)
                .text_color(t[STATUS_TONES[item.status]])
                .child(GROUP_LABELS[item.status]),
            ),
        )
        .children(askCard(t, item))
        .child(
          detailCard(t, "facts", "Details", [
            fact(t, "fact-due", "Due", item.due === null ? [] : [item.due]),
            fact(t, "fact-touches", "Touches", item.touches),
            ...(item.outcome === null ? [] : [fact(t, "fact-outcome", "Outcome", [item.outcome])]),
          ]),
        )
        .children(decidedCard(t, item))
        .children(delegatesCard(t, item, delegates.byItem.get(item.id) ?? [])),
    );

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
    .child(findingsCard(t, model.findings));
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
 * The whole panel: tool bar, then either the domain crumb and its body, or the all-domains
 * listing when no domain is focused or opened.
 * @param t The theme.
 * @param model What to draw.
 * @returns The element.
 */
export const panel = (t: Theme, model: PanelModel): Element =>
  v_flex()
    .id("coordinate-panel")
    .size_full()
    .bg(t.surface)
    .child(toolbar(t, model.detail !== undefined || model.picked ? model.back : undefined))
    .when(model.domain === undefined, (el) =>
      el.child(crumb(t, "All domains")).child(scroll(listingBody(t, model.listing, model))),
    )
    .when(model.domain !== undefined, (el) =>
      el.child(crumb(t, model.domain!)).child(
        // Screens stack as the Tasks panel's do: the list stays mounted, invisible, under an
        // item's detail, so its scroll area keeps its position for Back.
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
              .when(model.detail !== undefined, (list) => list.invisible())
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
                .child(detailScreen(t, model.detail!, model.delegates)),
            ),
          ),
      ),
    );
