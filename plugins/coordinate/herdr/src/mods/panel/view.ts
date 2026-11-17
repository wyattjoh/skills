// The panel's regions as element functions: everything it draws, from data the View hands in.
import { div, svg } from "gpui-kit";
import type { Color, Context, Element } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import type { Item } from "../../lib/store.ts";
import {
  BAR_CONTROL_HEIGHT,
  BAR_PADDING_Y,
  CARD_GAP,
  CARD_HEADER_HEIGHT,
  CARD_PADDING_X,
  CARD_RADIUS,
  CARD_SECTION_GAP,
  CRUMB_HEIGHT,
  FOLD_MOTION,
  GROUP_HEADER_HEIGHT,
  ICONS,
  INNER_RADIUS,
  ITEM_ROW_HEIGHT,
  PANEL_PADDING,
  STATUS_TONES,
  TEXT_BODY,
  TEXT_SMALL,
} from "./look.ts";
import type { DocumentState, ItemGroup } from "./model.ts";

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
  groups: ItemGroup[];
  isOpen: (group: ItemGroup) => boolean;
  toggle: (group: ItemGroup, cx: Context) => void;
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
    .bg(t.chrome)
    .child(
      h_flex()
        .h(BAR_CONTROL_HEIGHT)
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

const itemRow = (t: Theme, item: Item): Element =>
  cardRow(t, `item-${item.id}`, t.hover)
    .h(ITEM_ROW_HEIGHT)
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
): Element =>
  v_flex()
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
        .h(open ? group.items.length * ITEM_ROW_HEIGHT : 0)
        .transition("height", FOLD_MOTION)
        .children(group.items.map((item) => itemRow(t, item))),
    );

const itemsCard = (t: Theme, model: PanelModel): Element =>
  v_flex()
    .flex_none()
    .gap(CARD_SECTION_GAP)
    .child(cardHeader(t, "items-header", "Items"))
    .child(
      card(t, "items").children(
        model.groups.length === 0
          ? [
              div()
                .id("items-empty")
                .px(CARD_PADDING_X)
                .py(8)
                .text_size(TEXT_SMALL)
                .text_color(t.dim)
                .child("No items"),
            ]
          : model.groups.map((group, index) =>
              groupBlock(
                t,
                group,
                model.isOpen(group),
                index === 0,
                index === model.groups.length - 1,
                (cx) => model.toggle(group, cx),
              ),
            ),
      ),
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
  if (doc.kind === "invalid") return message(t, "invalid", "Couldn't read the backlog", doc.reason);
  return v_flex()
    .id("domain")
    .gap(CARD_GAP)
    .child(focusHeader(t, doc.backlog.focus))
    .child(itemsCard(t, model));
};

/**
 * The whole panel: tool bar, then the domain crumb and its body, or why there is none.
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
    .when(model.domain === undefined, (el) =>
      el.child(
        message(
          t,
          "no-domain",
          "No domain focused",
          "Focus a coordinator or one of its delegates to see its backlog.",
        ),
      ),
    )
    .when(model.domain !== undefined, (el) =>
      el.child(crumb(t, model.domain!)).child(
        v_flex()
          .id("panel-scroll")
          .flex_1()
          .min_h_0()
          .overflow_y_scrollbar()
          .p(PANEL_PADDING)
          .child(domainBody(t, model.domain!, model.doc, model)),
      ),
    );
