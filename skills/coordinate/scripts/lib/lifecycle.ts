import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { loadavg, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Option } from "effect";
import {
  BacklogError,
  checkFileable,
  createDocument,
  itemUpdate,
  normalizeBoundary,
  readDocument,
  recordDelegate,
  refSessions,
  seedDocument,
} from "./backlog-doc.ts";
import { filedUnder, idleDelegated, updateItem, type ItemUpdate } from "./backlog-store/ops.ts";
import type { ItemStatus } from "./backlog-store/schema.ts";
import { documentPath } from "./backlog-store/paths.ts";
import { absolutePath, type Config } from "./config.ts";
import {
  backlogPath,
  checkDomainName,
  coordinators,
  domainNamePart,
  L,
  callerRole,
  members,
  ownCoordinator,
  readEnded,
  Refused,
  removeEnded,
  writeEnded,
  type EndedRecord,
} from "./fleet.ts";
import {
  currentBranch,
  excludeScratch,
  gitOk,
  gitTry,
  mainCheckout,
  real,
  refExists,
} from "./git.ts";
import {
  agentArgv,
  CLAUDE_EFFORTS,
  type DelegateFirstMessage,
  firstMessage,
  type Harness,
  harnessOf,
  inLoginShell,
  PI_THINKING,
} from "./harness.ts";
import * as hc from "./herdr.ts";
import { defaultStop, scanProcesses, type StopOptions, teardownEnded } from "./processes.ts";
import { countResume, readSession } from "./sessions.ts";
import { armWatcher, WATCHER_DOMAIN_LABEL, watcherInfoLine } from "./watch-terminal.ts";
import { writeDelegateWiki } from "./wiki.ts";
import {
  capacityItemEligible,
  enqueueCapacityWait,
  readCapacityQueue,
  removeCapacityWait,
  withCapacityClaim,
} from "./capacity-queue.ts";
import { liveDelegateCount, machineDelegateBudget, machineOfAddress } from "./delegate-capacity.ts";
import {
  harnessPolicyStatus,
  requireRecordedHarnessEnabled,
  resolveHarnessForLaunch,
} from "./harness-policy.ts";

const loginShell = (): string => {
  try {
    return userInfo().shell ?? process.env.SHELL ?? "/bin/sh";
  } catch {
    return process.env.SHELL ?? "/bin/sh";
  }
};

/**
 * Label this terminal as the domain's coordinator and make sure its backlog exists.
 * @param config Config.
 * @param domain Domain.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Lines to print.
 */
export const start = Effect.fn("start")(function* (
  config: Config,
  domain: string,
  env: Record<string, string | undefined> = process.env,
) {
  yield* checkDomainName(domain);
  const address = env.HC_TERMINAL_ID;
  if (!address)
    return yield* new Refused({
      message: "HC_TERMINAL_ID is unset: run this inside a Herdr terminal",
    });
  const lines: string[] = [];
  const others = (yield* coordinators(domain)).filter((terminal) => terminal.address !== address);
  if (others.length > 0)
    lines.push(
      `warning: ${others.map((terminal) => terminal.address).join(", ")} also coordinates ${domain}; end or unlabel it (hc label <t> fleet.role= fleet.domain=)`,
    );
  yield* hc.label(address, { [L.role]: "coordinator", [L.domain]: domain });
  lines.push(`labelled ${address}: fleet.role=coordinator fleet.domain=${domain}`);
  const made = yield* createDocument(config, domain);
  if (!made.created) lines.push(`backlog ${made.path}`);
  else {
    lines.push(`created backlog ${made.path}`);
    if (made.legacy)
      lines.push(`recorded legacy Markdown backlog ${made.legacy} (reference only, not read)`);
  }
  lines.push(watcherInfoLine(yield* armWatcher(config, domain, address)));
  lines.push(...(yield* harnessPolicyStatus(config, domain)));
  return lines;
});

/**
 * Options for `coordinate delegate`.
 */
export type DelegateOptions = {
  name: string;
  task: string;
  repo: string | undefined;
  cwd: string | undefined;
  base: string | undefined;
  harness: Harness | undefined;
  model: string | undefined;
  effort: string | undefined;
  message: DelegateFirstMessage;
  space: boolean;
  domain: string | undefined;
  /**
   * Item to file the delegate under: required from a coordinator, refused from a delegate.
   */
  item: string | undefined;
  overBudget: boolean;
  queueIfFull: boolean;
  retryQueued: boolean;
};

/**
 * Wait until the agent reports a status, or its terminal ends.
 * @param address Terminal.
 * @param seconds Budget.
 * @returns True when the agent showed.
 */
const agentShowed = Effect.fn("agentShowed")(function* (address: string, seconds: number) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    const terminal = yield* hc.get(address).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (terminal === undefined || !terminal.live) return false;
    if (terminal.status !== undefined) return true;
    yield* Effect.sleep("1 second");
  }
  return false;
});

/**
 * Start a terminal in a new unfocused space of its own: the space's placeholder shell is closed
 * and its tab renamed. Assumes no worktree, delegate labels or parent; the caller supplies them.
 * @param spec What to run and where. `parent` undefined starts it with no parent link;
 *   `recordSpace` adds `fleet.space` so `coordinate end` closes the space with the terminal.
 * @returns Address and the new space id.
 */
