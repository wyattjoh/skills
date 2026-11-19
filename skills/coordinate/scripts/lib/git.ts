import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { cleanGitEnv } from "./git-env.ts";
import { Proc, type RunOutput } from "./proc.ts";

/**
 * A git command that had to succeed did not.
 */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  dir: Schema.String,
  args: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/**
 * Branches never treated as task branches.
 */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "next",
  "develop",
]);

/**
 * Run git in `dir` with the repository-location variables stripped.
 * @param dir Working directory.
 * @param args Git arguments.
 * @returns The raw output; spawn failures become a non-zero exit.
 */
export const git = Effect.fn("git")(function* (dir: string, args: readonly string[]) {
  const proc = yield* Proc;
  return yield* proc
    .run(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      env: cleanGitEnv(process.env),
      timeoutMs: 60_000,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.succeed<RunOutput>({ exitCode: 128, stdout: "", stderr: error.message }),
      ),
    );
});

/**
 * Run git and require exit 0.
 * @param dir Working directory.
 * @param args Git arguments.
 * @returns Trimmed stdout.
 */
export const gitOk = Effect.fn("gitOk")(function* (dir: string, args: readonly string[]) {
  const out = yield* git(dir, args);
  if (out.exitCode !== 0)
    return yield* new GitError({
      dir,
      args: [...args],
      message: (out.stderr || out.stdout).trim().slice(0, 400),
    });
  return out.stdout.trim();
});

/**
 * Run git; a failure is `undefined`.
 * @param dir Working directory.
 * @param args Git arguments.
 * @returns Trimmed stdout, or undefined on a non-zero exit.
 */
export const gitTry = Effect.fn("gitTry")(function* (dir: string, args: readonly string[]) {
  const out = yield* git(dir, args);
  return out.exitCode === 0 ? out.stdout.trim() : undefined;
});

/**
 * Resolve symlinks when the path exists.
 * @param path Any path.
 * @returns Its real path, or the resolved path when it does not exist.
 */
export const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Whether `path` is `folder` or inside it. Both should be real paths.
 * @param path Candidate.
 * @param folder Container.
 * @returns True when inside.
 */
export const inside = (path: string, folder: string): boolean =>
  `${path}/`.startsWith(`${folder.replace(/\/+$/, "")}/`);

/**
 * One entry of `git worktree list --porcelain`.
 */
export type Worktree = { path: string; branch: string | undefined; head: string | undefined };

/**
 * Parse `git worktree list --porcelain`.
 * @param text Porcelain output.
 * @returns Worktrees, main checkout first.
 */
export const parseWorktrees = (text: string): Worktree[] =>
  text
    .trim()
    .split(/\n\n+/)
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const fields = new Map(
        block.split("\n").map((line) => {
          const space = line.indexOf(" ");
          return space === -1 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
        }),
      );
      const branch = fields.get("branch");
      return {
        path: fields.get("worktree") ?? "",
        branch: branch === undefined ? undefined : branch.replace(/^refs\/heads\//, ""),
        head: fields.get("HEAD"),
      };
    });

/**
 * The repository's worktrees.
 * @param repo Any checkout of the repository.
 * @returns Worktrees, main checkout first.
 */
export const worktrees = Effect.fn("worktrees")(function* (repo: string) {
  return parseWorktrees(yield* gitOk(repo, ["worktree", "list", "--porcelain"]));
});

/**
 * The main checkout of the repository holding `dir`, from its common git dir.
 * @param dir Any folder inside a checkout.
 * @returns The main checkout's path, or undefined outside Git.
 */
export const mainCheckout = Effect.fn("mainCheckout")(function* (dir: string) {
  const common = yield* gitTry(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common === undefined) return undefined;
  return common.endsWith("/.git") ? dirname(common) : common;
});

/**
 * The checked-out branch, or undefined when detached.
 * @param dir Checkout.
 * @returns Branch name.
 */
export const currentBranch = Effect.fn("currentBranch")(function* (dir: string) {
  return (yield* gitTry(dir, ["symbolic-ref", "--short", "-q", "HEAD"])) || undefined;
});

/**
 * `git status --porcelain` lines.
 * @param dir Checkout.
 * @returns Lines, or undefined when git failed.
 */
