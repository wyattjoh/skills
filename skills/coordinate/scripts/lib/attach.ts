import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { readDocument, recordDelegate, releaseDelegate } from "./backlog-doc.ts";
import { filedUnder, unfileable } from "./backlog-store/ops.ts";
import type { DelegateRef } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { coordinatorDomain, findTerminal, L, Refused, sessionOf } from "./fleet.ts";
import { currentBranch, gitTry } from "./git.ts";
import { harnessOf } from "./harness.ts";
import { localMachine, machineOfAddress } from "./delegate-capacity.ts";
import * as hc from "./herdr.ts";

const json = (value: unknown): string[] => [JSON.stringify(value, null, 2)];

/**
 * Where a terminal works: its `fleet.worktree` and `fleet.branch` labels when set (what
 * `delegate --item` recorded), else the Git checkout holding its folder and that checkout's branch.
 * Outside Git both are null. A terminal on another machine (`machine/tN`) has its folder there, so
 * only its labels count: Git here would read a different checkout, or none.
 */
const placeOf = Effect.fn("placeOf")(function* (terminal: hc.Terminal) {
  const labelled = terminal.labels[L.worktree];
  const dir = labelled ?? terminal.cwd;
  const remote = terminal.address.includes("/");
  const top =
    dir === "" || remote ? undefined : yield* gitTry(dir, ["rev-parse", "--show-toplevel"]);
  const worktree = labelled ?? top ?? null;
  const branch =
    terminal.labels[L.branch] ?? (top === undefined ? undefined : yield* currentBranch(top));
  return { worktree, branch: branch ?? null };
});

/**
 * Options for `coordinate item attach`.
 */
export type AttachOptions = {
  id: string;
  /**
   * Delegate name or Herdr terminal address.
   */
  target: string;
  domain: string | undefined;
  json: boolean;
  /**
   * Session id for a terminal Herdr sees none for (`--session`, attach only).
   */
  session: string | undefined;
};

/**
 * File an already-running agent session under an item, as `delegate --item` would have, and give
 * a hand-started terminal the labels `coordinate delegate` sets so status, watch, end and resume
 * track it. Every refusal runs before anything is written; existing labels are never overwritten.
 * @param config Config.
 * @param options Item, target, `--domain`, `--json`.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Lines to print.
 */
