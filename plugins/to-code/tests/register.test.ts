import { type Engine, expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

const agentRow = (pane: string, status: string, seq: number) => ({
  agent: "pi",
  agent_status: status,
  cwd: "/repo",
  display_agent: `worker-${pane}`,
  pane_id: pane,
  workspace_id: pane.split(":")[0],
  state_change_seq: seq,
});

// Answers $.process.run for herdr: `agent list` from the current rows, every
// other command with an empty success.
const herdr = (on: On, rows: () => ReturnType<typeof agentRow>[], argvs: string[][] = []) => {
  on("process.run", async (_$, e) => {
    argvs.push([...e.argv]);
    const isList = e.argv[1] === "agent" && e.argv[2] === "list";
    const stdout = isList ? JSON.stringify({ result: { agents: rows() } }) : "{}";
    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  return argvs;
};

const start = ($: Engine) => $.session.start({ cwd: "/repo", surface: null } as never);

test("registers nothing outside herdr", async ($, on) => {
  mock.env(on, {});
  const registered: string[] = [];
  on("tool.register", async (_$, e) => {
    registered.push(e.name);
    return { value: { tool: e.name } };
  });
  on("session.start", async () => ({ cwd: "/repo" }));
  await start($);
  expect(registered).toEqual([]);
});

test("registers the fleet tools inside herdr", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  mock.clock(on);
  const registered: string[] = [];
  on("tool.register", async (_$, e) => {
    registered.push(e.name);
    return { value: { tool: `mcp__to-code__${e.name}` } };
  });
  on("session.start", async () => ({ cwd: "/repo" }));
  await start($);
  expect(registered).toEqual([
    "fleet_setup",
    "fleet_status",
    "fleet_wait",
    "fleet_read",
    "fleet_send",
    "fleet_watch",
  ]);
});

test("setup scopes status and rejects outside targets through the mod adapter", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  mock.clock(on);
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__to-code__${e.name}` } }));
  on("session.start", async () => ({ cwd: "/repo" }));
  const rows = [agentRow("w1:p2", "idle", 1), agentRow("w2:p3", "working", 2)];
  const argvs = herdr(on, () => rows);
  await start($);
  const setup = await $.tool.call({ tool: "mcp__to-code__fleet_setup", panes: ["w1:p2"] } as never);
  expect(setup.isError).toBe(undefined);
  const { fleetId } = JSON.parse(String(setup.result));
  expect(fleetId).toBe("fleet-1");
  rows.push(agentRow("w1:p4", "working", 3));
  const status = await $.tool.call({ tool: "mcp__to-code__fleet_status", fleetId } as never);
  expect(JSON.parse(String(status.result)).map((agent: { pane: string }) => agent.pane)).toEqual([
    "w1:p2",
    "w1:p4",
  ]);
  const read = await $.tool.call({
    tool: "mcp__to-code__fleet_read",
    fleetId,
    pane: "w2:p3",
  } as never);
  expect(read.isError).toBe(true);
  expect(argvs.every((argv) => argv[2] === "list")).toBe(true);
});

test("fleet_send prompts the pane and watches it, so the stop gate stays quiet", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  mock.clock(on);
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__to-code__${e.name}` } }));
  on("session.start", async () => ({ cwd: "/repo" }));
  on("classic.Stop", async () => ({}));
  const argvs = herdr(on, () => [agentRow("w1:p2", "idle", 4)]);
  await start($);

  const sent = await $.tool.call({
    tool: "mcp__to-code__fleet_send",
    pane: "w1:p2",
    text: "go",
  } as never);
  expect(sent.isError).toBe(undefined);
  expect(argvs).toEqual([
    ["herdr", "agent", "list"],
    ["herdr", "agent", "prompt", "w1:p2", "go"],
  ]);

  const stop = await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
  });
  expect(stop.block).toBe(undefined);
});

