import { Effect, Fiber, Queue } from "effect";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CliIssue, SchedulerTicket } from "./contract.ts";
import type { EngineContext } from "./engine.ts";
import { planSchedule } from "./scheduler.ts";

/**
 * One ticket from the accepted snapshot graph.
 */
export type TicketInfo = {
  number: string;
  path: string;
  blockedBy: string[];
};

/**
 * Outcome of one Standards or Spec review axis.
 */
export type ReviewAxis = "standards" | "spec";

/**
 * Result of running every configured gate on the current ticket tip. When a
 * rebase kept both reviews, passing gates make the ticket ready to land.
 */
export type GateOutcome = {
  passed: boolean;
  failed: string[];
  readyToLand: boolean;
};

/**
 * Result of one external review round after both axes and self-review finalize.
 */
export type RoundOutcome = {
  action: "land" | "fix";
  fixRequestPath: string | null;
};

/**
 * Result of bringing a ticket up to date with the base: rebased or already
 * current and ready for gates, or already reviewed and ready to land.
 */
export type SyncOutcome = "up_to_date" | "rebased" | "ready_to_land";

/**
 * Result of a landing attempt under the shared land lock.
 */
export type LandOutcome = "landed" | "rebase_required";

/**
 * Engine-side ticket operations. Each converges on the effect already recorded
 * in RESUME.md and evidence, so calling it again after a restart is safe.
 */
export type TicketOps = {
  implement: (ticket: TicketInfo) => Effect.Effect<void, WorkflowError>;
  rebase: (ticket: TicketInfo) => Effect.Effect<SyncOutcome, WorkflowError>;
  gates: (ticket: TicketInfo) => Effect.Effect<GateOutcome, WorkflowError>;
  selfReview: (ticket: TicketInfo) => Effect.Effect<void, WorkflowError>;
  review: (ticket: TicketInfo, axis: ReviewAxis) => Effect.Effect<void, WorkflowError>;
  finalizeRound: (ticket: TicketInfo) => Effect.Effect<RoundOutcome, WorkflowError>;
  fix: (ticket: TicketInfo, request: FixRequest) => Effect.Effect<void, WorkflowError>;
  land: (ticket: TicketInfo) => Effect.Effect<LandOutcome, WorkflowError>;
  beforeLaunch: () => Effect.Effect<void, WorkflowError>;
};

/**
 * Work sent back to a ticket's bound implementor.
 */
export type FixRequest = { kind: "review"; path: string } | { kind: "gates"; failed: string[] };

/**
 * Typed workflow failure that blocks one ticket or the run.
 */
export class WorkflowError extends Error {
  readonly issue: CliIssue;

