import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

import { currentAssignment } from "../fleet/model.ts";
import type { Runner } from "../hooks/core/herdr.ts";
import { listenCallbacks, notifyCallback } from "./callbacks.ts";
import { nodeFleetPlatform, processIsAlive, type FleetPlatform } from "./platform.ts";
import {
  callbackIsCurrent,
  createFleetRuntime,
  type FleetActor,
  type FleetRuntime,
} from "./runtime.ts";
import { fleetStorage, type FleetRun } from "./storage.ts";

const MESSAGE = "to-code-async";
const RUN_ENTRY = "to-code-async-run";
const Text = Schema.NonEmptyString;
const WorkerConfig = {
  model: Text,
  thinking: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh"]),
};
const FleetId = { fleetId: Text };
const Setup = Schema.Struct({
  workspace: Text,
  integrationBranch: Text,
  checks: Schema.Array(Text),
  commandTimeoutMs: Schema.optionalKey(Schema.Number),
});
const StartTicket = Schema.Struct({
  ...FleetId,
  ticketId: Text,
  worktree: Text,
  goal: Text,
  ...WorkerConfig,
});
const StartReview = Schema.Struct({ ...FleetId, ticketId: Text, ...WorkerConfig });
const Finish = Schema.Struct({ ...FleetId, ticketId: Text });
const Restart = Schema.Struct({ ...FleetId, workerId: Text });
const Resume = Schema.Struct({ directory: Text });
const Send = Schema.Struct({
  ...FleetId,
  workerId: Schema.optionalKey(Text),
  pane: Schema.optionalKey(Text),
  text: Text,
  questionId: Schema.optionalKey(Schema.NullOr(Text)),
});
const Question = Schema.Struct({ reportId: Text, assignmentId: Text, question: Text });
const Report = Schema.Struct({
  reportId: Text,
  assignmentId: Text,
  outcome: Schema.Literals(["completed", "failed", "review", "approval"]),
  summary: Text,
  filename: Schema.optionalKey(Schema.NullOr(Text)),
});
const ReReview = Schema.Struct({ reportId: Text, assignmentId: Text, summary: Text });
const RunReference = Schema.Struct({ fleetId: Text, directory: Text });
const CallbackReference = Schema.Struct({
  ...FleetId,
  directory: Text,
  commandId: Text,
  target: Text,
});

const result = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
  isError,
});

/**
 * Register launch flags even outside Herdr so misconfigured async launches fail explicitly.
 */
export const registerFleetFlags = (pi: ExtensionAPI): void => {
  pi.registerFlag("fleet-run", {
    type: "string",
    description: "Absolute durable async fleet directory",
  });
  pi.registerFlag("fleet-implementor", {
    type: "string",
    description: "Assignment-bound async fleet implementor ID",
  });
  pi.registerFlag("fleet-reviewer", {
    type: "string",
    description: "Assignment-bound async fleet reviewer ID",
  });
};

const summary = (run: FleetRun): string =>
  JSON.stringify(
    {
      fleetId: run.id,
      directory: run.directory,
      workspace: run.workspace,
      integrationBranch: run.integrationBranch,
      tickets: run.tickets.map((ticket) => ({
        ticketId: ticket.id,
        state: ticket.snapshot.state.path,
        goal: ticket.snapshot.value.goal,
        worktree: ticket.snapshot.value.worktree,
        evidence: ticket.snapshot.state,
        implementor: ticket.implementor,
        reviewer: ticket.reviewer,
      })),
      workers: run.workers.map((worker) => ({
        workerId: worker.id,
        role: worker.snapshot.value.role,
        pane: worker.pane,
        state: worker.snapshot.state.path,
        assignment: currentAssignment(worker.snapshot),
        launch: worker.launch,
        callbackReady: worker.callbackReady,
        launchError: worker.launchError,
      })),
      pendingCallbacks: run.outbox
        .filter((callback) => callback.status === "pending")
        .map((callback) => ({
          id: callback.id,
          target: callback.target,
          kind: callback.kind,
          reportId: callback.reportId,
        })),
    },
    null,
    2,
  );

/**
 * Durable async Pi adapter. Legacy tool interception is explicit; managed workers never
 * use the old status watcher or completion wait surface.
 */
