import { Effect, Schema } from "effect";
import type { Backlog } from "./backlog-store/schema.ts";
import { Refused } from "./fleet.ts";
import type { Harness } from "./harness.ts";
import * as hc from "./herdr.ts";
import { DEFAULT_TIMEOUT_MS, type Proc, SpawnError } from "./proc.ts";

// A remote launch on another Herdr machine: everything there goes through `hc exec --on` and
// `hc file write --on`, so the machine needs only the harness and git.

/**
 * Quote a string as one POSIX shell word.
 * @param value Any string.
 * @returns The quoted word.
 */
const word = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Remote scripts run without the Mac's repository-location variables.
const UNSET_GIT =
  "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES";

/**
 * The recorded checkout of a repo on another machine, or a refusal naming the missing entry.
 * @param boundary The domain's Boundary.
 * @param repo The repo's main checkout on this machine (the owned path).
 * @param machine Herdr machine name.
 * @returns The absolute checkout path on that machine.
 */
export const remoteCheckout = Effect.fn("remoteCheckout")(function* (
  boundary: Backlog["boundary"],
  repo: string,
  machine: string,
) {
  const checkout = boundary.checkouts?.[repo]?.[machine];
  if (checkout !== undefined) return checkout;
  return yield* new Refused({
    message: `${repo} has no checkout on ${machine}; record one with coordinate backlog boundary add ${repo} --machine ${machine} --checkout <path>`,
  });
});

/**
 * Confirm the harness and git are on the machine's login PATH and the checkout is a Git
 * repository there. A missing piece refuses the launch; an unreachable machine fails the check.
 * @param machine Herdr machine name.
 * @param harness Harness to launch.
 * @param checkout Recorded checkout on that machine.
 * @returns The machine's login shell, for the launch.
 */
export const preflightRemote = Effect.fn("preflightRemote")(function* (
  machine: string,
  harness: Harness,
  checkout: string,
) {
  const out = yield* hc.execOn(
    machine,
    [
      UNSET_GIT,
      `for tool in ${harness} git; do command -v "$tool" >/dev/null 2>&1 || echo "missing $tool"; done`,
      `if git -C ${word(checkout)} rev-parse --git-dir >/dev/null 2>&1; then echo repo; fi`,
      'echo "shell $SHELL"',
    ].join("\n"),
    30,
  );
  const lines = out.split("\n");
  const missing = lines.flatMap((line) => (line.startsWith("missing ") ? [line.slice(8)] : []));
  if (missing.length > 0)
    return yield* new Refused({
      message: `${machine} lacks ${missing.join(" and ")} on its login PATH; setting up ${machine} belongs to ${machine}'s own domain, so file it there`,
    });
  if (!lines.includes("repo"))
    return yield* new Refused({
      message: `${checkout} on ${machine} is not a Git checkout; fix its entry with coordinate backlog boundary rm and add`,
    });
  const shell = lines.find((line) => line.startsWith("shell "))?.slice(6) ?? "";
  return shell === "" ? "/bin/sh" : shell;
});

/**
 * Make a delegate's worktree with git on the machine, inside its checkout, refusing a path or
 * branch that already exists or a base that is not a commit. Adds `.scratch/` to the repo's
 * info/exclude there when git does not already ignore it.
 * @param machine Herdr machine name.
 * @param input Checkout, delegate name, branch and optional base.
 * @returns The worktree path, the base name and commit, and whether the exclude was added.
 */
export const remoteWorktree = Effect.fn("remoteWorktree")(function* (
  machine: string,
  input: { checkout: string; name: string; branch: string; base: string | undefined },
) {
  const cwd = `${input.checkout}/.claude/worktrees/${input.name}`;
  const base =
    input.base === undefined
      ? '"$(git symbolic-ref --quiet --short HEAD || echo HEAD)"'
      : word(input.base);
  const out = yield* hc.execOn(
    machine,
    [
      UNSET_GIT,
      `cd ${word(input.checkout)} || exit 3`,
      `if [ -e ${word(cwd)} ]; then echo exists; exit 0; fi`,
      `if git show-ref --verify --quiet ${word(`refs/heads/${input.branch}`)}; then echo branch-exists; exit 0; fi`,
      `base=${base}`,
      'sha=$(git rev-parse --verify --quiet "$base^{commit}") || { echo "no-base $base"; exit 0; }',
      `git worktree add -q ${word(cwd)} -b ${word(input.branch)} "$sha" >&2 || exit 4`,
      'echo "made $sha $base"',
      `if ! git -C ${word(cwd)} check-ignore -q .scratch/BRIEF.md; then`,
      '  exclude="$(git rev-parse --path-format=absolute --git-common-dir)/info/exclude"',
      '  mkdir -p "$(dirname "$exclude")"',
      '  if [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude")" ]; then printf \'\\n\' >> "$exclude"; fi',
      "  printf '.scratch/\\n' >> \"$exclude\"",
      "  echo excluded",
      "fi",
    ].join("\n"),
    60,
  );
  const lines = out.split("\n");
  if (lines.includes("exists"))
    return yield* new Refused({ message: `${cwd} already exists on ${machine}` });
  if (lines.includes("branch-exists"))
    return yield* new Refused({
      message: `branch ${input.branch} already exists in ${input.checkout} on ${machine}`,
    });
  const noBase = lines.find((line) => line.startsWith("no-base "));
  if (noBase !== undefined)
    return yield* new Refused({
      message: `${noBase.slice(8)} is not a commit in ${input.checkout} on ${machine}`,
    });
  const made = lines.find((line) => line.startsWith("made "))?.split(" ") ?? [];
  return {
    cwd,
    baseSha: made[1] ?? "",
    base: made.slice(2).join(" "),
    excluded: lines.includes("excluded"),
  };
});

