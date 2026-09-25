import { describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateProcess } from "./lib/gate-runner.ts";

const cwd = (): string => mkdtempSync(join(tmpdir(), "coordinate-gate-"));

const limits = { timeoutMs: 5_000, maxOutputBytes: 1_000 };

describe("gate process runner", () => {
  it("classifies exit zero as passed and captures output", async () => {
    const run = await Effect.runPromise(
      runGateProcess(
        { name: "echo", argv: ["bun", "-e", "console.log('ok')"] },
        cwd(),
        process.env,
        limits,
      ),
    );

    expect([run.status, run.exitCode, run.stdout]).toEqual(["passed", 0, "ok\n"]);
  });

  it("classifies a nonzero exit as a gate failure", async () => {
    const run = await Effect.runPromise(
      runGateProcess(
        { name: "fail", argv: ["bun", "-e", "process.exit(3)"] },
        cwd(),
        process.env,
        limits,
      ),
    );

    expect([run.status, run.exitCode]).toEqual(["failed", 3]);
  });

  it("classifies a missing executable as an infrastructure failure", async () => {
    const run = await Effect.runPromise(
      runGateProcess(
        { name: "missing", argv: ["coordinate-no-such-binary"] },
        cwd(),
        process.env,
        limits,
      ),
    );

    expect(run.status).toBe("infrastructure_failed");
  });

  it("kills the process group on timeout", async () => {
    const dir = cwd();
    const marker = join(dir, "late");
    const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 800)`;

    const run = await Effect.runPromise(
      runGateProcess(
        {
          name: "slow",
          argv: [
            "bun",
            "-e",
            `require("node:child_process").spawn("bun", ["-e", ${JSON.stringify(script)}], { stdio: "ignore" }); setTimeout(() => {}, 10000)`,
          ],
        },
        dir,
        process.env,
        { timeoutMs: 200, maxOutputBytes: 1_000 },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(run.status).toBe("infrastructure_failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("kills the gate when the engine interrupts it", async () => {
    const dir = cwd();
    const marker = join(dir, "late");

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runGateProcess(
            {
              name: "slow",
              argv: [
                "bun",
                "-e",
                `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 800)`,
              ],
            },
            dir,
            process.env,
            limits,
          ),
        );
        yield* Effect.sleep(200);
        yield* Fiber.interrupt(fiber);
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(existsSync(marker)).toBe(false);
  });
});
