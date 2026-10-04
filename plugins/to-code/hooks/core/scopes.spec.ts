import { describe, expect, test } from "bun:test";

import { recordBashDispatch, resetPrompt, stopReason } from "./dispatch.ts";
import { EMPTY_MEMORY, formatWake, memoryStore, tick, waitKey } from "./fleet.ts";
import { parseAgentList, type RunOutput, type Runner } from "./herdr.ts";
import { executeFleetTool, FLEET_TOOLS, type ToolContext } from "./tools.ts";

const row = (pane: string, workspace: string, seq = 1, status = "idle") => ({
  pane_id: pane,
  workspace_id: workspace,
  name: pane,
  agent: "pi",
  agent_status: status,
  state_change_seq: seq,
});

const output = (agents: ReturnType<typeof row>[]): RunOutput => ({
  exitCode: 0,
  stdout: JSON.stringify({ result: { agents } }),
  stderr: "",
});

const fixture = () => {
  const state = { rows: [row("self", "w1"), row("a", "w1"), row("b", "w2")] };
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (argv) => {
    calls.push(argv);
    return argv[2] === "list"
      ? output(state.rows)
      : { exitCode: 0, stdout: "terminal", stderr: "" };
  };
  const context: ToolContext = {
    runner,
    store: memoryStore(),
    selfPane: "self",
    awaiting: new Set(),
    signal: undefined,
  };
  const call = (name: Parameters<typeof executeFleetTool>[0], input: Record<string, unknown>) =>
    executeFleetTool(name, input, context);
  const setup = async (panes = ["a"]): Promise<string> => {
    const result = await call("fleet_setup", { panes });
    expect(result.isError).toBe(false);
    return JSON.parse(result.text).fleetId;
  };
  return { state, calls, context, call, setup };
};

