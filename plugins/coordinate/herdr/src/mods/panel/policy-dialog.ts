// The harness policy editor as a Herdr dialog. Its structure, spacing, header, controls and
// buttons follow herdr-finbar's tag editor dialog (a padded popover surface, a 15px semibold
// title, dim-labelled rows, 28px raised buttons with one solid primary), so the two dialogs read
// as one family. The editor's state and CLI calls live in the panel View; this file only draws.
import { div } from "gpui-kit";
import type { Context, Element, FocusHandle } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import type { Theme } from "@wyattjoh/herdr-ui";
import { sameHarnessSelection } from "./model.ts";
import type {
  DelegateHarness,
  HarnessPolicyDraft,
  HarnessPolicyState,
  HarnessSelection,
} from "./model.ts";

/**
 * What the dialog draws and calls: the editor's state for one scope, and its actions.
 */
export type HarnessPolicyEditorModel = {
  scope: "global" | "domain";
  domain: string | undefined;
  state: HarnessPolicyState;
  draft: HarnessPolicyDraft | undefined;
  busy: boolean;
  failure: string | undefined;
  conflict: boolean;
  focus: FocusHandle;
  beginOverride: (cx: Context) => void;
  toggle: (harness: DelegateHarness, cx: Context) => void;
  setDefault: (harness: DelegateHarness | null, cx: Context) => void;
  save: (cx: Context) => void;
  reset: (cx: Context) => void;
  cancel: (cx: Context) => void;
  reload: (cx: Context) => void;
};

const HARNESS_LABELS: Readonly<Record<DelegateHarness, string>> = {
  pi: "Pi",
  claude: "Claude Code",
};

// Finbar's dialog metrics: surface padding, row gap, control height and radius, label column.
const DIALOG = {
  padding: 18,
  gap: 12,
  titleSize: 15,
  rowGap: 10,
  labelSize: 11.5,
  labelWidth: 56,
  controlHeight: 28,
  controlRadius: 7,
  controlSize: 12,
  buttonPaddingX: 12,
  buttonSize: 12.5,
  pillPaddingX: 9,
  footerGap: 8,
} as const;

/**
 * A dialog button: the raised secondary look, or the solid primary fill for the one main action.
 * Without a handler it is inert: dimmed, with no pointer or hover.
 * @param t The theme.
 * @param id The element id.
 * @param label The button text.
 * @param onClick Runs on click with that click's context.
 * @param primary Whether this is the dialog's main action.
 * @returns The button.
 */
const dialogButton = (
  t: Theme,
  id: string,
  label: string,
  onClick: ((cx: Context) => void) | undefined,
  primary = false,
): Element =>
  div()
    .id(id)
    .flex_none()
    .px(DIALOG.buttonPaddingX)
    .h(DIALOG.controlHeight)
    .flex()
    .items_center()
    .rounded(DIALOG.controlRadius)
    .text_size(DIALOG.buttonSize)
    .when(primary, (el) =>
      el.bg(t.solid).text_color(onClick === undefined ? t.dim : t.solid_foreground),
    )
    .when(!primary, (el) =>
      el.bg(t.raised ?? t.selected).text_color(onClick === undefined ? t.dim : t.foreground),
    )
    .when(onClick !== undefined, (el) =>
      el
        .cursor_pointer()
        .hover((style) => style.opacity(0.85))
        .on_click((_event, cx) => onClick!(cx)),
    )
    .child(label);

/**
 * A labelled dialog row: a fixed-width dim label, then its control.
 * @param t The theme.
 * @param id The row's element id.
 * @param label The row's label.
 * @param body The control.
 * @returns The row.
 */
const dialogSection = (t: Theme, id: string, label: string, body: Element): Element =>
  h_flex()
    .id(id)
    .gap(DIALOG.rowGap)
    .items_center()
    .child(
      div()
        .w(DIALOG.labelWidth)
        .flex_none()
        .text_size(DIALOG.labelSize)
        .text_color(t.dim)
        .child(label),
    )
    .child(body);

