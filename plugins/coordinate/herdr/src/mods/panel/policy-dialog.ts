// The harness policy settings window, drawn by the dialog copy of the panel mod. It mirrors
// herdr-finbar's settings window (a sidebar with a title, section entries and a Herdr Settings
// button pinned at the bottom; a right pane with an uppercase dim label, then rows of a title, a
// dim description and a right-aligned switch or segmented picker, separated by hairlines), copying
// its pieces rather than importing them. The editor's state and CLI calls live in the panel View.
import { div, svg } from "gpui-kit";
import type { Context, Element, FocusHandle } from "gpui-kit";
import { Popover, h_flex, v_flex } from "gpui-base";
import { HERDR_ICONS, MENU, menuPanel, menuRow } from "@wyattjoh/herdr-ui";
import type { Theme } from "@wyattjoh/herdr-ui";
import { HARNESS_DIALOG, HERDR_SETTINGS_ICON } from "./look.ts";
import type { DelegateHarness, HarnessPolicyState } from "./model.ts";

/**
 * What the window draws and calls: the editor's state for the selected scope, and its actions.
 * Every control applies at once through the Coordinate CLI; there is no draft.
 */
export type HarnessPolicyEditorModel = {
  scope: "global" | "domain";
  domain: string | undefined;
  domains: string[];
  domainMenuOpen: boolean;
  state: HarnessPolicyState;
  busy: boolean;
  failure: string | undefined;
  focus: FocusHandle;
  selectGlobal: (cx: Context) => void;
  selectDomain: (domain: string, cx: Context) => void;
  setDomainMenuOpen: (open: boolean, cx: Context) => void;
  toggle: (harness: DelegateHarness, cx: Context) => void;
  setDefault: (harness: DelegateHarness | null, cx: Context) => void;
  setInherit: (inherit: boolean, cx: Context) => void;
  reload: (cx: Context) => void;
  close: (cx: Context) => void;
  openHerdrSettings: (cx: Context) => void;
};

const HARNESS_LABELS: Readonly<Record<DelegateHarness, string>> = {
  pi: "Pi",
  claude: "Claude Code",
};

const FOLDER_ICON = "mods/workspace-chrome/folder.svg";
// A transparent fill, so a nav entry that is not selected keeps its layout without a color.
const CLEAR = "#00000000";
// A control that cannot be used right now keeps its place, dimmed.
const INERT_OPACITY = 0.45;

// Finbar's settings metrics: nav width and padding, entry padding and radius, pane padding, row
// padding and gap, and its switch and segment sizes.
const SETTINGS = {
  navWidth: 190,
  navPadding: 10,
  navGap: 2,
  titleSize: 16,
  entryGap: 10,
  entryPaddingX: 10,
  entryPaddingY: 7,
  entryRadius: 7,
  entryIcon: 15,
  entryText: 13.5,
  panePaddingX: 28,
  panePaddingY: 22,
  headingSize: 12,
  rowGap: 16,
  rowPaddingY: 12,
  rowTitle: 14,
  rowAbout: 12.5,
  rowAboutLine: "18px",
  segmentPaddingX: 10,
  segmentPaddingY: 6,
  segmentRadius: 5,
  segmentText: 12,
  segmentGap: 4,
  switchWidth: 36,
  switchHeight: 20,
  switchKnob: 16,
  actionPaddingX: 12,
  actionPaddingY: 5,
  actionRadius: 7,
  actionText: 13,
  menuMaxHeight: 240,
} as const;

// The uppercase dim label that opens the right pane.
const heading = (t: Theme, id: string, label: string): Element =>
  div()
    .id(id)
    .pt(6)
    .pb(8)
    .text_size(SETTINGS.headingSize)
    .font_semibold()
    .text_color(t.dim)
    .child(label.toUpperCase());

// One setting: a title over a dim description, with its control at the right, over a hairline.
const row = (t: Theme, id: string, title: string, about: string, control: Element): Element =>
  h_flex()
    .id(id)
    .w_full()
    .gap(SETTINGS.rowGap)
    .py(SETTINGS.rowPaddingY)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(3)
        .child(div().text_size(SETTINGS.rowTitle).text_color(t.foreground).child(title))
        .child(
          div()
            .text_size(SETTINGS.rowAbout)
            .line_height(SETTINGS.rowAboutLine)
            .text_color(t.dim)
            .child(about),
        ),
    )
    .child(control);