export const launchInOwnSpace = Effect.fn("launchInOwnSpace")(function* (spec: {
  name: string;
  cwd: string;
  tabLabel: string;
  spaceName: string;
  labels: Record<string, string>;
  parent: string | undefined;
  argv: string[];
  recordSpace: boolean;
}) {
  const made = yield* hc.newSpace(spec.spaceName, spec.cwd);
  const address = yield* hc
    .run({
      name: spec.name,
      cwd: spec.cwd,
      labels: {
        "herdr.space": made.space,
        "herdr.tab": made.tab,
        ...(spec.recordSpace ? { [L.space]: made.space } : {}),
        ...spec.labels,
      },
      parent: spec.parent,
      outliveParent: true,
      notifyParent: false,
      argv: inLoginShell(loginShell(), spec.argv),
    })
    .pipe(Effect.tapError(() => hc.closeSpace(made.space).pipe(Effect.ignore)));
  // The space came with a placeholder shell; close its pane so the agent has the tab to itself.
  const spaces = yield* hc.appSpaces().pipe(Effect.catch(() => Effect.succeed([])));
  const pane = spaces
    .find((space) => space.id === made.space)
    ?.tabs.flatMap((tab) => tab.terminals)
    .find((terminal) => terminal.terminal === made.terminal)?.pane;
  if (pane) yield* hc.appDo("pane.close", { pane }).pipe(Effect.ignore);
  yield* hc.end(made.terminal).pipe(Effect.ignore);
  yield* hc.appDo("tab.rename", { id: made.tab, name: spec.tabLabel }).pipe(Effect.ignore);
  return { address, space: made.space };
});

/**
 * Options for `coordinate spawn`.
 */
export type SpawnOptions = {
  domain: string;
  /**
   * Folder the new coordinator starts in.
   */
  cwd: string | undefined;
  harness: Harness | undefined;
  model: string | undefined;
  /**
   * pi `--thinking` level or Claude `--effort`.
   */
  effort: string | undefined;
  /**
   * Titles added to the domain's backlog as open items before launch.
   */
  items: readonly string[];
  /**
   * The time as an ISO string, for the seeded items.
   */
  now: string;
};

/**
 * Refuse an effort the harness does not have: a pi `--thinking` level or a Claude `--effort`.
 * @param harness Harness.
 * @param effort Effort, when given.
 */
const checkEffort = Effect.fn("checkEffort")(function* (
  harness: Harness,
  effort: string | undefined,
) {
  const efforts = harness === "pi" ? PI_THINKING : CLAUDE_EFFORTS;
  if (effort !== undefined && !efforts.has(effort))
    return yield* new Refused({
      message: `${effort} is not a ${harness} ${harness === "pi" ? "thinking level" : "effort"}: ${[...efforts].join(", ")}`,
    });
});

/**
 * A spawned coordinator's terminal name, `<domain>-coordinator`, with the domain fitted the way a
 * watcher's name fits it, so every valid domain has one.
 * @param domain Domain.
 * @returns Terminal name.
 */
const coordinatorName = (domain: string): string => `${domainNamePart(domain, 20, 11)}-coordinator`;

/**
 * The tab title a coordinator starts with, per the manager's tab-title convention.
 * @param domain Domain.
 * @returns `<Domain> · No active focus`.
 */
const idleTabTitle = (domain: string): string =>
  `${domain.charAt(0).toUpperCase()}${domain.slice(1)} · No active focus`;

/**
 * Decide the folder a spawned coordinator starts in, before anything is written or launched:
 * `--cwd`, or else the first owned Boundary path of the domain's existing backlog.
 * @param config Config.
 * @param options Spawn options.
 * @returns An existing folder, spelled as the owned Boundary stores it.
 */
const spawnFolder = Effect.fn("spawnFolder")(function* (config: Config, options: SpawnOptions) {
  const { domain } = options;
  const passCwd = `pass --cwd <dir>: the folder the ${domain} coordinator starts in`;
  const owned =
    options.cwd === undefined
      ? yield* Effect.gen(function* () {
          if (!existsSync(documentPath(config.stateDir, domain)))
            return yield* new Refused({ message: `${domain} has no backlog yet; ${passCwd}` });
          const { backlog } = yield* readDocument(config, domain);
          return (
            backlog.boundary.owned[0] ??
            (yield* new Refused({
              message: `the ${domain} backlog has no owned Boundary path; ${passCwd}`,
            }))
          );
        })
      : undefined;
  // The spelling `backlog boundary add` stores (a symlink kept), so a path is not listed twice
  // and the coordinator starts in the folder its Boundary names.
  const folder = owned ?? normalizeBoundary(options.cwd ?? "");
  if (!existsSync(folder)) return yield* new Refused({ message: `${folder} does not exist` });
  return folder;
});

type SeedItem = { id: string; title: string };

/**
 * What spawn seeded before the launch: the backlog, the owned folder when it added one, the items
 * it added, and the `--item` titles an item not yet closed already had.
 */
type SpawnSeed = {
  path: string;
  created: boolean;
  owned: string | null;
  items: readonly SeedItem[];
  present: readonly SeedItem[];
};

/**
 * Turn a seeded backlog into the lines spawn prints before the launch.
 * @param seeded What spawn seeded.
 * @returns Lines to print.
 */
const seedLines = (seeded: SpawnSeed): string[] => [
  seeded.created ? `created backlog ${seeded.path}` : `backlog ${seeded.path}`,
  ...(seeded.owned === null ? [] : [`owned: added ${seeded.owned}`]),
  ...seeded.items.map((item) => `added ${item.id}: ${item.title}`),
  ...seeded.present.map((item) => `already present ${item.id}: ${item.title}`),
];

/**
 * Whether the new coordinator became ready: `ready` once a live watcher terminal it started is
 * found, otherwise its last observed state. `watcher` is on every outcome, null when not ready.
 */
type SpawnReadiness =
  | { status: "ready"; watcher: string }
  /**
   * `agentStatus`: the agent status Herdr last reported for the new terminal.
   */
  | { status: "working"; watcher: null; agentStatus: string | null }
  /**
   * `tab`: where the blocking dialog is.
   */
  | { status: "blocked"; watcher: null; tab: string }
  | { status: "gone"; watcher: null };

/**
 * What `coordinate spawn` started and whether it became ready.
 */