/**
 * A choice pill in the dialog's raised look; the chosen one is outlined in the accent.
 * @param t The theme.
 * @param id The element id.
 * @param label The pill text.
 * @param on Whether it is the current choice.
 * @param onClick The press handler; without one the pill is inert.
 * @param tooltip What it does, when the label does not say.
 * @returns The pill.
 */
const dialogPill = (
  t: Theme,
  id: string,
  label: string,
  on: boolean,
  onClick: ((cx: Context) => void) | undefined,
  tooltip: string | undefined,
): Element =>
  div()
    .id(id)
    .flex_none()
    .px(DIALOG.pillPaddingX)
    .h(DIALOG.controlHeight)
    .flex()
    .items_center()
    .rounded(DIALOG.controlRadius)
    .text_size(DIALOG.controlSize)
    .border_1()
    .border_color(on ? t.accent : (t.raised ?? t.selected))
    .bg(on ? t.selected : (t.raised ?? t.background))
    .text_color(onClick === undefined ? t.dim : t.foreground)
    .when(onClick !== undefined, (el) =>
      el
        .cursor_pointer()
        .hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => onClick!(cx)),
    )
    .when(tooltip !== undefined, (el) => el.tooltip(tooltip!))
    .child(label);

// The text of one row of notes under the controls: an error in the blocked color.
const dialogNote = (t: Theme, id: string, message: string): Element =>
  div().id(id).text_size(DIALOG.controlSize).text_color(t.blocked).child(message);

/**
 * The dialog's whole surface, drawn by the dialog copy of the panel mod. Escape closes it, as
 * Cancel does, and either discards an unsaved draft.
 * @param t The theme.
 * @param model The editor's state and actions.
 * @returns The element.
 */