export const statusLines = Effect.fn("statusLines")(function* (dir: string) {
  const out = yield* git(dir, ["status", "--porcelain"]);
  if (out.exitCode !== 0) return undefined;
  return out.stdout.split("\n").filter((line) => line !== "");
});

/**
 * Commits on HEAD that no remote-tracking ref or base branch holds.
 * @param dir Checkout.
 * @param bases Base refs.
 * @returns The count, or undefined when git failed.
 */
export const unsavedCommits = Effect.fn("unsavedCommits")(function* (
  dir: string,
  bases: readonly string[],
) {
  const out = yield* git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes", ...bases]);
  if (out.exitCode !== 0) return undefined;
  return Number(out.stdout.trim());
});

/**
 * Whether `commit` is an ancestor of `descendant`.
 * @param repo Repository.
 * @param commit Candidate ancestor.
 * @param descendant Candidate descendant.
 * @returns True when it is.
 */
export const isAncestor = Effect.fn("isAncestor")(function* (
  repo: string,
  commit: string,
  descendant: string,
) {
  return (yield* git(repo, ["merge-base", "--is-ancestor", commit, descendant])).exitCode === 0;
});

/**
 * Whether a ref resolves.
 * @param repo Repository.
 * @param ref Ref name.
 * @returns True when it does.
 */
export const refExists = Effect.fn("refExists")(function* (repo: string, ref: string) {
  return (yield* git(repo, ["rev-parse", "--verify", "-q", ref])).exitCode === 0;
});

/**
 * Base refs to compare a task branch against: origin's HEAD (or local main/master), plus extras that exist.
 * @param repo Repository.
 * @param extra Extra base refs.
 * @returns Base refs.
 */
