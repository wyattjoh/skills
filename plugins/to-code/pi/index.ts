import { execFile } from "node:child_process";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  isHerdrDispatch,
  recordBashDispatch,
  resetPrompt,
  stopReason,
} from "../hooks/core/dispatch.ts";
import { formatWake, listFleet, memoryStore, summarize, tick } from "../hooks/core/fleet.ts";
import type { Runner } from "../hooks/core/herdr.ts";
import { executeFleetTool, FLEET_TOOLS } from "../hooks/core/tools.ts";

const STATUS_KEY = "to-code";
const MESSAGE_TYPE = "to-code-fleet";
const DEFAULT_INTERVAL_MS = 3_000;

/**
 * Runs herdr through Node's child_process, killing the child when the call is
 * aborted or runs past its timeout.
 */
export const nodeRunner: Runner = (argv, timeoutMs, signal) =>
  new Promise((resolve) => {
    const [file = "herdr", ...args] = argv;
    execFile(
      file,
      args,
      { timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * Options for wiring the extension, injectable for tests.
 */
export type FleetExtensionOptions = {
  runner: Runner;
  env: Readonly<Record<string, string | undefined>>;
  intervalMs: number;
};

/**
 * Builds the pi extension: the fleet tools, a watcher that wakes the agent
 * when watched panes settle, and a one-time nudge when a prompt dispatched
 * herdr work with nothing watching it. Does nothing outside herdr.
 *
 * @param options the runner, environment, and watch interval
 * @returns the extension factory
 */
export const createFleetExtension =
  (options: FleetExtensionOptions) =>
  (pi: ExtensionAPI): void => {
    if (options.env.HERDR_ENV !== "1") return;
    const selfPane = options.env.HERDR_PANE_ID;
    const store = memoryStore();
    const awaiting = new Set<string>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let isTicking = false;

    const wake = (text: string) =>
      pi.sendMessage(
        { customType: MESSAGE_TYPE, content: text, display: true, details: undefined },
        {
          triggerTurn: true,
          deliverAs: "followUp",
        },
      );

    const poll = async (ctx: ExtensionContext) => {
      if (isTicking) return;
      isTicking = true;
      try {
        const { agents, events } = await tick(options.runner, store, awaiting, selfPane);
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, summarize(agents, await store.read()));
        if (events.length === 0) return;
        if (ctx.hasUI)
          ctx.ui.notify(events.map((event) => `${event.name}: ${event.status}`).join(", "), "info");
        wake(formatWake(events));
      } catch {
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      } finally {
        isTicking = false;
      }
    };

    for (const tool of FLEET_TOOLS) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          const outcome = await executeFleetTool(tool.name, params, {
            runner: options.runner,
            store,
            selfPane,
            awaiting,
            signal,
          });
          return {
            content: [{ type: "text", text: outcome.text }],
            details: undefined,
            isError: outcome.isError,
          };
        },
      });
    }

    pi.on("session_start", (_event, ctx) => {
      if (timer !== undefined) clearInterval(timer);
      timer = setInterval(() => void poll(ctx), options.intervalMs);
    });

    pi.on("session_shutdown", () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    });

    // Each agent run, a typed prompt or a wake, gets its own stop-gate record.
    pi.on("agent_start", async () => {
      await store.update(resetPrompt);
    });

    pi.on("tool_call", async (event) => {
      const command =
        event.toolName === "bash" ? (event.input as { command?: unknown }).command : undefined;
      if (typeof command === "string" && isHerdrDispatch(command)) {
        const agents = await listFleet(options.runner, selfPane, undefined).catch(() => []);
        await store.update((memory) => recordBashDispatch(memory, command, agents));
      }
    });

    // pi cannot hold a turn open, so the stop gate becomes one follow-up turn.
    pi.on("agent_end", async () => {
      const reason = stopReason({ memory: await store.read(), pendingBackground: 0 });
      if (reason === undefined) return;
      await store.update((memory) => ({ ...memory, nudged: true }));
      wake(reason);
    });
  };

export default createFleetExtension({
  runner: nodeRunner,
  env: process.env,
  intervalMs: DEFAULT_INTERVAL_MS,
});
