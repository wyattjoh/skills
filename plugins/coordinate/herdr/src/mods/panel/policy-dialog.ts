// The harness policy settings window, drawn by the dialog copy of the panel mod. It mirrors
// herdr-finbar's settings window (a sidebar with a title, section entries and a Herdr Settings
// button pinned at the bottom; a right pane with an uppercase dim label, then rows of a title, a
// dim description and a right-aligned switch or segmented picker, separated by hairlines), copying
// its pieces rather than importing them. The editor's state and CLI calls live in the panel View.
import { div, svg } from "gpui-kit";
import type { Context, Element, FocusHandle } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { HERDR_ICONS, MENU, TEXT, menuPanel, menuRow } from "@wyattjoh/herdr-ui";
import type { Theme } from "@wyattjoh/herdr-ui";
import { GLOBE_ICON, HARNESS_DIALOG } from "./look.ts";
import { harnessPolicyNotices } from "./model.ts";
import type {
  DelegateHarness,
  HarnessPolicyDraft,
  HarnessPolicyNotice,
  HarnessPolicyState,
  HarnessSelection,
} from "./model.ts";

/**
 * What the window draws and calls: the editor's state for the selected scope, and its actions.
 * Controls edit a draft; nothing is written until Save, and every way out with unsaved changes
 * asks first.
 */
export type HarnessPolicyEditorModel = {
  scope: "global" | "domain";
  domain: string | undefined;
  domains: string[];
  // The listed domains with their own saved override (Inherit global off), badged in the menu.
  overrides: string[];
  // Those domains' saved overrides, for the global scope's notes on what each keeps enabled.
  overrideSelections: readonly (readonly [string, HarnessSelection])[];
  domainMenuOpen: boolean;
  state: HarnessPolicyState;
  busy: boolean;
  failure: string | undefined;
  // The edit in progress (or what is on disk, before any edit), whether it differs from disk, and
  // whether the policy changed on disk since it was seeded.
  draft: HarnessPolicyDraft | undefined;
  dirty: boolean;
  conflict: boolean;
  // Whether the Discard changes? confirm is showing.
  confirming: boolean;
  focus: FocusHandle;
  selectGlobal: (cx: Context) => void;
  selectDomain: (domain: string, cx: Context) => void;
  setDomainMenuOpen: (open: boolean, cx: Context) => void;
  toggle: (harness: DelegateHarness, cx: Context) => void;
  setDefault: (harness: DelegateHarness | null, cx: Context) => void;
  setInherit: (inherit: boolean, cx: Context) => void;
  reload: (cx: Context) => void;
  save: (cx: Context) => void;
  cancel: (cx: Context) => void;
  keepEditing: (cx: Context) => void;
  discard: (cx: Context) => void;
};

const HARNESS_LABELS: Readonly<Record<DelegateHarness, string>> = {
  pi: "Pi",
  claude: "Claude Code",
};

// A transparent fill, so a nav entry that is not selected keeps its layout without a color.
const CLEAR = "#00000000";
// A control that cannot be used right now keeps its place, dimmed.
const INERT_OPACITY = 0.45;
// A dim layer over the window behind the confirm.
const SCRIM = "#00000099";

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
  controlHeight: 28,
  buttonPaddingX: 12,
  buttonText: 12.5,
  footerGap: 8,
  footerPaddingY: 14,
  confirmWidth: 360,
  confirmPadding: 18,
  confirmGap: 12,
  confirmRadius: 10,
  confirmTitle: 15,
  windowRadius: 10,
  scopeMenuWidth: 220,
  scopeMenuTop: 58,
  scopeLabelWidth: 180,
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

// A footer button in Finbar's dialog style: raised, or solid for the one main action, or the
// blocked color for a destructive one. Without a handler it is inert and dimmed, and an inert
// main action drops back to the raised look so no bright button sits there doing nothing.
const dialogButton = (
  t: Theme,
  id: string,
  label: string,
  onClick: ((cx: Context) => void) | undefined,
  tone: "plain" | "primary" | "destructive" = "plain",
): Element =>
  div()
    .id(id)
    .flex_none()
    .px(SETTINGS.buttonPaddingX)
    .h(SETTINGS.controlHeight)
    .flex()
    .items_center()
    .rounded(SETTINGS.actionRadius)
    .text_size(SETTINGS.buttonText)
    .when(tone === "primary" && onClick !== undefined, (el) =>
      el.bg(t.solid).text_color(t.solid_foreground),
    )
    .when(tone === "destructive", (el) => el.bg(t.blocked).text_color(t.solid_foreground))
    .when(tone === "plain" || (tone === "primary" && onClick === undefined), (el) =>
      el.bg(t.raised ?? t.selected).text_color(onClick === undefined ? t.dim : t.foreground),
    )
    .when(onClick !== undefined, (el) =>
      el
        .cursor_pointer()
        .hover((style) => style.opacity(0.85))
        .on_click((_event, cx) => onClick!(cx)),
    )
    .child(label);