type SpawnResult = {
  name: string;
  domain: string;
  terminal: string;
  space: string;
  harness: Harness;
  session: string;
  backlog: SpawnSeed;
  /**
   * The readiness bound spawn waited within.
   */
  timeoutMs: number;
} & SpawnReadiness;

/**
 * How long and how often spawn polls for the new coordinator's watcher.
 */
type SpawnWait = {
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Effect.Effect<void>;
};

const SPAWN_WAIT: SpawnWait = {
  timeoutMs: 120_000,
  intervalMs: 2_000,
  sleep: (ms) => Effect.sleep(ms),
};

/**
 * Describe why a spawned coordinator is not ready.
 * @param result A result whose status is not `ready`.
 * @returns One line.
 */
const notReadyLine = (result: SpawnResult & { status: "working" | "blocked" | "gone" }): string => {
  const who = `${result.name} (${result.terminal})`;
  if (result.status === "gone")
    return `not ready: ${who} is gone, it ended before arming its watcher`;
  const after = `not ready after ${Math.round(result.timeoutMs / 1000)}s: ${who}`;
  if (result.status === "blocked")
    return `${after} is blocked on a dialog, which is the user's to answer in "${result.tab}" (hc read ${result.terminal}); left running`;
  return `${after} is still ${result.agentStatus ?? "starting"} with no watcher armed; left running`;
};

/**
 * Turn a spawn result into the lines spawn prints: what it seeded, the started line, then ready or
 * the last state.
 * @param result What started.
 * @returns Lines to print.
 */
export const spawnOutput = (result: SpawnResult): string[] => [
  ...seedLines(result.backlog),
  `started coordinator ${result.name} for ${result.domain} (${result.terminal}) in its own space ${result.space}, ${result.harness} session ${result.session}`,
  result.status === "ready"
    ? `ready: ${result.name} (${result.terminal}) armed watcher ${result.watcher}`
    : notReadyLine(result),
];

/**
 * Poll until a live watcher terminal for the domain is found whose parent is the new coordinator:
 * its own `coordinate start` arms it as its child, so a leftover watcher of another owner does not
 * count. Stops early when the new terminal is gone; never ends it.
 * @param domain Domain.
 * @param address The new coordinator's terminal.
 * @param wait Bound, interval and sleep.
 * @returns The readiness fields of the result.
 */
const awaitWatcher = Effect.fn("awaitWatcher")(function* (
  domain: string,
  address: string,
  wait: SpawnWait,
) {
  const attempts = Math.max(1, Math.ceil(wait.timeoutMs / wait.intervalMs));
  let last: SpawnReadiness = { status: "working", watcher: null, agentStatus: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) yield* wait.sleep(wait.intervalMs);
    const watchers = yield* hc
      .list([`${WATCHER_DOMAIN_LABEL}=${domain}`])
      .pipe(Effect.catch(() => Effect.succeed([])));
    const watcher = watchers.find((candidate) => candidate.live && candidate.parent === address);
    if (watcher) return { status: "ready", watcher: watcher.address } satisfies SpawnReadiness;
    // A transient hc failure keeps the last observation; only a missing or ended terminal is gone.
    const terminal = yield* hc.get(address).pipe(
      Effect.map((got) => ({ got })),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (terminal === undefined) continue;
    if (terminal.got === undefined || !terminal.got.live)
      return { status: "gone", watcher: null } satisfies SpawnReadiness;
    if (terminal.got.status !== "blocked") {
      last = { status: "working", watcher: null, agentStatus: terminal.got.status ?? null };
      continue;
    }
    // `hc ls` carries the terminal's space and tab; the title spawn set is the fallback.
    const listed = yield* hc.list().pipe(Effect.catch(() => Effect.succeed([])));
    const where = listed.find((candidate) => candidate.address === address)?.where;
    last = { status: "blocked", watcher: null, tab: where || idleTabTitle(domain) };
  }
  return last;
});

/**
 * Start a new coordinator for a domain in its own unfocused Herdr space, from a coordinator.
 * Every refusal comes before anything is written or launched; then the domain's backlog is seeded
 * with the folder and `--item` titles, and the coordinator launched. The new terminal has no parent, so
 * it outlives the caller, and is labelled as the domain's coordinator at launch, so a second spawn
 * for the domain is refused even before the first has started. After launch it waits, bounded, for
 * the new coordinator to arm the domain's watcher, and leaves the terminal running either way.
 * @param config Config.
 * @param options Spawn options.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @param wait Readiness bound, poll interval and sleep, injectable for tests.
 * @returns What started and whether it became ready.
 */
export const spawn = Effect.fn("spawn")(function* (
  config: Config,
  options: SpawnOptions,
  env: Record<string, string | undefined> = process.env,
  wait: SpawnWait = SPAWN_WAIT,
) {
  const { domain } = options;
  yield* checkDomainName(domain);
  if (!env.HC_TERMINAL_ID)
    return yield* new Refused({
      message:
        "spawn runs from a coordinator terminal, and HC_TERMINAL_ID is unset: this is not a Herdr terminal",
    });
  const caller = yield* callerRole(env);
  if (caller.kind !== "coordinator")
    return yield* new Refused({
      message: `spawn runs from a coordinator terminal, and ${caller.address} is not labelled as one (fleet.role=coordinator)`,
    });
  const harness = yield* resolveHarnessForLaunch(config, domain, options.harness, false);
  yield* checkEffort(harness, options.effort);
  const name = coordinatorName(domain);
  const cwd = yield* spawnFolder(config, options);
  const running = (yield* coordinators(domain)).find((terminal) => terminal.live);
  if (running)
    return yield* new Refused({
      message: `${domain} already has a live coordinator: ${running.name ?? running.address} (${running.address}); go to it instead of spawning another`,
    });
  const taken = (yield* hc.list()).find((terminal) => terminal.live && terminal.name === name);
  if (taken)
    return yield* new Refused({
      message: `a live terminal is already named ${name} (${taken.address})`,
    });

  const seeded = yield* seedDocument(config, domain, {
    owned: cwd,
    titles: options.items,
    now: options.now,
  });
  const session = crypto.randomUUID();
  const launched = yield* launchInOwnSpace({
    name,
    cwd,
    tabLabel: idleTabTitle(domain),
    spaceName: domain,
    labels: {
      [L.role]: "coordinator",
      [L.domain]: domain,
      [L.session]: session,
      [L.harness]: harness,
    },
    parent: undefined,
    argv: agentArgv({
      harness,
      name,
      session,
      model: options.model,
      effort: options.effort,
      extraArgs: [],
      message: firstMessage(harness, { kind: "skill", skill: "coordinate", args: domain }),
      resume: false,
    }),
    recordSpace: false,
  });
  const ready = yield* awaitWatcher(domain, launched.address, wait);
  const result: SpawnResult = {
    name,
    domain,
    terminal: launched.address,
    space: launched.space,
    harness,
    session,
    backlog: {
      path: seeded.path,
      created: seeded.created,
      owned: seeded.added ? cwd : null,
      items: seeded.items.map((item) => ({ id: item.id, title: item.title })),
      present: seeded.present.map((item) => ({ id: item.id, title: item.title })),
    },
    ...ready,
    timeoutMs: wait.timeoutMs,
  };
  return result;
});