test("a Bash herdr dispatch with no wake path is blocked once", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  mock.clock(on);
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__to-code__${e.name}` } }));
  on("session.start", async () => ({ cwd: "/repo" }));
  on("classic.Stop", async () => ({}));
  on("tool.call", { tool: "Bash" }, async () => ({
    result: { stdout: "", stderr: "", interrupted: false } as never,
  }));
  await start($);

  await $.tool.call({ tool: "Bash", command: "herdr agent prompt w1:p2 'go'" } as never);
  const first = await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
  });
  expect(
    first.block?.startsWith("[to-code fleet] This turn dispatched work (herdr via Bash)"),
  ).toBe(true);

  const second = await $.classic.Stop({
    stop_hook_active: true,
    background_tasks: [],
    session_crons: [],
  });
  expect(second.block).toBe(undefined);
});

test("the watcher wakes an idle session when a watched pane settles", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  const clock = mock.clock(on);
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__to-code__${e.name}` } }));
  on("session.start", async () => ({ cwd: "/repo" }));
  on("ui.status", async () => undefined as never);
  on("ui.toast", async () => undefined as never);
  const prompts: string[] = [];
  on("prompt.submit", async (_$, e) => {
    prompts.push(e.text);
    return { text: e.text } as never;
  });
  let status = "working";
  let seq = 4;
  herdr(on, () => [agentRow("w1:p2", status, seq)]);
  await start($);

  await $.tool.call({ tool: "mcp__to-code__fleet_watch", panes: ["w1:p2"] } as never);
  await clock.advance(3_000);
  expect(prompts).toEqual([]);

  status = "idle";
  seq = 6;
  await clock.advance(3_000);
  expect(prompts.length).toBe(1);
  expect(prompts[0]?.split("\n")[1]).toBe("- w1:p2 (worker-w1:p2): idle");

  await clock.advance(3_000);
  expect(prompts.length).toBe(1);
});

test("a wake turn leaves the stop gate quiet once its pane settled", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  const clock = mock.clock(on);
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__to-code__${e.name}` } }));
  on("session.start", async () => ({ cwd: "/repo" }));
  on("ui.status", async () => undefined as never);
  on("ui.toast", async () => undefined as never);
  on("classic.Stop", async () => ({}));
  const prompts: string[] = [];
  on("prompt.submit", async (_$, e) => {
    prompts.push(e.text);
    return { text: e.text } as never;
  });
  let seq = 4;
  herdr(on, () => [agentRow("w1:p2", "idle", seq)]);
  await start($);

  await $.tool.call({ tool: "mcp__to-code__fleet_send", pane: "w1:p2", text: "go" } as never);
  seq = 6;
  await clock.advance(3_000);
  expect(prompts.length).toBe(1);

  const stop = await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
  });
  expect(stop.block).toBe(undefined);
});

test("a pane that settles mid-turn wakes the session after the turn", async ($, on) => {
  mock.env(on, { HERDR_ENV: "1", HERDR_PANE_ID: "self" });
  const clock = mock.clock(on);
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__to-code__${e.name}` } }));
  on("session.start", async () => ({ cwd: "/repo" }));
  on("ui.status", async () => undefined as never);
  on("ui.toast", async () => undefined as never);
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async () => ({ text: "" }));
  const prompts: string[] = [];
  on("prompt.submit", async (_$, e) => {
    prompts.push(e.text);
    return { text: e.text } as never;
  });
  let status = "working";
  let seq = 4;
  herdr(on, () => [agentRow("w1:p2", status, seq)]);
  await start($);

  await $.tool.call({ tool: "mcp__to-code__fleet_watch", panes: ["w1:p2"] } as never);
  await $.turn.start({ text: "", turnId: "t1" });
  status = "idle";
  seq = 6;
  await clock.advance(3_000);
  expect(prompts).toEqual([]);

  await $.turn.complete({
    turnId: "t1",
    reason: "answer",
    answer: "",
    durationMs: 1,
    isAborted: false,
  });
  await clock.advance(0);
  expect(prompts.length).toBe(1);
  expect(prompts[0]?.split("\n")[1]).toBe("- w1:p2 (worker-w1:p2): idle");
});
