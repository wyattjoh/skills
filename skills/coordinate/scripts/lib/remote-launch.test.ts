import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { tempDir } from "./fixture.ts";
import { cleanGitEnv } from "./git-env.ts";
import { Proc, type RunOutput } from "./proc.ts";
import { remoteProc } from "./remote-launch.ts";

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
      expect([failure._tag, failure.message]).toEqual([
        "SpawnError",
        `working folder ${missing} does not exist on strix`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
