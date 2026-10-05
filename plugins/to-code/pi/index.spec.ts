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
  const flags: Record<string, string> = {};
  const handlers = new Map<string, Handler>();
  const registrations: string[] = [];
  const messages: { content: string; options: unknown }[] = [];
  return {
    pi: {
      registerFlag: () => undefined,
      getFlag: (name: string) => flags[name],
      registerTool: (tool: Tool) => tools.push(tool),
      on: (event: string, handler: Handler) => {
        registrations.push(event);
        handlers.set(event, handler);
      },
      sendMessage: (message: { content: string }, options: unknown) =>
        messages.push({ content: message.content, options }),
    },
    tools,
    handlers,
    registrations,
    messages,
    flags,
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

const ctx = {
  hasUI: false,
  ui: {},
  cwd: "/tmp",
  sessionManager: { getSessionId: () => "session", getBranch: () => [] },
};

const load = async (
  runner: Runner,
  env: Record<string, string | undefined> = { HERDR_ENV: "1", HERDR_PANE_ID: "self" },
) => {
  const fake = createFakePi();
  createFleetExtension({ runner, env, intervalMs: 60_000 })(fake.pi as never);
  await fake.handlers.get("session_start")?.({}, ctx);
  return fake;
};

const tool = (fake: ReturnType<typeof createFakePi>, name: string) => {
  const found = fake.tools.find((one) => one.name === name);
  if (found === undefined) throw new Error(`${name} is not registered`);
  return found;
};

describe("pi fleet extension", () => {
  test("does nothing outside herdr", async () => {
    const fake = await load(async () => list("idle", 1), {});
    expect(fake.tools.length).toBe(0);
    expect([...fake.handlers.keys()]).toEqual([
      "session_start",
      "session_before_switch",
      "session_shutdown",
    ]);
  });

  test("binds delayed role flags before registering worker tools", async () => {
    const fake = createFakePi();
    createFleetExtension({
      runner: async () => list("idle", 1),
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "self" },
      intervalMs: 60_000,
      assertHost: () => undefined,
    })(fake.pi as never);
    expect(fake.tools).toEqual([]);
    fake.flags["fleet-run"] = "/tmp/missing-fleet-run";
    fake.flags["fleet-implementor"] = "worker-1";
    await expect(fake.handlers.get("session_start")?.({}, ctx)).rejects.toThrow();
    const workerTools = fake.tools.map((entry) => entry.name);
    expect(workerTools).toEqual([
      "fleet_question",
      "fleet_report",
      "fleet_request_review",
      "fleet_status",
    ]);
    const registrations = [...fake.registrations];
    await expect(fake.handlers.get("session_start")?.({}, ctx)).rejects.toThrow();
    expect(fake.tools.map((entry) => entry.name)).toEqual(workerTools);
    expect(fake.registrations).toEqual(registrations);
  });

  test("rejects delayed worker flags outside Herdr", async () => {
    const fake = createFakePi();
    createFleetExtension({ runner: async () => list("idle", 1), env: {}, intervalMs: 60_000 })(
      fake.pi as never,
    );
    fake.flags["fleet-implementor"] = "worker-1";
    await expect(fake.handlers.get("session_start")?.({}, ctx)).rejects.toThrow(
      "Async fleet workers must launch inside Herdr",
    );
    await expect(fake.handlers.get("session_start")?.({}, ctx)).rejects.toThrow(
      "Async fleet workers must launch inside Herdr",
    );
    expect(fake.tools).toEqual([]);
  });

  test("retries failed adapter construction without duplicating tools or hooks", async () => {
    const env: Record<string, string | undefined> = { HERDR_ENV: "1" };
    const fake = createFakePi();
    createFleetExtension({ runner: async () => list("idle", 1), env, intervalMs: 60_000 })(
      fake.pi as never,
    );
    await expect(fake.handlers.get("session_start")?.({}, ctx)).rejects.toThrow(
      "Async fleet requires HERDR_PANE_ID",
    );
    expect(fake.tools).toEqual([]);
    env.HERDR_PANE_ID = "self";
    await fake.handlers.get("session_start")?.({}, ctx);
    const registeredTools = fake.tools.map((entry) => entry.name);
    const registeredHooks = [...fake.registrations];
    expect(registeredTools).toHaveLength(11);
    await fake.handlers.get("session_start")?.({}, ctx);
    expect(fake.tools.map((entry) => entry.name)).toEqual(registeredTools);
    expect(fake.registrations).toEqual(registeredHooks);
  });

  test("session changes reuse registrations without duplicating tools", async () => {
    const fake = await load(async () => list("idle", 1));
    const registered = fake.tools.map((entry) => entry.name);
    await fake.handlers.get("session_start")?.({}, ctx);
    expect(fake.tools.map((entry) => entry.name)).toEqual(registered);
  });

  test("registers the fleet tools", async () => {
    const fake = await load(async () => list("idle", 1));
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
    const fake = await load(async () => list("working", 3));
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
    const fake = await load(async () => list("working", 3));
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
    const fake = await load(async () => list("working", 3));
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
    const fake = await load(async () => list("working", 3));
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
    const fake = await load(async () => list("working", 3));
    await fake.handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "herdr agent prompt w1:p2 go" } },
      ctx,
    );
    await fake.handlers.get("agent_start")?.({}, ctx);
    await fake.handlers.get("agent_end")?.({}, ctx);
    expect(fake.messages).toEqual([]);
  });

  test("stays quiet when the dispatch went through fleet_send", async () => {
    const fake = await load(async (argv) =>
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