/**
 * Launch a delegate terminal, in its own space or as a tab in the coordinator's space.
 * @param spec What to run and where.
 * @returns Address, tab label, and the space id when one was made.
 */
const launch = Effect.fn("launch")(function* (spec: {
  name: string;
  cwd: string;
  tabLabel: string;
  spaceName: string;
  labels: Record<string, string>;
  parent: string | undefined;
  argv: string[];
  ownSpace: boolean;
  coordinatorSpace: string | undefined;
}) {
  if (spec.ownSpace)
    return yield* launchInOwnSpace({
      name: spec.name,
      cwd: spec.cwd,
      tabLabel: spec.tabLabel,
      spaceName: spec.spaceName,
      labels: spec.labels,
      parent: spec.parent,
      argv: spec.argv,
      recordSpace: true,
    });
  const labels = spec.coordinatorSpace
    ? { "herdr.space": spec.coordinatorSpace, ...spec.labels }
    : spec.labels;
  const address = yield* hc.run({
    name: spec.name,
    cwd: spec.cwd,
    labels,
    parent: spec.parent,
    outliveParent: true,
    notifyParent: false,
    argv: inLoginShell(loginShell(), spec.argv),
  });
  const tab = (yield* hc.get(address).pipe(Effect.catch(() => Effect.succeed(undefined))))?.labels[
    "herdr.tab"
  ];
  if (tab) yield* hc.appDo("tab.rename", { id: tab, name: spec.tabLabel }).pipe(Effect.ignore);
  return { address, space: undefined };
});

/**
 * Create the worktree, copy the brief, and start a delegate.
 * @param config Config.
 * @param options Delegate options.
 * @param readLoadAverage Read the 1-minute load average, injectable for tests.
 * @returns Lines to print.
 */
