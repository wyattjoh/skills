import type { FleetMemory } from "./fleet.ts";
import type { FleetAgent } from "./herdr.ts";

const HERDR_DISPATCH = /\bherdr\s+(agent\s+(prompt|start)|pane\s+run)\b/;
const HERDR_TARGET = /\bherdr\s+(?:agent\s+prompt|pane\s+run)\s+["']?([A-Za-z0-9_.:-]+)/g;

/**
 * The label a shell dispatch gets when its target pane cannot be named.
 */
export const BASH_DISPATCH = "herdr via Bash";

/**
 * Whether a shell command hands work to another herdr pane.
 *
 * @param command the shell command
 * @returns true for `herdr agent prompt|start` and `herdr pane run`
 */
export const isHerdrDispatch = (command: string): boolean => HERDR_DISPATCH.test(command);

/**
 * The literal targets of the `herdr agent prompt` and `herdr pane run` calls
 * in a shell command: pane ids or agent names, as written.
 *
 * @param command the shell command
 * @returns the targets, in order
 */
export const dispatchTargets = (command: string): string[] =>
  [...command.matchAll(HERDR_TARGET)].flatMap((match) => (match[1] ? [match[1]] : []));

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
    "Call fleet_watch with the dispatched panes so the session resumes when they settle (a pane that already finished fires on the next check), or fleet_wait to block on them now.",
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
 * Records a shell dispatch: each target that names a listed agent pane by id
 * or agent name is recorded as that pane, with its seq before the work began
 * as the baseline a later `fleet_watch` starts from. Anything else, including
 * `herdr agent start`, is recorded under BASH_DISPATCH.
 *
 * @param memory the session's memory
 * @param command the shell command, already known to dispatch
 * @param agents the fleet as listed before the command ran
 * @returns the updated memory
 */
export const recordBashDispatch = (
  memory: FleetMemory,
  command: string,
  agents: readonly FleetAgent[],
): FleetMemory => {
  const targets = dispatchTargets(command);
  const resolved = targets.flatMap((target) => {
    const agent = agents.find((one) => one.pane === target || one.name === target);
    return agent === undefined ? [] : [agent];
  });
  const isNamedOnly =
    resolved.length > 0 &&
    resolved.length === targets.length &&
    !/\bherdr\s+agent\s+start\b/.test(command);

  const recorded = resolved.reduce(
    (current, agent) => ({
      ...recordDispatch(current, agent.pane),
      baselines: { ...current.baselines, [agent.pane]: agent.seq },
    }),
    memory,
  );
  return isNamedOnly ? recorded : recordDispatch(recorded, BASH_DISPATCH);
};

/**
 * Clears the stop gate's record when a new prompt or run starts. Watches and
 * dispatch baselines carry over: they describe panes, not the prompt.
 *
 * @param memory the session's memory
 * @returns the updated memory
 */
export const resetPrompt = (memory: FleetMemory): FleetMemory => ({
  ...memory,
  dispatched: [],
  nudged: false,
});
