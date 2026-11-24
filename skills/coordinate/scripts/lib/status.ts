import { existsSync } from "node:fs";
import { Effect, Option } from "effect";
import { readDocument, refSessions, showBacklog } from "./backlog-doc.ts";
import { idleDelegated } from "./backlog-store/ops.ts";
import { proseSource, questionOf } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { L, type Delegate, members, readEnded } from "./fleet.ts";
import { harnessPolicyStatus } from "./harness-policy.ts";
import { endedRecordMachines, remoteMachineOf } from "./delegate-capacity.ts";
import { currentBranch, defaultBases, mainCheckout } from "./git.ts";
import { requireBacklog } from "./lifecycle.ts";
import { readSession, type SessionState } from "./sessions.ts";
import { branchState, type RepoPrs, repoPullRequests } from "./prs.ts";
import { watcherInfo, watcherInfoLine, type WatcherInfo } from "./watch-terminal.ts";

const age = (fromMs: number | undefined, nowMs: number): string => {
  if (fromMs === undefined) return "?";
  const minutes = Math.max(0, nowMs - fromMs) / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

/**
 * The other machine a live delegate runs on, from its `machine/tN` address; undefined for this one.
 * @param delegate Live delegate.
 * @returns Herdr machine name.
 */
const remoteOf = (delegate: Delegate): string | undefined => remoteMachineOf(delegate.address);

/**
 * The machine an ended record names when it is not this one, by its canonical name. When this
 * core's name is unreadable, the record's own machine name is shown, so its folder is never judged
 * on this Mac's disk.
 * @param records Ended records.
 * @returns A lookup by record, undefined for this machine.
 */
const endedMachines = Effect.fn("endedMachines")(function* (
  records: readonly { record: { machine?: string | null } }[],
) {
  const machineOf = yield* endedRecordMachines(records);
  return (record: { machine?: string | null }): string | undefined => {
    const machine = machineOf(record);
    return machine === "unknown" ? (record.machine ?? undefined) : machine;
  };
});
const badge = (machine: string | undefined): string => (machine ? ` [${machine}]` : "");

/**
 * Who acts next for one delegate.
 * @param delegate Live delegate.
 * @param prLine PR summary.
 * @returns "user", "coordinator" or "delegate", with why.
 */
export const waitsOn = (
  status: string | undefined,
  pr: {
    state: string | undefined;
    checks: string | undefined;
    review: string | undefined;
    landed: string | undefined;
  },
): string => {
  if (status === "blocked") return "user: a dialog in its tab";
  if (status === "error") return "coordinator: it errored, read its terminal";
  if (pr.landed) return "coordinator: landed, sweep it";
  if (pr.state === "open" && pr.checks === "fail") return "delegate: failing checks";
  if (pr.state === "open" && pr.review === "changes_requested")
    return "delegate: changes requested";
  if (pr.state === "open" && pr.review === "approved") return "user: approved PR";
  if (status === "working") return "delegate: working";
  if (status === "idle" || status === "done") return "coordinator: read its REPORT.md";
  return "?";
};

/**
 * The main checkouts a domain owns: its `boundary.owned` paths, nothing else. Adjacent repos, and
 * repos a delegate or an ended record happens to sit in, never feed PR polling, watch or sweep. A
 * repo holding an adjacent path stays adjacent even when an owned folder sits inside it.
 * @param config Config.
 * @param domain Domain.
 * @returns Main checkouts, unique, in Boundary order.
 */
export const domainRepos = Effect.fn("domainRepos")(function* (config: Config, domain: string) {
  const { backlog } = yield* readDocument(config, domain);
  const checkouts = Effect.fn("checkouts")(function* (paths: readonly string[]) {
    const found: string[] = [];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const main = yield* mainCheckout(path);
      if (main && !found.includes(main)) found.push(main);
    }
    return found;
  });
  const adjacent = yield* checkouts(backlog.boundary.adjacent);
  return (yield* checkouts(backlog.boundary.owned)).filter((repo) => !adjacent.includes(repo));
});

/**
 * What status adds for a session that was verified or resumed, or "" for neither.
 * @param state Session state.
 * @returns Text such as " · problem: why · resumed 2x".
 */
const sessionNote = (state: SessionState): string => {
  const verdict =
    state.verdict === null
      ? ""
      : state.verdict.result === "ok"
        ? " · verified ok"
        : ` · problem: ${state.verdict.reason ?? ""}`;
  return `${verdict}${state.resumes > 0 ? ` · resumed ${state.resumes}x` : ""}`;
};

/**
 * The domain's live and ended delegates as JSON, each with its session's verify verdict and resume
 * count. Polls no forge.
 * @param config Config.
 * @param domain Domain.
 * @returns One line of JSON.
 */