export const delegate = Effect.fn("delegate")(function* (
  config: Config,
  options: DelegateOptions,
  readLoadAverage: () => number = () => loadavg()[0] ?? 0,
) {
  if (!hc.TERMINAL_NAME.test(options.name))
    return yield* new Refused({
      message: `${options.name} is not a terminal name: 1 to 32 of a-z, 0-9, - and _`,
    });
  if ((options.repo === undefined) === (options.cwd === undefined))
    return yield* new Refused({
      message: "pass exactly one of --repo (new worktree) or --cwd (a folder with no repo work)",
    });
  if (options.harness !== undefined) yield* checkEffort(options.harness, options.effort);
  // Fails closed: a caller whose role cannot be checked is neither filed nor exempt.
  const caller = yield* callerRole();
  const coordinator = caller.kind === "coordinator" ? caller : undefined;
  if (coordinator !== undefined && options.item === undefined)
    return yield* new Refused({
      message:
        "a coordinator files every delegate under an item: pass --item <id> (coordinate item add prints one)",
    });
  if (coordinator === undefined && options.item !== undefined)
    return yield* new Refused({
      message: "--item is for the coordinator; a delegate starting a child review passes no --item",
    });
  const domain =
    options.domain ??
    coordinator?.domain ??
    (yield* new Refused({ message: "no coordinator label on this terminal; pass --domain" }));
  yield* checkDomainName(domain);
  if (options.item !== undefined) yield* checkFileable(config, domain, options.item);
  if (options.retryQueued && coordinator === undefined)
    return yield* new Refused({ message: "--retry-queued is for the coordinator" });
  if (options.queueIfFull && coordinator === undefined)
    return yield* new Refused({ message: "--queue-if-full is for the coordinator" });
  if ((options.retryQueued || options.queueIfFull) && options.overBudget)
    return yield* new Refused({
      message: "--over-budget cannot be combined with a capacity queue",
    });
  if (options.retryQueued && options.item === undefined)
    return yield* new Refused({ message: "--retry-queued needs --item <id>" });
  if (options.retryQueued && options.harness === undefined)
    return yield* new Refused({
      message: `--retry-queued requires the original authorized harness explicitly: pass --harness pi|claude when retrying ${domain}'s queued item`,
    });

  const targetMachine = machineOfAddress(caller.address);
  const perform = Effect.gen(function* () {
    const queue = options.retryQueued ? yield* readCapacityQueue(config, domain) : undefined;
    const queued = queue?.entries.find((entry) => entry.item === options.item);
    if (options.retryQueued && queued === undefined)
      return yield* new Refused({
        message: `item ${options.item} is not in the capacity queue for ${domain}; ignore this stale wake`,
      });
    if (queued && queued.machine !== targetMachine)
      return yield* new Refused({
        message: `item ${queued.item} is queued for machine ${queued.machine}, not ${targetMachine}; retry it from its target machine`,
      });
    if (queued && queue) {
      const { backlog } = yield* readDocument(config, domain);
      const item = backlog.items.find((candidate) => candidate.id === queued.item);
      if (item && !capacityItemEligible(item.status))
        return yield* new Refused({
          message: `queued item ${item.id} is ${item.status}; resolve or resume it before retrying`,
        });
      const eligibleItems = new Set(
        backlog.items
          .filter((candidate) => capacityItemEligible(candidate.status))
          .map((candidate) => candidate.id),
      );
      const oldest = queue.entries
        .filter((entry) => entry.machine === targetMachine && eligibleItems.has(entry.item))
        .toSorted((left, right) => left.order - right.order)[0];
      if (oldest?.item !== queued.item)
        return yield* new Refused({
          message: `item ${queued.item} is queued but is not the oldest eligible launch for machine ${targetMachine}; retry ${oldest?.item ?? "the queue's oldest item"} first`,
        });
    }

    const terminals = yield* hc.list([], queued !== undefined);
    if (queued) {
      const marker = `${domain}:${queued.item}:${queued.order}`;
      for (const listed of terminals) {
        if (machineOfAddress(listed.address) !== targetMachine) continue;
        const terminal = yield* hc.get(listed.address);
        if (terminal?.labels[L.queue] !== marker) continue;
        yield* removeCapacityWait(config, domain, queued.item);
        return [
          `already started queued delegate ${terminal.name ?? terminal.address} (${terminal.address}) for ${queued.item} order ${queued.order}; no duplicate launch; verify it is filed under the item`,
        ];
      }
    }
    const harness = yield* resolveHarnessForLaunch(
      config,
      domain,
      options.harness,
      options.retryQueued,
    );
    yield* checkEffort(harness, options.effort);

    const taken = terminals.find((terminal) => terminal.live && terminal.name === options.name);
    if (taken)
      return yield* new Refused({
        message: `a live terminal is already named ${options.name} (${taken.address})`,
      });

    const liveDelegates = yield* liveDelegateCount(targetMachine, terminals);
    const { budget, warning: budgetWarning } = yield* machineDelegateBudget(
      config,
      targetMachine,
      coordinator?.address.includes("/") === false,
      coordinator !== undefined && !options.overBudget,
    );

    const load = readLoadAverage();
    const lines: string[] = [];
    if (load > config.cores)
      lines.push(
        `warning: 1-minute load average ${load} exceeds ${config.cores} cores; native gates may be slow`,
      );
    if (budgetWarning && liveDelegates < budget) lines.push(budgetWarning);
    if (coordinator !== undefined && liveDelegates >= budget && !options.overBudget) {
      if (options.queueIfFull || options.retryQueued) {
        if (!queued) {
          const { backlog } = yield* readDocument(config, domain);
          const item = backlog.items.find((candidate) => candidate.id === options.item);
          if (item && !capacityItemEligible(item.status))
            return yield* new Refused({
              message: `item ${item.id} is ${item.status}; resolve or resume it before queueing a delegate`,
            });
        }
        const entry =
          queued ??
          (yield* enqueueCapacityWait(config, domain, {
            item: options.item ?? "",
            machine: targetMachine,
          }));
        lines.push(
          `queued delegate for item ${entry.item} on machine ${entry.machine} (order ${entry.order}); no launch was started; the domain watcher will wake this coordinator when capacity is available`,
        );
        if (budgetWarning) lines.push(budgetWarning);
        return lines;
      }
      return yield* new Refused({
        message: `machine ${targetMachine} has ${liveDelegates} live delegates (budget ${budget}); refusing ${options.name} for item ${options.item ?? "?"}; pass --over-budget to start anyway${budgetWarning ? `; ${budgetWarning}` : ""}`,
      });
    }
    let cwd: string;
    let branch: string | undefined;
    let baseSha: string | undefined;
    let checkout: string | undefined;
    if (options.repo !== undefined) {
      const repo = yield* mainCheckout(absolutePath(options.repo));
      if (!repo) return yield* new Refused({ message: `${options.repo} is not a Git checkout` });
      checkout = repo;
      branch = `${config.branchPrefix}${options.name}`;
      cwd = join(repo, ".claude", "worktrees", options.name);
      if (existsSync(cwd)) return yield* new Refused({ message: `${cwd} already exists` });
      if (yield* refExists(repo, `refs/heads/${branch}`))
        return yield* new Refused({ message: `branch ${branch} already exists in ${repo}` });
      const base = options.base ?? (yield* currentBranch(repo)) ?? "HEAD";
      baseSha = yield* gitTry(repo, ["rev-parse", "--verify", `${base}^{commit}`]);
      if (!baseSha) return yield* new Refused({ message: `${base} is not a commit in ${repo}` });
      yield* gitOk(repo, ["worktree", "add", cwd, "-b", branch, baseSha]);
      lines.push(`worktree ${cwd} on ${branch} from ${base}`);
      // After the name and collision checks, so a refused start changes nothing in the repo.
      if (yield* excludeScratch(cwd)) lines.push("added .scratch/ to the repo's info/exclude");
    } else {
      cwd = real(absolutePath(options.cwd ?? "."));
      if (!existsSync(cwd)) return yield* new Refused({ message: `${cwd} does not exist` });
    }

    // A --repo worktree is the delegate's own; a --cwd folder may host several, so each gets a subfolder.
    const scratch =
      options.repo !== undefined ? join(cwd, ".scratch") : join(cwd, ".scratch", options.name);
    let brief: string | undefined;
    let message = options.message;
    const briefSource = message.kind === "brief" ? message.path : message.brief;
    if (briefSource !== undefined) {
      const source = absolutePath(briefSource);
      if (!existsSync(source)) return yield* new Refused({ message: `no brief at ${source}` });
      brief = join(scratch, "BRIEF.md");
      const destination = brief;
      if (real(source) !== real(destination)) {
        const preserved = yield* Effect.promise(async () => {
          await mkdir(dirname(destination), { recursive: true });
          if (existsSync(destination)) {
            const [incoming, existing] = await Promise.all([
              readFile(source),
              readFile(destination),
            ]);
            if (incoming.equals(existing)) return undefined;
            const backup = join(
              dirname(destination),
              `BRIEF.${Date.now()}.${crypto.randomUUID()}.md`,
            );
            await rename(destination, backup);
            try {
              await copyFile(source, destination);
            } catch (error) {
              await rename(backup, destination);
              throw error;
            }
            return backup;
          }
          await copyFile(source, destination);
          return undefined;
        });
        if (preserved) lines.push(`preserved existing brief at ${preserved}`);
      }
      message = message.kind === "brief" ? { kind: "brief", path: brief } : { ...message, brief };
    }
    const wiki = yield* writeDelegateWiki(config, domain, {
      name: options.name,
      scratch,
      place: checkout !== undefined ? { repo: checkout } : { cwd },
    });
    if (wiki !== undefined) message = { ...message, wiki };
    const report = brief ? join(scratch, "REPORT.md") : undefined;
    const session = crypto.randomUUID();
    const tabLabel = options.task;
    const labels: Record<string, string> = {
      [L.domain]: domain,
      [L.task]: options.task,
      [L.session]: session,
      [L.harness]: harness,
      [L.worktree]: cwd,
      ...(queued ? { [L.queue]: `${domain}:${queued.item}:${queued.order}` } : {}),
      ...(options.model ? { [L.model]: options.model } : {}),
      ...(options.effort ? { [L.effort]: options.effort } : {}),
      ...(branch ? { [L.branch]: branch } : {}),
      ...(baseSha ? { [L.base]: baseSha } : {}),
    };
    const argv = agentArgv({
      harness,
      name: options.name,
      session,
      model: options.model,
      effort: options.effort,
      extraArgs: harness === "pi" ? config.delegatePiArgs : config.delegateClaudeArgs,
      message: firstMessage(harness, message),
      resume: false,
    });
    const coordinatorTerminal = coordinator?.terminal;
    const launched = yield* launch({
      name: options.name,
      cwd,
      tabLabel,
      spaceName: `${domain} [${options.task}]`,
      labels,
      parent: coordinatorTerminal?.address ?? process.env.HC_TERMINAL_ID,
      argv,
      ownSpace: options.space,
      coordinatorSpace: coordinatorTerminal?.labels["herdr.space"],
    });
    if (coordinator !== undefined && options.item !== undefined)
      yield* removeCapacityWait(config, domain, options.item);
    const unfiled = (why: string): string =>
      `started ${options.name} (${launched.address}, session ${session}) but could not file it under ${options.item}: ${why}`;
    // Filed before the status wait, so a slow start is still on the item.
    const filed =
      options.item === undefined
        ? undefined
        : yield* recordDelegate(config, domain, {
            id: options.item,
            ref: {
              name: options.name,
              session,
              branch: branch ?? null,
              worktree: cwd,
              brief: brief ?? "",
              report: report ?? "",
            },
          }).pipe(
            Effect.catchTags({
              Refused: (error) =>
                Effect.fail(new Refused({ message: `${unfiled(error.message)}` })),
              BacklogError: (error) =>
                Effect.fail(
                  new BacklogError({ path: error.path, message: unfiled(error.message) }),
                ),
            }),
          );
    const showed = yield* agentShowed(launched.address, 60);
    if (!showed) {
      const text = yield* hc
        .read(launched.address, 40)
        .pipe(Effect.catch(() => Effect.succeed("")));
      lines.push(
        `warning: no agent status in ${launched.address} within 60s; it shows:\n${text.trim().slice(-1500)}`,
      );
    }
    lines.push(
      `started ${options.name} (${launched.address})${launched.space ? ` in its own space ${launched.space}` : ""}`,
      filed
        ? `filed ${options.name} under ${filed.id} [${filed.status}]`
        : `session ${session}${report ? ` report ${report}` : ""}`,
    );
    return lines;
  });
  return options.retryQueued && options.item !== undefined
    ? yield* withCapacityClaim(config, domain, options.item, perform)
    : yield* perform;
});