// The Discard changes? confirm, in the same window: a dim layer over everything, with a card
// that follows the dialog's surface. Clicks on the layer do nothing.
const confirmLayer = (t: Theme, model: HarnessPolicyEditorModel): Element =>
  h_flex()
    .id("harness-policy-confirm-layer")
    .absolute()
    .inset_0()
    .items_center()
    .justify_center()
    .bg(SCRIM)
    .on_click((_event, cx) => cx.stop_propagation())
    .child(
      v_flex()
        .id("harness-policy-confirm")
        .w(SETTINGS.confirmWidth)
        .p(SETTINGS.confirmPadding)
        .gap(SETTINGS.confirmGap)
        .rounded(SETTINGS.confirmRadius)
        .border_1()
        .border_color(t.border)
        .bg(t.popover)
        .child(
          div()
            .id("harness-policy-confirm-title")
            .text_size(SETTINGS.confirmTitle)
            .font_semibold()
            .text_color(t.foreground)
            .child("Discard changes?"),
        )
        .child(
          div()
            .id("harness-policy-confirm-text")
            .text_size(SETTINGS.rowAbout)
            .line_height(SETTINGS.rowAboutLine)
            .text_color(t.dim)
            .child("Your harness setting changes will be lost."),
        )
        .child(
          h_flex()
            .id("harness-policy-confirm-actions")
            .gap(SETTINGS.footerGap)
            .justify_end()
            .child(
              dialogButton(t, "harness-policy-keep-editing", "Keep editing", (cx) =>
                model.keepEditing(cx),
              ),
            )
            .child(
              dialogButton(
                t,
                "harness-policy-discard",
                "Discard",
                (cx) => model.discard(cx),
                "destructive",
              ),
            ),
        ),
    );

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

// The scope control: a bordered button at the pane's top right showing the scope shown. One click
// opens the menu below it. The menu is plain state, not a Popover: a Popover also reacts to the
// press on its trigger, and a toggle on the click then closed it again on release.
const scopeTrigger = (t: Theme, model: HarnessPolicyEditorModel): Element =>
  h_flex()
    .id("harness-policy-scope-trigger")
    .flex_none()
    .gap(8)
    .items_center()
    .px(SETTINGS.actionPaddingX)
    .py(SETTINGS.actionPaddingY)
    .rounded(SETTINGS.actionRadius)
    .border_1()
    .border_color(t.border)
    .bg(t.raised ?? t.selected)
    .text_size(SETTINGS.actionText)
    .text_color(t.foreground)
    .cursor_pointer()
    .hover((style) => style.bg(t.hover))
    .on_click((_event, cx) => model.setDomainMenuOpen(true, cx))
    .child(
      div()
        .max_w(SETTINGS.scopeLabelWidth)
        .truncate()
        .child(model.scope === "global" ? "Global" : (model.domain ?? "Global")),
    )
    .child(
      svg(HERDR_ICONS.chevronDown)
        .size(SETTINGS.entryIcon - 3)
        .text_color(t.dim),
    );

// The Override tag beside a domain with its own saved policy, in the panel's tag style (the
// answer cards' Recommended and Answered).
const overrideBadge = (t: Theme, id: string): Element =>
  div().id(id).flex_none().text_size(TEXT.label).text_color(t.accent).child("Override");

