import type { FleetMemory } from "./fleet.ts";

const HERDR_DISPATCH = /\bherdr\s+(agent\s+(prompt|start)|pane\s+run)\b/;

/**
 * Whether a shell command hands work to another herdr pane.
 *
 * @param command the shell command
 * @returns true for `herdr agent prompt|start` and `herdr pane run`
 */
export const isHerdrDispatch = (command: string): boolean => HERDR_DISPATCH.test(command);

/**
 * What the stop gate knows when a turn is about to end.
 */
export type StopContext = {
  memory: FleetMemory;
  pendingBackground: number;
};

/**
 * Decides whether to keep the model going because it dispatched work and left
 * no way to be woken when that work finishes. Fires at most once per prompt.
 *
 * @param context the session's memory and the harness's pending background work
 * @returns the reason the model reads, or undefined to let the turn end
 */
export const stopReason = (context: StopContext): string | undefined => {
  const { memory, pendingBackground } = context;
  if (memory.nudged || memory.dispatched.length === 0) return undefined;
  if (Object.keys(memory.watched).length > 0 || pendingBackground > 0) return undefined;

  return [
    `[to-code fleet] This turn dispatched work (${memory.dispatched.join(", ")}) but nothing will wake this session when it finishes.`,
    "Call fleet_watch with the dispatched panes so the session resumes when they settle, or fleet_wait to block on them now.",
    "If no follow-up is needed, say so and end the turn.",
  ].join(" ");
};

/**
 * Records one dispatch for the stop gate.
 *
 * @param memory the session's memory
 * @param label what was dispatched, for the reason text
 * @returns the updated memory
 */
export const recordDispatch = (memory: FleetMemory, label: string): FleetMemory => ({
  ...memory,
  dispatched: memory.dispatched.includes(label) ? memory.dispatched : [...memory.dispatched, label],
});

/**
 * Clears the stop gate's record when a new prompt starts.
 *
 * @param memory the session's memory
 * @returns the updated memory
 */
export const resetPrompt = (memory: FleetMemory): FleetMemory => ({
  ...memory,
  dispatched: [],
  nudged: false,
});