/**
 * Send a message to a delegate. Refuses a terminal blocked on a dialog; hc itself waits for a draft.
 * @param target Name or address.
 * @param text Message.
 * @returns Lines to print.
 */
export const sendTo = Effect.fn("sendTo")(function* (target: string, text: string) {
  const terminal = yield* hc.get(target);
  if (!terminal || !terminal.live)
    return yield* new Refused({ message: `no live terminal ${target}` });
  if (terminal.status === "blocked")
    return yield* new Refused({
      message: `${target} is blocked on a dialog, which is the user's to answer in "${terminal.labels.where ?? target}"; read it with hc read ${terminal.address}`,
    });
  yield* hc.send(terminal.address, text);
  return [
    `sent to ${terminal.name ?? terminal.address} (${terminal.address}, ${terminal.status ?? "no status"})`,
  ];
});

/**
 * Wake the caller's coordinator with one line, through `sendTo` (refused while it is blocked on a
 * dialog; hc waits for the user's draft). Run from a delegate terminal: the coordinator it was started
 * under when that one lives, else any live coordinator of its domain. With none, nothing is sent and
 * it still succeeds, since the delegate's turn ends either way.
 * @param text One line.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Lines to print.
 */
export const notifyCoordinator = Effect.fn("notifyCoordinator")(function* (
  text: string,
  env: Record<string, string | undefined> = process.env,
) {
  const caller = yield* callerRole(env);
  if (caller.kind === "coordinator")
    return yield* new Refused({
      message: `terminal ${caller.address} is the coordinator; notify is for delegates, use coordinate send`,
    });
  const domain = caller.terminal?.labels[L.domain];
  if (!domain)
    return yield* new Refused({
      message: `terminal ${caller.address} carries no ${L.domain} label, so it has no coordinator to notify`,
    });
  const live = (yield* coordinators(domain)).filter(
    (terminal) => terminal.live && terminal.address !== caller.address,
  );
  const target = live.find((terminal) => terminal.address === caller.terminal?.parent) ?? live[0];
  if (!target) return [`no live coordinator for ${domain}; nothing sent: ${text}`];
  return yield* sendTo(target.address, text);
});

