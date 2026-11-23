import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { cleanGitEnv } from "./git-env.ts";
import { failureOf, initRepo, tempDir } from "./fixture.ts";
import { fakeProc, Proc, type RunOutput, SpawnError } from "./proc.ts";
import { preflightRemote, remoteProc } from "./remote-launch.ts";

// A local Proc that answers `hc exec --on <m> --json ... -- argv` by running argv here, as hc does
// on the machine, and printing hc's JSON result.
const hereAsRemote: Proc["Service"] = {
  run: (argv) =>
    Effect.sync((): RunOutput => {
      const command = argv.slice(argv.indexOf("--") + 1);
      const done = Bun.spawnSync(command, {
        env: cleanGitEnv(process.env),
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

describe("remoteProc", () => {
  it("runs in the working folder there and returns the program's exit code and output", async () => {
    const dir = tempDir();
    try {
      const out = await Effect.runPromise(
        remoteProc("strix", hereAsRemote).run(["sh", "-c", "pwd; exit 3"], {
          cwd: dir,
          env: undefined,
          timeoutMs: 10_000,
        }),
      );
      expect(out).toEqual({ exitCode: 3, stdout: `${dir}\n`, stderr: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails naming the working folder when it is missing there, unlike a git failure", async () => {
    const dir = tempDir();
    try {
      const missing = join(dir, "gone");
      const failure = await Effect.runPromise(
        remoteProc("strix", hereAsRemote)
          .run(["git", "status"], { cwd: missing, env: undefined, timeoutMs: 10_000 })
          .pipe(Effect.flip),
      );
      expect([failure instanceof SpawnError, failure.message]).toEqual([
        true,
        `working folder ${missing} does not exist on strix`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A machine whose login PATH holds only the named tools (a stand-in harness among them): `hc exec`
// runs the preflight script here with that PATH, so its own checks decide.
const machineWith = (dir: string, tools: readonly string[]) => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of tools) {
    if (tool === "claude") {
      writeFileSync(join(bin, tool), "#!/bin/sh\n", { mode: 0o755 });
      continue;
    }
    const found = Bun.which(tool);
    if (found !== null) symlinkSync(found, join(bin, tool));
  }
  return fakeProc((argv) => {
    const script = argv.at(-1) ?? "";
    const done = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: { PATH: bin, HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: done.exitCode, stdout: done.stdout.toString(), stderr: "" };
  });
};

const BASE_TOOLS = ["tar", "gzip", "base64", "fold", "mktemp", "shasum", "ps", "ls"];
// The remote process scan reads Linux /proc; this test machine may have none.
const noProc = existsSync("/proc/self") ? "" : ", and Linux /proc, which the process scan reads";

describe("preflightRemote", () => {
  it("passes a machine with the harness, git and the base tools, unless it has no /proc", async () => {
    const dir = tempDir();
    try {
      const repo = initRepo();
      const fake = machineWith(dir, ["claude", "git", ...BASE_TOOLS]);
      const got = await failureOf(preflightRemote("strix", "claude", repo), fake.layer);
      rmSync(repo, { recursive: true, force: true });
      expect(got === "no failure" ? got : got.message).toBe(
        noProc === ""
          ? "no failure"
          : `strix lacks Linux /proc, which the process scan reads; setting up strix belongs to strix's own domain, so file it there`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses naming every base tool copy-back, fetch and the process scan need", async () => {
    const dir = tempDir();
    try {
      const fake = machineWith(dir, ["claude", "git"]);
      const failure = await failureOf(preflightRemote("strix", "claude", dir), fake.layer);
      expect(failure === "no failure" ? failure : failure.message).toBe(
        `strix lacks tar, gzip, base64, fold, mktemp, ps, and sha256sum or shasum on its login PATH${noProc}; setting up strix belongs to strix's own domain, so file it there`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
