import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import { isHerdrDispatch, recordDispatch, resetPrompt, stopReason } from "./core/dispatch.ts";
import { EMPTY_MEMORY, type FleetStore, formatWake, summarize, tick } from "./core/fleet.ts";
import type { Runner } from "./core/herdr.ts";
import { executeFleetTool, FLEET_TOOLS, type FleetToolName } from "./core/tools.ts";

const memory = atom({ plugin: "to-code", key: "memory" } as const, EMPTY_MEMORY);

const TOOL_PREFIX = "mcp__to-code__";
const FLEET_TOOL = /^mcp__to-code__fleet_/;

// `$.process.run` takes no abort signal: a child whose wait was abandoned
// exits at its own herdr timeout instead.
const processRunner =
  ($: EngineInterface): Runner =>
  async (argv, timeoutMs) => {
    const ran = await $.process.run(argv, { timeoutMs: Math.min(timeoutMs, 600_000) });
    return { exitCode: ran.exitCode ?? 1, stdout: ran.stdout, stderr: ran.stderr };
  };

const stateStore = ($: EngineInterface): FleetStore => ({
  read: () => read($, memory),
  update: async (fn) => {
    await update($, memory, fn);
  },
});

// Mid-turn, a user-role row reaches the running loop at its next request;
// otherwise a queued prompt starts a turn of its own.
const deliver = async ($: EngineInterface, text: string, isBusy: boolean) => {
  if (isBusy) {
    await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
    return;
  }
  await $.prompt.submit({ text });
};

export const register: Register = (on, options) => {
  const intervalMs =
    typeof options.watchIntervalMs === "number" ? Math.max(1_000, options.watchIntervalMs) : 3_000;
  const isStopGateOn = options.stopGate !== false;
  // Panes an in-flight fleet_wait covers; the watcher leaves them to it.
  const awaiting = new Set<string>();
  let selfPane: string | undefined;
  let isActive = false;
  let isBusy = false;

  on("session.start", async ($, e, next) => {
    isActive = (await $.env.get("HERDR_ENV")) === "1";
    if (!isActive) return next(e);
    selfPane = await $.env.get("HERDR_PANE_ID");

    for (const tool of FLEET_TOOLS) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    const runner = processRunner($);
    const store = stateStore($);
    let isTicking = false;
    $.clock.every(intervalMs, () => {
      if (isTicking) return;
      isTicking = true;
      void tick(runner, store, awaiting, selfPane)
        .then(async ({ agents, events }) => {
          $.ui.status(summarize(agents, await store.read()));
          if (events.length === 0) return;
          $.ui.toast(events.map((event) => `${event.name}: ${event.status}`).join(", "));
          await deliver($, formatWake(events), isBusy);
        })
        .catch(() => $.ui.status(undefined))
        .finally(() => {
          isTicking = false;
        });
    });

    return next(e);
  });

  on("tool.describe", { tool: FLEET_TOOL }, async ($, e, next) => ({
    ...(await next(e)),
    isDeferred: false,
  }));

  on("tool.call", { tool: FLEET_TOOL }, async ($, e, next) => {
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e as Record<string, unknown>;
    const name = String(tool).slice(TOOL_PREFIX.length) as FleetToolName;
    const outcome = await executeFleetTool(name, input, {
      runner: processRunner($),
      store: stateStore($),
      selfPane,
      awaiting,
      signal: next.signal,
    });
    return outcome.isError ? { isError: true, result: outcome.text } : { result: outcome.text };
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (isActive && e.agentId === undefined && isHerdrDispatch(e.command)) {
      await update($, memory, (current) => recordDispatch(current, "herdr via Bash"));
    }
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    await update($, memory, resetPrompt);
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    isBusy = true;
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) isBusy = false;
    return next(e);
  });

  on("classic.Stop", async ($, e, next) => {
    const result = await next(e);
    if (!isActive || !isStopGateOn || result.block !== undefined) return result;
    const current = await read($, memory);
    const reason = stopReason({
      memory: current,
      pendingBackground: (e.background_tasks?.length ?? 0) + (e.session_crons?.length ?? 0),
    });
    if (reason === undefined) return result;
    await update($, memory, (value) => ({ ...value, nudged: true }));
    return { ...result, block: reason };
  });
};