export const createAsyncFleetAdapter = (
  pi: ExtensionAPI,
  options: {
    runner: Runner;
    env: Readonly<Record<string, string | undefined>>;
    platform: FleetPlatform | undefined;
    assertHost: (() => void) | undefined;
  },
) => {
  const pane = options.env.HERDR_PANE_ID;
  if (pane === undefined) throw new Error("Async fleet requires HERDR_PANE_ID");
  const implementor = pi.getFlag("fleet-implementor");
  const reviewer = pi.getFlag("fleet-reviewer");
  const runFlag = pi.getFlag("fleet-run");
  const workerId =
    typeof implementor === "string"
      ? implementor
      : typeof reviewer === "string"
        ? reviewer
        : undefined;
  const role = typeof implementor === "string" ? "implementor" : "reviewer";
  if (
    (implementor !== undefined && reviewer !== undefined) ||
    (workerId !== undefined && (typeof runFlag !== "string" || !isAbsolute(runFlag))) ||
    (runFlag !== undefined && workerId === undefined)
  )
    throw new Error("Supply exactly one async role flag and an absolute --fleet-run directory");
  if (workerId !== undefined) options.assertHost?.();
  const references = new Map<string, string>();
  const endpoints = new Map<string, { runtime: FleetRuntime; close: () => Promise<void> }>();
  const inFlight = new Set<string>();
  let managed = workerId !== undefined;

  const actor = (ctx: ExtensionContext): FleetActor =>
    workerId === undefined
      ? { kind: "coordinator", pane, session: ctx.sessionManager.getSessionId() }
      : { kind: "worker", pane, workerId, role };
  const runtime = (
    directory: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined = undefined,
  ): FleetRuntime =>
    createFleetRuntime({
      storage: fleetStorage(directory),
      platform: options.platform ?? nodeFleetPlatform(options.runner, process.env, signal),
      actor: actor(ctx),
      notify: notifyCallback,
      newId: undefined,
    });
  const fromId = (
    fleetId: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined = undefined,
  ): FleetRuntime => {
    const directory = references.get(fleetId);
    if (directory === undefined)
      throw new Error("Unknown durable fleet; use fleet_resume with its directory");
    return runtime(directory, ctx, signal);
  };
  const openEndpoint = async (
    directory: string,
    ctx: ExtensionContext,
    recover: boolean,
  ): Promise<FleetRuntime> => {
    const rt = runtime(directory, ctx);
    const run = await rt.read();
    if (endpoints.has(run.id)) return endpoints.get(run.id)!.runtime;
    const target = workerId ?? "coordinator";
    let draining: Promise<void> | undefined;
    let again = false;
    const drain = (): Promise<void> => {
      if (draining !== undefined) {
        again = true;
        return draining;
      }
      draining = (async () => {
        do {
          again = false;
          const current = await rt.read();
          for (const callback of current.outbox.filter(
            (entry) => entry.target === target && entry.status === "pending",
          )) {
            const worker = current.workers.find((entry) => entry.id === callback.workerId);
            if (callback.kind === "assignment" && worker?.launch !== "started") continue;
            if (!callbackIsCurrent(current, callback)) {
              await rt.obsolete(callback.id);
              continue;
            }
            if (inFlight.has(callback.id)) continue;
            let content = callback.text;
            if (callback.kind === "assignment" && worker?.snapshot.value.role === "reviewer") {
              const review = await rt.reviewContext();
              if (review.assignmentId !== callback.assignmentId) {
                await rt.obsolete(callback.id);
                continue;
              }
              content += `\n\nRequired review template (copy it exactly, filling in findings):\n${review.template}\nWrite this file using the absolute path ${join(current.repository, review.filename)}, then pass the exact relative filename \`${review.filename}\` to fleet_report with outcome review. If submission is rejected and you cannot resolve the assigned filename/schema issue, ask the coordinator with fleet_question. Do not weaken or bypass review validation.`;
            }
            inFlight.add(callback.id);
            pi.sendMessage(
              {
                customType: MESSAGE,
                content,
                display: true,
                details: { fleetId: current.id, directory, commandId: callback.id, target },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          }
        } while (again);
      })().finally(() => {
        draining = undefined;
        if (again)
          void drain().catch((error: unknown) => {
            if (ctx.hasUI) ctx.ui.notify(String(error), "error");
          });
      });
      return draining;
    };
    const close = await listenCallbacks(directory, target, drain, recover, (error) => {
      void (async () => {
        if (workerId !== undefined) {
          await rt.transportReady(false);
          await rt.interrupted(`Callback endpoint failed: ${error.message}`);
        }
        pi.sendMessage(
          {
            customType: "to-code-async-transport-error",
            content: `Callback transport failed for ${run.id}: ${error.message}. Pending outbox is preserved. Inspect/reload the owning session, then resume; do not infer completion.`,
            display: true,
            details: undefined,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      })().catch((failure: unknown) => {
        if (ctx.hasUI) ctx.ui.notify(String(failure), "error");
      });
    });
    endpoints.set(run.id, { runtime: rt, close });
    references.set(run.id, directory);
    // Restore acknowledgments only from actually persisted custom messages.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message" || entry.customType !== MESSAGE) continue;
      const decoded = Schema.decodeUnknownOption(CallbackReference)(entry.details);
      if (
        decoded._tag === "Some" &&
        decoded.value.fleetId === run.id &&
        decoded.value.target === target
      )
        await rt.acknowledge(decoded.value.commandId);
    }
    await drain();
    return rt;
  };
  const closeEndpoints = async (): Promise<void> => {
    await Promise.all(
      [...endpoints.values()].map(async (endpoint) => {
        if (workerId !== undefined) await endpoint.runtime.transportReady(false);
        await endpoint.close();
      }),
    );
    endpoints.clear();
    inFlight.clear();
  };
  const resume = async (
    directory: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined = undefined,
  ): Promise<FleetRuntime> => {
    options.assertHost?.();
    const canonical = await realpath(directory);
    if (canonical !== directory || !isAbsolute(directory))
      throw new Error("Resume requires the canonical absolute run directory");
    const storage = fleetStorage(directory);
    const previous = await storage.read();
    if (previous.directory !== directory || previous.hostname !== hostname())
      throw new Error("Run directory/host does not match persisted ownership");
    if (workerId !== undefined) {
      const worker = previous.workers.find((entry) => entry.id === workerId);
      if (worker === undefined || worker.pane !== pane || worker.snapshot.value.role !== role)
        throw new Error("Launch role/worker/pane does not match the durable assignment");
      if (worker.pid !== null && worker.pid !== process.pid && processIsAlive(worker.pid))
        throw new Error("A live process already owns this worker");
      await storage.change(async (run) => {
        const current = run.workers.find((entry) => entry.id === workerId);
        if (current?.pid !== worker.pid) throw new Error("Worker owner changed during startup");
        return {
          run: {
            ...run,
            workers: run.workers.map((entry) =>
              entry.id === workerId ? { ...entry, pid: process.pid, callbackReady: false } : entry,
            ),
          },
          value: undefined,
        };
      });
      const rt = await openEndpoint(
        directory,
        ctx,
        worker.pid !== null && worker.pid !== process.pid,
      );
      await storage.change(async (run) => ({
        run: {
          ...run,
          workers: run.workers.map((entry) =>
            entry.id === workerId ? { ...entry, callbackReady: true } : entry,
          ),
        },
        value: undefined,
      }));
      return rt;
    }
    if (previous.coordinatorPid !== process.pid && processIsAlive(previous.coordinatorPid))
      throw new Error("A live coordinator owns this run; stop it before takeover");
    if (previous.coordinatorPid === process.pid && previous.coordinatorPane !== pane)
      throw new Error("Another pane in this process owns the run");
    const facts = await (
      options.platform ?? nodeFleetPlatform(options.runner, process.env, signal)
    ).facts(previous.repository, previous.integrationBranch);
    if (facts.commonDirectory !== previous.commonDirectory)
      throw new Error("Run repository identity changed");
    await storage.change(async (run) => {
      if (
        run.coordinatorPid !== previous.coordinatorPid ||
        run.coordinatorSession !== previous.coordinatorSession
      )
        throw new Error("Coordinator changed during resume");
      return {
        run: {
          ...run,
          coordinatorPane: pane,
          coordinatorPid: process.pid,
          coordinatorSession: ctx.sessionManager.getSessionId(),
        },
        value: undefined,
      };
    });
    const rt = await openEndpoint(directory, ctx, previous.coordinatorPid !== process.pid);
    managed = true;
    references.set(previous.id, directory);
    pi.appendEntry(RUN_ENTRY, { fleetId: previous.id, directory });
    return rt;
  };

  const register = <P extends Record<string, unknown>>(
    name: string,
    description: string,
    schema: Schema.Constraint,
    decode: (input: unknown) => P,
    execute: (input: P, ctx: ExtensionContext, signal: AbortSignal | undefined) => Promise<string>,
  ): void => {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters:
        name === "fleet_status"
          ? Type.Object({})
          : Type.Unsafe<Record<string, unknown>>(Schema.toJsonSchemaDocument(schema).schema),
      async execute(_id, params, signal, _update, ctx) {
        try {
          return result(await execute(decode(params), ctx, signal));
        } catch (error) {
          return result(String(error), true);
        }
      },
    });
  };
  if (workerId === undefined) {
    register(
      "fleet_start_ticket",
      "Start an async implementor in a new background tab, using an existing clean worktree. Never creates a branch/worktree. Return is launch acknowledgment, not completion.",
      StartTicket,
      Schema.decodeUnknownSync(StartTicket),
      async (input, ctx, signal) => {
        const rt = fromId(input.fleetId, ctx, signal);
        const id = await rt.startTicket({
          ticketId: input.ticketId,
          worktree: input.worktree,
          goal: input.goal,
          config: { model: input.model, thinking: input.thinking },
        });
        return `Worker ${id} assigned. Outcomes arrive as durable callbacks; do not poll/wait for completion.`;
      },
    );
    register(
      "fleet_start_review",
      "Dispatch initial review after recorded implementation. New reviewer gets a background tab; subsequent fix reviews retain that reviewer and are requested by the implementor.",
      StartReview,
      Schema.decodeUnknownSync(StartReview),
      async (input, ctx, signal) =>
        `Reviewer ${await fromId(input.fleetId, ctx, signal).startReview(input.ticketId, { model: input.model, thinking: input.thinking })} assigned.`,
    );
    register(
      "fleet_finish_ticket",
      "After YOU have landed the approved head serially, verify ancestry, unchanged head/artifact, and fresh configured checks; then retire only owned settled workers. Preserves worktrees, branches, reports, and unrelated panes.",
      Finish,
      Schema.decodeUnknownSync(Finish),
      async (input, ctx, signal) => {
        await fromId(input.fleetId, ctx, signal).finishTicket(input.ticketId);
        return "Landing verified. Owned workers retired; Git resources and reports preserved.";
      },
    );
    register(
      "fleet_resume",
      "Recover a durable fleet directory after coordinator restart. Refuses takeover of a live other owner. Replays pending callbacks and returns machine states, not inferred completion.",
      Resume,
      Schema.decodeUnknownSync(Resume),
      async (input, ctx, signal) =>
        summary(await (await resume(input.directory, ctx, signal)).read()),
    );
    register(
      "fleet_restart_worker",
      "Reconcile a known worker's uncertain launch or restart in its existing owned pane. Never allocate a duplicate tab or replace an unknown/busy occupant.",
      Restart,
      Schema.decodeUnknownSync(Restart),
      async (input, ctx, signal) => {
        await fromId(input.fleetId, ctx, signal).restartWorker(input.workerId);
        return "Known worker startup reconciled; callbacks remain assignment-correlated.";
      },
    );
  } else {
    const own = (
      ctx: ExtensionContext,
      signal: AbortSignal | undefined = undefined,
    ): FleetRuntime => {
      if (typeof runFlag !== "string") throw new Error("Worker has no run binding");
      return runtime(runFlag, ctx, signal);
    };
    register(
      "fleet_question",
      "Durably ask the coordinator about the current assignment. This accounts for waiting; identify its reportId in the coordinator answer. Never ask the user directly.",
      Question,
      Schema.decodeUnknownSync(Question),
      async (input, ctx, signal) => {
        await own(ctx, signal).question(input.reportId, input.assignmentId, input.question);
        return "Question persisted and callback queued. Waiting is accounted until a correlated answer rearms you.";
      },
    );
    register(
      "fleet_report",
      "Persist the current assignment's explicit outcome before yielding. Implementors report completed/failed or forward approval; reviewers MUST return the exact assigned validated scratch Markdown filename, never bare approval/failure. Duplicate report IDs are idempotent; conflicting reuse fails.",
      Report,
      Schema.decodeUnknownSync(Report),
      async (input, ctx, signal) => {
        await own(ctx, signal).report({ ...input, filename: input.filename ?? null });
        return `Outcome ${input.reportId} persisted. Recipient callback is queued durably; do not send a separate prompt.`;
      },
    );
    register(
      "fleet_request_review",
      "Implementor-only: after fixing medium-or-higher findings, commit and verify fixes, then rearm the retained reviewer. Records your outcome and the new review assignment atomically.",
      ReReview,
      Schema.decodeUnknownSync(ReReview),
      async (input, ctx, signal) => {
        await own(ctx, signal).requestReview(input.reportId, input.assignmentId, input.summary);
        return "Fix outcome persisted and retained reviewer rearmed.";
      },
    );
    register(
      "fleet_status",
      "Read your durable assignment and accounted waiting status. Does not poll Herdr or infer completion.",
      Schema.Struct({}),
      Schema.decodeUnknownSync(Schema.Struct({})),
      async (_input, ctx, signal) => summary(await own(ctx, signal).read()),
    );
    pi.on("before_agent_start", async (_event, ctx) => {
      const rt = own(ctx);
      const run = await rt.read();
      const worker = run.workers.find((entry) => entry.id === workerId);
      if (worker === undefined) throw new Error("Worker binding missing");
      let content = `[async fleet] You are ${role} ${workerId}. State: ${worker.snapshot.state.path}. Current assignment: ${JSON.stringify(currentAssignment(worker.snapshot))}. When not Active, wait for a fresh assignment and never repeat already-accounted work. Use its exact assignmentId in every report/question. All questions route through fleet_question. Do not orchestrate other agents, land code, or answer native approval dialogs yourself.`;
      if (role === "reviewer" && worker.snapshot.state.path === "Active")
        content += `\nRequired review template:\n${await rt.reviewTemplate()}`;
      return {
        message: {
          customType: "to-code-async-binding",
          content,
          display: true,
          details: undefined,
        },
      };
    });
    pi.on("tool_call", (event) => {
      if (["ask_user_question", "request_user_input"].includes(event.toolName))
        return {
          block: true,
          reason: "Async worker questions must use fleet_question and route to the coordinator.",
        };
      return undefined;
    });
    pi.on("ui_prompt_start", async (event, ctx) => {
      const rt = own(ctx);
      const run = await rt.read();
      const worker = run.workers.find((entry) => entry.id === workerId);
      if (worker?.snapshot.state.path !== "Active") return;
      const assignment = currentAssignment(worker.snapshot);
      if (assignment === undefined) return;
      await rt.question(
        `native-${randomUUID()}`,
        assignment.id,
        `Native ${event.kind} prompt requires coordinator inspection: ${event.title ?? "untitled"}. Do not treat a fleet answer as granting native permissions; the authorized human must resolve the native dialog.`,
      );
    });
    pi.on("agent_before_settle", async (event, ctx) => {
      if (event.outcome !== "completed" || !event.context.canContinue) {
        await own(ctx).interrupted(
          `Pi ${event.outcome}; provider continuation available: ${event.context.canContinue}`,
        );
        return undefined;
      }
      let reason: string | undefined;
      try {
        reason = await own(ctx).stop();
      } catch (error) {
        reason = `Fleet stop accounting failed. The assignment is NOT complete: ${String(error)}. Retry accounting or ask the coordinator; do not yield unreported.`;
      }
      if (reason === undefined) return undefined;
      return {
        continue: true,
        entries: [
          {
            type: "custom_message" as const,
            customType: "to-code-outcome-required",
            content: reason,
            display: true,
            details: undefined,
          },
        ],
      };
    });
  }

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "custom" || event.message.customType !== MESSAGE) return;
    const reference = Schema.decodeUnknownOption(CallbackReference)(event.message.details);
    if (reference._tag === "None") return;
    const details = reference.value;
    if (
      references.get(details.fleetId) !== details.directory ||
      details.target !== (workerId ?? "coordinator")
    )
      return;
    await runtime(details.directory, ctx).acknowledge(details.commandId);
    inFlight.delete(details.commandId);
  });

  return {
    worker: workerId !== undefined,
    managed: () => managed,
    inputSchema: (name: string, legacy: Record<string, unknown>): Record<string, unknown> =>
      name === "fleet_setup"
        ? { anyOf: [legacy, Schema.toJsonSchemaDocument(Setup).schema] }
        : name === "fleet_send"
          ? { anyOf: [legacy, Schema.toJsonSchemaDocument(Send).schema] }
          : legacy,
    start: async (ctx: ExtensionContext): Promise<void> => {
      references.clear();
      managed = workerId !== undefined;
      if (workerId !== undefined && typeof runFlag === "string") {
        await resume(runFlag, ctx);
        return;
      }
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) continue;
        const reference = Schema.decodeUnknownOption(RunReference)(entry.data);
        if (reference._tag === "None" || endpoints.has(reference.value.fleetId)) continue;
        await resume(reference.value.directory, ctx);
      }
    },
    shutdown: closeEndpoints,
    execute: async (
      name: string,
      params: Record<string, unknown>,
      ctx: ExtensionContext,
      signal: AbortSignal | undefined = undefined,
    ): Promise<ReturnType<typeof result> | undefined> => {
      const commandPlatform =
        options.platform ?? nodeFleetPlatform(options.runner, process.env, signal);
      try {
        if (name === "fleet_setup" && "workspace" in params) {
          options.assertHost?.();
          const input = Schema.decodeUnknownSync(Setup)(params);
          if (!(await commandPlatform.workspaceExists(input.workspace)))
            throw new Error("Coordinator must select an existing Herdr workspace");
          const repository = await realpath(ctx.cwd);
          const facts = await commandPlatform.facts(repository, input.integrationBranch);
          if (facts.branch !== input.integrationBranch)
            throw new Error("Coordinator cwd must be the chosen integration worktree/branch");
          if (
            input.checks.length === 0 ||
            (input.commandTimeoutMs !== undefined &&
              (input.commandTimeoutMs < 1 || input.commandTimeoutMs > 570_000))
          )
            throw new Error(
              "Provide verification commands and a bounded command timeout (1..570000 ms)",
            );
          if (!(await commandPlatform.scratchIgnored(repository)))
            throw new Error(".scratch/ must be Git-ignored before fleet setup");
          const fleetId = `async-${randomUUID()}`;
          const directory = join(repository, ".scratch", "to-code", fleetId);
          await mkdir(join(directory, "reports"), { recursive: true, mode: 0o700 });
          if (
            (await realpath(directory)) !== directory ||
            relative(repository, directory).startsWith("..")
          )
            throw new Error("Fleet scratch directory must be canonical and inside the repository");
          const run: FleetRun = {
            version: 1,
            id: fleetId,
            directory,
            repository,
            commonDirectory: facts.commonDirectory,
            workspace: input.workspace,
            integrationBranch: input.integrationBranch,
            coordinatorPane: pane,
            coordinatorSession: ctx.sessionManager.getSessionId(),
            coordinatorPid: process.pid,
            hostname: hostname(),
            checks: input.checks,
            commandTimeoutMs: input.commandTimeoutMs ?? 120_000,
            workers: [],
            tickets: [],
            reports: [],
            outbox: [],
          };
          await fleetStorage(directory).initialize(run);
          await openEndpoint(directory, ctx, false);
          references.set(fleetId, directory);
          managed = true;
          pi.appendEntry(RUN_ENTRY, { fleetId, directory });
          return result(summary(run));
        }
        const fleetId = typeof params.fleetId === "string" ? params.fleetId : undefined;
        if (fleetId?.startsWith("async-")) {
          const rt = fromId(fleetId, ctx, signal);
          if (name === "fleet_status") return result(summary(await rt.read()));
          if (name === "fleet_send") {
            const input = Schema.decodeUnknownSync(Send)(params);
            const run = await rt.read();
            const target =
              input.workerId ?? run.workers.find((worker) => worker.pane === input.pane)?.id;
            if (target === undefined) throw new Error("Target is not owned by this async fleet");
            await rt.send(target, input.text, input.questionId ?? null);
            return result(
              "Assignment/answer durably recorded and stop guard rearmed. Callback delivery does not imply task completion.",
            );
          }
          if (name === "fleet_wait" || name === "fleet_watch")
            return result(
              "Managed async workers use durable callbacks. Do not poll or wait for their completion.",
              true,
            );
          if (name === "fleet_read") {
            const run = await rt.read();
            const worker = run.workers.find((entry) => entry.pane === params.pane);
            if (worker === undefined || worker.pane === pane)
              throw new Error("Read target is not an owned worker");
            const output = await options.runner(
              [
                "herdr",
                "agent",
                "read",
                worker.name,
                "--source",
                "recent-unwrapped",
                "--lines",
                "80",
              ],
              10_000,
              signal,
            );
            return result(output.stdout || output.stderr, output.exitCode !== 0);
          }
        }
        // Do not let unscoped legacy send/wait/watch bypass managed-worker assignment gates.
        if (["fleet_send", "fleet_wait", "fleet_watch"].includes(name)) {
          for (const directory of references.values()) {
            const run = await fleetStorage(directory).read();
            const targets = [params.pane, ...(Array.isArray(params.panes) ? params.panes : [])];
            if (run.workers.some((worker) => targets.includes(worker.pane)))
              throw new Error(
                "Managed worker requires its async fleetId and assignment-correlated tool surface",
              );
          }
        }
        return undefined;
      } catch (error) {
        return result(String(error), true);
      }
    },
  };
};
