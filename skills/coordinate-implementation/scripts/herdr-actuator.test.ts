import { describe, expect, it } from "bun:test";
import { Effect, Result } from "effect";
import {
  deliveryPromptArgs,
  makeHerdrActuator,
  type CommandRunner,
  type HerdrCommandResult,
} from "./lib/herdr-actuator.ts";

type Call = { command: string; args: string[] };

const scripted = (
  respond: (args: string[]) => HerdrCommandResult,
): { runner: CommandRunner; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push({ command, args });
      return respond(args);
    },
  };
};

const ok = (result: unknown): HerdrCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ id: "cli", result }),
  stderr: "",
});

describe("Herdr actuator", () => {
  it("adopts an existing tab with the exact label instead of creating another", async () => {
    const { runner, calls } = scripted((args) =>
      args[0] === "tab"
        ? ok({ tabs: [{ tab_id: "w1:t4", label: "implement ex 02 outbox" }] })
        : ok({ panes: [{ pane_id: "w1:p7", tab_id: "w1:t4" }] }),
    );

    const tab = await Effect.runPromise(
      makeHerdrActuator(runner).ensureTab({
        workspace: "w1",
        cwd: "/repo",
        label: "implement ex 02 outbox",
        env: {},
      }),
    );

    expect(tab).toEqual({ tab_id: "w1:t4", pane_id: "w1:p7", adopted: true });
    expect(calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual(["tab list", "pane list"]);
  });

  it("creates a missing tab without focus and returns its root pane", async () => {
    const { runner, calls } = scripted((args) =>
      args[1] === "list"
        ? ok({ tabs: [] })
        : ok({ tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p12" } }),
    );

    const tab = await Effect.runPromise(
      makeHerdrActuator(runner).ensureTab({
        workspace: "w1",
        cwd: "/repo",
        label: "engine ex",
        env: { COORDINATE_ENGINE: "1" },
      }),
    );

    expect(tab).toEqual({ tab_id: "w1:t9", pane_id: "w1:p12", adopted: false });
    expect(calls[1]!.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "engine ex",
      "--env",
      "COORDINATE_ENGINE=1",
      "--no-focus",
    ]);
  });

  it("treats an already absent pane as closed", async () => {
    const { runner } = scripted(() => ({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":{"code":"pane_not_found"}}',
    }));

    const outcome = await Effect.runPromise(makeHerdrActuator(runner).closePane("w1:p3"));

    expect(outcome).toBe("absent");
  });

  it("delivers prompts without waiting for the whole turn", async () => {
    const { runner, calls } = scripted(() => ok({}));

    await Effect.runPromise(makeHerdrActuator(runner).deliverPrompt("ex-02", "--rebase now"));

    expect(calls[0]!.args).toEqual(deliveryPromptArgs("ex-02", "--rebase now"));
  });

  it("refuses to execute non-Herdr argv", async () => {
    const { runner, calls } = scripted(() => ok({}));

    const outcome = await Effect.runPromise(
      Effect.result(makeHerdrActuator(runner).run({ command: "sh", args: ["-c", "true"] })),
    );

    expect(Result.isFailure(outcome) ? outcome.failure.issue.code : "ok").toBe(
      "herdr.command_unsupported",
    );
    expect(calls.length).toBe(0);
  });
});
