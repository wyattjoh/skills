/**
 * Runs fixed POSIX `sh` scripts on either side of a move. The target only needs
 * `sh`, `git`, `tar`, `find`, `wc`, `mktemp` and `cat`; all hashing and parsing
 * happens locally.
 */

import { Context, Effect, Layer, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { type ExecError, type ExecResult, runProcess } from "./exec.ts";

/**
 * Quotes one word for a POSIX shell (and zsh/bash), so it reaches the script as
 * a single argument byte-for-byte.
 */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Builds the command line `sh -c <script> beam-me-up <args...>`. Both transports
 * hand this exact string to a shell, so quoting is exercised identically in
 * tests and over SSH.
 */
export const shellCommand = (script: string, args: ReadonlyArray<string>): string =>
  ["sh", "-c", shellQuote(script), "beam-me-up", ...args.map(shellQuote)].join(" ");

/**
 * Options for one script run.
 */
export interface ShellRunOptions {
  readonly stdin: Stream.Stream<Uint8Array, PlatformError> | undefined;
  readonly timeout: `${number} ${"seconds" | "minutes"}`;
}

/**
 * A place scripts run: the local machine or an SSH target.
 */
export interface Shell {
  readonly label: string;
  run(
    script: string,
    args: ReadonlyArray<string>,
    options?: Partial<ShellRunOptions>,
  ): Effect.Effect<ExecResult, ExecError>;
}

/**
 * SSH options: never prompt (a prompt would hang the move), and give up on an
 * unreachable host after 10 seconds instead of the OS default of minutes.
 */
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"] as const;

const withPreamble = (script: string): string => `${PREAMBLE}\n${script}`;

/**
 * A shell on an SSH target. The login shell there parses the command line, so
 * PATH is whatever the user's shell sets for non-interactive sessions.
 */
export const makeSshShell = Effect.fn("makeSshShell")(function* (target: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    label: target,
    run: (script, args, options = {}) =>
      runProcess(
        "ssh",
        [...SSH_OPTIONS, target, shellCommand(withPreamble(script), args)],
        options,
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  } satisfies Shell;
});

/**
 * A shell on this machine. `env` overrides variables such as `HOME`, which tests
 * use to stand in for a second machine.
 */
export const makeLocalShell = Effect.fn("makeLocalShell")(function* (
  env: Record<string, string> | undefined,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    label: "local",
    run: (script, args, options = {}) =>
      runProcess("sh", ["-c", shellCommand(withPreamble(script), args)], {
        ...options,
        env,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  } satisfies Shell;
});

/**
 * The target machine's shell.
 */
export class Remote extends Context.Service<Remote, Shell>()("beam-me-up/Remote") {
  /**
   * Targets a host over SSH.
   */
  static readonly ssh = (target: string) => Layer.effect(Remote, makeSshShell(target));

  /**
   * Targets this machine with `HOME` replaced, standing in for a second machine.
   */
  static readonly local = (home: string) =>
    Layer.effect(Remote, makeLocalShell({ HOME: home, TMPDIR: `${home}/tmp` }));
}

// ─── Scripts ─────────────────────────────────────────────────

/**
 * Shared prologue. Git never prompts, SSH under Git never prompts, and temporary
 * stash commits always have an identity. `section` prints one length-prefixed
 * block (see `parseSections` in session.ts); a failing command prints length -1.
 */
export const PREAMBLE = `set -eu
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
export GIT_AUTHOR_NAME="\${GIT_AUTHOR_NAME:-beam-me-up}" GIT_AUTHOR_EMAIL="\${GIT_AUTHOR_EMAIL:-beam-me-up@localhost}"
export GIT_COMMITTER_NAME="\${GIT_COMMITTER_NAME:-beam-me-up}" GIT_COMMITTER_EMAIL="\${GIT_COMMITTER_EMAIL:-beam-me-up@localhost}"
mkdir -p "\${TMPDIR:-/tmp}"
section() {
  _name=$1; shift
  _tmp=$(mktemp "\${TMPDIR:-/tmp}/beam-me-up.XXXXXX")
  if "$@" >"$_tmp" 2>/dev/null; then
    printf '%s\\n%s\\n' "$_name" "$(wc -c <"$_tmp" | tr -d ' ')"
    cat "$_tmp"
  else
    printf '%s\\n-1\\n' "$_name"
  fi
  printf '\\n'
  rm -f "$_tmp"
}
flag() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }`;

/**
 * Prints `$HOME`, then `missing <tool>` for each argument not on PATH.
 */
export const HOME_SCRIPT = `printf '%s\\n' "$HOME"
for t in "$@"; do command -v "$t" >/dev/null 2>&1 || printf 'missing %s\\n' "$t"; done`;

/**
 * Prints the comparable state of one side as sections.
 * Args: worktree repo branch base projects-dir session-id include-path...
 *
 * Code state is compared by tree hashes, not diffs: \`git stash create\` writes
 * the index and working tree as a commit without touching refs or files, and
 * tree hashes ignore diff settings that differ between machines.
 */
export const STATE_SCRIPT = `wt=$1 repo=$2 branch=$3 base=$4 pdir=$5 sid=$6; shift 6
section probe:wt_dir flag test -d "$wt"
section probe:repo flag git -C "$repo" rev-parse --git-dir
section probe:branch_sha git -C "$repo" rev-parse -q --verify "refs/heads/$branch"
section probe:has_base flag git -C "$repo" cat-file -e "$base^{commit}"
if git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  s=$(git -C "$wt" stash create 2>/dev/null || true)
  section code:head git -C "$wt" rev-parse HEAD
  section code:branch git -C "$wt" symbolic-ref --short HEAD
  section probe:head_tree git -C "$wt" rev-parse "HEAD^{tree}"
  section probe:manifest cat "$(git -C "$wt" rev-parse --absolute-git-dir)/beam-me-up-includes"
  if [ -n "$s" ]; then
    section code:worktree_tree git -C "$wt" rev-parse "$s^{tree}"
    section code:index_tree git -C "$wt" rev-parse "$s^2^{tree}"
  else
    section code:worktree_tree git -C "$wt" rev-parse "HEAD^{tree}"
    section code:index_tree git -C "$wt" rev-parse "HEAD^{tree}"
  fi
  for p in "$@"; do
    if [ -d "$wt/$p" ]; then (cd "$wt" && find "$p" -type f); elif [ -f "$wt/$p" ]; then printf '%s\\n' "$p"; fi
  done | while IFS= read -r f; do section "include:$f" cat "$wt/$f"; done
fi
section "session:$sid.jsonl" cat "$pdir/$sid.jsonl"
if [ -d "$pdir/$sid" ]; then
  (cd "$pdir" && find "$sid" -type f) | while IFS= read -r f; do section "session:$f" cat "$pdir/$f"; done
fi`;

/**
 * Clones the repository if it is missing, fetches origin if the bundle base is
 * missing, and creates the transcript directory. Prints \`has-base\` or \`no-base\`.
 * Args: repo origin-url base projects-dir
 */
export const PREPARE_SCRIPT = `repo=$1 url=$2 base=$3 pdir=$4
mkdir -p "$pdir"
if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  [ -n "$url" ] || { echo needs-seed; exit 0; }
  mkdir -p "$(dirname "$repo")"
  git clone -q "$url" "$repo"
fi
if [ -n "$base" ] && ! git -C "$repo" cat-file -e "$base^{commit}" 2>/dev/null; then
  git -C "$repo" fetch -q origin || true
fi
if [ -n "$base" ] && git -C "$repo" cat-file -e "$base^{commit}" 2>/dev/null; then echo has-base; else echo no-base; fi`;

/**
 * Creates the repository from a full bundle on stdin when the source has no
 * remote to clone from: every local branch, with the main checkout on the
 * source's branch. No remote is added, matching the source.
 * Args: repo main-branch
 */
export const SEED_SCRIPT = `repo=$1 main=$2
[ ! -e "$repo" ] || { echo "$repo exists but is not a Git repository" >&2; exit 2; }
bundle=$(mktemp "\${TMPDIR:-/tmp}/beam-me-up.XXXXXX")
trap 'rm -f "$bundle"' EXIT
cat >"$bundle"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" bundle verify -q "$bundle" >/dev/null 2>&1 || { echo "the seed bundle is incomplete" >&2; exit 3; }
git -C "$repo" fetch -q --update-head-ok "$bundle" "+refs/heads/*:refs/heads/*"
git -C "$repo" symbolic-ref HEAD "refs/heads/$main"
git -C "$repo" reset -q --hard`;

/**
 * Reads a bundle on stdin, creates or reuses the worktree on the source branch at
 * the source HEAD, then reapplies uncommitted changes from the stash commit.
 * Exits 3 when the bundle's prerequisites are missing.
 * Args: repo worktree branch head stash upstream
 */
export const RECEIVE_SCRIPT = `repo=$1 wt=$2 branch=$3 head=$4 stash=$5 upstream=$6
bundle=$(mktemp "\${TMPDIR:-/tmp}/beam-me-up.XXXXXX")
trap 'rm -f "$bundle"' EXIT
cat >"$bundle"
git -C "$repo" bundle verify -q "$bundle" >/dev/null 2>&1 || exit 3
git -C "$repo" fetch -q "$bundle" "+refs/beam-me-up/*:refs/beam-me-up/*"
if [ ! -d "$wt" ]; then
  mkdir -p "$(dirname "$wt")"
  if git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    git -C "$repo" worktree add -q "$wt" "$branch"
  else
    git -C "$repo" worktree add -q -b "$branch" "$wt" "$head"
  fi
fi
[ "$(git -C "$wt" rev-parse HEAD)" = "$head" ] || { echo "$wt is not at $head" >&2; exit 4; }
if [ -n "$upstream" ] && git -C "$repo" rev-parse -q --verify "refs/remotes/$upstream" >/dev/null; then
  git -C "$wt" branch -q --set-upstream-to="$upstream"
fi
if [ -n "$stash" ]; then git -C "$wt" stash apply -q --index "$stash" >/dev/null; fi
git -C "$repo" update-ref -d refs/beam-me-up/head 2>/dev/null || true
git -C "$repo" update-ref -d refs/beam-me-up/stash 2>/dev/null || true`;

/**
 * Extracts a tar from stdin into a directory, creating it first.
 * Args: dir
 */
export const EXTRACT_SCRIPT = `mkdir -p "$1"
tar -xf - -C "$1"`;

/**
 * Records the include checksums from stdin in the worktree's Git directory, so
 * the next move can tell files edited on this machine from stale copies.
 * Args: worktree
 */
export const WRITE_MANIFEST_SCRIPT = `cat >"$(git -C "$1" rev-parse --absolute-git-dir)/beam-me-up-includes"`;

/**
 * Runs \`herdr\` with the given arguments.
 */
export const HERDR_SCRIPT = `exec herdr "$@"`;