// The scope menu, over the pane: Global first with the globe, then every backlog domain, each
// with an Override tag when it has its own policy. The check is drawn here rather than by
// menuRow, so it stays at the far end after the tag. A backdrop under the menu catches a click
// anywhere else and closes it.
const scopeMenu = (t: Theme, model: HarnessPolicyEditorModel): Element[] => [
  div()
    .id("harness-policy-scope-backdrop")
    .absolute()
    .inset_0()
    .on_click((_event, cx) => model.setDomainMenuOpen(false, cx)),
  menuPanel(t, SETTINGS.scopeMenuWidth, MENU.padding)
    .id("harness-policy-scope-options")
    .role("menu")
    .accessibility_label("Scope")
    .absolute()
    .top(SETTINGS.scopeMenuTop)
    .right(SETTINGS.panePaddingX)
    .max_h(SETTINGS.menuMaxHeight)
    .overflow_y_scroll()
    .children(
      [undefined, ...model.domains].map((name, index) =>
        menuRow(t, {
          id:
            name === undefined
              ? "harness-policy-scope-global"
              : `harness-policy-scope-domain-${name}`,
          label: name ?? "Global",
          ...(name === undefined
            ? {
                leading: svg(GLOBE_ICON)
                  .id("harness-policy-scope-global-icon")
                  .size(MENU.icon)
                  .flex_none()
                  .text_color(t.muted),
              }
            : {}),
          selected: false,
          onClick: (cx) =>
            name === undefined ? model.selectGlobal(cx) : model.selectDomain(name, cx),
        })
          .when(name !== undefined && model.overrides.includes(name), (el) =>
            el.child(overrideBadge(t, `harness-policy-scope-override-${name}`)),
          )
          .when(model.domain === name, (el) =>
            el.child(
              svg(HERDR_ICONS.check)
                .id(
                  name === undefined
                    ? "harness-policy-scope-check-global"
                    : `harness-policy-scope-check-${name}`,
                )
                .size(MENU.icon)
                .flex_none()
                .text_color(t.foreground),
            ),
          )
          .role("menu_item")
          .set_position(index + 1, model.domains.length + 1),
      ),
    ),
];

// The sidebar: the title and its one section, Harness.
const sidebar = (t: Theme): Element =>
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
    .child(navEntry(t, "harness-policy-nav-harness", HERDR_ICONS.terminal, "Harness", true));

const harnessList = (harnesses: readonly DelegateHarness[]): string =>
  harnesses.map((harness) => HARNESS_LABELS[harness]).join(" and ");

// A note under the rows: what an override does against the global policy, or which domains keep
// a harness the global policy disables. A re-enable is a warning, in the failure color.
const noticeRow = (t: Theme, notice: HarnessPolicyNotice): Element => {
  const [id, message, warning] =
    notice.kind === "reenabled"
      ? [
          "harness-policy-notice-reenabled",
          `This override enables ${harnessList(notice.harnesses)}, which the global policy disables. Turn on Inherit global to follow it.`,
          true,
        ]
      : notice.kind === "frozen"
        ? [
            "harness-policy-notice-frozen",
            "This override matches the global policy now, but it will not follow later global changes.",
            false,
          ]
        : [
            `harness-policy-notice-kept-${notice.domain}`,
            `${notice.domain} keeps ${harnessList(notice.harnesses)} enabled through its own override.`,
            true,
          ];
  return div()
    .id(id)
    .py(SETTINGS.rowPaddingY)
    .text_size(SETTINGS.rowAbout)
    .line_height(SETTINGS.rowAboutLine)
    .text_color(warning ? t.blocked : t.dim)
    .child(message);
};

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

// The pane for the scope shown: rows of switches and segments for its draft.
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
  const draft = model.draft;
  if (draft === undefined || (model.scope === "domain" && domainPolicy === null))
    return failureRows(t, "Coordinate returned policy data for the wrong scope.", model);
  const inheriting = model.scope === "domain" && draft.inherit;
  // An inheriting domain shows the global policy it will use, not the override being dropped.
  const selection = inheriting ? view.global.policy : draft.selection;
  const canEdit = !model.busy && !model.conflict;
  const source =
    model.scope === "global"
      ? view.global.source === "legacy"
        ? "Legacy defaults"
        : "Global policy"
      : inheriting
        ? view.global.source === "legacy"
          ? "Inherits legacy defaults"
          : "Inherits global policy"
        : "Domain override";
  const rows: Element[] = [
    div()
      .id("harness-policy-source")
      .pb(SETTINGS.rowPaddingY)
      .text_size(SETTINGS.rowAbout)
      .text_color(t.dim)
      .child(model.dirty ? `${source} · Unsaved changes` : source),
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
          canEdit ? (cx) => model.setInherit(!draft.inherit, cx) : undefined,
        ),
      ),
    );
  const editable = canEdit && !inheriting;
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
              editable ? (cx) => model.toggle(harness, cx) : undefined,
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
            editable && selection.default !== null ? (cx) => model.setDefault(null, cx) : undefined,
          ),
          ...(["pi", "claude"] as const).map((harness) =>
            segment(
              t,
              `harness-policy-default-${harness}`,
              HARNESS_LABELS[harness],
              selection.default === harness,
              editable && selection.enabled.includes(harness) && selection.default !== harness
                ? (cx) => model.setDefault(harness, cx)
                : undefined,
            ),
          ),
        ]),
    ),
  );
  rows.push(
    ...harnessPolicyNotices(view, draft, model.overrideSelections).map((notice) =>
      noticeRow(t, notice),
    ),
  );
  if (model.conflict)
    rows.push(
      ...failureRows(
        t,
        "Policy changed while you were editing. Reload to discard your changes, then make them again.",
        model,
      ),
    );
  else if (model.failure !== undefined) rows.push(...failureRows(t, model.failure, model));
  return rows;
};

