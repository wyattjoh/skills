#!/usr/bin/env bun
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Stdio, Terminal } from "effect";
import { Argument, CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import {
  boundaryAdd,
  boundaryReplace,
  boundaryRm,
  checkoutAdd,
  checkoutRm,
  findingAdd,
  findingClose,
  findingEdit,
  findingPromote,
  focusSet,
  itemAdd,
  itemClose,
  itemEdit,
  itemStart,
  itemUpdate,
  policyAdd,
  policyLs,
  policyReplace,
  policyRm,
  readDocument,
  showBacklog,
} from "./lib/backlog-doc.ts";
import {
  FINDING_DETAIL_SHAPE,
  ITEM_STATUSES,
  type ItemStatus,
} from "./lib/backlog-store/schema.ts";
import { absolutePath, loadConfig, MissingFolder, type Config } from "./lib/config.ts";
import { useStateBackend } from "./lib/state.ts";
import { StoreConflict } from "./lib/state-store.ts";
import {
  DELEGATE_HARNESSES,
  resetHarnessPolicy,
  setHarnessPolicy,
  showHarnessPolicy,
  type DelegateHarness,
  type HarnessSelection,
} from "./lib/harness-policy.ts";
import {
  answerDomain,
  coordinatorDomain,
  statusDomain,
  domainOfCaller,
  Refused,
  resolveDomain,
} from "./lib/fleet.ts";
import type { DelegateFirstMessage, Harness } from "./lib/harness.ts";
import { attachDelegate, detachDelegate } from "./lib/attach.ts";
import { watcherBanner } from "./lib/banner.ts";
import {
  delegate,
  endDelegate,
  listIdle,
  NEXT_STATUSES,
  notifyCoordinator,
  resumeDelegate,
  sendTo,
  spawn,
  spawnOutput,
  start,
} from "./lib/lifecycle.ts";
import { Proc } from "./lib/proc.ts";
import { domainRepos, domainStatus, domainStatusJson } from "./lib/status.ts";
import { fetchRemoteBranch } from "./lib/remote-fetch.ts";
import { verifyDelegate } from "./lib/sessions.ts";
import { renameDomain } from "./lib/rename.ts";
import { showOutbox, watch } from "./lib/watch.ts";
import { showCapacityQueue } from "./lib/capacity-queue.ts";
import {
  armWatcher,
  createWatchViewWriter,
  stopWatcher,
  watcherInfoLine,
} from "./lib/watch-terminal.ts";
import type { WatchView } from "./lib/watch-terminal.ts";
import { defaultStop } from "./lib/processes.ts";
import {
  context,
  pruneBranches,
  pruneEnded,
  remoteCheckouts,
  remoteTarget,
  removeMany,
  renderRows,
  report,
  type Row,
  stopDeletedFolders,
} from "./lib/sweep.ts";
import { mainCheckout } from "./lib/git.ts";
import { pathWrapper } from "./lib/path-wrapper.ts";
import {
  citedPage,
  commitWiki,
  LINT_INTERVAL_DAYS,
  lintLines,
  lintWiki,
  markLint,
  wikiList,
  wikiPath,
  wikiShow,
} from "./lib/wiki.ts";

/**
 * The failure to report from a cause: its typed error, else a `MissingFolder` thrown while
 * resolving a relative path (a defect, since path resolution is synchronous).
 * @param cause Cause of a failed exit.
 * @returns The error, or `undefined` to print the whole cause.
 */
const reportedFailure = (cause: Cause.Cause<unknown>): unknown => {
  const failed = cause.reasons.find(Cause.isFailReason);
  if (failed) return failed.error;
  return cause.reasons.find(
    (reason): reason is Cause.Die =>
      Cause.isDieReason(reason) && reason.defect instanceof MissingFolder,
  )?.defect;
};

/**
 * Run one command at the CLI boundary: print its lines, exit 0; a `Refused` exits 1; anything else exits 2.
 * From a coordinator's terminal it first prints the watcher-down banner to stderr, whatever the
 * outcome, unless `banner` is false (`watch`, `item answer`, and `status`, which prints it itself).
 * @param build The command, given the config.
 * @param banner Check for the watcher-down banner.
 */
const main = async <E extends { message: string }>(
  build: (config: Config) => Effect.Effect<readonly string[], E, Proc>,
  banner = true,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    loadConfig().pipe(
      Effect.tap((config) => Effect.sync(() => useStateBackend(config))),
      Effect.flatMap((config) =>
        build(config).pipe(
          Effect.ensuring(
            banner
              ? Effect.map(watcherBanner(config), (line) => {
                  if (line) console.error(line);
                })
              : Effect.void,
          ),
        ),
      ),
      Effect.provide(Proc.layer),
    ),
  );
  if (Exit.isSuccess(exit)) {
    if (exit.value.length > 0) console.log(exit.value.join("\n"));
    return;
  }
  const failure = reportedFailure(exit.cause) as { message: string } | undefined;
  if (failure instanceof Refused) {
    console.error(`refused: ${failure.message}`);
    process.exit(1);
  }
  // A write that lost a race outside the three-attempt retry (rename, policy-with-domains) is a
  // refusal to run again, like one inside it.
  if (failure instanceof StoreConflict) {
    console.error(
      `refused: ${failure.location} changed while the command ran; run the command again`,
    );
    process.exit(1);
  }
  console.error(
    `could not check: ${failure ? `${failure.constructor.name}: ${failure.message}` : Cause.pretty(exit.cause)}`,
  );
  process.exit(2);
};

const execute = <E extends { message: string }>(
  build: (config: Config) => Effect.Effect<readonly string[], E, Proc>,
  banner = true,
) => Effect.promise(() => main(build, banner));

const writeWatchLine = (line: string): Promise<void> =>
  new Promise((complete, reject) => {
    process.stdout.write(`${line}\n`, (error?: Error | null) => {
      if (error) reject(error);
      else complete();
    });
  });

const createWatchTerminalRenderer = (): ((view: WatchView) => void) => {
  process.stdout.on("error", () => undefined);
  const renderer = createWatchViewWriter(
    (output) => process.stdout.write(output, () => undefined),
    {
      ansi: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
      columns: process.stdout.columns ?? 100,
      rows: process.stdout.rows ?? 24,
    },
  );
  return (view) => {
    try {
      renderer(view);
    } catch {
      // Rendering is best-effort and never participates in event delivery.
    }
  };
};

const argument = (name: string, description: string) =>
  Argument.String(name).pipe(Argument.withDescription(description));

const optionalArgument = (name: string, description: string) =>
  argument(name, description).pipe(Argument.optional);

const stringFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description));

const optionalStringFlag = (name: string, description: string) =>
  stringFlag(name, description).pipe(Flag.optional);

const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.withDefault(false));

const optionalBooleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDescription(description), Flag.optional);

const choiceFlag = <const Values extends ReadonlyArray<string>>(
  name: string,
  values: Values,
  description: string,
) => Flag.Literals(name, values).pipe(Flag.withDescription(description));

const optionalChoiceFlag = <const Values extends ReadonlyArray<string>>(
  name: string,
  values: Values,
  description: string,
) => choiceFlag(name, values, description).pipe(Flag.optional);

const parsePolicyRevision = (value: string): Effect.Effect<number, Refused> => {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    return Effect.fail(
      new Refused({ message: "--expected-revision must be a non-negative safe integer" }),
    );
  return Effect.succeed(Number(value));
};

const parseHarnessSelection = (
  enabledInput: string,
  defaultInput: string | undefined,
  noDefault: boolean,
): Effect.Effect<HarnessSelection, Refused> => {
  if ((defaultInput !== undefined) === noDefault)
    return Effect.fail(new Refused({ message: "pass exactly one of --default or --no-default" }));
  const values =
    enabledInput === "none" ? [] : enabledInput.split(",").map((value) => value.trim());
  if (values.some((value) => value === ""))
    return Effect.fail(
      new Refused({ message: "--enabled must be none, pi, claude, or a comma-separated list" }),
    );
  if (new Set(values).size !== values.length)
    return Effect.fail(new Refused({ message: "--enabled must not repeat a harness" }));
  const unsupported = values.find(
    (value) => !DELEGATE_HARNESSES.includes(value as DelegateHarness),
  );
  if (unsupported !== undefined)
    return Effect.fail(
      new Refused({
        message: `unsupported harness ${unsupported}; supported harnesses: ${DELEGATE_HARNESSES.join(", ")}`,
      }),
    );
  const enabled = DELEGATE_HARNESSES.filter((harness) => values.includes(harness));
  const defaultHarness = noDefault ? null : (defaultInput as DelegateHarness);
  if (defaultHarness !== null && !enabled.includes(defaultHarness))
    return Effect.fail(new Refused({ message: "--default must also be listed in --enabled" }));
  return Effect.succeed({ enabled, default: defaultHarness });
};

const repeatedStringFlag = (name: string, description: string) =>
  Flag.atMost(stringFlag(name, description), Number.MAX_SAFE_INTEGER);

