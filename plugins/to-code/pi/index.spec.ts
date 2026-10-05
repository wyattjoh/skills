import { describe, expect, test } from "bun:test";

import type { RunOutput, Runner } from "../hooks/core/herdr.ts";
import { createFleetExtension } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError: boolean }>;
};

const createFakePi = () => {
  const tools: Tool[] = [];
  const handlers = new Map<string, Handler>();
  const messages: { content: string; options: unknown }[] = [];
  return {
    pi: {
      registerFlag: () => undefined,
      getFlag: () => undefined,
      registerTool: (tool: Tool) => tools.push(tool),
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      sendMessage: (message: { content: string }, options: unknown) =>
        messages.push({ content: message.content, options }),
    },
    tools,
    handlers,
    messages,
  };
};

const list = (status: string, seq: number): RunOutput => ({
  exitCode: 0,
  stdout: JSON.stringify({
    result: {
      agents: [
        {
          pane_id: "w1:p2",
          workspace_id: "w1",
          agent: "claude",
          agent_status: status,
          display_agent: "impl",
          state_change_seq: seq,
        },
      ],
    },
  }),
  stderr: "",
});

const ctx = { hasUI: false, ui: {} };

const load = (
  runner: Runner,
  env: Record<string, string | undefined> = { HERDR_ENV: "1", HERDR_PANE_ID: "self" },
) => {
  const fake = createFakePi();
  createFleetExtension({ runner, env, intervalMs: 60_000 })(fake.pi as never);
  return fake;
};

const tool = (fake: ReturnType<typeof createFakePi>, name: string) => {
  const found = fake.tools.find((one) => one.name === name);
  if (found === undefined) throw new Error(`${name} is not registered`);
  return found;
};

describe("pi fleet extension", () => {
  test("does nothing outside herdr", () => {
    const fake = load(async () => list("idle", 1), {});
    expect(fake.tools.length).toBe(0);
    expect(fake.handlers.size).toBe(0);
  });

  test("registers the fleet tools", () => {
    const fake = load(async () => list("idle", 1));
    expect(fake.tools.map((one) => one.name)).toEqual([
      "fleet_start_ticket",
      "fleet_start_review",
      "fleet_finish_ticket",
      "fleet_resume",
      "fleet_restart_worker",
      "fleet_setup",
      "fleet_status",
      "fleet_wait",
      "fleet_read",
      "fleet_send",
      "fleet_watch",
    ]);
  });

  test("fleet_status returns the listing as text", async () => {
    const fake = load(async () => list("working", 3));
    const result = await tool(fake, "fleet_status").execute(
      "call-1",
      {},
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      {
        pane: "w1:p2",
        name: "impl",
        harness: "claude",
        status: "working",
        cwd: "",
        workspace: "w1",
        seq: 3,
        watched: false,
      },
    ]);
  });

  test("setup and scoped status work through the pi tool adapter", async () => {
    const fake = load(async () => list("working", 3));
    const setup = await tool(fake, "fleet_setup").execute("setup", { panes: ["w1:p2"] });
    expect(setup.isError).toBe(false);
    const { fleetId } = JSON.parse(setup.content[0]?.text ?? "");
    expect(fleetId).toBe("fleet-1");
    const status = await tool(fake, "fleet_status").execute("status", { fleetId });
    expect(status.isError).toBe(false);
    expect(
      JSON.parse(status.content[0]?.text ?? "").map((agent: { pane: string }) => agent.pane),
    ).toEqual(["w1:p2"]);
    const rejected = await tool(fake, "fleet_read").execute("read", { fleetId, pane: "w2:p9" });
    expect(rejected.isError).toBe(true);
  });

  test("nudges once after a bash herdr dispatch with nothing watched", async () => {
    const fake = load(async () => list("working", 3));
    await fake.handlers.get("agent_start")?.({}, ctx);
    await fake.handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "herdr agent prompt w1:p2 go" } },
      ctx,
    );
    await fake.handlers.get("agent_end")?.({}, ctx);
    await fake.handlers.get("agent_end")?.({}, ctx);
    expect(fake.messages.length).toBe(1);
    expect(fake.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("records a bash prompt by its pane, so the nudge names it", async () => {
    const fake = load(async () => list("working", 3));
    await fake.handlers.get("agent_start")?.({}, ctx);
    await fake.handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "herdr agent prompt impl go" } },
      ctx,
    );
    await fake.handlers.get("agent_end")?.({}, ctx);
    expect(
      fake.messages[0]?.content.startsWith("[to-code fleet] This turn dispatched work (w1:p2) but"),
    ).toBe(true);
  });

  test("a new run starts with a clean stop-gate record", async () => {
    const fake = load(async () => list("working", 3));
    await fake.handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "herdr agent prompt w1:p2 go" } },
      ctx,
    );
    await fake.handlers.get("agent_start")?.({}, ctx);
    await fake.handlers.get("agent_end")?.({}, ctx);
    expect(fake.messages).toEqual([]);
  });

  test("stays quiet when the dispatch went through fleet_send", async () => {
    const fake = load(async (argv) =>
      argv[2] === "list" ? list("idle", 3) : { exitCode: 0, stdout: "{}", stderr: "" },
    );
    await tool(fake, "fleet_send").execute(
      "call-1",
      { pane: "w1:p2", text: "go" },
      undefined,
      undefined,
      ctx,
    );
    await fake.handlers.get("agent_end")?.({}, ctx);
    expect(fake.messages).toEqual([]);
  });
});
