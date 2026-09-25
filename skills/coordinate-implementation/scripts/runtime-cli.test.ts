import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimEngineLease } from "./lib/engine-lease.ts";
import type { HerdrActuator } from "./lib/herdr-actuator.ts";
import { runRuntimeCommand, type RuntimeDeps, type WorkflowModule } from "./lib/runtime-cli.ts";

type Output = { ok: boolean; result: Record<string, any>; errors: Array<{ code: string }> };

const engines: Array<Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(engines.splice(0));
});

const makeRun = (): { runPath: string; scriptPath: string } => {
  const runPath = mkdtempSync(join(tmpdir(), "coordinate-runtime-"));
  writeFileSync(join(runPath, "RESUME.md"), "# Run\n\nSchema version: 2\nPrefix: ex\n");
  const scriptPath = join(runPath, "run.ts");
  writeFileSync(scriptPath, "export default 1;\n");
  return { runPath, scriptPath };
};

const untilStopped: WorkflowModule = {
  kind: "coordinate-workflow",
  run: (context) =>
    Effect.gen(function* () {
      yield* context.emit("attention.question", "02", { id: "02-question-1-1" }, true);
      yield* Effect.never;
    }),
};

const makeDeps = (module: WorkflowModule): { deps: RuntimeDeps; launched: string[] } => {
  const launched: string[] = [];
  const deps: RuntimeDeps = {
    actuator: {
      ensureTab: () => Effect.succeed({ tab_id: "w1:t9", pane_id: "w1:p9", adopted: false }),
      runInPane: (_pane: string, commandLine: string) =>
        Effect.sync(() => {
          launched.push(commandLine);
          const argv = commandLine.split(" ").slice(2);
          engines.push(runRuntimeCommand(argv, deps));
        }),
      readPane: () => Effect.succeed(""),
    } as unknown as HerdrActuator,
    now: () => new Date(),
    host: "host-a",
    pid: process.pid,
    env: { HERDR_WORKSPACE_ID: "w1" },
    skillDir: "/skill",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadWorkflow: async () => module,
    pollMs: 10,
    startTimeoutMs: 2_000,
    heartbeatMs: 20,
  };
  return { deps, launched };
};

const cli = async (argv: string[], deps: RuntimeDeps): Promise<Output> =>
  JSON.parse((await runRuntimeCommand(argv, deps)).stdout) as Output;

describe("runtime CLI", () => {
  it("starts one engine, attaches on repeat, surfaces attention, and stops", async () => {
    const { runPath, scriptPath } = makeRun();
    const { deps, launched } = makeDeps(untilStopped);

    const started = await cli(["start", "--run", runPath, "--script", scriptPath], deps);
    const again = await cli(["start", "--run", runPath, "--script", scriptPath], deps);
    const waited = await cli(
      ["wait", "--run", runPath, "--cursor", "0", "--budget-seconds", "5"],
      deps,
    );
    const stopped = await cli(["stop", "--run", runPath], deps);

    expect(started.result).toEqual({
      engine: "started",
      generation: 1,
      pane: "w1:p9",
      tab: "w1:t9",
      cursor: 0,
    });
    expect(again.result.engine).toBe("running");
    expect(launched.length).toBe(1);
    expect(waited.result.reason).toBe("attention");
    expect(waited.result.attention.map((event: { type: string }) => event.type)).toEqual([
      "attention.question",
    ]);
    expect(stopped.result).toEqual({ engine: "stopped", generation: 1 });
  });

  it("returns at the budget with the persisted cursor when nothing needs attention", async () => {
    const { runPath, scriptPath } = makeRun();
    const quiet: WorkflowModule = { kind: "coordinate-workflow", run: () => Effect.never };
    const { deps } = makeDeps(quiet);
    await cli(["start", "--run", runPath, "--script", scriptPath], deps);

    const waited = await cli(["wait", "--run", runPath, "--budget-seconds", "1"], deps);
    const status = await cli(["status", "--run", runPath], deps);
    await cli(["stop", "--run", runPath], deps);

    expect(waited.result.reason).toBe("budget");
    expect(waited.result.next_cursor).toBe(1);
    expect(status.result.cursor).toBe(1);
    expect(status.result.engine.liveness).toBe("alive");
  });

  it("refuses a changed script until the new hash is accepted", async () => {
    const { runPath, scriptPath } = makeRun();
    const { deps } = makeDeps({ kind: "coordinate-workflow", run: () => Effect.void });
    await cli(["start", "--run", runPath, "--script", scriptPath], deps);
    await Promise.all(engines.splice(0));
    writeFileSync(scriptPath, "export default 2;\n");

    const refused = await cli(["start", "--run", runPath, "--script", scriptPath], deps);
    const sha = new Bun.CryptoHasher("sha256").update("export default 2;\n").digest("hex");
    const accepted = await cli(
      ["start", "--run", runPath, "--script", scriptPath, "--accept-script", sha],
      deps,
    );

    expect(refused.errors.map((error) => error.code)).toEqual(["engine.script_changed"]);
    expect(accepted.result.generation).toBe(2);
  });

  it("reports a stale engine instead of blocking until the budget", async () => {
    const { runPath } = makeRun();
    const { deps } = makeDeps(untilStopped);
    await Effect.runPromise(
      claimEngineLease({
        statePath: join(runPath, "RESUME.md"),
        expectedGeneration: 0,
        pid: 999_999,
        host: "host-b",
        pane: "w1:p2",
        scriptSha256: "x",
        now: new Date(Date.now() - 3_600_000),
      }),
    );

    const waited = await cli(["wait", "--run", runPath, "--budget-seconds", "60"], deps);

    expect(waited.result.reason).toBe("engine");
    expect(waited.result.engine.liveness).toBe("stale");
  });

  it("fences a stale engine with stop --force", async () => {
    const { runPath } = makeRun();
    const { deps } = makeDeps(untilStopped);
    await Effect.runPromise(
      claimEngineLease({
        statePath: join(runPath, "RESUME.md"),
        expectedGeneration: 0,
        pid: 999_999,
        host: "host-b",
        pane: "w1:p2",
        scriptSha256: "x",
        now: new Date(Date.now() - 3_600_000),
      }),
    );

    const stopped = await cli(["stop", "--run", runPath, "--force"], deps);

    expect(stopped.result).toEqual({ engine: "fenced", fenced_generation: 1, generation: 2 });
  });

  it("rejects unknown commands as usage errors", async () => {
    const { deps } = makeDeps(untilStopped);

    const output = await runRuntimeCommand(["launch"], deps);

    expect(output.exitCode).toBe(2);
  });
});
