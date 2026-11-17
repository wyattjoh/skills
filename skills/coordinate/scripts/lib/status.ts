import { existsSync } from "node:fs";
import { Effect } from "effect";
import { boundaryPaths, pullRequestLinks } from "./backlog.ts";
import type { Config } from "./config.ts";
import { type Delegate, members, readEnded } from "./fleet.ts";
import { currentBranch, defaultBases, mainCheckout } from "./git.ts";
import { readBacklog } from "./lifecycle.ts";
import { branchState, type RepoPrs, repoPullRequests } from "./prs.ts";
import { watcherAlive } from "./watch-lock.ts";

const age = (fromMs: number | undefined, nowMs: number): string => {
  if (fromMs === undefined) return "?";
  const minutes = Math.max(0, nowMs - fromMs) / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

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
 * The domain's status: delegates, ended delegates, PRs on GitHub and Forgejo, and who acts next.
 * @param config Config.
 * @param domain Domain.
 * @param withResume Also print the Open section and the watcher state.
 * @param nowMs Current time.
 * @returns Lines to print.
 */
export const domainStatus = Effect.fn("domainStatus")(function* (
  config: Config,
  domain: string,
  withResume: boolean,
  nowMs: number,
) {
  const backlog = yield* readBacklog(config, domain);
  const delegates = yield* members(domain, backlog.open);
  const ended = (yield* readEnded(config.stateDir)).records.filter(
    (entry) => entry.record.domain === domain,
  );

  const checkouts = new Set<string>();
  const addCheckout = Effect.fn("addCheckout")(function* (path: string | null | undefined) {
    if (!path || !existsSync(path)) return undefined;
    const main = yield* mainCheckout(path);
    if (main) checkouts.add(main);
    return main;
  });
  for (const path of boundaryPaths(backlog.text)) yield* addCheckout(path);
  const delegateRepos = new Map<Delegate, string | undefined>();
  for (const delegate of delegates) delegateRepos.set(delegate, yield* addCheckout(delegate.cwd));
  for (const entry of ended) yield* addCheckout(entry.record.repo ?? entry.record.cwd);

  const prsByRepo = new Map<string, RepoPrs>();
  const basesByRepo = new Map<string, string[]>();
  for (const repo of checkouts) {
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
    const state = yield* branchState(repo, branch, basesByRepo.get(repo) ?? [], prsOf(repo));
    const open = state.prs.find((pr) => pr.state === "open");
    const prText = state.prLabel || (prsByRepo.get(repo)?.ok === false ? "PRs unknown" : "no PR");
    const extra = open ? ` checks ${open.checks} review ${open.review} ${open.url}` : "";
    const landed = state.landed ? ` · landed (${state.landed})` : "";
    return {
      text: `${branch} · ${prText}${extra}${landed}`,
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
    const branch = delegate.labels["fleet.branch"] ?? (yield* currentBranch(delegate.cwd));
    const info = yield* describe(repo, branch, delegate.status);
    lines.push(
      `  ${delegate.name} ${delegate.address} ${delegate.status ?? "no status"} ${age(delegate.statusMs, nowMs)}${delegate.byLabel ? "" : " (by backlog session)"} · ${info.text} · next: ${info.next}`,
    );
  }
  for (const { record } of ended) {
    const repo = record.repo ?? undefined;
    const info = yield* describe(repo, record.branch ?? undefined, "ended");
    const gone = existsSync(record.cwd) ? "" : " · folder gone (coordinate sweep prune-ended)";
    lines.push(
      `  ${record.name} ended ${record.ended_at.slice(0, 10)} · ${info.text}${gone} · resume: coordinate resume ${record.name}`,
    );
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
  const linked = pullRequestLinks(backlog.text).filter(
    (link) =>
      ![...prsByRepo.values()].some(
        (result) => result.ok && result.ref.host === link.host && result.ref.slug === link.slug,
      ),
  );
  if (linked.length > 0)
    lines.push(
      `backlog links PRs in repos outside Boundary: ${linked.map((link) => `${link.host}/${link.slug}#${link.number}`).join(", ")}`,
    );
  if (withResume) {
    lines.push("", `## Open (${backlog.path})`, backlog.open.trim() || "(empty)");
    const watcher = yield* watcherAlive(config.stateDir, domain);
    lines.push(
      "",
      watcher ? `watcher running (pid ${watcher})` : "no watcher running: arm coordinate watch",
    );
  }
  return lines;
});
