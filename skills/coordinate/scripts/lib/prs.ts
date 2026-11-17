import { Effect } from "effect";
import type { Config } from "./config.ts";
import {
  forgeKind,
  listPullRequests,
  parseRemote,
  prsForBranch,
  prSummary,
  type PullRequest,
  type RepoRef,
} from "./forge.ts";
import { gitTry, isAncestor, type Landing, landedOn, remoteUrl } from "./git.ts";

/**
 * A checkout's pull requests, or why they could not be read. Never a silent empty list.
 */
export type RepoPrs =
  | { ok: true; repo: string; ref: RepoRef; kind: string; prs: PullRequest[] }
  | { ok: false; repo: string; error: string };

/**
 * Read a checkout's pull requests from the forge its remote names.
 * @param config Config (forge map).
 * @param repo Main checkout.
 * @param withChecks Fetch Forgejo checks for open PRs too.
 * @returns PRs or the error.
 */
export const repoPullRequests = Effect.fn("repoPullRequests")(function* (
  config: Config,
  repo: string,
  withChecks = false,
) {
  const url = yield* remoteUrl(repo);
  if (!url) return { ok: false, repo, error: "no remote" } satisfies RepoPrs;
  const ref = parseRemote(url);
  if (!ref)
    return { ok: false, repo, error: `remote ${url} has no owner/name path` } satisfies RepoPrs;
  const result = yield* Effect.gen(function* () {
    const kind = yield* forgeKind(ref.host, config.forges);
    const prs = yield* listPullRequests(ref, kind, withChecks);
    return { ok: true, repo, ref, kind, prs } satisfies RepoPrs;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ ok: false, repo, error: error.message } satisfies RepoPrs),
    ),
  );
  return result as RepoPrs;
});

/**
 * What a task branch's PRs and the bases say about it.
 */
export type BranchState = {
  tip: string | undefined;
  prs: PullRequest[];
  prState: PullRequest["state"] | undefined;
  prLabel: string;
  landed: Landing | "pr-merged" | undefined;
};

/**
 * Join a branch to its PRs and check whether its work is on a base.
 * @param repo Repository.
 * @param branch Branch.
 * @param bases Base refs.
 * @param prs The repo's PRs (empty when unknown).
 * @returns Branch state.
 */
export const branchState = Effect.fn("branchState")(function* (
  repo: string,
  branch: string,
  bases: readonly string[],
  prs: readonly PullRequest[],
) {
  const tip = yield* gitTry(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  if (!tip)
    return {
      tip: undefined,
      prs: [],
      prState: undefined,
      prLabel: "",
      landed: undefined,
    } satisfies BranchState;
  const matched = yield* prsForBranch(prs, branch, tip, (sha) => isAncestor(repo, tip, sha));
  const summary = prSummary(matched);
  const landed: BranchState["landed"] =
    summary.state === "merged" ? "pr-merged" : yield* landedOn(repo, branch, bases);
  return {
    tip,
    prs: matched,
    prState: summary.state,
    prLabel: summary.label,
    landed,
  } satisfies BranchState;
});