const valueOptions = new Set([
  "--task",
  "--repo",
  "--cwd",
  "--base",
  "--harness",
  "--model",
  "--effort",
  "--brief",
  "--skill",
  "--args",
  "--domain",
  "--item",
  "--item-status",
  "--at",
  "--status",
  "--outcome",
  "--decided",
  "--touch",
  "--untouch",
  "--due",
  "--ask",
  "--context",
  "--option",
  "--enabled",
  "--default",
  "--expected-revision",
  "--rec",
  "--why",
  "--answer",
  "--outcome-md",
  "--decided-md",
  "--ask-md",
  "--context-md",
  "--option-md",
  "--why-md",
  "--answer-md",
  "--note-md",
  "--detail-md",
  "--md",
  "--session",
  "--kind",
  "--detail",
  "--path",
  "--from",
  "--interval",
  "--owner",
  "--forge-interval",
  "--max-minutes",
  "--keep",
  "--message",
  "-m",
]);

const switchOptions = new Set([
  "--adjacent",
  "--all-safe",
  "--clear",
  "--dismissed",
  "--done",
  "--arm",
  "--deliver",
  "--follow",
  "--json",
  "--list",
  "--list-idle",
  "--no-due",
  "--no-default",
  "--no-space",
  "--now",
  "--over-budget",
  "--queue-if-full",
  "--retry-queued",
  "--replace",
  "--resume",
  "--shared",
  "--sizes",
  "--space",
  "--stop",
]);
const knownOptions = new Set([...valueOptions, ...switchOptions, "--help", "-h"]);
const isKnownOption = (token: string) =>
  knownOptions.has(token.includes("=") ? token.slice(0, token.indexOf("=")) : token);

/**
 * Keep option values beginning with a dash as values, as Commander accepts them.
 * Effect CLI accepts those values in `--flag=value` form.
 */
const normalizeLeadingDashValues = (args: readonly string[]): string[] => {
  const normalized: string[] = [];
  let passthrough = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (passthrough) {
      normalized.push(current);
      continue;
    }
    if (current === "--") {
      passthrough = true;
      normalized.push(current);
      continue;
    }
    const next = args[index + 1];
    if (
      valueOptions.has(current) &&
      next !== undefined &&
      next.startsWith("-") &&
      next !== "--" &&
      !isKnownOption(next)
    ) {
      normalized.push(`${current}=${next}`);
      index += 1;
      continue;
    }
    normalized.push(current);
  }
  return normalized;
};

/**
 * Commander treats `--due` and `--no-due` as last-wins alternatives and accepts a repeated
 * `--due`. Collapse those occurrences to the final one before Effect CLI validates its flags.
 */
const normalizeDueOverrides = (args: readonly string[]): string[] => {
  if (args[0] !== "item" || args[1] !== "update") return [...args];
  const delimiter = args.indexOf("--");
  const end = delimiter === -1 ? args.length : delimiter;
  const events: Array<{ start: number; end: number; value: string[] }> = [];
  for (let index = 0; index < end; index += 1) {
    const current = args[index] ?? "";
    if (current === "--no-due") {
      events.push({ start: index, end: index + 1, value: [current] });
      continue;
    }
    if (current.startsWith("--due=")) {
      events.push({ start: index, end: index + 1, value: [current] });
      continue;
    }
    if (current === "--due") {
      const next = args[index + 1];
      if (next !== undefined && next !== "--" && next !== "--no-due") {
        events.push({ start: index, end: index + 2, value: [current, next] });
        index += 1;
      }
    }
  }
  if (events.length < 2) return [...args];
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return [...args];
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const event = events.find((candidate) => candidate.start === index);
    if (event) {
      if (index === first.start) normalized.push(...last.value);
      index = event.end - 1;
      continue;
    }
    normalized.push(args[index] ?? "");
  }
  return normalized;
};

/**
 * Commander lets the last of `--space` and `--no-space` win on `resume`; Effect CLI rejects
 * duplicate occurrences, so retain only the final switch for that command.
 */
const normalizeResumeSpace = (args: readonly string[]): string[] => {
  if (args[0] !== "resume") return [...args];
  const delimiter = args.indexOf("--");
  const end = delimiter === -1 ? args.length : delimiter;
  let lastIndex = -1;
  for (let index = 0; index < end; index += 1) {
    if (args[index] === "--space" || args[index] === "--no-space") lastIndex = index;
  }
  if (lastIndex === -1) return [...args];
  return args.filter(
    (arg, index) =>
      index >= end || (arg !== "--space" && arg !== "--no-space") || index === lastIndex,
  );
};

/**
 * Preserve the former add invocation as an alias without advertising it in generated help.
 * @param args Original command-line arguments.
 * @returns Arguments using the current policy command.
 */
const normalizeStandingAlias = (args: readonly string[]): string[] =>
  args[0] === "backlog" && args[1] === "standing" && args[2] === "add"
    ? ["backlog", "policy", "add", ...args.slice(3)]
    : [...args];

const normalizeArgs = (args: readonly string[]) =>
  normalizeLeadingDashValues(
    normalizeDueOverrides(normalizeResumeSpace(normalizeStandingAlias(args))),
  );

/** The skill folder this CLI runs from (Bun reports its real path, not the link). */
const SKILL_DIR = join(import.meta.dir, "..");

const startCommand = Command.make(
  "start",
  { domain: argument("domain", "domain name, also the backlog's file name") },
  ({ domain }) =>
    execute((config) =>
      Effect.gen(function* () {
        const lines = [...(yield* start(config, domain))];
        lines.push("", ...(yield* domainStatus(config, domain, false, Date.now())));
        lines.push(
          "",
          "sweep:",
          ...renderRows(
            yield* Effect.gen(function* () {
              const repos = yield* domainRepos(config, domain);
              return yield* report(
                config,
                repos,
                { bases: [], keep: [], sizes: false, nowMs: Date.now() },
                yield* domainRemotes(config, domain, repos),
              );
            }),
          ),
        );
        lines.push("", ...(yield* listIdle(config, domain, Date.now())));
        lines.push(...(yield* pathWrapper(SKILL_DIR)));
        return lines;
      }),
    ),
).pipe(
  Command.withDescription(
    "label this terminal as the domain's coordinator, create the backlog document if missing, then print status",
  ),
);

const delegateCommand = Command.make(
  "delegate",
  {
    name: argument("name", "terminal and session name (a-z 0-9 - _), also the worktree folder"),
    task: stringFlag("task", "a few words; the tab label"),
    repo: optionalStringFlag(
      "repo",
      "repository: creates <repo>/.claude/worktrees/<name> on <branch_prefix><name>",
    ),
    cwd: optionalStringFlag("cwd", "folder for work with no repo (no worktree is made)"),
    base: optionalStringFlag(
      "base",
      "base for the new branch (default: the main checkout's branch)",
    ),
    harness: optionalChoiceFlag(
      "harness",
      ["pi", "claude"],
      "agent harness (omitted only when policy has an enabled default)",
    ),
    model: optionalStringFlag("model", "model (pi: provider/id; claude: opus, sonnet, ... )"),
    effort: optionalStringFlag("effort", "claude --effort, or pi --thinking"),
    brief: optionalStringFlag(
      "brief",
      "brief to copy to <worktree>/.scratch/BRIEF.md, or <cwd>/.scratch/<name>/BRIEF.md (with --skill: its boundary, stop points and report)",
    ),
    skill: optionalStringFlag(
      "skill",
      "start with any skill installed for the harness (implement, implement-spec, retro, pr-review, ...); the harness itself reports a missing one; --brief may accompany it",
    ),
    args: stringFlag("args", "arguments after the skill prefix").pipe(Flag.withDefault("")),
    noSpace: booleanFlag(
      "no-space",
      "open a tab in the coordinator's space instead of a new space",
    ).pipe(Flag.withoutNegation),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    overBudget: booleanFlag(
      "over-budget",
      "start even when this machine's per-machine delegate budget is reached",
    ),
    queueIfFull: booleanFlag(
      "queue-if-full",
      "retain only item, machine and enqueue order when the budget is full",
    ),
    retryQueued: booleanFlag(
      "retry-queued",
      "recheck an existing queued item; requires its original authorized --harness choice",
    ),
    item: optionalStringFlag(
      "item",
      "item to file the delegate under (required from a coordinator, refused from a delegate)",
    ),
    machine: optionalStringFlag(
      "machine",
      "Herdr machine to start it on: makes the worktree in the repo's recorded checkout there (with --repo)",
    ),
  },
  (options) => {
    const brief = Option.getOrUndefined(options.brief);
    const skill = Option.getOrUndefined(options.skill);
    if (brief === undefined && skill === undefined) {
      console.error(
        "refused: pass --brief <path>, --skill <name> (an installed skill such as implement, implement-spec or retro), or both",
      );
      process.exit(1);
    }
    if (skill !== undefined && (skill === "" || /\s/.test(skill) || skill.startsWith("/"))) {
      console.error(
        `refused: --skill takes a bare skill name such as implement or pr-review, not "${skill}" (no spaces, no leading /; the script adds the prefix)`,
      );
      process.exit(1);
    }
    if (skill === "coordinate") {
      console.error(
        "refused: --skill coordinate starts a coordinator, which only coordinate spawn does",
      );
      process.exit(1);
    }
    const message: DelegateFirstMessage =
      skill === undefined
        ? { kind: "brief", path: brief ?? "" }
        : { kind: "skill", skill, args: options.args, brief };
    return execute((config) =>
      delegate(config, {
        name: options.name,
        task: options.task,
        repo: Option.getOrUndefined(options.repo),
        cwd: Option.getOrUndefined(options.cwd),
        base: Option.getOrUndefined(options.base),
        harness: Option.getOrUndefined(options.harness) as Harness | undefined,
        model: Option.getOrUndefined(options.model),
        effort: Option.getOrUndefined(options.effort),
        message,
        space: !options.noSpace,
        domain: Option.getOrUndefined(options.domain),
        item: Option.getOrUndefined(options.item),
        overBudget: options.overBudget,
        queueIfFull: options.queueIfFull,
        retryQueued: options.retryQueued,
        machine: Option.getOrUndefined(options.machine),
      }),
    );
  },
).pipe(
  Command.withDescription(
    "create the worktree and start an authorized pi or Claude Code delegate in its own Herdr space, recording it on the item",
  ),
);

