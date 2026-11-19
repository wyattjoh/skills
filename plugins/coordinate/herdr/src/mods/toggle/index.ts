// coordinate-toggle: the tab row's Backlog pill, and the target of the cmd-alt-b key command.
// It opens and closes the docked coordinate-panel for the focused tab, and on every render (Herdr
// renders it on each focus, layout and shared change) matches the column to the focused tab.
import { View } from "gpui-kit";
import type { AsyncContext, Context, Element } from "gpui-kit";
import { h_flex } from "gpui-base";
import { togglePill, type Theme } from "@wyattjoh/herdr-ui";
import {
  checking,
  focused,
  layout,
  nextCommand,
  props,
  run,
  setShared,
  shared,
  theme,
} from "herdr";
import { ICON } from "./look.ts";
import {
  DOCK_SETTING,
  FIRST_SYNC,
  TOGGLE_COMMAND,
  dockSync,
  panelDock,
  scopeOf,
  toggleEffects,
} from "./model.ts";
import type { SyncMemory, ToggleAction } from "./model.ts";
import { fitInset, fitRequest, fitTarget, fitWidth } from "./sizing.ts";
import type { FitHistory } from "./sizing.ts";

const apply = (effects: ToggleAction[]) => {
  for (const effect of effects)
    if (effect.kind === "run") run(effect.command, effect.args);
    else setShared(effect.key, effect.value);
};

/**
 * The Backlog pill.
 */
export default class Toggle extends View {
  memory: SyncMemory = FIRST_SYNC;
  closed = false;
  private wanted: number | undefined;
  private fitPending = false;
  private fitHistory: FitHistory = { fitted: undefined, requests: [], stopped: false };

  init(_props: unknown, cx: AsyncContext) {
    if (checking()) return;
    // Key commands reach only mounted mods, which is why cmd-alt-b goes to this always-shown pill.
    cx.spawn(async () => {
      try {
        while (!this.closed) {
          const command = await nextCommand();
          if (this.closed) return;
          if (command === TOGGLE_COMMAND) this.toggle();
        }
      } catch {
        // Closing this copy cancels its pending nextCommand; the loop ends with it.
      }
    });
  }

  close() {
    this.closed = true;
  }

  // Match the column to the focused tab from a task, outside render. The task reads the layout,
  // focus and shared value when it runs, so a switch away and back before it runs decides on
  // where focus is then. A second task on the same tab finds nothing to do.
  schedule(cx: Context) {
    if (this.closed || checking()) return;
    cx.spawn(async () => {
      if (!this.closed) this.sync();
    });
  }

  sync() {
    const synced = dockSync(
      panelDock(layout()),
      shared(DOCK_SETTING),
      scopeOf(focused()),
      this.memory,
      Date.now(),
    );
    this.memory = synced.memory;
    apply(synced.effects);
  }

  toggle() {
    apply(toggleEffects(panelDock(layout()), shared(DOCK_SETTING), scopeOf(focused())));
  }

  private fit(width: number, sizeCx: Context) {
    const targetAtMeasure = fitTarget(layout(), props());
    if (
      checking() ||
      targetAtMeasure === undefined ||
      fitWidth(width, targetAtMeasure.inset) === undefined
    )
      return;
    if (this.fitHistory.stopped) return;
    this.wanted = width;
    if (this.fitPending) return;
    this.fitPending = true;
    sizeCx.timer.after(0, (timerCx) => {
      this.fitPending = false;
      const liveTarget = fitTarget(layout(), props());
      if (liveTarget === undefined || this.wanted === undefined) return;
      const wanted = fitWidth(this.wanted, liveTarget.inset);
      if (wanted === undefined) return;
      const plan = fitRequest(this.fitHistory, liveTarget, wanted, Date.now());
      this.fitHistory = plan.history;
      if (plan.request === undefined) return;
      run("layout.resize", plan.request);
      timerCx.notify();
    });
  }

  render(cx: Context): Element {
    this.schedule(cx);
    const t = theme() as Theme;
    const dock = panelDock(layout());
    const on = dock?.shown === true;
    const inert = dock === undefined;
    const button = togglePill(t, {
      id: "coordinate-toggle-button",
      label: "Backlog",
      icon: ICON,
      lit: on,
      onClick: inert ? undefined : () => this.toggle(),
    });
    return h_flex()
      .id("coordinate-toggle")
      .size_full()
      .justify_end()
      .pr(fitInset(layout(), props()))
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("coordinate-toggle-fit")
          .flex_none()
          .flex_nowrap()
          .on_size_change(({ width }, sizeCx) => this.fit(width, sizeCx))
          .child(inert ? button : button.hover((s) => s.bg(t.hover)).on_click(() => this.toggle())),
      );
  }
}
