// Herdr's overlay and settings calls in a module of their own. The shared test renderer's herdr
// mock has no overlays, so the panel's tests replace this module instead of the host.
import { run } from "herdr";

export { closeOverlay, openOverlay } from "herdr";

/**
 * Open Herdr's own settings window.
 */
export const openHerdrSettingsPage = (): void => {
  void run("app.settings");
};