export const domainStatusJson = Effect.fn("domainStatusJson")(function* (
  config: Config,
  domain: string,
) {
  yield* requireBacklog(config, domain);
  const delegates = [];
  for (const delegate of yield* members(domain, yield* refSessions(config, domain))) {
    const state = yield* readSession(config.stateDir, delegate.session);
    delegates.push({
      name: delegate.name,
      address: delegate.address,
      status: delegate.status ?? null,
      session: delegate.session,
      task: delegate.task,
      cwd: delegate.cwd,
      machine: remoteOf(delegate) ?? null,
      branch: delegate.labels[L.branch] ?? null,
      verdict: state.verdict,
      resumes: state.resumes,
    });
  }
  const ended = [];
  const records = (yield* readEnded(config.stateDir)).records.filter(
    ({ record }) => record.domain === domain,
  );
  const remoteRecord = yield* endedMachines(records);
  for (const { record } of records) {
    const state = yield* readSession(config.stateDir, record.session);
    ended.push({
      name: record.name,
      session: record.session,
      task: record.task ?? null,
      cwd: record.cwd,
      machine: remoteRecord(record) ?? null,
      branch: record.branch ?? null,
      ended_at: record.ended_at,
      verdict: state.verdict,
      resumes: state.resumes,
    });
  }
  return [JSON.stringify({ domain, delegates, ended }, null, 2)];
});

/**
 * The domain's status: delegates, ended delegates, PRs on GitHub and Forgejo, and who acts next.
 * @param config Config.
 * @param domain Domain.
 * @param withResume Also print the rendered backlog and the watcher state.
 * @param nowMs Current time.
 * @param showDone Include closed items in the rendered backlog.
 * @param watcher A watcher state already resolved by `status --resume`.
 * @param verbose Render full context, options and recommendations for answered asks.
 * @returns Lines to print.
 */