/**
 * The statuses `end --item-status` sets: where an item rests when its last delegate is gone.
 * Closing is `item close`, and `delegated` needs a delegate.
 */
export const NEXT_STATUSES = ["waiting-user", "building", "in-review", "open", "parked"] as const;

const statusUpdate = (id: string, status: ItemStatus, now: string): ItemUpdate => ({
  id,
  status,
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
  answer: undefined,
  now,
});

/**
 * End a settled delegate: record what resuming needs, end its terminal, close its space. When it
 * was the last live delegate filed under a delegated item, set the item's next status, or say that
 * it still needs one.
 * @param config Config.
 * @param target Name or address.
 * @param now End even while working.
 * @param itemStatus Next status for the item left with no live delegate.
 * @param stop How the delegate's left-over processes are stopped.
 * @returns Lines to print.
 */
export const endDelegate = Effect.fn("endDelegate")(function* (
  config: Config,
  target: string,
  now: boolean,
  itemStatus: ItemStatus | undefined = undefined,
  stop: StopOptions = defaultStop(),
) {
  if (itemStatus !== undefined && !NEXT_STATUSES.some((known) => known === itemStatus))
    return yield* new Refused({
      message: `--item-status ${itemStatus} is not one of ${NEXT_STATUSES.join(", ")}; close an item with coordinate item close`,
    });
  const terminal = yield* hc.get(target);
  if (!terminal) return yield* new Refused({ message: `no terminal ${target}` });
  if (terminal.labels[L.role] === "coordinator")
    return yield* new Refused({ message: `${target} is a coordinator` });
  if (terminal.status === "working" && !now)
    return yield* new Refused({
      message: `${target} is working; wait for it to settle, or pass --now`,
    });
  const session = terminal.labels[L.session] ?? "";
  const domain = terminal.labels[L.domain];
  if (!session || !domain)
    return yield* new Refused({
      message: `${target} carries no ${L.session}/${L.domain} label, so it could not be resumed; end it with hc kill if the user agrees`,
    });
  // Before anything ends: find the item left with no live delegate, and refuse a status it cannot take.
  const read = yield* readDocument(config, domain).pipe(Effect.option);
  const filed = Option.isSome(read) ? filedUnder(read.value.backlog, session) : undefined;
  let orphan: string | undefined;
  if (Option.isSome(read) && filed?.status === "delegated") {
    const others = (yield* members(domain, yield* refSessions(config, domain))).filter(
      (member) => member.session !== session,
    );
    const idle = idleDelegated(read.value.backlog, new Set(others.map((member) => member.session)));
    orphan = idle.find((item) => item.id === filed.id)?.id;
    if (orphan !== undefined && itemStatus !== undefined) {
      const dry = updateItem(
        read.value.backlog,
        statusUpdate(orphan, itemStatus, new Date().toISOString()),
      );
      if (!dry.ok) return yield* new Refused({ message: dry.reason });
    }
  }
  const sessionState = yield* readSession(config.stateDir, session);
  const record: EndedRecord = {
    name: terminal.name ?? terminal.address,
    task: terminal.labels[L.task] ?? null,
    domain,
    tab_label: terminal.labels[L.task] ?? null,
    session,
    program: terminal.labels[L.harness] ?? harnessOf(terminal.app) ?? null,
    model: terminal.labels[L.model] ?? null,
    effort: terminal.labels[L.effort] ?? null,
    cwd: terminal.labels[L.worktree] ?? terminal.cwd,
    repo:
      (yield* mainCheckout(terminal.cwd).pipe(Effect.catch(() => Effect.succeed(undefined)))) ??
      null,
    branch: terminal.labels[L.branch] ?? null,
    base_sha: terminal.labels[L.base] ?? null,
    ended_at: new Date().toISOString(),
    quiet_since: terminal.statusMs ? new Date(terminal.statusMs).toISOString() : null,
    space: terminal.labels[L.space] !== undefined,
    verdict: sessionState.verdict,
    resumes: sessionState.resumes,
  };
  const path = yield* writeEnded(config.stateDir, record);
  // Read the terminal's process tree while it still has one: once it ends, survivors move to launchd.
  // A remote terminal (machine/address) has pids and folders on another machine: leave them alone.
  const remote = terminal.address.includes("/");
  const before = remote ? Option.none() : yield* scanProcesses().pipe(Effect.option);
  yield* hc.end(terminal.address).pipe(Effect.tapError(() => removeEnded(path)));
  const space = terminal.labels[L.space];
  if (space) yield* hc.closeSpace(space).pipe(Effect.ignore);
  // Only a worktree coordinate made for it (`delegate --repo` sets the base label): a --cwd folder or
  // an attached session's folder may be shared, and its processes anyone's.
  const worktree = terminal.labels[L.worktree];
  const ownWorktree =
    worktree !== undefined &&
    terminal.labels[L.base] !== undefined &&
    real(worktree) !== real(record.repo ?? "")
      ? real(worktree)
      : undefined;
  const stopped = remote
    ? [`stopped no processes: ${record.name} ran on ${machineOfAddress(terminal.address)}`]
    : yield* teardownEnded(
        { name: record.name, rootPid: terminal.pid, worktree: ownWorktree },
        Option.getOrUndefined(before),
        stop,
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed([`stopped no processes: the process scan failed (${error.message})`]),
        ),
      );
  const lines = [
    `ended ${record.name} (${terminal.address}); record ${path}`,
    `worktree, branch and session stay; resume with: coordinate resume ${record.name}`,
    ...stopped,
  ];
  if (orphan === undefined) {
    if (itemStatus !== undefined && filed?.status !== "delegated")
      lines.push(`--item-status ignored: ${record.name} is not filed under a delegated item`);
    return lines;
  }
  if (itemStatus === undefined)
    return [
      ...lines,
      `${orphan} is still delegated with no live delegate; set its next status (coordinate item update ${orphan} --status ...)`,
    ];
  return [
    ...lines,
    ...(yield* itemUpdate(config, domain, {
      ...statusUpdate(orphan, itemStatus, new Date().toISOString()),
      json: false,
    })),
  ];
});