export const harnessPolicyDialog = (t: Theme, model: HarnessPolicyEditorModel): Element => {
  const id =
    model.scope === "global" ? "harness-policy-global" : `harness-policy-domain-${model.domain}`;
  const title = model.scope === "global" ? "Delegate harness defaults" : "Delegate harness policy";
  const reload = dialogButton(
    t,
    `${id}-reload-button`,
    "Reload policy",
    model.busy ? undefined : (cx) => model.reload(cx),
  );
  const body: Element[] = [];
  const secondary: Element[] = [];
  let footerSave: Element | undefined;
  if (model.state.kind === "loading") {
    body.push(div().id(`${id}-loading`).text_color(t.dim).child("Loading policy…"));
  } else if (model.state.kind === "error") {
    body.push(dialogNote(t, `${id}-error`, model.state.message));
    secondary.push(reload);
  } else {
    const view = model.state.view;
    const domainPolicy = view.domain;
    const original = model.scope === "global" ? view.global.policy : domainPolicy?.effective;
    const selection: HarnessSelection | undefined = model.draft?.selection ?? original;
    if (selection === undefined || (model.scope === "domain" && domainPolicy === null)) {
      body.push(
        dialogNote(t, `${id}-error`, "Coordinate returned policy data for the wrong scope."),
      );
      secondary.push(reload);
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
      body.push(
        dialogSection(t, `${id}-source`, "Source", div().text_color(t.dim).child(source)),
        dialogSection(
          t,
          `${id}-enabled`,
          "Enabled",
          h_flex()
            .flex_wrap()
            .gap(DIALOG.footerGap)
            .items_center()
            .children([
              ...(["pi", "claude"] as const).map((harness) =>
                dialogPill(
                  t,
                  `${id}-enabled-${harness}`,
                  HARNESS_LABELS[harness],
                  selection.enabled.includes(harness),
                  canEdit ? (cx) => model.toggle(harness, cx) : undefined,
                  `Enable or disable ${HARNESS_LABELS[harness]}`,
                ),
              ),
              dialogPill(
                t,
                `${id}-codex-unavailable`,
                "Codex",
                false,
                undefined,
                "Codex is not available in Coordinate",
              ),
              div()
                .text_size(DIALOG.labelSize)
                .text_color(t.dim)
                .child(selection.enabled.length === 0 ? "None enabled" : "Unavailable"),
            ]),
        ),
        dialogSection(
          t,
          `${id}-default`,
          "Default",
          h_flex()
            .flex_wrap()
            .gap(DIALOG.footerGap)
            .items_center()
            .children([
              dialogPill(
                t,
                `${id}-default-none`,
                "No default",
                selection.default === null,
                canEdit ? (cx) => model.setDefault(null, cx) : undefined,
                undefined,
              ),
              ...(["pi", "claude"] as const).map((harness) => {
                const available = selection.enabled.includes(harness);
                return dialogPill(
                  t,
                  `${id}-default-${harness}`,
                  HARNESS_LABELS[harness],
                  selection.default === harness,
                  canEdit && available ? (cx) => model.setDefault(harness, cx) : undefined,
                  available
                    ? `${HARNESS_LABELS[harness]} default`
                    : `Enable ${HARNESS_LABELS[harness]} before choosing it as the default`,
                );
              }),
            ]),
        ),
      );
      if (model.conflict || model.failure !== undefined) {
        body.push(
          dialogNote(
            t,
            `${id}-failure`,
            model.conflict
              ? "Policy changed while this draft was open. Reload to discard it, then reapply your choices."
              : model.failure!,
          ),
        );
        secondary.push(reload);
      }
      if (model.scope === "domain" && inherited && model.draft === undefined)
        secondary.push(
          dialogButton(
            t,
            `${id}-override-button`,
            "Override global",
            model.busy ? undefined : (cx) => model.beginOverride(cx),
          ),
        );
      if (model.scope === "domain" && domainPolicy?.mode === "replace")
        secondary.push(
          dialogButton(
            t,
            `${id}-reset-button`,
            "Reset to global",
            model.busy || model.conflict ? undefined : (cx) => model.reset(cx),
          ),
        );
      if (model.draft !== undefined) {
        const dirty =
          original !== undefined &&
          ((model.scope === "domain" && domainPolicy?.mode === "inherit") ||
            !sameHarnessSelection(model.draft.selection, original));
        footerSave = dialogButton(
          t,
          `${id}-save`,
          model.busy ? "Saving…" : model.scope === "global" ? "Save defaults" : "Save override",
          dirty && canEdit ? (cx) => model.save(cx) : undefined,
          dirty && canEdit,
        );
      }
    }
  }
  return v_flex()
    .id("harness-policy-dialog")
    .track_focus(model.focus)
    .w_full()
    .p(DIALOG.padding)
    .gap(DIALOG.gap)
    .bg(t.popover)
    .text_size(13)
    .text_color(t.foreground)
    .on_key_down((event, cx) => {
      if (event.key === "escape") model.cancel(cx);
    })
    .child(
      h_flex()
        .id(`${id}-header`)
        .items_center()
        .gap(DIALOG.footerGap)
        .child(
          div()
            .flex_1()
            .text_size(DIALOG.titleSize)
            .font_semibold()
            .text_color(t.foreground)
            .child(title),
        )
        .when(model.domain !== undefined, (el) =>
          el.child(
            div()
              .id(`${id}-scope`)
              .max_w(160)
              .truncate()
              .text_size(DIALOG.controlSize)
              .text_color(t.dim)
              .child(model.domain!),
          ),
        ),
    )
    .children(body)
    .child(
      h_flex()
        .id(`${id}-footer`)
        .gap(DIALOG.footerGap)
        .items_center()
        .children(secondary)
        .child(div().flex_1())
        .child(
          dialogButton(
            t,
            `${id}-cancel`,
            "Cancel",
            model.busy ? undefined : (cx) => model.cancel(cx),
          ),
        )
        .when(footerSave !== undefined, (el) => el.child(footerSave!)),
    );
};