// Finbar's settings switch: an accent track with a knob at the end when on. Without a handler it
// is inert and dimmed.
const settingsSwitch = (
  t: Theme,
  id: string,
  checked: boolean,
  onClick: ((cx: Context) => void) | undefined,
): Element =>
  div()
    .id(id)
    .w(SETTINGS.switchWidth)
    .h(SETTINGS.switchHeight)
    .flex_none()
    .rounded(SETTINGS.switchHeight / 2)
    .p(2)
    .bg(checked ? t.accent : t.hover)
    .flex()
    .when(checked, (el) => el.justify_end())
    .when(onClick === undefined, (el) => el.opacity(INERT_OPACITY))
    .when(onClick !== undefined, (el) =>
      el.cursor_pointer().on_click((_event, cx) => {
        cx.stop_propagation();
        onClick!(cx);
      }),
    )
    .child(
      div()
        .w(SETTINGS.switchKnob)
        .h(SETTINGS.switchKnob)
        .rounded(SETTINGS.switchKnob / 2)
        .bg(checked ? t.accent_foreground : t.muted),
    );

// A switch with its harness name beside it, for the enabled-harnesses row.
const harnessSwitch = (
  t: Theme,
  id: string,
  label: string,
  checked: boolean,
  onClick: ((cx: Context) => void) | undefined,
  note: string | undefined,
): Element =>
  h_flex()
    .id(`${id}-group`)
    .gap(8)
    .items_center()
    .child(div().text_size(SETTINGS.segmentText).text_color(t.dim).child(label))
    .child(settingsSwitch(t, id, checked, onClick))
    .when(note !== undefined, (el) =>
      el.child(div().text_size(SETTINGS.segmentText).text_color(t.dim).child(note!)),
    );

// One segment of a segmented picker: the chosen one is filled with the accent.
const segment = (
  t: Theme,
  id: string,
  label: string,
  selected: boolean,
  onClick: ((cx: Context) => void) | undefined,
): Element =>
  div()
    .id(id)
    .px(SETTINGS.segmentPaddingX)
    .py(SETTINGS.segmentPaddingY)
    .rounded(SETTINGS.segmentRadius)
    .text_size(SETTINGS.segmentText)
    .text_color(selected ? t.accent_foreground : t.dim)
    .bg(selected ? t.accent : t.surface)
    .when(onClick === undefined && !selected, (el) => el.opacity(INERT_OPACITY))
    .when(onClick !== undefined, (el) => el.cursor_pointer().on_click((_event, cx) => onClick!(cx)))
    .child(label);

// Finbar's settings action: a bordered raised button.
const settingsAction = (
  t: Theme,
  id: string,
  label: string,
  onClick: ((cx: Context) => void) | undefined,
): Element =>
  h_flex()
    .id(id)
    .gap(8)
    .items_center()
    .px(SETTINGS.actionPaddingX)
    .py(SETTINGS.actionPaddingY)
    .rounded(SETTINGS.actionRadius)
    .border_1()
    .border_color(t.border)
    .bg(t.raised ?? t.selected)
    .text_size(SETTINGS.actionText)
    .text_color(onClick === undefined ? t.dim : t.foreground)
    .when(onClick !== undefined, (el) =>
      el
        .cursor_pointer()
        .hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => onClick!(cx))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation()),
    )
    .child(div().flex_1().child(label));

// A sidebar entry: an icon and a label, raised when it is the one shown.
const navEntry = (t: Theme, id: string, icon: string, label: string, on: boolean): Element =>
  h_flex()
    .id(id)
    .gap(SETTINGS.entryGap)
    .px(SETTINGS.entryPaddingX)
    .py(SETTINGS.entryPaddingY)
    .items_center()
    .rounded(SETTINGS.entryRadius)
    .cursor_pointer()
    .bg(on ? (t.raised ?? t.selected) : CLEAR)
    .hover((style) => style.bg(t.raised ?? t.selected))
    .child(
      svg(icon)
        .size(SETTINGS.entryIcon)
        .text_color(on ? t.accent : t.dim),
    )
    .child(
      div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(SETTINGS.entryText)
        .text_color(on ? t.foreground : t.muted)
        .child(label),
    );

