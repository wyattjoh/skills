// coordinate-toggle: the tab row's Backlog pill, and the target of the cmd-alt-b key command.
// It opens and closes the docked coordinate-panel for the focused tab.
import { View, svg } from "gpui-kit";
import type { AsyncContext, Element } from "gpui-kit";
import { h_flex } from "gpui-base";
import { checking, focused, layout, nextCommand, run, setShared, shared, theme } from "herdr";
import { CONTROL } from "../../lib/look.ts";
import { ICON, TOGGLE_END_INSET } from "./look.ts";
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
import type { Theme } from "../panel/view.ts";

// How often the toggle matches the docked panel to the focused tab.
const SYNC_MS = 1_000;

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

  init(_props: unknown, cx: AsyncContext) {
    if (checking()) return;
    cx.timer.every(SYNC_MS, () => this.sync());
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

  render(): Element {
    const t = theme() as Theme;
    const dock = panelDock(layout());
    const on = dock?.shown === true;
    const inert = dock === undefined;
    const button = h_flex()
      .id("coordinate-toggle-button")
      .h(CONTROL.height)
      .px(CONTROL.paddingX)
      .gap(CONTROL.gap)
      .flex_none()
      .flex_nowrap()
      .items_center()
      .justify_center()
      .rounded(CONTROL.radius)
      .text_size(CONTROL.textSize)
      .bg(on ? t.selected : t.chrome)
      .text_color(inert ? t.dim : on ? t.foreground : t.muted)
      .child(svg(ICON).size(CONTROL.iconSize))
      .child("Backlog");
    return h_flex()
      .id("coordinate-toggle")
      .size_full()
      .justify_end()
      .pr(TOGGLE_END_INSET)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(inert ? button : button.hover((s) => s.bg(t.hover)).on_click(() => this.toggle()));
  }
}