export const defaultBases = Effect.fn("defaultBases")(function* (
  repo: string,
  extra: readonly string[],
) {
  const head = yield* gitTry(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const bases: string[] = [];
  if (head) bases.push(head);
  for (const local of ["main", "master"]) {
    if (yield* refExists(repo, `refs/heads/${local}`)) {
      bases.push(local);
      break;
    }
  }
  for (const ref of extra) if (yield* refExists(repo, ref)) bases.push(ref);
  return [...new Set(bases)];
});

/**
 * How a branch's work reached a base.
 */
export type Landing = "ancestor" | "rebase" | "squash";

/**
 * Whether a branch's work is already on one of the bases: as an ancestor (fast-forward or merge commit),
 * as patch-equivalent commits (rebase merge, via `git cherry`), or as one squashed commit whose patch
 * matches the branch's whole diff (squash merge).
 * @param repo Repository.
 * @param branch Branch or commit.
 * @param bases Base refs.
 * @param creationBase Recorded base SHA, or undefined to use the branch creation reflog.
 * @param hasCommits Known result when the caller already checked the creation base.
 * @returns How it landed, or undefined.
 */
export const landedOn = Effect.fn("landedOn")(function* (
  repo: string,
  branch: string,
  bases: readonly string[],
  creationBase: string | undefined = undefined,
  hasCommits: boolean | undefined = undefined,
) {
  if ((hasCommits ?? (yield* hasCommitsSince(repo, branch, creationBase))) !== true)
    return undefined;
  for (const base of bases) {
    if (yield* isAncestor(repo, branch, base)) return "ancestor" satisfies Landing;
  }
  for (const base of bases) {
    const cherry = yield* gitTry(repo, ["cherry", base, branch]);
    const lines = (cherry ?? "").split("\n").filter((line) => line !== "");
    if (cherry !== undefined && lines.length > 0 && lines.every((line) => line.startsWith("-")))
      return "rebase" satisfies Landing;
    const mergeBase = yield* gitTry(repo, ["merge-base", base, branch]);
    if (!mergeBase) continue;
    const tree = yield* gitTry(repo, ["rev-parse", `${branch}^{tree}`]);
    if (!tree) continue;
    if (tree === (yield* gitTry(repo, ["rev-parse", `${mergeBase}^{tree}`]))) continue;
    // A throwaway commit holding the branch's whole diff; `git cherry` marks it "-" when a
    // commit on the base carries the same patch. The object stays unreferenced.
    const squashed = yield* gitTry(repo, ["commit-tree", tree, "-p", mergeBase, "-m", "squash"]);
    if (!squashed) continue;
    const squashCherry = yield* gitTry(repo, ["cherry", base, squashed]);
    if (squashCherry?.startsWith("-")) return "squash" satisfies Landing;
  }
  return undefined;
});

/**
 * Whether a branch has only ever been created or reset, never committed to.
 * A missing reflog counts as committed.
 * @param repo Repository.
 * @param branch Branch.
 * @returns True when never committed.
 */
export const neverCommitted = Effect.fn("neverCommitted")(function* (repo: string, branch: string) {
  const log = yield* gitTry(repo, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`]);
  if (!log) return false;
  return !log
    .split("\n")
    .some((entry) => /^(commit|cherry-pick|revert|merge|rebase|pull)/.test(entry));
});

/**
 * The branch tip when it was created, read from the oldest reflog entry for legacy records.
 * @param repo Repository.
 * @param branch Branch.
 * @returns The creation tip, or undefined when the branch reflog is unavailable.
 */
export const branchCreationBase = Effect.fn("branchCreationBase")(function* (
  repo: string,
  branch: string,
) {
  const entries = yield* gitTry(repo, ["reflog", "show", "--format=%H", `refs/heads/${branch}`]);
  return entries?.split("\n").at(-1) || undefined;
});

/**
 * Whether a branch has commits beyond the tip it started from.
 * @param repo Repository.
 * @param branch Branch.
 * @param creationBase Recorded base, or undefined to use the branch reflog.
 * @returns True, false, or undefined when no trustworthy creation base is available.
 */
export const hasCommitsSince = Effect.fn("hasCommitsSince")(function* (
  repo: string,
  branch: string,
  creationBase: string | undefined,
) {
  const base = creationBase ?? (yield* branchCreationBase(repo, branch));
  if (!base) return undefined;
  const count = yield* gitTry(repo, ["rev-list", "--count", `${base}..refs/heads/${branch}`]);
  if (count === undefined) return undefined;
  return Number(count) > 0;
});

/**
 * Make Git ignore `.scratch/` through the repository's `info/exclude` (never committed).
 * @param dir Checkout.
 * @returns True when the exclude file changed.
 */
export const excludeScratch = Effect.fn("excludeScratch")(function* (dir: string) {
  const ignored = yield* git(dir, ["check-ignore", "-q", ".scratch/BRIEF.md"]);
  if (ignored.exitCode === 0) return false;
  const common = yield* gitOk(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const exclude = join(common, "info", "exclude");
  yield* Effect.promise(async () => {
    await mkdir(dirname(exclude), { recursive: true });
    const existing = await readFile(exclude, "utf8").catch(() => "");
    const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
    await appendFile(exclude, `${lead}.scratch/\n`);
  });
  return true;
});

/**
 * Delete a branch with `git branch -d` only. When git refuses, the caller gets its message.
 * @param repo Repository.
 * @param branch Branch.
 * @returns undefined on success, else git's refusal.
 */
export const deleteBranch = Effect.fn("deleteBranch")(function* (repo: string, branch: string) {
  const out = yield* git(repo, ["branch", "-d", branch]);
  return out.exitCode === 0 ? undefined : (out.stderr || out.stdout).trim();
});

/**
 * The fetch URL of `origin`, else of the first remote.
 * @param dir Checkout.
 * @returns URL, or undefined with no remote.
 */
export const remoteUrl = Effect.fn("remoteUrl")(function* (dir: string) {
  const remotes = ((yield* gitTry(dir, ["remote"])) ?? "").split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (remote === undefined) return undefined;
  return yield* gitTry(dir, ["remote", "get-url", remote]);
});

/**
 * How far a checkout's branch is ahead of its upstream.
 * @param dir Checkout.
 * @returns Branch, upstream and ahead count, or undefined with no upstream.
 */
export const aheadOfUpstream = Effect.fn("aheadOfUpstream")(function* (dir: string) {
  const branch = yield* currentBranch(dir);
  const upstream = yield* gitTry(dir, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (!branch || !upstream) return undefined;
  const count = yield* gitTry(dir, ["rev-list", "--count", "@{upstream}..HEAD"]);
  return { branch, upstream, ahead: Number(count ?? "0") };
});