export const attachDelegate = Effect.fn("attachDelegate")(function* (
  config: Config,
  options: AttachOptions,
  env: Record<string, string | undefined> = process.env,
) {
  const domain = yield* coordinatorDomain(options.domain, env);
  const { backlog } = yield* readDocument(config, domain);
  const problem = unfileable(backlog, options.id);
  if (problem) return yield* new Refused({ message: problem });
  const terminal = yield* findTerminal(options.target);
  if (!terminal || !terminal.live)
    return yield* new Refused({ message: `no live terminal ${options.target}` });
  if (terminal.labels[L.role] === "coordinator")
    return yield* new Refused({ message: `${options.target} is a coordinator, not a delegate` });
  const labelledDomain = terminal.labels[L.domain];
  if (labelledDomain !== undefined && labelledDomain !== domain)
    return yield* new Refused({
      message: `${options.target} is labelled for ${labelledDomain}, not ${domain}; its coordinator files it`,
    });
  const given = options.session?.trim();
  if (given !== undefined && (given === "" || given.startsWith("-") || /\s/.test(given)))
    return yield* new Refused({ message: `--session ${options.session} is not a session id` });
  const seen = sessionOf(terminal);
  const visible = seen === "" || seen.startsWith("-") ? undefined : seen;
  if (visible !== undefined && given !== undefined && given !== visible)
    return yield* new Refused({
      message: `${options.target} runs session ${visible}, not ${given}`,
    });
  const session = visible ?? given;
  if (session === undefined)
    return yield* new Refused({
      message: `${options.target} has no agent session id Herdr can see (no ${L.session} label, no --session-id or --resume argument); pass it with --session <id> (in Claude Code, /status shows the session id)`,
    });
  const harness = harnessOf(terminal.labels[L.harness] ?? terminal.app);
  if (harness === undefined)
    return yield* new Refused({
      message: `${options.target} runs ${terminal.app ?? "no known agent"}, not pi or Claude Code`,
    });
  const name = terminal.name ?? terminal.address;
  const holder = filedUnder(backlog, session);
  if (holder)
    return yield* new Refused({
      message:
        holder.id === options.id
          ? `${name} is already filed under ${holder.id}`
          : `${name} is already filed under ${holder.id}; detach it first: coordinate item detach ${holder.id} ${name}`,
    });

  const place = yield* placeOf(terminal);
  // A `delegate --cwd` start keeps its brief in a per-delegate subfolder; prefer it when present.
  const own = place.worktree ? join(place.worktree, ".scratch", name) : undefined;
  const scratch =
    own && existsSync(join(own, "BRIEF.md"))
      ? own
      : place.worktree
        ? join(place.worktree, ".scratch")
        : undefined;
  const ref: DelegateRef = {
    name,
    session,
    branch: place.branch,
    worktree: place.worktree,
    brief: scratch ? join(scratch, "BRIEF.md") : "",
    report: scratch ? join(scratch, "REPORT.md") : "",
  };
  // Read before filing, so a Herdr failure here files nothing.
  const machine = machineOfAddress(terminal.address, yield* localMachine());
  const item = yield* recordDelegate(config, domain, { id: options.id, ref });
  const wanted: Record<string, string> = {
    [L.domain]: domain,
    [L.task]: name,
    [L.session]: session,
    [L.harness]: harness,
    // The folder the session runs in, as `delegate` labels it, so `end` and `resume` start there.
    [L.worktree]: terminal.cwd,
    ...(place.branch ? { [L.branch]: place.branch } : {}),
    [L.machine]: machine,
  };
  const missing = Object.fromEntries(
    Object.entries(wanted).filter(([key, value]) => value !== "" && !(key in terminal.labels)),
  );
  const pairs = Object.entries(missing).map(([key, value]) => `${key}=${value}`);
  yield* hc.label(terminal.address, missing).pipe(
    Effect.mapError(
      (error) =>
        new hc.HerdrError({
          command: error.command,
          kind: error.kind,
          message: `filed ${name} under ${item.id} but could not label ${terminal.address} with ${pairs.join(" ")}: ${error.message}`,
        }),
    ),
  );
  if (options.json) return json(item);
  return [
    `filed ${name} (${terminal.address}, session ${session}) under ${item.id} [${item.status}]`,
    ...(pairs.length > 0 ? [`labelled ${terminal.address}: ${pairs.join(" ")}`] : []),
  ];
});

/**
 * Undo a filing: remove the delegate from the item, matched by name or session id in the backlog
 * first, so an ended delegate detaches too; only an unmatched target is looked up as a live
 * terminal. Labels stay, so a live terminal shows as an unfiled delegate again.
 * @param config Config.
 * @param options Item, target, `--domain`, `--json`.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Lines to print.
 */
export const detachDelegate = Effect.fn("detachDelegate")(function* (
  config: Config,
  options: AttachOptions,
  env: Record<string, string | undefined> = process.env,
) {
  const domain = yield* coordinatorDomain(options.domain, env);
  const { backlog } = yield* readDocument(config, domain);
  const found = backlog.items.find((entry) => entry.id === options.id);
  const named = found?.delegates.some(
    (ref) => ref.name === options.target || ref.session === options.target,
  );
  let key = options.target;
  if (found && !named) {
    const terminal = yield* findTerminal(options.target);
    const session = terminal ? sessionOf(terminal) : "";
    if (session !== "") key = session;
  }
  const { item, ref } = yield* releaseDelegate(config, domain, { id: options.id, key });
  if (options.json) return json(item);
  return [`detached ${ref.name} (session ${ref.session}) from ${item.id} [${item.status}]`];
});