// The domain picker: a sidebar entry that opens a menu of every domain.
const domainPicker = (t: Theme, model: HarnessPolicyEditorModel): Element => {
  const trigger = navEntry(
    t,
    "harness-policy-domain-trigger",
    FOLDER_ICON,
    model.domain ?? "Domain",
    model.domain !== undefined,
  )
    .on_click((_event, cx) => model.setDomainMenuOpen(!model.domainMenuOpen, cx))
    .child(
      svg(HERDR_ICONS.chevronDown)
        .size(SETTINGS.entryIcon - 3)
        .text_color(t.dim),
    );
  return Popover.new("harness-policy-domain-popover")
    .id("harness-policy-domain-popover")
    .open(model.domainMenuOpen)
    .on_open_change((open, cx) => model.setDomainMenuOpen(open, cx))
    .trigger(trigger)
    .when(model.domainMenuOpen, (el) =>
      el.content(
        menuPanel(t, SETTINGS.navWidth - 2 * SETTINGS.navPadding, MENU.padding)
          .id("harness-policy-domain-options")
          .role("menu")
          .accessibility_label("Domain")
          .max_h(SETTINGS.menuMaxHeight)
          .overflow_y_scroll()
          .children(
            model.domains.length === 0
              ? [div().px(SETTINGS.entryPaddingX).py(6).text_color(t.dim).child("No backlogs yet")]
              : model.domains.map((name, index) =>
                  menuRow(t, {
                    id: `harness-policy-domain-${name}`,
                    label: name,
                    selected: false,
                    checked: model.domain === name,
                    onClick: (cx) => model.selectDomain(name, cx),
                  })
                    .role("menu_item")
                    .set_position(index + 1, model.domains.length),
                ),
          ),
      ),
    );
};

// The sidebar: the title, the Global entry, the domain picker, and Herdr Settings at the bottom.
const sidebar = (t: Theme, model: HarnessPolicyEditorModel): Element =>
  v_flex()
    .id("harness-policy-nav")
    .flex_none()
    .w(SETTINGS.navWidth)
    .h_full()
    .p(SETTINGS.navPadding)
    .gap(SETTINGS.navGap)
    .border_r(1)
    .border_color(t.border)
    .child(
      div()
        .px(SETTINGS.entryPaddingX)
        .pt(6)
        .pb(12)
        .text_size(SETTINGS.titleSize)
        .font_semibold()
        .text_color(t.foreground)
        .child("Backlog"),
    )
    .child(
      navEntry(
        t,
        "harness-policy-nav-global",
        HERDR_SETTINGS_ICON,
        "Global",
        model.scope === "global",
      ).on_click((_event, cx) => model.selectGlobal(cx)),
    )
    .child(domainPicker(t, model))
    .child(div().flex_1())
    .child(
      settingsAction(t, "harness-policy-herdr-settings", "Herdr Settings", (cx) =>
        model.openHerdrSettings(cx),
      ),
    );

// The failure line and its Reload button, inline in the pane.
const failureRows = (t: Theme, message: string, model: HarnessPolicyEditorModel): Element[] => [
  div()
    .id("harness-policy-failure")
    .py(SETTINGS.rowPaddingY)
    .text_size(SETTINGS.rowAbout)
    .line_height(SETTINGS.rowAboutLine)
    .text_color(t.blocked)
    .child(message),
  h_flex()
    .id("harness-policy-reload-row")
    .pb(SETTINGS.rowPaddingY)
    .child(
      settingsAction(
        t,
        "harness-policy-reload",
        "Reload policy",
        model.busy ? undefined : (cx) => model.reload(cx),
      ),
    ),
];