export const domainStatus = Effect.fn("domainStatus")(function* (
  config: Config,
  domain: string,
  withResume: boolean,
  nowMs: number,
  showDone = false,
  watcherOverride: WatcherInfo | undefined = undefined,
  verbose = false,
) {
  // Status still reports delegates when the document is missing or invalid; --resume names why.
  const ownedOrProblem = yield* domainRepos(config, domain).pipe(
    Effect.catchTags({
      Refused: (refused) => Effect.succeed(refused.message),
      BacklogError: (error) => Effect.succeed(`could not read the backlog: ${error.message}`),
    }),
  );
  const owned = typeof ownedOrProblem === "string" ? [] : ownedOrProblem;
  // Refuses a domain with neither a document nor a legacy Markdown backlog.
  yield* requireBacklog(config, domain);
  const delegates = yield* members(domain, yield* refSessions(config, domain));
  const ended = (yield* readEnded(config.stateDir)).records.filter(
    (entry) => entry.record.domain === domain,
  );

  const repoOf = Effect.fn("repoOf")(function* (path: string | null | undefined) {
    if (!path || !existsSync(path)) return undefined;
    return yield* mainCheckout(path);
  });
  // A remote delegate's folder is a path on its own machine, never one to look up here.
  const machineOf = remoteOf;
  const remoteRecord = yield* endedMachines(ended);
  const delegateRepos = new Map<Delegate, string | undefined>();
  for (const delegate of delegates)
    delegateRepos.set(
      delegate,
      machineOf(delegate) === undefined ? yield* repoOf(delegate.cwd) : undefined,
    );

  const prsByRepo = new Map<string, RepoPrs>();
  const basesByRepo = new Map<string, string[]>();
  for (const repo of owned) {
    prsByRepo.set(repo, yield* repoPullRequests(config, repo, true));
    basesByRepo.set(repo, yield* defaultBases(repo, []));
  }
  const prsOf = (repo: string | undefined) => {
    const found = repo ? prsByRepo.get(repo) : undefined;
    return found?.ok ? found.prs : [];
  };

  const lines: string[] = [`${domain}: ${delegates.length} live delegates, ${ended.length} ended`];
  const describe = Effect.fn("describe")(function* (
    repo: string | undefined,
    branch: string | undefined,
    status: string | undefined,
    creationBase: string | undefined = undefined,
  ) {
    if (!repo || !branch)
      return {
        text: branch ? "no repo" : "no branch",
        next: waitsOn(status, {
          state: undefined,
          checks: undefined,
          review: undefined,
          landed: undefined,
        }),
      };
    if (!owned.includes(repo))
      return {
        text: `${branch} · repo ${repo} is outside the owned Boundary`,
        next: waitsOn(status, {
          state: undefined,
          checks: undefined,
          review: undefined,
          landed: undefined,
        }),
      };
    const state = yield* branchState(
      repo,
      branch,
      basesByRepo.get(repo) ?? [],
      prsOf(repo),
      creationBase,
    );
    const open = state.prs.find((pr) => pr.state === "open");
    const prText = state.prLabel || (prsByRepo.get(repo)?.ok === false ? "PRs unknown" : "no PR");
    const noCommits =
      state.hasCommits === false
        ? status === "ended"
          ? "no commits (nothing to land)"
          : "no commits yet"
        : undefined;
    const extra = open ? ` checks ${open.checks} review ${open.review} ${open.url}` : "";
    const landed = state.landed ? ` · landed (${state.landed})` : "";
    return {
      text: `${branch} · ${noCommits ? `${noCommits} · ` : ""}${prText}${extra}${landed}`,
      next: waitsOn(status, {
        state: open?.state,
        checks: open?.checks,
        review: open?.review,
        landed: state.landed,
      }),
    };
  });
  for (const delegate of delegates) {
    const repo = delegateRepos.get(delegate);
    const machine = machineOf(delegate);
    const branch =
      delegate.labels["fleet.branch"] ??
      (machine === undefined ? yield* currentBranch(delegate.cwd) : undefined);
    // Its branch lives on its own machine until it is fetched, so there is no PR or landing state.
    const info =
      machine === undefined
        ? yield* describe(repo, branch, delegate.status, delegate.labels[L.base])
        : {
            text: branch ?? "no branch",
            next: waitsOn(delegate.status, {
              state: undefined,
              checks: undefined,
              review: undefined,
              landed: undefined,
            }),
          };
    const note = sessionNote(yield* readSession(config.stateDir, delegate.session));
    lines.push(
      `  ${delegate.name}${badge(machine)} ${delegate.address} ${delegate.status ?? "no status"} ${age(delegate.statusMs, nowMs)}${delegate.byLabel ? "" : " (by item ref)"} · ${info.text}${note} · next: ${info.next}`,
    );
  }
  for (const { record } of ended) {
    const repo = record.repo ?? undefined;
    const info = yield* describe(
      repo,
      record.branch ?? undefined,
      "ended",
      record.base_sha ?? undefined,
    );
    const machine = remoteRecord(record);
    const gone =
      machine !== undefined || existsSync(record.cwd)
        ? ""
        : " · folder gone (coordinate sweep prune-ended)";
    const note = sessionNote(yield* readSession(config.stateDir, record.session));
    lines.push(
      `  ${record.name}${badge(machine)} ended ${record.ended_at.slice(0, 10)} · ${info.text}${note}${gone} · resume: coordinate resume ${record.name}`,
    );
  }
  const live = new Set(delegates.map((delegate) => delegate.session));
  const document = yield* readDocument(config, domain).pipe(Effect.option);
  if (Option.isSome(document)) {
    for (const item of idleDelegated(document.value.backlog, live))
      lines.push(
        `  ${item.id} delegated, no live delegate · ${item.title} · next: coordinator: set its next status`,
      );
    if (!withResume)
      for (const item of document.value.backlog.items) {
        if (item.ask !== null && item.ask.discuss !== null) {
          const source = proseSource(item.ask.discuss.note, item.ask.discuss.noteMarkdown);
          const note = source === "" ? "" : `; ${source}`;
          lines.push(
            `  discuss ${item.id} ${item.title}: "${questionOf(item.ask)}" (${item.ask.discuss.at}${note})`,
          );
        }
        if (item.startRequested !== undefined)
          lines.push(`  start ${item.id} ${item.title}: requested ${item.startRequested.at}`);
        for (const answered of item.answered) {
          const note = proseSource(answered.note, answered.noteMarkdown);
          if (answered.note !== null || note !== "")
            lines.push(`  answer note ${item.id} ${item.title}: ${note}`);
        }
      }
  }
  for (const [repo, result] of prsByRepo) {
    if (!result.ok) {
      lines.push(`repo ${repo}: could not read PRs: ${result.error}`);
      continue;
    }
    const open = result.prs.filter((pr) => pr.state === "open");
    lines.push(`repo ${repo} (${result.kind} ${result.ref.slug}): ${open.length} open PRs`);
    for (const pr of open)
      lines.push(
        `  #${pr.number} ${pr.headRef ?? pr.headSha.slice(0, 8)} checks ${pr.checks} review ${pr.review} ${pr.url}`,
      );
  }
  if (typeof ownedOrProblem === "string" && !withResume)
    lines.push(`no repos polled: ${ownedOrProblem}`);
  if (withResume) {
    const rendered = yield* showBacklog(config, domain, false, live, showDone, verbose).pipe(
      Effect.catchTags({
        Refused: (refused) => Effect.succeed([refused.message]),
        BacklogError: (error) => Effect.succeed([`could not read the backlog: ${error.message}`]),
      }),
    );
    lines.push("", ...rendered);
    if (Option.isSome(document)) lines.push("", ...(yield* harnessPolicyStatus(config, domain)));
    const watcher = watcherOverride ?? (yield* watcherInfo(config, domain));
    lines.push("", watcherInfoLine(watcher));
  }
  return lines;
});
