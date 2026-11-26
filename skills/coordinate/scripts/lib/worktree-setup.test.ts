import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { tempDir } from "./fixture.ts";
import { Refused } from "./fleet.ts";
import { cleanGitEnv } from "./git-env.ts";
import { Proc, realProc } from "./proc.ts";
import {
  localSetupHost,
  parseSetup,
  remoteSetupHost,
  runWorktreeSetup,
  SETUP_FILE,
  type SetupHost,
} from "./worktree-setup.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});

const worktree = (declaration: unknown): string => {
  const made = tempDir("coordinate-setup-");
  dirs.push(made);
  if (declaration !== undefined) {
    mkdirSync(join(made, ".claude"));
    writeFileSync(
      join(made, SETUP_FILE),
      typeof declaration === "string" ? declaration : JSON.stringify(declaration),
    );
  }
  return made;
};

// Herdr's reads go through the same fake hc as its exec.
const provided = <A, E>(effect: Effect.Effect<A, E, Proc>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(Proc, fakeHerdr)));

const run = (host: SetupHost, dir: string, where = "", timeoutMs?: number) =>
  provided(runWorktreeSetup(host, dir, where, timeoutMs));

const refusal = (host: SetupHost, dir: string, where = "", timeoutMs?: number) =>
  provided(
    runWorktreeSetup(host, dir, where, timeoutMs).pipe(
      Effect.flip,
      Effect.map((error) => [error instanceof Refused, error.message]),
    ),
  );

const log = (dir: string): string => readFileSync(join(dir, ".scratch", "setup.log"), "utf8");

// Answers `hc exec --on <machine> --json --timeout <s> -- sh -lc <wrapper> sh <cwd> <argv...>` the
// way Herdr does, running the wrapper here (without a login shell) and base64-encoding its output,
// and `hc file read --on <machine> <path> --json` from this filesystem.
const fakeHerdr: Proc["Service"] = {
  run: (argv) =>
    Effect.sync(() => {
      if (argv[0] === "hc" && argv[1] === "file" && argv[2] === "read") {
        const path = argv[5] ?? "";
        if (!existsSync(path))
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { kind: "not_found", message: "no such file" } }),
          };
        const text = readFileSync(path, "utf8");
        const lines = text.split("\n").length;
        return { exitCode: 0, stdout: JSON.stringify({ text, last: lines, lines }), stderr: "" };
      }
      if (argv[0] !== "hc" || argv[1] !== "exec") throw new Error(`unexpected ${argv.join(" ")}`);
      const [, wrapper, ...rest] = argv.slice(argv.indexOf("--") + 2);
      const done = Bun.spawnSync(["sh", "-c", wrapper ?? "", ...rest], {
        env: cleanGitEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          code: done.exitCode,
          stdout: done.stdout.toString("base64"),
          stderr: done.stderr.toString("base64"),
          timed_out: false,
        }),
        stderr: "",
      };
    }),
};

describe("parseSetup", () => {
  it.each([
    [
      '{"worktreeSetup":["bun install","lefthook install"]}',
      { commands: ["bun install", "lefthook install"] },
    ],
    ['{"other":true}', { commands: [] }],
    ["not json", { problem: "is not JSON" }],
    [
      '{"worktreeSetup":"bun install"}',
      { problem: 'needs "worktreeSetup" as a list of command strings' },
    ],
    ['{"worktreeSetup":["bun install"," "]}', { problem: 'has a blank "worktreeSetup" command' }],
  ])("reads %s", (text, expected) => {
    expect(parseSetup(text)).toEqual(expected);
  });
});

describe("runWorktreeSetup on this machine", () => {
  const here = localSetupHost(realProc);

  it("runs nothing and makes no log without a declaration", async () => {
    const dir = worktree(undefined);
    expect(await run(here, dir)).toEqual([]);
    expect(existsSync(join(dir, ".scratch"))).toBe(false);
  });

  it("runs each command in order in the worktree and logs its output", async () => {
    const dir = worktree({ worktreeSetup: ["echo one > first.txt", "cat first.txt; echo two"] });
    expect(await run(here, dir)).toEqual([
      `ran 2 worktree setup commands from ${SETUP_FILE}, log ${dir}/.scratch/setup.log`,
    ]);
    expect(log(dir)).toBe(
      "$ echo one > first.txt\n[exit 0]\n\n$ cat first.txt; echo two\none\ntwo\n[exit 0]\n\n",
    );
  });

  it("refuses at the first failing command, naming it and the log, and runs no later one", async () => {
    const dir = worktree({ worktreeSetup: ["echo ok", "echo broken >&2; exit 7", "touch later"] });
    expect(await refusal(here, dir)).toEqual([
      true,
      `worktree setup command 2 of 3 (echo broken >&2; exit 7) exited 7; output in ${dir}/.scratch/setup.log; the worktree ${dir} stays and no harness was started`,
    ]);
    expect(log(dir)).toBe(
      "$ echo ok\nok\n[exit 0]\n\n$ echo broken >&2; exit 7\nbroken\n[exit 7]\n\n",
    );
    expect(existsSync(join(dir, "later"))).toBe(false);
  });

  it("refuses a command that runs past its timeout", async () => {
    const dir = worktree({ worktreeSetup: ["sleep 5"] });
    expect(await refusal(here, dir, "", 200)).toEqual([
      true,
      `worktree setup command 1 of 1 (sleep 5) sh timed out after 0.2s; output in ${dir}/.scratch/setup.log; the worktree ${dir} stays and no harness was started`,
    ]);
  });

  it("refuses a malformed declaration", async () => {
    const dir = worktree('{"worktreeSetup":[1]}');
    expect(await refusal(here, dir)).toEqual([
      true,
      `${dir}/${SETUP_FILE} needs "worktreeSetup" as a list of command strings; the worktree ${dir} stays and no harness was started`,
    ]);
  });
});

describe("runWorktreeSetup on another machine", () => {
  const strix = remoteSetupHost("strix", fakeHerdr);

  it("runs the commands there through hc exec and logs there", async () => {
    const dir = worktree({ worktreeSetup: ["pwd"] });
    expect(await run(strix, dir, " on strix")).toEqual([
      `ran 1 worktree setup command from ${SETUP_FILE} on strix, log ${dir}/.scratch/setup.log`,
    ]);
    expect(log(dir)).toBe(`$ pwd\n${dir}\n[exit 0]\n\n`);
  });

  it("refuses a failing command there, naming the machine", async () => {
    const dir = worktree({ worktreeSetup: ["false"] });
    expect(await refusal(strix, dir, " on strix")).toEqual([
      true,
      `worktree setup command 1 of 1 (false) exited 1; output in ${dir}/.scratch/setup.log on strix; the worktree ${dir} stays and no harness was started`,
    ]);
  });

  it("runs nothing without a declaration there", async () => {
    expect(await run(strix, worktree(undefined), " on strix")).toEqual([]);
  });
});