// The pane for the scope shown: rows of switches and segments for its policy.
const paneRows = (t: Theme, model: HarnessPolicyEditorModel): Element[] => {
  if (model.state.kind === "loading")
    return [
      div()
        .id("harness-policy-loading")
        .py(SETTINGS.rowPaddingY)
        .text_color(t.dim)
        .child("Loading policy…"),
    ];
  if (model.state.kind === "error") return failureRows(t, model.state.message, model);
  const view = model.state.view;
  const domainPolicy = view.domain;
  const selection = model.scope === "global" ? view.global.policy : domainPolicy?.effective;
  if (selection === undefined || (model.scope === "domain" && domainPolicy === null))
    return failureRows(t, "Coordinate returned policy data for the wrong scope.", model);
  const inheriting = model.scope === "domain" && domainPolicy?.mode === "inherit";
  const canEdit = !model.busy && !inheriting;
  const source =
    model.scope === "global"
      ? view.global.source === "legacy"
        ? "Legacy defaults"
        : "Global policy"
      : inheriting
        ? view.global.source === "legacy"
          ? "Inherited from legacy defaults"
          : "Inherited from global policy"
        : "Domain override";
  const rows: Element[] = [
    div()
      .id("harness-policy-source")
      .pb(SETTINGS.rowPaddingY)
      .text_size(SETTINGS.rowAbout)
      .text_color(t.dim)
      .child(source),
  ];
  if (model.scope === "domain")
    rows.push(
      row(
        t,
        "harness-policy-row-inherit",
        "Inherit global",
        "Use the global harness policy for this domain. Turn it off to give the domain its own.",
        settingsSwitch(
          t,
          "harness-policy-inherit-toggle",
          inheriting,
          model.busy ? undefined : (cx) => model.setInherit(!inheriting, cx),
        ),
      ),
    );
  rows.push(
    row(
      t,
      "harness-policy-row-enabled",
      "Enabled harnesses",
      "Harnesses delegates may be launched with. A disabled harness is refused, including on resume.",
      h_flex()
        .id("harness-policy-enabled")
        .flex_none()
        .gap(18)
        .items_center()
        .children([
          ...(["pi", "claude"] as const).map((harness) =>
            harnessSwitch(
              t,
              `harness-policy-enabled-${harness}`,
              HARNESS_LABELS[harness],
              selection.enabled.includes(harness),
              canEdit ? (cx) => model.toggle(harness, cx) : undefined,
              undefined,
            ),
          ),
          harnessSwitch(
            t,
            "harness-policy-enabled-codex",
            "Codex",
            false,
            undefined,
            "Unavailable",
          ),
        ]),
    ),
    row(
      t,
      "harness-policy-row-default",
      "Default harness",
      "Used when a delegate is launched without naming a harness. Only enabled harnesses can be the default.",
      h_flex()
        .id("harness-policy-default")
        .flex_none()
        .gap(SETTINGS.segmentGap)
        .children([
          segment(
            t,
            "harness-policy-default-none",
            "No default",
            selection.default === null,
            canEdit && selection.default !== null ? (cx) => model.setDefault(null, cx) : undefined,
          ),
          ...(["pi", "claude"] as const).map((harness) =>
            segment(
              t,
              `harness-policy-default-${harness}`,
              HARNESS_LABELS[harness],
              selection.default === harness,
              canEdit && selection.enabled.includes(harness) && selection.default !== harness
                ? (cx) => model.setDefault(harness, cx)
                : undefined,
            ),
          ),
        ]),
    ),
  );
  if (model.failure !== undefined) rows.push(...failureRows(t, model.failure, model));
  return rows;
};

/**
 * The whole settings window. Escape closes the domain menu when it is open, and the window
 * otherwise; a click beside the window closes it too, which Herdr handles for a dialog.
 * @param t The theme.
 * @param model The editor's state and actions.
 * @returns The element.
 */
export const harnessPolicyDialog = (t: Theme, model: HarnessPolicyEditorModel): Element =>
  h_flex()
    .id("harness-policy-dialog")
    .key_context("modal")
    .track_focus(model.focus)
    .w_full()
    .h(HARNESS_DIALOG.height)
    .min_h(0)
    .items_start()
    .text_color(t.foreground)
    .on_key_down((event, cx) => {
      if (event.key !== "escape") return;
      if (model.domainMenuOpen) model.setDomainMenuOpen(false, cx);
      else model.close(cx);
    })
    .child(sidebar(t, model))
    .child(
      v_flex()
        .id("harness-policy-pane")
        .flex_1()
        .min_w(0)
        .h_full()
        .px(SETTINGS.panePaddingX)
        .py(SETTINGS.panePaddingY)
        .overflow_y_scroll()
        .child(
          heading(
            t,
            "harness-policy-title",
            model.scope === "global" ? "Global" : (model.domain ?? "Global"),
          ),
        )
        .children(paneRows(t, model)),
    );