describe("workspace fleets", () => {
  test("setup issues unique IDs and reports all workspace members without watching", async () => {
    const f = fixture();
    f.state.rows.push(row("c", "w1"));
    expect(JSON.parse((await f.call("fleet_setup", { panes: ["a", "a"] })).text)).toEqual({
      fleetId: "fleet-1",
      workspaces: ["w1"],
      panes: ["a", "c"],
    });
    expect(await f.setup(["b"])).toBe("fleet-2");
    const memory = await f.context.store.read();
    expect(memory.nextFleetId).toBe(3);
    expect(memory.fleets["fleet-1"]).toEqual({
      workspaces: ["w1"],
      watched: {},
      baselines: {},
      dispatched: [],
      nudged: false,
    });
    expect(memory.watched).toEqual({});
  });

  test("setup spans selected workspaces and excludes the coordinator", async () => {
    const f = fixture();
    const fleetId = await f.setup(["a", "b"]);
    expect(
      JSON.parse((await f.call("fleet_status", { fleetId })).text).map(
        (agent: { pane: string }) => agent.pane,
      ),
    ).toEqual(["a", "b"]);
  });

  test("invalid setup leaves memory unchanged", async () => {
    const f = fixture();
    for (const panes of [[], ["self"], ["a", "missing"], ["a", 42]]) {
      expect((await f.call("fleet_setup", { panes })).isError).toBe(true);
      expect(await f.context.store.read()).toEqual(EMPTY_MEMORY);
    }
    f.state.rows = [{ ...row("a", "w1"), workspace_id: "" }];
    expect((await f.call("fleet_setup", { panes: ["a"] })).text).toBe(
      "Herdr did not report workspace IDs for the selected panes; fleet_setup requires workspace metadata",
    );
    expect(await f.context.store.read()).toEqual(EMPTY_MEMORY);
  });

  test("status discovers new workers and excludes closed or moved workers", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    f.state.rows = [row("self", "w1"), row("a", "w2"), row("new", "w1")];
    const scoped = await f.call("fleet_status", { fleetId });
    expect(JSON.parse(scoped.text).map((agent: { pane: string }) => agent.pane)).toEqual(["new"]);
    const global = await f.call("fleet_status", {});
    expect(JSON.parse(global.text).map((agent: { pane: string }) => agent.pane)).toEqual([
      "a",
      "new",
    ]);
    f.state.rows = [];
    expect(JSON.parse((await f.call("fleet_status", { fleetId })).text)).toEqual([]);
  });

  test("invalid IDs fail before any Herdr command", async () => {
    const f = fixture();
    for (const fleetId of ["missing", "__proto__", "constructor", "", null, 12]) {
      expect((await f.call("fleet_read", { fleetId, pane: "b" })).isError).toBe(true);
    }
    expect(f.calls).toEqual([]);
  });

  test("all targeted tools reject other workspaces without touching the target", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    for (const [name, input] of [
      ["fleet_read", { pane: "b" }],
      ["fleet_send", { pane: "b", text: "go" }],
      ["fleet_watch", { panes: ["a", "b"] }],
      ["fleet_watch", { panes: ["b"], unwatch: true }],
      ["fleet_wait", { panes: ["b"], timeoutMs: 1000 }],
    ] as const) {
      expect(await f.call(name, { ...input, fleetId })).toEqual({
        isError: true,
        text: `not members of ${fleetId}: b; call fleet_status with fleetId for the current list`,
      });
    }
    expect(f.calls.every((argv) => argv[2] === "list")).toBe(true);
    expect((await f.context.store.read()).fleets[fleetId]?.watched).toEqual({});
  });

  test("read and send accept newly discovered members", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    f.state.rows.push(row("c", "w1", 4));
    expect(await f.call("fleet_read", { fleetId, pane: "c" })).toEqual({
      text: "terminal",
      isError: false,
    });
    expect(
      JSON.parse((await f.call("fleet_send", { fleetId, pane: "c", text: "go" })).text),
    ).toEqual({ sent: true, pane: "c", watched: true });
    const memory = await f.context.store.read();
    expect(memory.watched).toEqual({});
    expect(memory.fleets[fleetId]?.watched).toEqual({ c: 4 });
  });

  test("overlapping fleets have independent watches, baselines, and unwatch", async () => {
    const f = fixture();
    const first = await f.setup();
    const second = await f.setup();
    await f.call("fleet_send", { fleetId: first, pane: "a", text: "go", watch: false });
    f.state.rows = [row("a", "w1", 3, "done"), row("b", "w2")];
    await f.call("fleet_watch", { fleetId: first, panes: ["a"] });
    await f.call("fleet_watch", { fleetId: second, panes: ["a"] });
    const memory = await f.context.store.read();
    expect(memory.fleets[first]?.watched).toEqual({ a: 1 });
    expect(memory.fleets[second]?.watched).toEqual({ a: 3 });
    expect(JSON.parse((await f.call("fleet_status", { fleetId: second })).text)[0].watched).toBe(
      true,
    );
    expect(JSON.parse((await f.call("fleet_status", {})).text)[0].watched).toBe(false);
    await f.call("fleet_watch", { fleetId: second, panes: ["a"], unwatch: true });
    const result = await tick(f.context.runner, f.context.store, f.context.awaiting, "self");
    expect(result.events).toEqual([{ fleetId: first, pane: "a", name: "a", status: "done" }]);
    expect(formatWake(result.events).split("\n")[1]).toBe(`- a (a): done [fleetId: ${first}]`);
    expect(result.agents.map((agent) => agent.pane)).toEqual(["a"]);
    expect((await f.context.store.read()).fleets[first]?.dispatched).toEqual([]);
    expect((await tick(f.context.runner, f.context.store, new Set(), "self")).events).toEqual([]);
  });

  test("a wait suppresses only its own fleet's wake", async () => {
    const f = fixture();
    const first = await f.setup();
    const second = await f.setup();
    await f.call("fleet_watch", { fleetId: first, panes: ["a"] });
    await f.call("fleet_watch", { fleetId: second, panes: ["a"] });
    f.context.awaiting.add(waitKey(first, "a"));
    f.state.rows = [row("a", "w1", 2, "done")];
    const result = await tick(f.context.runner, f.context.store, f.context.awaiting, "self");
    expect(result.events.map((event) => event.fleetId)).toEqual([second]);
    expect((await f.context.store.read()).fleets[first]?.watched).toEqual({ a: 1 });
  });

  test("scoped waits clear only the selected fleet and always release their wait keys", async () => {
    const f = fixture();
    const first = await f.setup();
    const second = await f.setup();
    await f.call("fleet_watch", { fleetId: first, panes: ["a"] });
    await f.call("fleet_watch", { fleetId: second, panes: ["a"] });
    f.context.runner = async (argv) => {
      if (argv[2] === "list") return output(f.state.rows);
      expect([...f.context.awaiting]).toEqual([waitKey(first, "a")]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: { agent: row("a", "w1", 2, "done") } }),
        stderr: "",
      };
    };
    expect(
      (await f.call("fleet_wait", { fleetId: first, panes: ["a"], timeoutMs: 1000 })).isError,
    ).toBe(false);
    const memory = await f.context.store.read();
    expect(memory.fleets[first]?.watched).toEqual({});
    expect(memory.fleets[second]?.watched).toEqual({ a: 1 });
    expect(f.context.awaiting.size).toBe(0);
  });

  test("closed and moved watched panes produce a scoped gone wake", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    await f.call("fleet_watch", { fleetId, panes: ["a"] });
    f.state.rows = [row("a", "w2")];
    const result = await tick(f.context.runner, f.context.store, new Set(), "self");
    expect(result.events).toEqual([{ fleetId, pane: "a", name: "a", status: "gone" }]);
    expect(result.agents).toEqual([]);
  });

  test("unwatch can remove a closed member before a watcher tick", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    await f.call("fleet_watch", { fleetId, panes: ["a"] });
    f.state.rows = [];
    expect(
      JSON.parse((await f.call("fleet_watch", { fleetId, panes: ["a"], unwatch: true })).text),
    ).toEqual({ unwatched: ["a"] });
    expect((await tick(f.context.runner, f.context.store, new Set(), "self")).events).toEqual([]);
  });

  test("shell dispatch baselines reach matching fleets and prompt reset retains membership", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    await f.context.store.update((memory) =>
      recordBashDispatch(memory, "herdr agent prompt a go", parseAgentList(output(f.state.rows))),
    );
    f.state.rows = [row("a", "w1", 3, "done")];
    await f.call("fleet_watch", { fleetId, panes: ["a"] });
    expect((await f.context.store.read()).fleets[fleetId]?.watched).toEqual({ a: 1 });
    await f.context.store.update(resetPrompt);
    const memory = await f.context.store.read();
    expect(memory.fleets[fleetId]?.workspaces).toEqual(["w1"]);
    expect(memory.fleets[fleetId]?.dispatched).toEqual([]);
    expect(memory.fleets[fleetId]?.watched).toEqual({ a: 1 });
  });

  test("setup retains shell dispatch baselines captured before the fleet existed", async () => {
    const f = fixture();
    await f.context.store.update((memory) =>
      recordBashDispatch(memory, "herdr agent prompt a go", parseAgentList(output(f.state.rows))),
    );
    f.state.rows = [row("a", "w1", 3, "done")];
    const fleetId = await f.setup();
    await f.call("fleet_watch", { fleetId, panes: ["a"] });
    const result = await tick(f.context.runner, f.context.store, new Set(), "self");
    expect(result.events).toEqual([{ fleetId, pane: "a", name: "a", status: "done" }]);
  });

  test("a scoped wait accounts for shell work without leaving a stale global dispatch", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    await f.context.store.update((memory) =>
      recordBashDispatch(memory, "herdr agent prompt a go", parseAgentList(output(f.state.rows))),
    );
    f.context.runner = async (argv) =>
      argv[2] === "list"
        ? output(f.state.rows)
        : {
            exitCode: 0,
            stdout: JSON.stringify({ result: { agent: row("a", "w1", 3, "done") } }),
            stderr: "",
          };
    expect((await f.call("fleet_wait", { fleetId, panes: ["a"], timeoutMs: 1000 })).isError).toBe(
      false,
    );
    const memory = await f.context.store.read();
    expect(memory.dispatched).toEqual([]);
    expect(memory.fleets[fleetId]?.dispatched).toEqual([]);
    expect(stopReason({ memory, pendingBackground: 0 })).toBe(undefined);
  });

  test("a pane moved outside the fleet during a wait returns no outside agent data", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    f.context.runner = async (argv) =>
      argv[2] === "list"
        ? output(f.state.rows)
        : {
            exitCode: 0,
            stdout: JSON.stringify({ result: { agent: row("a", "w2", 3, "done") } }),
            stderr: "",
          };
    expect(await f.call("fleet_wait", { fleetId, panes: ["a"], timeoutMs: 1000 })).toEqual({
      isError: true,
      text: `The waited pane is no longer a member of ${fleetId}; call fleet_status with fleetId`,
    });
    expect(f.context.awaiting.size).toBe(0);
  });

  test("stop gate identifies the unwatched fleet and nudges only once", async () => {
    const f = fixture();
    const fleetId = await f.setup();
    await f.call("fleet_send", { fleetId, pane: "a", text: "go", watch: false });
    const memory = await f.context.store.read();
    expect(stopReason({ memory, pendingBackground: 0 })?.endsWith(`Use fleetId: ${fleetId}.`)).toBe(
      true,
    );
    expect(stopReason({ memory: { ...memory, nudged: true }, pendingBackground: 0 })).toBe(
      undefined,
    );
  });

  test("tool schemas keep legacy inputs and expose fleetId everywhere except setup", () => {
    expect(FLEET_TOOLS.map((tool) => tool.name)).toEqual([
      "fleet_setup",
      "fleet_status",
      "fleet_wait",
      "fleet_read",
      "fleet_send",
      "fleet_watch",
    ]);
    for (const tool of FLEET_TOOLS.slice(1)) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(properties.fleetId).toEqual({
        type: "string",
        minLength: 1,
        description: "Session-local ID issued by fleet_setup",
      });
      expect(
        (tool.inputSchema.required as string[] | undefined)?.includes("fleetId") ?? false,
      ).toBe(false);
    }
  });
});
