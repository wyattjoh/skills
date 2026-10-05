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
import { createAsyncFleetAdapter, registerFleetFlags } from "./async.ts";
import { assertFleetHost } from "./host.ts";

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
      { timeout: timeoutMs, signal, env: process.env, maxBuffer: 4 * 1024 * 1024 },
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
  assertHost?: (() => void) | undefined;
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
    registerFleetFlags(pi);
    let asyncFleet: ReturnType<typeof createAsyncFleetAdapter> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let initialize: ((ctx: ExtensionContext) => Promise<void>) | undefined;
    let startLegacy: ((ctx: ExtensionContext) => void) | undefined;
    let initialized = false;
    pi.on("session_start", async (_event, ctx) => {
      if (!initialized) {
        initialized = true;
        if (
          options.env.HERDR_ENV !== "1" &&
          (pi.getFlag("fleet-implementor") !== undefined ||
            pi.getFlag("fleet-reviewer") !== undefined)
        )
          throw new Error("Async fleet workers must launch inside Herdr");
        if (options.env.HERDR_ENV !== "1") return;
        await initialize?.(ctx);
        await asyncFleet?.start(ctx);
        return;
      }
      await asyncFleet?.start(ctx);
      startLegacy?.(ctx);
    });
    pi.on("session_before_switch", async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await asyncFleet?.shutdown();
    });
    pi.on("session_shutdown", async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await asyncFleet?.shutdown();
    });
    initialize = async (ctx: ExtensionContext): Promise<void> => {
      const selfPane = options.env.HERDR_PANE_ID;
      const adapter = createAsyncFleetAdapter(pi, {
        runner: options.runner,
        env: options.env,
        platform: undefined,
        assertHost: options.assertHost ?? assertFleetHost,
      });
      asyncFleet = adapter;
      if (adapter.worker) return;
      const store = memoryStore();
      const awaiting = new Set<string>();
      let isTicking = false;

      const wake = (text: string) =>
        pi.sendMessage(
          { customType: MESSAGE_TYPE, content: text, display: true, details: undefined },
          {
            triggerTurn: true,
            deliverAs: "followUp",
          },
        );

      const poll = async (sessionCtx: ExtensionContext) => {
        if (isTicking || adapter.managed()) return;
        isTicking = true;
        try {
          const { agents, events } = await tick(options.runner, store, awaiting, selfPane);
          if (sessionCtx.hasUI)
            sessionCtx.ui.setStatus(STATUS_KEY, summarize(agents, await store.read()));
          if (events.length === 0) return;
          if (sessionCtx.hasUI)
            sessionCtx.ui.notify(
              events.map((event) => `${event.name}: ${event.status}`).join(", "),
              "info",
            );
          wake(formatWake(events));
        } catch {
          if (sessionCtx.hasUI) sessionCtx.ui.setStatus(STATUS_KEY, undefined);
        } finally {
          isTicking = false;
        }
      };

      for (const tool of FLEET_TOOLS) {
        pi.registerTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>(
            adapter.inputSchema(tool.name, tool.inputSchema),
          ),
          async execute(_toolCallId, params, signal, _update, toolCtx) {
            if (tool.name === "fleet_setup" && "workspace" in params) {
              const memory = await store.read();
              const scopes = [memory, ...Object.values(memory.fleets)];
              if (
                awaiting.size > 0 ||
                scopes.some(
                  (scope) => Object.keys(scope.watched).length > 0 || scope.dispatched.length > 0,
                )
              ) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Finish/account for legacy watches and dispatches before switching to a callback-driven fleet.",
                    },
                  ],
                  details: undefined,
                  isError: true,
                };
              }
            }
            const managed = await adapter.execute(tool.name, params, toolCtx, signal);
            if (adapter.managed() && timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            if (managed !== undefined) return managed;
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

      startLegacy = (sessionCtx: ExtensionContext) => {
        if (timer !== undefined) clearInterval(timer);
        if (!adapter.managed())
          timer = setInterval(() => void poll(sessionCtx), options.intervalMs);
      };
      startLegacy(ctx);

      // Each agent run, a typed prompt or a wake, gets its own stop-gate record.
      pi.on("agent_start", async () => {
        await store.update(resetPrompt);
      });

      pi.on("tool_call", async (event) => {
        if (adapter.managed()) return;
        const command =
          event.toolName === "bash" ? (event.input as { command?: unknown }).command : undefined;
        if (typeof command === "string" && isHerdrDispatch(command)) {
          const agents = await listFleet(options.runner, selfPane, undefined).catch(() => []);
          await store.update((memory) => recordBashDispatch(memory, command, agents));
        }
      });

      // pi cannot hold a turn open, so the stop gate becomes one follow-up turn.
      pi.on("agent_end", async () => {
        if (adapter.managed()) return;
        const reason = stopReason({ memory: await store.read(), pendingBackground: 0 });
        if (reason === undefined) return;
        await store.update((memory) => ({ ...memory, nudged: true }));
        wake(reason);
      });
    };
  };

export default createFleetExtension({
  runner: nodeRunner,
  env: process.env,
  intervalMs: DEFAULT_INTERVAL_MS,
});
