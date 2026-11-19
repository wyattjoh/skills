import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { loadavg, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Option } from "effect";
import {
  BacklogError,
  checkFileable,
  createDocument,
  itemUpdate,
  readDocument,
  recordDelegate,
  refSessions,
} from "./backlog-doc.ts";
import { filedUnder, idleDelegated, updateItem, type ItemUpdate } from "./backlog-store/ops.ts";
import type { ItemStatus } from "./backlog-store/schema.ts";
import { documentPath } from "./backlog-store/paths.ts";
import type { Config } from "./config.ts";
import {
  backlogPath,
  checkDomainName,
  coordinators,
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
  type FirstMessage,
  firstMessage,
  type Harness,
  harnessOf,
  inLoginShell,
  PI_THINKING,
} from "./harness.ts";
import * as hc from "./herdr.ts";

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
  harness: Harness;
  model: string | undefined;
  effort: string | undefined;
  message: FirstMessage;
  space: boolean;
  domain: string | undefined;
  /**
   * Item to file the delegate under: required from a coordinator, refused from a delegate.
   */
  item: string | undefined;
  overBudget: boolean;
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
 * Launch an agent terminal, in its own space or as a tab in the coordinator's space.
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
  const argv = inLoginShell(loginShell(), spec.argv);
  if (!spec.ownSpace) {
    const labels = spec.coordinatorSpace
      ? { "herdr.space": spec.coordinatorSpace, ...spec.labels }
      : spec.labels;
    const address = yield* hc.run({
      name: spec.name,
      cwd: spec.cwd,
      labels,
      parent: spec.parent,
      argv,
    });
    const tab = (yield* hc.get(address).pipe(Effect.catch(() => Effect.succeed(undefined))))
      ?.labels["herdr.tab"];
    if (tab) yield* hc.appDo("tab.rename", { id: tab, name: spec.tabLabel }).pipe(Effect.ignore);
    return { address, space: undefined };
  }
  const made = yield* hc.newSpace(spec.spaceName, spec.cwd);
  const address = yield* hc
    .run({
      name: spec.name,
      cwd: spec.cwd,
      labels: {
        "herdr.space": made.space,
        "herdr.tab": made.tab,
        [L.space]: made.space,
        ...spec.labels,
      },
      parent: spec.parent,
      argv,
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
  const efforts = options.harness === "pi" ? PI_THINKING : CLAUDE_EFFORTS;
  if (options.effort && !efforts.has(options.effort))
    return yield* new Refused({
      message: `${options.effort} is not a ${options.harness} ${options.harness === "pi" ? "thinking level" : "effort"}: ${[...efforts].join(", ")}`,
    });
  if ((options.repo === undefined) === (options.cwd === undefined))
    return yield* new Refused({
      message: "pass exactly one of --repo (new worktree) or --cwd (a folder with no repo work)",
    });
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
  if (options.item !== undefined) yield* checkFileable(config, domain, options.item);
  const terminals = yield* hc.list();
  const taken = terminals.find((terminal) => terminal.name === options.name);
  if (taken)
    return yield* new Refused({
      message: `a live terminal is already named ${options.name} (${taken.address})`,
    });

  let liveDelegates = 0;
  for (const listed of terminals) {
    if (!listed.live) continue;
    const terminal = yield* hc.get(listed.address);
    if (terminal?.live && terminal.labels[L.domain] && terminal.labels[L.role] !== "coordinator")
      liveDelegates += 1;
  }

  const load = readLoadAverage();
  const lines: string[] = [];
  if (load > config.cores)
    lines.push(
      `warning: 1-minute load average ${load} exceeds ${config.cores} cores; native gates may be slow`,
    );
  if (coordinator !== undefined && liveDelegates >= config.maxFleetDelegates && !options.overBudget)
    return yield* new Refused({
      message: `fleet has ${liveDelegates} live delegates (budget ${config.maxFleetDelegates}); refusing ${options.name} for item ${options.item ?? "?"}; pass --over-budget to start anyway`,
    });
  let cwd: string;
  let branch: string | undefined;
  let baseSha: string | undefined;
  if (options.repo !== undefined) {
    const repo = yield* mainCheckout(resolve(options.repo));
    if (!repo) return yield* new Refused({ message: `${options.repo} is not a Git checkout` });
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
    cwd = real(resolve(options.cwd ?? "."));
    if (!existsSync(cwd)) return yield* new Refused({ message: `${cwd} does not exist` });
  }

  let brief: string | undefined;
  let message = options.message;
  if (message.kind === "brief") {
    const source = resolve(message.path);
    if (!existsSync(source)) return yield* new Refused({ message: `no brief at ${source}` });
    brief = join(cwd, ".scratch", "BRIEF.md");
    if (real(source) !== real(brief))
      yield* Effect.promise(async () => {
        await mkdir(dirname(brief ?? cwd), { recursive: true });
        await copyFile(source, brief ?? source);
      });
    message = { kind: "brief", path: brief };
  }
  const report = brief ? join(cwd, ".scratch", "REPORT.md") : undefined;
  const session = crypto.randomUUID();
  const tabLabel = options.task;
  const labels: Record<string, string> = {
    [L.domain]: domain,
    [L.task]: options.task,
    [L.session]: session,
    [L.harness]: options.harness,
    [L.worktree]: cwd,
    ...(options.model ? { [L.model]: options.model } : {}),
    ...(options.effort ? { [L.effort]: options.effort } : {}),
    ...(branch ? { [L.branch]: branch } : {}),
    ...(baseSha ? { [L.base]: baseSha } : {}),
  };
  const argv = agentArgv({
    harness: options.harness,
    name: options.name,
    session,
    model: options.model,
    effort: options.effort,
    extraArgs: options.harness === "pi" ? config.delegatePiArgs : config.delegateClaudeArgs,
    message: firstMessage(options.harness, message),
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
            Refused: (error) => Effect.fail(new Refused({ message: `${unfiled(error.message)}` })),
            BacklogError: (error) =>
              Effect.fail(new BacklogError({ path: error.path, message: unfiled(error.message) })),
          }),
        );
  const showed = yield* agentShowed(launched.address, 60);
  if (!showed) {
    const text = yield* hc.read(launched.address, 40).pipe(Effect.catch(() => Effect.succeed("")));
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
export const NEXT_STATUSES = ["waiting-user", "building", "open", "parked"] as const;

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
 * @returns Lines to print.
 */
export const endDelegate = Effect.fn("endDelegate")(function* (
  config: Config,
  target: string,
  now: boolean,
  itemStatus: ItemStatus | undefined = undefined,
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
  };
  const path = yield* writeEnded(config.stateDir, record);
  yield* hc.end(terminal.address).pipe(Effect.tapError(() => removeEnded(path)));
  const space = terminal.labels[L.space];
  if (space) yield* hc.closeSpace(space).pipe(Effect.ignore);
  const lines = [
    `ended ${record.name} (${terminal.address}); record ${path}`,
    `worktree, branch and session stay; resume with: coordinate resume ${record.name}`,
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
  return [
    `resumed ${name} in ${launched.address}`,
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
