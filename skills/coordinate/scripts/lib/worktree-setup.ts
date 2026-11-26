import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { Refused } from "./fleet.ts";
import { cleanGitEnv } from "./git-env.ts";
import * as hc from "./herdr.ts";
import type { Proc } from "./proc.ts";
import { remoteProc } from "./remote-launch.ts";

// A repo declares the commands that prepare a fresh worktree (install dependencies, hooks) in a
// committed file; `delegate --repo` runs them in the new worktree, on whichever machine it is,
// before it starts the harness.

/**
 * The declaration, relative to the worktree: `{"worktreeSetup": ["<command>", ...]}`.
 */
export const SETUP_FILE = ".claude/coordinate.json";

/**
 * Where each command's output goes, relative to the worktree.
 */
export const SETUP_LOG = ".scratch/setup.log";

/**
 * Each command's budget: Herdr's own limit for a remote `hc exec`.
 */
export const SETUP_TIMEOUT_MS = 600_000;

const Declaration = Schema.Struct({
  worktreeSetup: Schema.optionalKey(Schema.Array(Schema.String)),
});

// Runs "$1" in the worktree, appending the command line, its output and its exit status to the log.
const STEP = [
  "mkdir -p .scratch || exit 1",
  `{ printf '$ %s\\n' "$1"; sh -c "$1"; } >>${SETUP_LOG} 2>&1 </dev/null`,
  "status=$?",
  `printf '[exit %s]\\n\\n' "$status" >>${SETUP_LOG}`,
  'exit "$status"',
].join("\n");

/**
 * Where a worktree lives: how to run a program there and read a file there (undefined when the
 * file does not exist).
 */
export type SetupHost = {
  run: Proc["Service"];
  read: (path: string) => Effect.Effect<string | undefined, hc.HerdrError, Proc>;
};

/**
 * This machine as a setup host.
 * @param local This machine's `Proc`.
 * @returns The host.
 */
export const localSetupHost = (local: Proc["Service"]): SetupHost => ({
  run: local,
  read: (path) =>
    Effect.promise(() => readFile(path, "utf8").catch((): string | undefined => undefined)),
});

/**
 * Another Herdr machine as a setup host: programs run through `hc exec --on`, files are read
 * with `hc file read --on`.
 * @param machine Herdr machine name.
 * @param local The `Proc` that runs `hc` here.
 * @returns The host.
 */
export const remoteSetupHost = (machine: string, local: Proc["Service"]): SetupHost => ({
  run: remoteProc(machine, local),
  read: (path) => hc.readFileOn(machine, path),
});

/**
 * The setup commands a declaration lists.
 * @param text The declaration file's text.
 * @returns The commands in order, or why the file is not a declaration.
 */
export const parseSetup = (text: string): { commands: string[] } | { problem: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "is not JSON" };
  }
  let commands: readonly string[];
  try {
    commands = Schema.decodeUnknownSync(Declaration)(parsed).worktreeSetup ?? [];
  } catch {
    return { problem: 'needs "worktreeSetup" as a list of command strings' };
  }
  if (commands.some((command) => command.trim() === ""))
    return { problem: 'has a blank "worktreeSetup" command' };
  return { commands: [...commands] };
};

/**
 * Run the worktree's declared setup commands in order, each in the worktree with its own timeout
 * and its output appended to `.scratch/setup.log`. No declaration runs nothing. A malformed
 * declaration, or a command that fails or times out, refuses the launch, naming the command and
 * the log; the worktree stays.
 * @param host Where the worktree is: `localSetupHost` or `remoteSetupHost`.
 * @param worktree The new worktree's absolute path there.
 * @param where Suffix naming the machine in messages (" on <machine>"), or "" for this one.
 * @param timeoutMs Budget per command.
 * @returns Lines to print.
 */
export const runWorktreeSetup = Effect.fn("runWorktreeSetup")(function* (
  host: SetupHost,
  worktree: string,
  where: string,
  timeoutMs: number = SETUP_TIMEOUT_MS,
) {
  const text = yield* host.read(`${worktree}/${SETUP_FILE}`);
  if (text === undefined) return [];
  const declaration = `${worktree}/${SETUP_FILE}${where}`;
  const parsed = parseSetup(text);
  if ("problem" in parsed)
    return yield* new Refused({
      message: `${declaration} ${parsed.problem}; the worktree ${worktree} stays and no harness was started`,
    });
  const { commands } = parsed;
  if (commands.length === 0) return [];
  const log = `${worktree}/${SETUP_LOG}`;
  const env = cleanGitEnv();
  for (const [index, command] of commands.entries()) {
    const failed = (why: string) =>
      new Refused({
        message: `worktree setup command ${index + 1} of ${commands.length} (${command}) ${why}; output in ${log}${where}; the worktree ${worktree} stays and no harness was started`,
      });
    const out = yield* host.run
      .run(["sh", "-c", STEP, "sh", command], { cwd: worktree, timeoutMs, env })
      .pipe(Effect.catchTag("SpawnError", (error) => Effect.fail(failed(error.message))));
    if (out.exitCode !== 0) return yield* failed(`exited ${out.exitCode}`);
  }
  return [
    `ran ${commands.length} worktree setup ${commands.length === 1 ? "command" : "commands"} from ${SETUP_FILE}${where}, log ${log}`,
  ];
});