// The settings window itself, drawn with the frame Herdr's dialog would give it: the dialog's
// surface, a hairline border, rounded corners and a shadow. A click inside stays inside.
const settingsWindow = (t: Theme, model: HarnessPolicyEditorModel): Element =>
  h_flex()
    .id("harness-policy-dialog")
    .key_context("modal")
    .track_focus(model.focus)
    .relative()
    .flex_none()
    .w(HARNESS_DIALOG.width)
    .max_w_full()
    .h(HARNESS_DIALOG.height)
    .max_h_full()
    .min_h(0)
    .items_start()
    .rounded(SETTINGS.windowRadius)
    .border_1()
    .border_color(t.border)
    .bg(t.popover)
    .shadow_lg()
    .overflow_hidden()
    .text_color(t.foreground)
    .on_click((_event, cx) => cx.stop_propagation())
    .on_key_down((event, cx) => {
      if (event.key !== "escape") return;
      cx.stop_propagation();
      if (model.confirming) model.keepEditing(cx);
      else if (model.domainMenuOpen) model.setDomainMenuOpen(false, cx);
      else model.cancel(cx);
    })
    .child(sidebar(t))
    .child(
      v_flex()
        .id("harness-policy-pane-column")
        .flex_1()
        .min_w(0)
        .h_full()
        .child(
          v_flex()
            .id("harness-policy-pane")
            .flex_1()
            .min_h(0)
            .px(SETTINGS.panePaddingX)
            .py(SETTINGS.panePaddingY)
            .overflow_y_scroll()
            .child(
              h_flex()
                .id("harness-policy-pane-head")
                .items_center()
                .gap(SETTINGS.rowGap)
                .child(
                  div()
                    .flex_1()
                    .child(heading(t, "harness-policy-title", "Harness")),
                )
                .child(scopeTrigger(t, model)),
            )
            .children(paneRows(t, model)),
        )
        .child(
          h_flex()
            .id("harness-policy-footer")
            .flex_none()
            .px(SETTINGS.panePaddingX)
            .py(SETTINGS.footerPaddingY)
            .gap(SETTINGS.footerGap)
            .justify_end()
            .border_t(1)
            .border_color(t.border)
            .child(
              dialogButton(
                t,
                "harness-policy-cancel",
                "Cancel",
                model.busy ? undefined : (cx) => model.cancel(cx),
              ),
            )
            .child(
              dialogButton(
                t,
                "harness-policy-save",
                model.busy ? "Saving…" : "Save",
                model.dirty && !model.busy && !model.conflict ? (cx) => model.save(cx) : undefined,
                "primary",
              ),
            ),
        ),
    )
    .when(model.domainMenuOpen, (el) => el.children(scopeMenu(t, model)))
    .when(model.confirming, (el) => el.child(confirmLayer(t, model)));

/**
 * The whole overlay: the settings window centered over the dimmed app. Escape closes the domain
 * menu when it is open, and the window otherwise; a click beside the window is Cancel, so it
 * closes at once or, with unsaved changes in any scope, asks first.
 * @param t The theme.
 * @param model The editor's state and actions.
 * @returns The element.
 */
export const harnessPolicyDialog = (t: Theme, model: HarnessPolicyEditorModel): Element =>
  h_flex()
    .id("harness-policy-backdrop")
    .size_full()
    .items_center()
    .justify_center()
    .on_click((_event, cx) => model.cancel(cx))
    .child(settingsWindow(t, model));
