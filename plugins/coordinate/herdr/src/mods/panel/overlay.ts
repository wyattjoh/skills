// Herdr's overlay calls in a module of their own. The shared test renderer's herdr mock has no
// overlays, so the panel's tests replace this module instead of the host.
export { closeOverlay, openOverlay } from "herdr";