/**
 * The main checkout a folder on another machine belongs to, read by git there.
 * @param machine Herdr machine name.
 * @param folder A worktree or checkout on that machine.
 * @returns Its main checkout's path there, or undefined when git does not know the folder.
 */
export const remoteMainCheckout = Effect.fn("remoteMainCheckout")(function* (
  machine: string,
  folder: string,
) {
  const out = yield* hc.execOn(
    machine,
    [
      UNSET_GIT,
      `git -C ${word(folder)} rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true`,
    ].join("\n"),
    30,
  );
  const common = out.trim();
  if (common === "") return undefined;
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : common;
});

/**
 * Whether a folder exists on another machine.
 * @param machine Herdr machine name.
 * @param path Absolute path there.
 * @returns True when it is a folder there.
 */
export const remoteFolderExists = Effect.fn("remoteFolderExists")(function* (
  machine: string,
  path: string,
) {
  const out = yield* hc.execOn(machine, `if [ -d ${word(path)} ]; then echo present; fi`, 30);
  return out.split("\n").includes("present");
});

const Executed = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  timed_out: Schema.Boolean,
});

/**
 * A `Proc` that runs every program on another Herdr machine through `hc exec --on`, in its login
 * shell and the given working folder there, with git's repository-location variables unset. Its
 * exit code and output come back exactly, so the git helpers judge a remote checkout as they judge
 * a local one. When the machine does not answer, the run fails with a `SpawnError`.
 * @param machine Herdr machine name.
 * @param local The `Proc` that runs `hc` here.
 * @returns The remote runner.
 */
export const remoteProc = (machine: string, local: Proc["Service"]): Proc["Service"] => ({
  run: (argv, options) =>
    Effect.gen(function* () {
      const timeoutS = Math.min(
        600,
        Math.max(1, Math.ceil((options?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)),
      );
      const failed = (message: string) => new SpawnError({ argv: [...argv], message });
      const out = yield* local.run(
        [
          "hc",
          "exec",
          "--on",
          machine,
          "--json",
          "--timeout",
          String(timeoutS),
          "--",
          "sh",
          "-lc",
          `${UNSET_GIT}; if [ -n "$1" ]; then cd "$1" || exit 128; fi; shift; exec "$@"`,
          "sh",
          options?.cwd ?? "",
          ...argv,
        ],
        { timeoutMs: (timeoutS + 10) * 1000, env: options?.env },
      );
      if (out.exitCode !== 0)
        return yield* failed(
          `hc exec on ${machine} failed: ${(out.stderr || out.stdout).trim().slice(0, 300)}`,
        );
      const parsed = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Executed)(JSON.parse(out.stdout)),
        catch: () => failed(`hc exec on ${machine} printed no result`),
      });
      if (parsed.timed_out || parsed.code === null)
        return yield* failed(`${argv[0]} timed out on ${machine} after ${timeoutS}s`);
      return {
        exitCode: parsed.code,
        stdout: Buffer.from(parsed.stdout, "base64").toString("utf8"),
        stderr: Buffer.from(parsed.stderr, "base64").toString("utf8"),
      };
    }),
});

/**
 * Where a remote delegate appends its finding and notify lines: `OUTBOX.jsonl` in its scratch
 * folder on its own machine.
 * @param worktree The delegate's worktree on that machine.
 * @returns The absolute outbox path there.
 */
export const outboxPath = (worktree: string): string => `${worktree}/.scratch/OUTBOX.jsonl`;

/**
 * The brief a remote delegate reads: the coordinator's brief plus an Outbox section that replaces
 * the coordinate CLI, which its machine does not have.
 * @param brief The brief's text.
 * @param machine The delegate's Herdr machine.
 * @param outbox Absolute outbox path there.
 * @returns The brief to write on that machine.
 */
export const remoteBrief = (brief: string, machine: string, outbox: string): string =>
  [
    brief.endsWith("\n") || brief === "" ? brief : `${brief}\n`,
    "## Outbox",
    "",
    `This delegate runs on ${machine}, which has no coordinate CLI. Do not run \`coordinate finding add\` or \`coordinate notify\`: wherever this brief says to run one, append one JSON object on its own line to \`${outbox}\` instead, and never change earlier lines. Your coordinator's watcher reads the file and applies each line once.`,
    "",
    '- A finding: `{"type":"finding","kind":"issue","title":"<title>","from":"<item id>","detail":"<what>","path":"<file or folder>"}`. `kind` is `issue` or `opportunity`; `from`, `detail` and `path` are optional.',
    '- The notify: `{"type":"notify","text":"<name>: <status>, report at <absolute report path>"}`.',
    "",
  ].join("\n");