  constructor(issue: CliIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

/**
 * Ticket handle given to script code. Every method resolves once its effect is
 * durable and rejects when the engine is stopping.
 */
export type Ticket = TicketInfo & {
  implement: () => Promise<void>;
  rebase: () => Promise<SyncOutcome>;
  gates: () => Promise<GateOutcome>;
  selfReview: () => Promise<void>;
  review: (axis: ReviewAxis) => Promise<void>;
  finalizeRound: () => Promise<RoundOutcome>;
  fix: (request: FixRequest) => Promise<void>;
  land: () => Promise<LandOutcome>;
  step: <T>(id: string, body: () => Promise<T>) => Promise<T>;
};

/**
 * Result of scheduling every ticket through the frontier.
 */
export type FrontierResult = {
  landed: string[];
  blocked: Array<{ ticket: string; issue: CliIssue }>;
};

/**
 * Run handle given to script code.
 */
export type Run = {
  tickets: TicketInfo[];
  parallel: number;
  frontier: (
    body: (ticket: Ticket) => Promise<void>,
    options?: { parallel?: number },
  ) => Promise<FrontierResult>;
  step: <T>(id: string, body: () => Promise<T>) => Promise<T>;
  emit: (type: string, data: Record<string, unknown>, attention?: boolean) => Promise<void>;
  parallelAll: <T>(bodies: Array<() => Promise<T>>) => Promise<T[]>;
};

const workflowIssue = (error: unknown): CliIssue => {
  if (typeof error === "object" && error !== null && "issue" in error) {
    return (error as { issue: CliIssue }).issue;
  }
  return {
    code: "workflow.step_failed",
    message: String(error instanceof Error ? error.message : error),
    remediation: "Inspect the event log and the ticket's evidence, then answer or restart.",
  };
};

/**
 * Reads the accepted ticket graph from `snapshot.json`.
 *
 * @param runPath - Run folder.
 * @returns The tickets in snapshot order.
 */
export const readTicketGraph = async (runPath: string): Promise<TicketInfo[]> => {
  const manifest = JSON.parse(await readFile(join(runPath, "snapshot.json"), "utf8")) as {
    tickets?: Array<{ number?: unknown; path?: unknown; blocked_by?: unknown }>;
  };
  return (manifest.tickets ?? []).map((ticket) => ({
    number: String(ticket.number),
    path: String(ticket.path),
    blockedBy: Array.isArray(ticket.blocked_by) ? ticket.blocked_by.map(String) : [],
  }));
};

/**
 * Parses ticket statuses from the `## Tickets` table in RESUME.md.
 *
 * @param markdown - RESUME.md text.
 * @returns Map from ticket number to recorded status.
 */
export const parseTicketStatuses = (markdown: string): Map<string, string> => {
  const statuses = new Map<string, string>();
  const heading = /^## Tickets\s*$/mu.exec(markdown);
  if (heading === null) return statuses;
  const lines = markdown.slice(heading.index + heading[0].length).split("\n");
  for (const line of lines) {
    if (line.startsWith("## ")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 9 || !/^\d+$/u.test(cells[1]!)) continue;
    statuses.set(cells[1]!, cells[7]!);
  }
  return statuses;
};

const parseCap = (markdown: string): { mode: "parallel" | "serial"; cap: number } => {
  const mode = /^Mode:\s*(serial|parallel)\s*$/mu.exec(markdown)?.[1] as
    | "serial"
    | "parallel"
    | undefined;
  const cap = Number(/^Parallel cap:\s*(\d+)\s*$/mu.exec(markdown)?.[1] ?? "1");
  return { mode: mode ?? "serial", cap: mode === "serial" ? 1 : cap };
};

/**
 * Topological levels for reporting waves; scheduling never waits on a wave.
 *
 * @param tickets - Accepted graph.
 * @returns Waves of ticket numbers.
 */
export const computeWaves = (tickets: TicketInfo[]): string[][] => {
  const byNumber = new Map(tickets.map((ticket) => [ticket.number, ticket]));
  const levels = new Map<string, number>();
  const level = (number: string, seen: Set<string>): number => {
    const known = levels.get(number);
    if (known !== undefined) return known;
    if (seen.has(number)) return 0;
    seen.add(number);
    const blockers = byNumber.get(number)?.blockedBy ?? [];
    const value = 1 + Math.max(0, ...blockers.map((blocker) => level(blocker, seen)));
    levels.set(number, value);
    return value;
  };
  const waves: string[][] = [];
  for (const ticket of tickets) {
    const index = level(ticket.number, new Set()) - 1;
    (waves[index] ??= []).push(ticket.number);
  }
  return waves.map((wave) => wave.toSorted());
};

const safeSegment = (id: string): string => {
  if (!/^[A-Za-z0-9][\w.-]{0,127}$/u.test(id)) {
    throw new WorkflowError({
      code: "workflow.step_id_invalid",
      message: `Step id \`${id}\` must match [A-Za-z0-9][A-Za-z0-9_.-]*.`,
      remediation: "Use a deterministic, filesystem-safe step id.",
    });
  }
  return id;
};

/**
 * Runs a custom step once and memoizes its JSON result as write-once evidence.
 *
 * @param path - Evidence file path.
 * @param body - Step body; its result must be JSON-serializable.
 * @returns The memoized or freshly computed value.
 */
export const memoizedStep = async <T>(path: string, body: () => Promise<T>): Promise<T> => {
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as { value: T };
    return stored.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = await body();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ value }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return value;
};

type RunOptions = {
  context: EngineContext;
  ops: TicketOps;
  tickets: TicketInfo[];
  signal: AbortSignal;
};

/**
 * Builds the script-facing run handle over engine services and ticket operations.
 *
 * @param options - Engine context, ticket operations, graph, and abort signal.
 * @returns The run handle.
 */
export const createRun = async (options: RunOptions): Promise<Run> => {
  const { context, ops, tickets, signal } = options;
  const initial = parseCap(await readFile(context.statePath, "utf8"));
  const perform = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
    Effect.runPromise(effect, { signal });

  const handle = (ticket: TicketInfo): Ticket => ({
    ...ticket,
    implement: () => perform(ops.implement(ticket)),
    rebase: () => perform(ops.rebase(ticket)),
    gates: () => perform(ops.gates(ticket)),
    selfReview: () => perform(ops.selfReview(ticket)),
    review: (axis) => perform(ops.review(ticket, axis)),
    finalizeRound: () => perform(ops.finalizeRound(ticket)),
    fix: (request) => perform(ops.fix(ticket, request)),
    land: () => perform(ops.land(ticket)),
    step: (id, body) =>
      memoizedStep(join(context.runPath, "steps", ticket.number, `${safeSegment(id)}.json`), body),
  });

  const frontier: Run["frontier"] = (body, frontierOptions) =>
    perform(
      Effect.gen(function* () {
        const cap = frontierOptions?.parallel ?? initial.cap;
        const mode = frontierOptions?.parallel === undefined ? initial.mode : "parallel";
        const running = new Map<string, Fiber.Fiber<void, never>>();
        const blocked = new Map<string, CliIssue>();
        const finished = yield* Queue.unbounded<string>();
        yield* context.emit("run.waves", null, { waves: computeWaves(tickets) });

        while (true) {
          const markdown = yield* Effect.promise(() => readFile(context.statePath, "utf8"));
          const recorded = parseTicketStatuses(markdown);
          const schedulerTickets: SchedulerTicket[] = tickets.map((ticket) => {
            const status = recorded.get(ticket.number) ?? "queued";
            const effective = running.has(ticket.number)
              ? "working"
              : blocked.has(ticket.number)
                ? "blocked"
                : status === "landed" || status === "closed" || status === "blocked"
                  ? status
                  : "queued";
            return {
              number: ticket.number,
              dependencies: ticket.blockedBy,
              status: effective,
            };
          });
          const plan = yield* planSchedule({
            mode,
            maxImplementors: cap,
            tickets: schedulerTickets,
            runtimes: [...running.keys()].map((number) => ({
              runtimeId: `frontier-${number}`,
              ticket: number,
              role: "implementor",
              state: "active",
            })),
          }).pipe(Effect.mapError((error) => new WorkflowError(error.issue)));

          if (plan.launch_tickets.length > 0) yield* ops.beforeLaunch();
          for (const number of plan.launch_tickets) {
            const ticket = tickets.find((candidate) => candidate.number === number)!;
            yield* context.emit("ticket.scheduled", number, {});
            const fiber = yield* Effect.forkChild(
              Effect.tryPromise({
                try: () => body(handle(ticket)),
                catch: (error) => error,
              }).pipe(
                Effect.matchEffect({
                  onSuccess: () => Queue.offer(finished, number).pipe(Effect.asVoid),
                  onFailure: (error) =>
                    Effect.gen(function* () {
                      const issue = workflowIssue(error);
                      blocked.set(number, issue);
                      yield* context
                        .emit("ticket.blocked", number, { issue }, true)
                        .pipe(Effect.ignore);
                      yield* Queue.offer(finished, number);
                    }),
                }),
              ),
            );
            running.set(number, fiber);
          }

          if (running.size === 0) {
            const after = parseTicketStatuses(
              yield* Effect.promise(() => readFile(context.statePath, "utf8")),
            );
            return {
              landed: tickets
                .filter((ticket) => after.get(ticket.number) === "landed")
                .map((ticket) => ticket.number),
              blocked: [...blocked].map(([ticket, issue]) => ({ ticket, issue })),
            };
          }
          const done = yield* Queue.take(finished);
          running.delete(done);
        }
      }),
    );

  return {
    tickets,
    parallel: initial.cap,
    frontier,
    step: (id, body) =>
      memoizedStep(join(context.runPath, "steps", "run", `${safeSegment(id)}.json`), body),
    emit: (type, data, attention = false) =>
      perform(context.emit(type, null, data, attention).pipe(Effect.asVoid)),
    parallelAll: (bodies) => Promise.all(bodies.map((body) => body())),
  };
};