/**
 * Delegates settled for longer than `quiet_hours`, each with the command that ends it.
 * @param config Config.
 * @param domain Domain.
 * @param nowMs Current time.
 * @returns Lines to print.
 */
export const listIdle = Effect.fn("listIdle")(function* (
  config: Config,
  domain: string,
  nowMs: number,
) {
  if (config.keepRunning.includes(domain))
    return [`${domain} is in keep_running: its delegates are never ended`];
  const limit = config.quietHours * 3_600_000;
  const quiet = (yield* members(domain, undefined)).filter(
    (member) =>
      member.status !== undefined &&
      hc.SETTLED.has(member.status) &&
      member.status !== "blocked" &&
      member.statusMs !== undefined &&
      nowMs - member.statusMs >= limit,
  );
  if (quiet.length === 0)
    return [`no delegate of ${domain} has been quiet for ${config.quietHours}h`];
  return quiet.map(
    (member) =>
      `${member.name} (${member.address}) ${member.status} for ${Math.round((nowMs - (member.statusMs ?? nowMs)) / 3_600_000)}h: coordinate end ${member.name}`,
  );
});

/**
 * Resume an ended delegate in a new terminal with the same name, labels and session.
 * @param config Config.
 * @param name Delegate name.
 * @param space Give it its own space (default: what it had).
 * @returns Lines to print.
 */
export const resumeDelegate = Effect.fn("resumeDelegate")(function* (
  config: Config,
  name: string,
  space: boolean | undefined,
) {
  const { records } = yield* readEnded(config.stateDir);
  const found = records
    .filter((entry) => entry.record.name === name)
    .toSorted((a, b) => b.record.ended_at.localeCompare(a.record.ended_at))[0];
  if (!found)
    return yield* new Refused({
      message: `no ended record for ${name} in ${config.stateDir}/ended`,
    });
  const { record } = found;
  const harness = harnessOf(record.program ?? "claude");
  if (!harness)
    return yield* new Refused({
      message: `${name} ran ${record.program}, which this skill cannot resume`,
    });
  yield* requireRecordedHarnessEnabled(config, record.domain, harness, name);
  if (!existsSync(record.cwd))
    return yield* new Refused({ message: `${name}'s folder is gone: ${record.cwd}` });
  const taken = (yield* hc.list()).find((terminal) => terminal.name === name);
  if (taken)
    return yield* new Refused({
      message: `a live terminal is already named ${name} (${taken.address})`,
    });
  const coordinator = yield* ownCoordinator().pipe(Effect.option);
  const coordinatorTerminal = Option.isSome(coordinator) ? coordinator.value.terminal : undefined;
  const task = record.task ?? name;
  const labels: Record<string, string> = {
    [L.domain]: record.domain,
    [L.task]: task,
    [L.session]: record.session,
    [L.harness]: harness,
    [L.worktree]: record.cwd,
    ...(record.model ? { [L.model]: record.model } : {}),
    ...(record.effort ? { [L.effort]: record.effort } : {}),
    ...(record.branch ? { [L.branch]: record.branch } : {}),
    ...(record.base_sha ? { [L.base]: record.base_sha } : {}),
  };
  const launched = yield* launch({
    name,
    cwd: record.cwd,
    tabLabel: task,
    spaceName: `${record.domain} [${task}]`,
    labels,
    parent: coordinatorTerminal?.address ?? process.env.HC_TERMINAL_ID,
    argv: agentArgv({
      harness,
      name,
      session: record.session,
      model: record.model ?? undefined,
      effort: record.effort ?? undefined,
      extraArgs: harness === "pi" ? config.delegatePiArgs : config.delegateClaudeArgs,
      message: undefined,
      resume: true,
    }),
    ownSpace: space ?? record.space ?? true,
    coordinatorSpace: coordinatorTerminal?.labels["herdr.space"],
  });
  const showed = yield* agentShowed(launched.address, 60);
  if (!showed)
    return yield* new Refused({
      message: `${name} did not show an agent status in ${launched.address} within 60s; read it with hc read ${launched.address}`,
    });
  yield* removeEnded(found.path);
  const counted = yield* countResume(config.stateDir, record.session);
  return [
    `resumed ${name} in ${launched.address} (resume ${counted.resumes} of session ${record.session})`,
    `send it what arrived: coordinate send ${name} "<message>"`,
  ];
});

/**
 * Refuse a domain that has neither a backlog document nor a legacy Markdown backlog. Neither file
 * is read: the document has its own readers, and the legacy file is a pointer only.
 * @param config Config.
 * @param domain Domain.
 * @returns Nothing; refused when the domain was never started.
 */
export const requireBacklog = Effect.fn("requireBacklog")(function* (
  config: Config,
  domain: string,
) {
  const document = documentPath(config.stateDir, domain);
  if (existsSync(document) || existsSync(backlogPath(config.backlogDir, domain))) return;
  return yield* new Refused({
    message: `no backlog for ${domain} at ${document}; run coordinate start ${domain}`,
  });
});