const spawnCommand = Command.make(
  "spawn",
  {
    domain: argument("domain", "domain the new coordinator owns"),
    cwd: optionalStringFlag(
      "cwd",
      "folder the new coordinator starts in, added to its owned Boundary (default: an existing backlog's first owned path)",
    ),
    harness: optionalChoiceFlag(
      "harness",
      ["pi", "claude"],
      "agent harness (omitted only when the domain's policy has an enabled default)",
    ),
    model: optionalStringFlag("model", "model (pi: provider/id; claude: opus, sonnet, ... )"),
    effort: optionalStringFlag("effort", "claude --effort, or pi --thinking"),
    item: repeatedStringFlag(
      "item",
      "title added as an open item to the new coordinator's backlog (repeatable)",
    ),
    json: booleanFlag("json", "print terminal, space, watcher and status as JSON"),
  },
  (options) =>
    execute((config) =>
      spawn(config, {
        domain: options.domain,
        cwd: Option.getOrUndefined(options.cwd),
        harness: Option.getOrUndefined(options.harness) as Harness | undefined,
        model: Option.getOrUndefined(options.model),
        effort: Option.getOrUndefined(options.effort),
        items: options.item,
        now: new Date().toISOString(),
      }).pipe(
        Effect.map((result) => {
          // Not ready within the bound exits 1; the terminal is left running.
          if (result.status !== "ready") process.exitCode = 1;
          return options.json ? [JSON.stringify(result, null, 2)] : spawnOutput(result);
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "from a coordinator: seed the domain's backlog, then start its coordinator in its own unfocused Herdr space, labelled at launch with no parent; refused while the domain has a live coordinator; waits about 120s for its watcher, exit 1 if not ready",
  ),
);

const sendCommand = Command.make(
  "send",
  {
    target: argument("target", "delegate name or address"),
    text: argument("text", "message"),
  },
  ({ target, text }) => execute(() => sendTo(target, text)),
).pipe(
  Command.withDescription(
    "send a delegate a message; refuses a terminal blocked on a dialog, waits for the user's draft",
  ),
);

const notifyCommand = Command.make(
  "notify",
  { text: argument("text", 'one line, such as "<name>: done, report at <path>"') },
  ({ text }) => execute(() => notifyCoordinator(text)),
).pipe(
  Command.withDescription(
    "from a delegate: wake its coordinator with one line, as send does; with no live coordinator, prints and exits 0",
  ),
);

const endCommand = Command.make(
  "end",
  {
    target: optionalArgument("target", "delegate name or address"),
    now: booleanFlag("now", "end it even while working"),
    itemStatus: optionalChoiceFlag(
      "item-status",
      NEXT_STATUSES,
      "when it was the item's last live delegate, set the item's next status",
    ),
    listIdle: booleanFlag(
      "list-idle",
      "list delegates settled for quiet_hours, each with its end command",
    ),
    domain: optionalStringFlag(
      "domain",
      "domain for --list-idle (default: this coordinator's label)",
    ),
  },
  (options) =>
    execute((config) => {
      if (options.listIdle)
        return Effect.flatMap(resolveDomain(Option.getOrUndefined(options.domain)), (domain) =>
          listIdle(config, domain, Date.now()),
        );
      const target = Option.getOrUndefined(options.target);
      if (!target) return Effect.succeed(["give a delegate name, or --list-idle"]);
      return endDelegate(
        config,
        target,
        options.now,
        Option.getOrUndefined(options.itemStatus) as ItemStatus | undefined,
      );
    }),
).pipe(
  Command.withDescription(
    "end a settled delegate, keeping its worktree, branch and session for resume",
  ),
);

const resumeCommand = Command.make(
  "resume",
  {
    name: argument("name", "ended delegate's name"),
    space: optionalBooleanFlag("space", "give it its own space"),
    noSpace: booleanFlag("no-space", "open it as a tab in the coordinator's space").pipe(
      Flag.withoutNegation,
    ),
  },
  ({ name, space, noSpace }) =>
    execute((config) =>
      resumeDelegate(config, name, noSpace ? false : Option.getOrUndefined(space)),
    ),
).pipe(
  Command.withDescription(
    "start an ended delegate's session again, same name, labels and session id",
  ),
);

const fetchCommand = Command.make(
  "fetch",
  {
    target: argument("delegate", "remote delegate's name or machine/tN address, live or ended"),
    domain: optionalStringFlag("domain", "only a delegate of this domain (default: any)"),
  },
  ({ target, domain }) =>
    execute((config) => fetchRemoteBranch(config, target, Option.getOrUndefined(domain))),
).pipe(
  Command.withDescription(
    "fetch a remote delegate's branch into its repo here as a git bundle read over Herdr, and copy back its .scratch",
  ),
);

const verifyCommand = Command.make(
  "verify",
  {
    target: argument("delegate", "delegate name or address, live or ended"),
    ok: booleanFlag("ok", "the delegate's work verified clean"),
    problem: optionalStringFlag(
      "problem",
      "why verification found a problem (a crossed stop point, a bad review verdict, work outside the brief)",
    ),
    json: booleanFlag("json", "print the session's verdict and resume count as JSON"),
  },
  (options) =>
    execute((config) => {
      const problem = Option.getOrUndefined(options.problem);
      if (options.ok === (problem !== undefined))
        return Effect.fail(
          new Refused({ message: 'pass exactly one of --ok or --problem "<why>"' }),
        );
      return verifyDelegate(
        config,
        options.target,
        problem === undefined ? { result: "ok" } : { result: "problem", reason: problem },
        options.json,
      );
    }),
).pipe(
  Command.withDescription(
    "record the verify verdict for a settled delegate's session: --ok, or --problem with why",
  ),
);

const statusCommand = Command.make(
  "status",
  {
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    resume: booleanFlag("resume", "also print the rendered backlog and arm or report the watcher"),
    done: booleanFlag("done", "include closed items in the rendered backlog (with --resume)"),
    verbose: booleanFlag(
      "verbose",
      "include full answered-ask details in the rendered backlog (with --resume)",
    ),
    json: booleanFlag(
      "json",
      "print live and ended delegates, with each session's verdict and resume count, as JSON",
    ),
  },
  (options) =>
    execute(
      (config) =>
        Effect.gen(function* () {
          const domain = yield* resolveDomain(Option.getOrUndefined(options.domain));
          if (options.json && options.resume)
            return yield* new Refused({ message: "--json does not combine with --resume" });
          if (options.json) return yield* domainStatusJson(config, domain);
          const owner = process.env.HC_TERMINAL_ID;
          if (options.resume && owner) yield* readDocument(config, domain);
          const watcher =
            options.resume && owner ? yield* armWatcher(config, domain, owner) : undefined;
          const lines = yield* domainStatus(
            config,
            domain,
            options.resume,
            Date.now(),
            options.done,
            watcher,
            options.verbose,
          );
          if (options.resume) lines.push(...(yield* pathWrapper(SKILL_DIR)));
          const line = watcher ? undefined : yield* watcherBanner(config);
          return line ? [line, ...lines] : lines;
        }),
      false,
    ),
).pipe(
  Command.withDescription(
    "delegates, ended delegates and PRs (GitHub and Forgejo), with who acts next; --resume renders the backlog and arms or reports the watcher, --done includes closed items, and --verbose restores full answered-ask details",
  ),
);

const backlogShowCommand = Command.make(
  "show",
  {
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the document instead of Markdown"),
    done: booleanFlag("done", "include closed items in the Done section"),
    verbose: booleanFlag(
      "verbose",
      "include full context, options and recommendation for answered asks",
    ),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(resolveDomain(Option.getOrUndefined(options.domain)), (domain) =>
        showBacklog(config, domain, options.json, undefined, options.done, options.verbose),
      ),
    ),
).pipe(
  Command.withDescription(
    "render the backlog as Markdown, hiding closed items unless --done is set; --verbose restores full answered-ask details",
  ),
);

const backlogRenameCommand = Command.make(
  "rename",
  {
    to: argument("new", "new domain name (lowercase letters, digits, . _ -)"),
    domain: optionalStringFlag("domain", "domain to rename (default: this coordinator's label)"),
    json: booleanFlag("json", "print what moved as JSON"),
  },
  (options) =>
    execute((config) =>
      renameDomain(config, {
        to: options.to,
        domain: Option.getOrUndefined(options.domain),
        json: options.json,
      }),
    ),
).pipe(
  Command.withDescription(
    "rename the domain: its backlog, archive, watcher snapshot, ended-delegate records and fleet.domain labels; refused while it has a live delegate, watcher, or source/target harness replacement",
  ),
);

const boundaryDescription =
  "owned and adjacent repos and folders, and where each owned repo is checked out on other machines; only owned ones feed status, watch and sweep";
const boundaryAddCommand = Command.make(
  "add",
  {
    path: argument("path", "repo or folder path"),
    adjacent: booleanFlag(
      "adjacent",
      "the adjacent list: read freely, change only with the user's yes",
    ),
    machine: optionalStringFlag(
      "machine",
      "with --checkout: record the owned path's checkout on this Herdr machine",
    ),
    checkout: optionalStringFlag(
      "checkout",
      "with --machine: the absolute path of the repo's checkout on that machine",
    ),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the Boundary as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const machine = Option.getOrUndefined(options.machine);
        const checkout = Option.getOrUndefined(options.checkout);
        if ((machine === undefined) !== (checkout === undefined))
          return yield* new Refused({ message: "pass --machine and --checkout together" });
        if (machine !== undefined && options.adjacent)
          return yield* new Refused({
            message: "checkouts are recorded only on owned paths; drop --adjacent",
          });
        const domain = yield* answerDomain(Option.getOrUndefined(options.domain));
        const outsideTerminal = !process.env.HC_TERMINAL_ID;
        if (machine !== undefined && checkout !== undefined)
          return yield* checkoutAdd(config, domain, {
            path: options.path,
            machine,
            checkout,
            json: options.json,
            outsideTerminal,
          });
        return yield* boundaryAdd(config, domain, {
          path: options.path,
          adjacent: options.adjacent,
          json: options.json,
          outsideTerminal,
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "add an existing path (~ expands) to the owned Boundary, or --adjacent; with --machine and --checkout, record an owned path's checkout on another Herdr machine",
  ),
);

// The time to record a backlog change at as the user's edit: only outside every Herdr terminal (the
// Backlog panel). A coordinator's own edits record nothing; it made them.
const editedAt = (): string | undefined =>
  process.env.HC_TERMINAL_ID ? undefined : new Date().toISOString();

const boundaryRmCommand = Command.make(
  "rm",
  {
    path: argument("path", "repo or folder path"),
    adjacent: booleanFlag(
      "adjacent",
      "the adjacent list: read freely, change only with the user's yes",
    ),
    machine: optionalStringFlag(
      "machine",
      "remove only the owned path's checkout on this Herdr machine",
    ),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the Boundary as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const machine = Option.getOrUndefined(options.machine);
        if (machine !== undefined && options.adjacent)
          return yield* new Refused({
            message: "checkouts are recorded only on owned paths; drop --adjacent",
          });
        const domain = yield* answerDomain(Option.getOrUndefined(options.domain));
        if (machine !== undefined)
          return yield* checkoutRm(config, domain, {
            path: options.path,
            machine,
            json: options.json,
          });
        const outsideTerminal = !process.env.HC_TERMINAL_ID;
        return yield* boundaryRm(config, domain, {
          path: options.path,
          adjacent: options.adjacent,
          json: options.json,
          outsideTerminal,
          editedAt: outsideTerminal ? new Date().toISOString() : undefined,
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "remove a path (and its checkouts) from the owned Boundary, or --adjacent; with --machine, remove only that machine's checkout",
  ),
);

const boundaryReplaceCommand = Command.make(
  "replace",
  {
    path: argument("path", "the listed repo or folder path"),
    next: argument("new", "the existing path to list in its place (~ expands)"),
    adjacent: booleanFlag("adjacent", "the path is in the adjacent list"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the Boundary as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        boundaryReplace(config, domain, {
          from: options.path,
          to: options.next,
          adjacent: options.adjacent,
          json: options.json,
          editedAt: editedAt(),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "list another existing path in place of a Boundary path, keeping its place and an owned path's checkouts; allowed outside a Herdr terminal with --domain, recorded for the watcher's edited event",
  ),
);

const boundaryCommand = Command.make("boundary").pipe(
  Command.withDescription(boundaryDescription),
  Command.withSubcommands([boundaryAddCommand, boundaryRmCommand, boundaryReplaceCommand]),
);

const policyLsCommand = Command.make(
  "ls",
  {
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print policies as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(resolveDomain(Option.getOrUndefined(options.domain)), (domain) =>
        policyLs(config, domain, options.json),
      ),
    ),
).pipe(Command.withDescription("list reusable policies by id and date"));

const policyAddCommand = Command.make(
  "add",
  {
    text: optionalArgument("text", "deprecated: the policy as plain text, on one line; use --md"),
    md: optionalStringFlag("md", "the policy as Markdown"),
    at: optionalStringFlag("at", "date it was set, YYYY-MM-DD (default: today)"),
    wiki: optionalStringFlag(
      "wiki",
      "the domain or shared wiki page that explains it, by name; refused when no such page exists",
    ),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the policy as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = yield* coordinatorDomain(Option.getOrUndefined(options.domain));
        const wiki = Option.getOrUndefined(options.wiki);
        if (wiki !== undefined) yield* citedPage(config, domain, wiki);
        return yield* policyAdd(config, domain, {
          text: Option.getOrUndefined(options.text),
          markdown: Option.getOrUndefined(options.md),
          at: Option.getOrUndefined(options.at),
          wiki,
          json: options.json,
          now: new Date().toISOString(),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "add a reusable policy (Markdown with --md), optionally citing a wiki page; prints its short id",
  ),
);

const policyRmCommand = Command.make(
  "rm",
  {
    id: argument("id", "policy id, such as p1"),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the removed policy as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        policyRm(config, domain, { id: options.id, json: options.json, editedAt: editedAt() }),
      ),
    ),
).pipe(
  Command.withDescription(
    "remove a policy by id; allowed outside a Herdr terminal with --domain, recorded for the watcher's edited event",
  ),
);

const policyReplaceCommand = Command.make(
  "replace",
  {
    id: argument("id", "policy id, such as p1"),
    text: optionalArgument(
      "text",
      "deprecated: the replacement policy as plain text, on one line; use --md",
    ),
    md: optionalStringFlag("md", "the replacement policy as Markdown"),
    at: optionalStringFlag("at", "date it was replaced, YYYY-MM-DD (default: today)"),
    wiki: optionalStringFlag(
      "wiki",
      "cite this domain or shared wiki page instead (default: keep its citation); refused when no such page exists",
    ),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the replacement policy as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = yield* answerDomain(Option.getOrUndefined(options.domain));
        const wiki = Option.getOrUndefined(options.wiki);
        if (wiki !== undefined) yield* citedPage(config, domain, wiki);
        return yield* policyReplace(config, domain, {
          editedAt: editedAt(),
          id: options.id,
          text: Option.getOrUndefined(options.text),
          markdown: Option.getOrUndefined(options.md),
          at: Option.getOrUndefined(options.at),
          wiki,
          json: options.json,
          now: new Date().toISOString(),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "replace a policy (Markdown with --md) and its date while keeping its id, optionally citing another wiki page; allowed outside a Herdr terminal with --domain, recorded for the watcher's edited event",
  ),
);

const policyCommand = Command.make("policy").pipe(
  Command.withDescription("reusable policies, in the user's words"),
  Command.withSubcommands([
    policyAddCommand,
    policyLsCommand,
    policyRmCommand,
    policyReplaceCommand,
  ]),
);

const focusCommand = Command.make(
  "focus",
  {
    text: optionalArgument(
      "text",
      "deprecated: one plain-text line on what the domain is doing now; use --md",
    ),
    md: optionalStringFlag("md", "one line of inline Markdown on what the domain is doing now"),
    clear: booleanFlag("clear", "clear the focus line"),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the focus as JSON"),
  },
  (options) => {
    const text = Option.getOrUndefined(options.text);
    const markdown = Option.getOrUndefined(options.md);
    if ([text !== undefined, markdown !== undefined, options.clear].filter(Boolean).length !== 1) {
      console.error("refused: pass exactly one of --md, <text> or --clear");
      process.exit(1);
    }
    return execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        focusSet(config, domain, {
          focus: text ?? null,
          markdown,
          json: options.json,
          editedAt: editedAt(),
        }),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "set the domain's focus line, or clear it with --clear; allowed outside a Herdr terminal with --domain, recorded for the watcher's edited event",
  ),
);

const backlogCommand = Command.make("backlog").pipe(
  Command.withDescription(
    "read and edit the domain's structured backlog (the CLI is its only writer)",
  ),
  Command.withSubcommands([
    backlogShowCommand,
    backlogRenameCommand,
    boundaryCommand,
    policyCommand,
    focusCommand,
  ]),
);

const harnessPolicyShowCommand = Command.make(
  "show",
  {
    domain: optionalStringFlag("domain", "domain whose effective policy to show"),
    json: booleanFlag("json", "print policy state as JSON"),
  },
  (options) =>
    execute((config) =>
      showHarnessPolicy(config, Option.getOrUndefined(options.domain), options.json),
    ),
).pipe(
  Command.withDescription(
    "show the global harness policy and, optionally, one domain's inherited or replacement policy",
  ),
);

const harnessPolicyGlobalSetCommand = Command.make(
  "global-set",
  {
    enabled: stringFlag("enabled", "complete enabled set: pi, claude, pi,claude, or none"),
    defaultHarness: optionalChoiceFlag(
      "default",
      DELEGATE_HARNESSES,
      "default harness, which must also be enabled",
    ),
    noDefault: booleanFlag("no-default", "leave the default unset"),
    expectedRevision: stringFlag(
      "expected-revision",
      "revision from the latest harness-policy show",
    ),
    json: booleanFlag("json", "print the committed policy state as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const expectedRevision = yield* parsePolicyRevision(options.expectedRevision);
        const selection = yield* parseHarnessSelection(
          options.enabled,
          Option.getOrUndefined(options.defaultHarness),
          options.noDefault,
        );
        return yield* setHarnessPolicy(config, {
          scope: "global",
          domain: undefined,
          selection,
          expectedRevision,
          json: options.json,
        });
      }),
    ),
).pipe(Command.withDescription("replace the complete global harness policy"));

const harnessPolicyDomainSetCommand = Command.make(
  "domain-set",
  {
    domain: argument("domain", "existing domain to give a complete replacement policy"),
    enabled: stringFlag("enabled", "complete enabled set: pi, claude, pi,claude, or none"),
    defaultHarness: optionalChoiceFlag(
      "default",
      DELEGATE_HARNESSES,
      "default harness, which must also be enabled",
    ),
    noDefault: booleanFlag("no-default", "leave the default unset"),
    expectedRevision: stringFlag(
      "expected-revision",
      "revision from the latest harness-policy show",
    ),
    json: booleanFlag("json", "print the committed policy state as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const expectedRevision = yield* parsePolicyRevision(options.expectedRevision);
        const selection = yield* parseHarnessSelection(
          options.enabled,
          Option.getOrUndefined(options.defaultHarness),
          options.noDefault,
        );
        return yield* setHarnessPolicy(config, {
          scope: "domain",
          domain: options.domain,
          selection,
          expectedRevision,
          json: options.json,
        });
      }),
    ),
).pipe(Command.withDescription("replace one domain's complete harness policy"));

const harnessPolicyDomainResetCommand = Command.make(
  "domain-reset",
  {
    domain: argument("domain", "domain whose replacement policy is removed"),
    expectedRevision: stringFlag(
      "expected-revision",
      "revision from the latest harness-policy show",
    ),
    json: booleanFlag("json", "print the committed policy state as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const expectedRevision = yield* parsePolicyRevision(options.expectedRevision);
        return yield* resetHarnessPolicy(config, options.domain, expectedRevision, options.json);
      }),
    ),
).pipe(Command.withDescription("remove a domain replacement and restore global inheritance"));

const harnessPolicyCommand = Command.make("harness-policy").pipe(
  Command.withDescription(
    "read and edit the local versioned delegate harness policy enforced for new launches, resumes and queued retries",
  ),
  Command.withSubcommands([
    harnessPolicyShowCommand,
    harnessPolicyGlobalSetCommand,
    harnessPolicyDomainSetCommand,
    harnessPolicyDomainResetCommand,
  ]),
);

const itemAddCommand = Command.make(
  "add",
  {
    title: argument("title", "one-line title"),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the new item as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(coordinatorDomain(Option.getOrUndefined(options.domain)), (domain) =>
        itemAdd(config, domain, {
          title: options.title,
          json: options.json,
          now: new Date().toISOString(),
        }),
      ),
    ),
).pipe(Command.withDescription("add an open item; prints its short id (i1, i2, ...)"));

const itemUpdateCommand = Command.make(
  "update",
  {
    id: argument("id", "item id, such as i3"),
    status: optionalChoiceFlag("status", ITEM_STATUSES, "set the status"),
    outcome: optionalStringFlag(
      "outcome",
      "deprecated: one plain-text line on how it ended; use --outcome-md",
    ),
    outcomeMd: optionalStringFlag(
      "outcome-md",
      "how it ended, as Markdown (with --status done or dismissed)",
    ),
    decided: repeatedStringFlag(
      "decided",
      "deprecated: append a plain-text decision; use --decided-md (repeatable)",
    ),
    decidedMd: repeatedStringFlag(
      "decided-md",
      "append a decision as Markdown, dated today (repeatable; after any --decided)",
    ),
    touch: repeatedStringFlag("touch", "record a repo the item touches (repeatable)"),
    untouch: repeatedStringFlag("untouch", "remove a touched repo (repeatable)"),
    due: optionalStringFlag("due", "due date, YYYY-MM-DD"),
    noDue: booleanFlag("no-due", "clear the due date").pipe(Flag.withoutNegation),
    ask: optionalStringFlag("ask", "deprecated: a plain-text question; use --ask-md"),
    askMd: optionalStringFlag(
      "ask-md",
      "attach a question for the user as one line of inline Markdown, replacing any ask",
    ),
    context: optionalStringFlag("context", "deprecated: plain-text context; use --context-md"),
    contextMd: optionalStringFlag(
      "context-md",
      "why the ask is asked, as Markdown (with --ask-md)",
    ),
    option: repeatedStringFlag(
      "option",
      "deprecated: an answer choice, optionally '<label> :: <detail>' in plain text; use --option-md (repeatable)",
    ),
    optionMd: repeatedStringFlag(
      "option-md",
      "an answer choice, a plain one-line label optionally followed by ' :: <Markdown detail>' (with --ask-md, repeatable)",
    ),
    rec: optionalStringFlag(
      "rec",
      "the recommended option label, one of the options (with --ask-md)",
    ),
    why: optionalStringFlag("why", "deprecated: a plain-text reason; use --why-md"),
    whyMd: optionalStringFlag("why-md", "why the recommended option, as Markdown (with --rec)"),
    note: optionalStringFlag("note", "deprecated: a plain-text answer note; use --note-md"),
    noteMd: optionalStringFlag("note-md", "a note attached to the answer, as Markdown"),
    answer: optionalStringFlag(
      "answer",
      "the user's answer, an option label, clears the ask; Discuss or Discuss: <note> keeps it open for conversation",
    ),
    answerMd: optionalStringFlag(
      "answer-md",
      "the user's free-text answer as one line of inline Markdown (not an option label), clears the ask",
    ),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the updated item as JSON"),
  },
  (options) => {
    const status = Option.getOrUndefined(options.status) as ItemStatus | undefined;
    // A change of status alone is the one item update the Backlog panel may run outside a terminal.
    const statusOnly =
      status !== undefined &&
      Option.isNone(options.outcome) &&
      Option.isNone(options.outcomeMd) &&
      options.decided.length === 0 &&
      options.decidedMd.length === 0 &&
      options.touch.length === 0 &&
      options.untouch.length === 0 &&
      Option.isNone(options.due) &&
      !options.noDue &&
      Option.isNone(options.ask) &&
      Option.isNone(options.askMd) &&
      Option.isNone(options.context) &&
      Option.isNone(options.contextMd) &&
      options.option.length === 0 &&
      options.optionMd.length === 0 &&
      Option.isNone(options.rec) &&
      Option.isNone(options.why) &&
      Option.isNone(options.whyMd) &&
      Option.isNone(options.note) &&
      Option.isNone(options.noteMd) &&
      Option.isNone(options.answer) &&
      Option.isNone(options.answerMd);
    const domainFlag = Option.getOrUndefined(options.domain);
    return execute((config) =>
      Effect.flatMap(
        statusOnly ? statusDomain(domainFlag, status) : coordinatorDomain(domainFlag),
        (domain) =>
          itemUpdate(config, domain, {
            id: options.id,
            status,
            outcome: Option.getOrUndefined(options.outcome),
            outcomeMarkdown: Option.getOrUndefined(options.outcomeMd),
            decided: [...options.decided],
            decidedMarkdown: [...options.decidedMd],
            touch: [...options.touch],
            untouch: [...options.untouch],
            due: options.noDue ? null : Option.getOrUndefined(options.due),
            ask: Option.getOrUndefined(options.ask),
            askMarkdown: Option.getOrUndefined(options.askMd),
            context: Option.getOrUndefined(options.context),
            contextMarkdown: Option.getOrUndefined(options.contextMd),
            options: [...options.option],
            optionsMarkdown: [...options.optionMd],
            rec: Option.getOrUndefined(options.rec),
            why: Option.getOrUndefined(options.why),
            whyMarkdown: Option.getOrUndefined(options.whyMd),
            answer: Option.getOrUndefined(options.answer),
            answerMarkdown: Option.getOrUndefined(options.answerMd),
            note: Option.getOrUndefined(options.note),
            noteMarkdown: Option.getOrUndefined(options.noteMd),
            json: options.json,
            now: new Date().toISOString(),
          }),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "change an item's status, decisions, touched repos, due date or ask; Discuss keeps an ask open for conversation; waiting-user needs an ask or a decision, delegated needs a delegate; --status open, building, in-review or parked alone is allowed outside a Herdr terminal with --domain",
  ),
);

const itemAnswerCommand = Command.make(
  "answer",
  {
    id: argument("id", "item id, such as i3"),
    answer: optionalArgument(
      "answer",
      "the user's answer as an option label, Discuss or Discuss: <note> (put -- before the arguments if it starts with -)",
    ),
    md: optionalStringFlag(
      "md",
      "the user's free-text answer as one line of inline Markdown, instead of <answer>",
    ),
    note: optionalStringFlag("note", "deprecated: a plain-text answer note; use --note-md"),
    noteMd: optionalStringFlag("note-md", "a note attached to the answer, as Markdown"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the updated item as JSON"),
  },
  (options) => {
    if (Option.isSome(options.answer) === Option.isSome(options.md)) {
      console.error("refused: pass exactly one of <answer> or --md");
      process.exit(1);
    }
    return execute(
      (config) =>
        Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
          itemUpdate(config, domain, {
            id: options.id,
            status: undefined,
            outcome: undefined,
            decided: [],
            touch: [],
            untouch: [],
            due: undefined,
            ask: undefined,
            context: undefined,
            options: [],
            rec: undefined,
            why: undefined,
            answer: Option.getOrUndefined(options.answer),
            answerMarkdown: Option.getOrUndefined(options.md),
            note: Option.getOrUndefined(options.note),
            noteMarkdown: Option.getOrUndefined(options.noteMd),
            json: options.json,
            now: new Date().toISOString(),
          }),
        ),
      false,
    );
  },
).pipe(
  Command.withDescription(
    "record the user's answer (an option label, or free-text inline Markdown with --md) or Discuss request for an item's ask, as item update --answer and --answer-md do; this, item close and backlog boundary add/rm are allowed outside a Herdr terminal with --domain",
  ),
);

const itemCloseCommand = Command.make(
  "close",
  {
    id: argument("id", "item id, such as i3"),
    outcome: stringFlag(
      "outcome",
      "deprecated: one plain-text line on how it ended; use --outcome-md",
    ).pipe(Flag.withDefault("")),
    outcomeMd: optionalStringFlag("outcome-md", "how it ended, as Markdown (required)"),
    dismissed: booleanFlag("dismissed", "close as dismissed instead of done"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the closed item as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        itemClose(config, domain, {
          id: options.id,
          outcome: options.outcome,
          outcomeMarkdown: Option.getOrUndefined(options.outcomeMd),
          dismissed: options.dismissed,
          json: options.json,
          now: new Date().toISOString(),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "close an item as done (or dismissed) with an outcome; allowed outside a Herdr terminal with --domain, as item answer is",
  ),
);

const itemStartCommand = Command.make(
  "start",
  {
    id: argument("id", "item id, such as i3"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the item as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        itemStart(config, domain, {
          id: options.id,
          json: options.json,
          now: new Date().toISOString(),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "record the user's request that the coordinator start an item now, which the watcher delivers as a start event; refused for a done, dismissed or delegated item, and a pending request is kept; allowed outside a Herdr terminal with --domain, as item answer is",
  ),
);

const itemEditCommand = Command.make(
  "edit",
  {
    id: argument("id", "item id, such as i3"),
    title: optionalStringFlag("title", "the new title, one plain-text line"),
    outcomeMd: optionalStringFlag("outcome-md", "a closed item's new outcome, as Markdown"),
    decision: optionalStringFlag(
      "decision",
      "the decision to change, by its key (<index>:<fingerprint>; an unknown key is refused with the item's current keys)",
    ),
    md: optionalStringFlag("md", "with --decision: the decision's new text, as Markdown"),
    remove: booleanFlag("remove", "with --decision: delete the decision"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the item as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const title = Option.getOrUndefined(options.title);
        const outcome = Option.getOrUndefined(options.outcomeMd);
        const key = Option.getOrUndefined(options.decision);
        const md = Option.getOrUndefined(options.md);
        const picked = [title, outcome, key].filter((value) => value !== undefined).length;
        if (picked !== 1)
          return yield* new Refused({
            message: "pass exactly one of --title, --outcome-md or --decision",
          });
        if (
          key === undefined
            ? md !== undefined || options.remove
            : (md === undefined) === !options.remove
        )
          return yield* new Refused({
            message: "--decision takes exactly one of --md or --remove, and they need --decision",
          });
        const domain = yield* answerDomain(Option.getOrUndefined(options.domain));
        return yield* itemEdit(config, domain, {
          id: options.id,
          edit:
            key !== undefined
              ? { field: "decision", key, markdown: options.remove ? null : (md ?? "") }
              : title !== undefined
                ? { field: "title", value: title }
                : { field: "outcome", value: outcome ?? "" },
          json: options.json,
          editedAt: editedAt(),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "edit an item's title, a closed item's outcome, or one coordinator decision (by key), or delete that decision; answers and discussion requests stay as recorded; allowed outside a Herdr terminal with --domain, recorded for the watcher's edited event",
  ),
);

const delegateArgumentDescription =
  "delegate name or Herdr terminal address (detach also takes a session id)";
const itemAttachCommand = Command.make(
  "attach",
  {
    id: argument("id", "item id, such as i3"),
    target: argument("delegate", delegateArgumentDescription),
    session: optionalStringFlag(
      "session",
      "the agent's session id, when Herdr sees none (Claude Code shows it in /status)",
    ),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the updated item as JSON"),
  },
  (options) =>
    execute((config) =>
      attachDelegate(config, {
        id: options.id,
        target: options.target,
        domain: Option.getOrUndefined(options.domain),
        json: options.json,
        session: Option.getOrUndefined(options.session),
      }),
    ),
).pipe(
  Command.withDescription(
    "file an already-running agent session under an item, as delegate --item would; labels a hand-started one so status, watch, end and resume track it",
  ),
);

const itemDetachCommand = Command.make(
  "detach",
  {
    id: argument("id", "item id, such as i3"),
    target: argument("delegate", delegateArgumentDescription),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    json: booleanFlag("json", "print the updated item as JSON"),
  },
  (options) =>
    execute((config) =>
      detachDelegate(config, {
        id: options.id,
        target: options.target,
        domain: Option.getOrUndefined(options.domain),
        json: options.json,
        session: undefined,
      }),
    ),
).pipe(
  Command.withDescription(
    "remove a delegate from an item; an item left with no delegates goes back to open",
  ),
);

const itemCommand = Command.make("item").pipe(
  Command.withDescription("add, update and close backlog items"),
  Command.withSubcommands([
    itemAddCommand,
    itemUpdateCommand,
    itemAnswerCommand,
    itemCloseCommand,
    itemStartCommand,
    itemEditCommand,
    itemAttachCommand,
    itemDetachCommand,
  ]),
);

const findingAddCommand = Command.make(
  "add",
  {
    title: argument("title", "one-line title"),
    kind: choiceFlag("kind", ["issue", "opportunity"], "what was noticed"),
    detail: optionalStringFlag("detail", "deprecated: plain-text detail; use --detail-md"),
    detailMd: optionalStringFlag(
      "detail-md",
      "the detail (required, or --detail): What, Where, Why it matters, Suggested fix",
    ),
    path: optionalStringFlag("path", "file or folder it concerns"),
    from: optionalStringFlag("from", "item it was noticed while working on, such as i3"),
    source: optionalStringFlag("source", "where it came from, such as retro:fix-a"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this terminal's fleet.domain label, coordinator or delegate)",
    ),
    json: booleanFlag("json", "print the new finding as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(domainOfCaller(Option.getOrUndefined(options.domain)), (domain) =>
        findingAdd(config, domain, {
          kind: options.kind as "issue" | "opportunity",
          title: options.title,
          detail: Option.getOrUndefined(options.detail),
          detailMarkdown: Option.getOrUndefined(options.detailMd),
          path: Option.getOrUndefined(options.path),
          from: Option.getOrUndefined(options.from),
          source: Option.getOrUndefined(options.source),
          json: options.json,
          now: new Date().toISOString(),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    `add an open finding; delegates may run this. Prints its short id (f1, f2, ... ). Refused without a detail: --detail-md with ${FINDING_DETAIL_SHAPE}`,
  ),
);

const findingCloseCommand = Command.make(
  "close",
  {
    id: argument("id", "finding id, such as f2"),
    outcome: stringFlag(
      "outcome",
      "deprecated: one plain-text line on what was done; use --outcome-md",
    ).pipe(Flag.withDefault("")),
    outcomeMd: optionalStringFlag("outcome-md", "what was done, as Markdown (required)"),
    dismissed: booleanFlag("dismissed", "close as dismissed instead of acted"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the closed finding as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        findingClose(config, domain, {
          id: options.id,
          outcome: options.outcome,
          outcomeMarkdown: Option.getOrUndefined(options.outcomeMd),
          dismissed: options.dismissed,
          json: options.json,
          now: new Date().toISOString(),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "close a finding as acted (or dismissed) with an outcome; allowed outside a Herdr terminal with --domain, as item close is",
  ),
);

const findingPromoteCommand = Command.make(
  "promote",
  {
    id: argument("id", "finding id, such as f2"),
    title: optionalStringFlag("title", "the new item's title (default: the finding's title)"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the new item and the closed finding as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(answerDomain(Option.getOrUndefined(options.domain)), (domain) =>
        findingPromote(config, domain, {
          id: options.id,
          title: Option.getOrUndefined(options.title),
          json: options.json,
          now: new Date().toISOString(),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    'turn an open finding into an open item in the same domain and close it as acted with the outcome "promoted to <item id>"; allowed outside a Herdr terminal with --domain',
  ),
);

const findingEditCommand = Command.make(
  "edit",
  {
    id: argument("id", "finding id, such as f2"),
    title: optionalStringFlag("title", "the new title, one plain-text line"),
    detailMd: optionalStringFlag("detail-md", "the new detail, as Markdown"),
    outcomeMd: optionalStringFlag("outcome-md", "a closed finding's new outcome, as Markdown"),
    domain: optionalStringFlag(
      "domain",
      "domain (default: this coordinator's label; required outside a terminal)",
    ),
    json: booleanFlag("json", "print the finding as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const fields = [
          ["title", Option.getOrUndefined(options.title)],
          ["detail", Option.getOrUndefined(options.detailMd)],
          ["outcome", Option.getOrUndefined(options.outcomeMd)],
        ] as const;
        const given = fields.filter(([, value]) => value !== undefined);
        const [picked] = given;
        if (given.length !== 1 || picked === undefined)
          return yield* new Refused({
            message: "pass exactly one of --title, --detail-md or --outcome-md",
          });
        const domain = yield* answerDomain(Option.getOrUndefined(options.domain));
        return yield* findingEdit(config, domain, {
          id: options.id,
          field: picked[0],
          value: picked[1] ?? "",
          json: options.json,
          editedAt: editedAt(),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "edit a finding's title, detail, or a closed finding's outcome; allowed outside a Herdr terminal with --domain, recorded for the watcher's edited event",
  ),
);

const findingCommand = Command.make("finding").pipe(
  Command.withDescription(
    "record, promote and close issues and opportunities noticed outside an item's scope",
  ),
  Command.withSubcommands([
    findingAddCommand,
    findingCloseCommand,
    findingPromoteCommand,
    findingEditCommand,
  ]),
);

const sharedFlag = booleanFlag(
  "shared",
  "the shared wiki instead of this domain's (only the manager coordinator writes it)",
);
const wikiDomainFlag = optionalStringFlag("domain", "domain (default: this coordinator's label)");

const wikiPathCommand = Command.make(
  "path",
  {
    shared: sharedFlag,
    domain: wikiDomainFlag,
    json: booleanFlag("json", "print domain, shared and path as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(coordinatorDomain(Option.getOrUndefined(options.domain)), (domain) =>
        wikiPath(config, domain, { shared: options.shared, json: options.json }),
      ),
    ),
).pipe(
  Command.withDescription(
    "print the wiki's folder, creating and git-initializing it on first use (--shared: the manager's shared wiki)",
  ),
);

const wikiLintCommand = Command.make(
  "lint",
  {
    shared: sharedFlag,
    domain: wikiDomainFlag,
    json: booleanFlag("json", "print path, page count and problems as JSON"),
    mark: booleanFlag(
      "mark",
      "when lint passes, record today as the last lint, restarting the watcher's weekly lint-due",
    ),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = yield* coordinatorDomain(Option.getOrUndefined(options.domain));
        if (options.mark && options.shared)
          return yield* new Refused({
            message: "--mark records the domain wiki's lint clock; run it without --shared",
          });
        const now = new Date();
        const result = yield* lintWiki(config, domain, { shared: options.shared, now });
        // Problems exit 1: fix the pages (or close the findings) and lint again.
        if (result.problems.length > 0) process.exitCode = 1;
        const marked =
          options.mark && result.problems.length === 0 ? now.toISOString().slice(0, 10) : null;
        if (marked !== null) yield* markLint(config, domain, marked);
        if (options.json)
          return [JSON.stringify(options.mark ? { ...result, marked } : result, null, 2)];
        return [
          ...lintLines(result),
          ...(marked === null
            ? []
            : [
                `recorded the last lint as ${marked}; the watcher's next lint-due is ${LINT_INTERVAL_DAYS} days later`,
              ]),
        ];
      }),
    ),
).pipe(
  Command.withDescription(
    "check the wiki: frontmatter, orphans, index.md, [[links]], undated claims about code, covers globs, findings open over 14 days; exit 1 on problems; --mark records a pass for the watcher's weekly lint-due",
  ),
);

const wikiCommitCommand = Command.make(
  "commit",
  {
    message: stringFlag("message", "one-line commit message (required)").pipe(Flag.withAlias("m")),
    shared: sharedFlag,
    domain: wikiDomainFlag,
    json: booleanFlag("json", "print path, committed hash and lint problems as JSON"),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(coordinatorDomain(Option.getOrUndefined(options.domain)), (domain) =>
        commitWiki(config, domain, {
          shared: options.shared,
          message: options.message,
          now: new Date(),
        }).pipe(
          Effect.map((result) => {
            if (options.json) {
              if (result.problems.length > 0) process.exitCode = 1;
              return [JSON.stringify(result, null, 2)];
            }
            if (result.problems.length > 0) {
              // Lint refuses the commit: exit 1 with the problems, as `wiki lint` prints them.
              process.exitCode = 1;
              console.error(
                `refused: wiki lint found ${result.problems.length} problems in ${result.path}, nothing committed`,
              );
              return result.problems.map((problem) => `${problem.kind}: ${problem.message}`);
            }
            return [
              result.committed === null
                ? `nothing to commit in ${result.path}`
                : `committed ${result.committed} in ${result.path}: ${options.message.trim()}`,
            ];
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "lint the wiki, then commit all its changes locally; exit 1 without committing when lint finds problems",
  ),
);

const wikiReadDomainFlag = optionalStringFlag(
  "domain",
  "domain (default: the calling terminal's label)",
);

const wikiListCommand = Command.make(
  "list",
  {
    domain: wikiReadDomainFlag,
    json: booleanFlag(
      "json",
      "print { domain, path, lastLint, pages, invalid }: each valid page's frontmatter in index order, and the names of pages with invalid frontmatter",
    ),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(domainOfCaller(Option.getOrUndefined(options.domain)), (domain) =>
        wikiList(config, domain, options.json),
      ),
    ),
).pipe(
  Command.withDescription(
    "list the domain wiki's pages in index order with their type and description, and the last lint; read-only, a missing wiki lists none and is not created",
  ),
);

const wikiShowCommand = Command.make(
  "show",
  {
    name: argument("name", "page name, as wiki list prints it"),
    domain: wikiReadDomainFlag,
    json: booleanFlag(
      "json",
      "print { domain, name, file, meta, errors, body }: meta is null when the frontmatter is invalid",
    ),
  },
  (options) =>
    execute((config) =>
      Effect.flatMap(domainOfCaller(Option.getOrUndefined(options.domain)), (domain) =>
        wikiShow(config, domain, { name: options.name, json: options.json }),
      ),
    ),
).pipe(
  Command.withDescription(
    "print one domain wiki page's frontmatter and Markdown body; read-only, refused for a name wiki list does not print",
  ),
);

const wikiCommand = Command.make("wiki").pipe(
  Command.withDescription(
    "locate, read, lint and commit the domain's wiki of dated knowledge pages (the coordinator is its only writer)",
  ),
  Command.withSubcommands([
    wikiPathCommand,
    wikiListCommand,
    wikiShowCommand,
    wikiLintCommand,
    wikiCommitCommand,
  ]),
);

const watchOutboxCommand = Command.make(
  "outbox",
  {
    domain: optionalStringFlag("domain", "domain (default: the calling terminal's label)"),
    json: booleanFlag(
      "json",
      "print { domain, events } with each event's kind, attrs, fields and text",
    ),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = yield* domainOfCaller(Option.getOrUndefined(options.domain));
        return yield* showOutbox(config, domain, options.json);
      }),
    ),
).pipe(
  Command.withDescription(
    "show the watcher events queued for the coordinator but not yet delivered; read-only",
  ),
);

const queueShowCommand = Command.make(
  "show",
  {
    domain: optionalStringFlag("domain", "domain (default: the calling terminal's label)"),
    json: booleanFlag(
      "json",
      "print { domain, entries } with each entry's item, machine, order and per-machine position",
    ),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = yield* domainOfCaller(Option.getOrUndefined(options.domain));
        return yield* showCapacityQueue(config, domain, options.json);
      }),
    ),
).pipe(
  Command.withDescription(
    "show the items waiting for a free delegate slot, with each one's machine and place in that machine's queue; read-only",
  ),
);

const queueCommand = Command.make("queue").pipe(
  Command.withDescription("read the capacity queue that delegate --queue-if-full writes"),
  Command.withSubcommands([queueShowCommand]),
);

const watchCommand = Command.make(
  "watch",
  {
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    owner: optionalStringFlag("owner", "coordinator terminal address (required with --deliver)"),
    interval: stringFlag("interval", "herdr-core poll interval").pipe(Flag.withDefault("5")),
    forgeInterval: stringFlag("forge-interval", "GitHub/Forgejo and due-date poll interval").pipe(
      Flag.withDefault("90"),
    ),
    maxMinutes: stringFlag(
      "max-minutes",
      "exit with an alive line after this long without events",
    ).pipe(Flag.withDefault("110")),
    replace: booleanFlag("replace", "stop a running watcher for the domain and take over"),
    deliver: booleanFlag("deliver", "send each tick's event batch to the explicit owner address"),
    arm: booleanFlag("arm", "launch the domain watcher in its own Herdr terminal"),
    stop: booleanFlag("stop", "stop the domain's Herdr watcher terminal"),
    follow: booleanFlag(
      "follow",
      "keep running and write event lines to stdout (no alive line or time limit)",
    ),
  },
  (options) =>
    execute(
      (config) =>
        Effect.gen(function* () {
          const domainFlag = Option.getOrUndefined(options.domain);
          const ownerFlag = Option.getOrUndefined(options.owner);
          if (options.arm && options.stop)
            return yield* new Refused({ message: "choose either --arm or --stop" });
          if ((options.arm || options.stop) && (options.deliver || options.follow))
            return yield* new Refused({ message: "--arm and --stop cannot run a watch loop" });
          if (options.deliver && (!domainFlag || !ownerFlag))
            return yield* new Refused({
              message:
                "watch --deliver requires explicit --domain <domain> and --owner <coordinator address>",
            });
          const domain = yield* resolveDomain(domainFlag);
          const owner = ownerFlag ?? process.env.HC_TERMINAL_ID;
          if (options.arm) {
            if (!owner)
              return yield* new Refused({
                message: "HC_TERMINAL_ID is unset: run this in the coordinator terminal",
              });
            return [watcherInfoLine(yield* armWatcher(config, domain, owner, options.replace))];
          }
          if (options.stop) {
            if (!owner)
              return yield* new Refused({
                message: "HC_TERMINAL_ID is unset: run this in the coordinator terminal",
              });
            return yield* stopWatcher(config, domain, owner);
          }
          return yield* watch(config, {
            domain,
            intervalMs: Number(options.interval) * 1000,
            forgeIntervalMs: Number(options.forgeInterval) * 1000,
            maxMs: Number(options.maxMinutes) * 60_000,
            owner,
            replace: options.replace,
            deliver: options.deliver,
            today: () => new Date().toISOString().slice(0, 10),
            now: () => Date.now(),
            follow: options.follow || options.deliver,
            emit: writeWatchLine,
            render: options.deliver ? createWatchTerminalRenderer() : undefined,
          });
        }),
      false,
    ),
).pipe(
  Command.withDescription(
    "watch a domain's delegates, PRs and backlog events; use --deliver with explicit --domain and --owner in the dedicated Herdr watcher terminal",
  ),
  Command.withSubcommands([watchOutboxCommand]),
);

/**
 * Main checkouts from explicit paths, else the domain's repos.
 * @param paths Paths given on the command line.
 * @param domain `--domain`.
 * @param config Config.
 * @returns Main checkouts.
 */
const reposFor = (paths: readonly string[], domain: string | undefined, config: Config) =>
  Effect.gen(function* () {
    if (paths.length === 0) return yield* domainRepos(config, yield* resolveDomain(domain));
    const repos: string[] = [];
    for (const path of paths) {
      const checkout = yield* mainCheckout(absolutePath(path));
      if (checkout && !repos.includes(checkout)) repos.push(checkout);
      if (!checkout) return yield* new Refused({ message: `${path} is not a Git checkout` });
    }
    return repos;
  });

/**
 * The checkouts on other machines the domain's Boundary records for these repos (all of them when
 * repos is undefined), or none when the domain or its backlog cannot be read.
 * @param config Config.
 * @param domain `--domain`, else this coordinator's label.
 * @param repos Main checkouts here.
 * @returns Remote checkouts.
 */
const domainRemotes = (
  config: Config,
  domain: string | undefined,
  repos: readonly string[] | undefined,
) =>
  resolveDomain(domain).pipe(
    Effect.flatMap((resolved) => remoteCheckouts(config, resolved, repos)),
    Effect.catch(() => Effect.succeed([])),
  );

const sweepReportCommand = Command.make(
  "report",
  {
    repos: Argument.String("repos")
      .pipe(Argument.withDescription("checkouts (default: the domain's repos)"))
      .pipe(Argument.variadic()),
    domain: optionalStringFlag("domain", "domain (default: this coordinator's label)"),
    base: repeatedStringFlag("base", "extra base ref (repeatable)"),
    keep: repeatedStringFlag("keep", "folder never removed (repeatable)"),
    sizes: booleanFlag("sizes", "show sizes of non-KEEP worktrees"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = Option.getOrUndefined(options.domain);
        const found = yield* reposFor(options.repos, domain, config);
        return renderRows(
          yield* report(
            config,
            found,
            { bases: options.base, keep: options.keep, sizes: options.sizes, nowMs: Date.now() },
            yield* domainRemotes(config, domain, found),
          ),
        );
      }),
    ),
).pipe(
  Command.withDescription("one verdict per item, changing nothing: SAFE, CLOSE, ASK, KEEP, INFO"),
);

const sweepRemoveCommand = Command.make(
  "remove",
  {
    worktrees: Argument.String("worktrees")
      .pipe(Argument.withDescription("worktrees to remove"))
      .pipe(Argument.variadic()),
    allSafe: booleanFlag(
      "all-safe",
      "remove every SAFE worktree of the domain's repos (or --repo)",
    ),
    repo: repeatedStringFlag("repo", "repo for --all-safe (repeatable)"),
    domain: optionalStringFlag(
      "domain",
      "domain for --all-safe and for machine:/path worktrees (its Boundary's checkouts)",
    ),
    base: repeatedStringFlag("base", "extra base ref (repeatable)"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const domain = Option.getOrUndefined(options.domain);
        // A machine:/path worktree lives on another machine; only paths here are resolved here.
        const targets = options.worktrees.map((path) =>
          remoteTarget(path) === undefined ? absolutePath(path) : path,
        );
        const repos: string[] = [];
        for (const path of targets) {
          if (remoteTarget(path) !== undefined) continue;
          const repo = yield* mainCheckout(path);
          if (repo && !repos.includes(repo)) repos.push(repo);
        }
        const allSafeRepos = options.allSafe ? yield* reposFor(options.repo, domain, config) : [];
        for (const repo of allSafeRepos) if (!repos.includes(repo)) repos.push(repo);
        const remoteTargets = targets.flatMap((path) => remoteTarget(path) ?? []);
        const remotes = (yield* domainRemotes(config, domain, undefined)).filter(
          (remote) =>
            allSafeRepos.includes(remote.repo) ||
            remoteTargets.some(
              (target) =>
                target.machine === remote.machine && target.path.startsWith(`${remote.checkout}/`),
            ),
        );
        for (const remote of remotes) if (!repos.includes(remote.repo)) repos.push(remote.repo);
        const ctx = yield* context(config, repos, options.base, [], remotes);
        let rows: readonly Row[] = [];
        if (options.allSafe) {
          rows = yield* report(
            config,
            repos,
            { bases: options.base, keep: [], sizes: false, nowMs: Date.now() },
            remotes,
          );
          for (const row of rows)
            if (
              row.verdict === "SAFE" &&
              row.text.startsWith("worktree ") &&
              row.path &&
              !targets.includes(row.path)
            )
              targets.push(row.path);
        }
        const stop = defaultStop();
        const deleted = options.allSafe ? yield* stopDeletedFolders(rows, stop) : [];
        if (targets.length === 0) return deleted.length > 0 ? deleted : ["no worktree to remove"];
        return [...(yield* removeMany(config, targets, ctx, stop)), ...deleted];
      }),
    ),
).pipe(
  Command.withDescription(
    "re-check each worktree and remove it only when SAFE: park .scratch/, drop the rest, git branch -d",
  ),
);

const sweepPruneBranchesCommand = Command.make(
  "prune-branches",
  {
    repoPath: argument("repo", "checkout"),
    branches: Argument.String("branches")
      .pipe(Argument.withDescription("landed branches to delete with git branch -d"))
      .pipe(Argument.variadic()),
    list: booleanFlag("list", "list landed branches"),
    base: repeatedStringFlag("base", "extra base ref (repeatable)"),
  },
  (options) =>
    execute((config) =>
      Effect.gen(function* () {
        const [repo] = yield* reposFor([options.repoPath], undefined, config);
        const ctx = yield* context(config, [repo ?? options.repoPath], options.base, []);
        return yield* pruneBranches(
          repo ?? options.repoPath,
          options.branches,
          options.list || options.branches.length === 0,
          ctx,
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "list or delete local branches whose work is on a base or whose PR merged",
  ),
);

const sweepPruneEndedCommand = Command.make("prune-ended", {}, () =>
  execute((config) => pruneEnded(config)),
).pipe(Command.withDescription("delete ended-delegate records whose worktree folder is gone"));

const sweepCommand = Command.make("sweep").pipe(
  Command.withDescription(
    "find finished worktrees, branches and records, and remove the safe ones",
  ),
  Command.withSubcommands([
    sweepReportCommand,
    sweepRemoveCommand,
    sweepPruneBranchesCommand,
    sweepPruneEndedCommand,
  ]),
);

const program = Command.make("coordinate")
  .pipe(
    Command.withDescription(
      "Coordinate one domain's delegates in Herdr. Exit 0 done, 1 refused (act on the message), 2 could not check.",
    ),
  )
  .pipe(
    Command.withSubcommands([
      startCommand,
      delegateCommand,
      spawnCommand,
      sendCommand,
      notifyCommand,
      endCommand,
      resumeCommand,
      verifyCommand,
      fetchCommand,
      statusCommand,
      backlogCommand,
      harnessPolicyCommand,
      itemCommand,
      findingCommand,
      wikiCommand,
      watchCommand,
      queueCommand,
      sweepCommand,
    ]),
  );

const cliLayer = (args: readonly string[]) =>
  Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({ args: Effect.succeed([...args]) }),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(process.stdout.columns ?? 80),
        rows: Effect.succeed(process.stdout.rows ?? 24),
        size: Effect.die("terminal size is unavailable"),
        readInput: Effect.die("terminal input is unavailable"),
        readLine: Effect.die("terminal input is unavailable"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("CLI child processes are unavailable")),
    ),
    CliConfig.layer({ builtIns: [GlobalFlag.Help] }),
  );

const cliExit = await Effect.runPromiseExit(
  Command.run(program, { version: "0.0.0" }).pipe(
    Effect.provide(cliLayer(normalizeArgs(process.argv.slice(2)))),
  ),
);
if (Exit.isFailure(cliExit)) {
  const failure = reportedFailure(cliExit.cause);
  if (failure instanceof CliError.ShowHelp) {
    process.exitCode = failure.errors.length > 0 ? 1 : 0;
  } else {
    console.error(
      `could not check: ${failure instanceof Error ? `${failure.constructor.name}: ${failure.message}` : Cause.pretty(cliExit.cause)}`,
    );
    process.exitCode = 2;
  }
}
