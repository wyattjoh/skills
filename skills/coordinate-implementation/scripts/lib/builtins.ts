import { Effect, Result, Semaphore, type Scope } from "effect";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { evaluateStallLive } from "./assessment.ts";
import type { CliIssue, RoleRecord } from "./contract.ts";
import { assertLease, type EngineContext } from "./engine.ts";
import {
  awaitAnswer,
  escalationDir,
  escalationId,
  openEscalation,
  type EscalationKind,
} from "./escalations.ts";
import { runGateProcess } from "./gate-runner.ts";
import { spawnGit } from "./git.ts";
import { makeHerdrActuator, type HerdrActuator } from "./herdr-actuator.ts";
import { makeHerdrHub, type HerdrHub, type PaneStatus } from "./herdr-hub.ts";
import { prepareImplementorLaunch, recordImplementorLaunch } from "./implementor.ts";
import { checkIntegration, operationInProgress } from "./integration.ts";
import { checkLandingRebase, completeLanding, type LandingRebaseResult } from "./landing.ts";
import { recordInfrastructureRetry } from "./retry.ts";
import {
  finalizeReviewRound,
  prepareReviewerLaunch,
  recordGate,
  recordReviewerLaunch,
  reviewDraftPath,
} from "./review.ts";
import {
  nextReviewRound,
  readActiveTicket,
  readRunConfig,
  readTicketStatus,
  renderBranch,
  ticketSlug,
  type ActiveTicket,
  type RunConfig,
} from "./run-config.ts";
import { checkSnapshot } from "./snapshot.ts";
import { runStallCheck, type StallCheck, type StallObservation } from "./stall-loop.ts";
import {
  WorkflowError,
  type FixRequest,
  type GateOutcome,
  type ReviewAxis,
  type TicketInfo,
  type TicketOps,
} from "./workflow-runtime.ts";
import { prepareWorktree } from "./worktrees.ts";

/**
 * Engine settings supplied by the run script's `workflow()` options.
 */
export type BuiltinOptions = {
  repository: string;
  implementSkill: string | undefined;
  workspace: string | undefined;
  socketPath: string | undefined;
  gateConcurrency: number;
  reviewChurnRound: number;
  answerPollMs: number;
  projectRemoteWrites: "allowed" | "forbidden";
  actuator: HerdrActuator | undefined;
};

const MAX_IMPLEMENTOR_ATTEMPTS = 3;

const utc = (): string => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");

const issueOf = (error: unknown): CliIssue => {
  if (typeof error === "object" && error !== null && "issue" in error) {
    return (error as { issue: CliIssue }).issue;
  }
  return {
    code: "workflow.step_failed",
    message: String(error instanceof Error ? error.message : error),
    remediation: "Inspect the event log and the ticket's evidence.",
  };
};

const toWorkflowError = (error: unknown): WorkflowError =>
  error instanceof WorkflowError ? error : new WorkflowError(issueOf(error));

const blocked = (code: string, message: string, remediation: string): WorkflowError =>
  new WorkflowError({ code, message, remediation });

const git = (worktree: string, args: string[]): string => {
  const result = spawnGit(["-C", worktree, ...args]);
  return result.exitCode === 0 ? result.stdout.trim() : "";
};

const head = (worktree: string): string => git(worktree, ["rev-parse", "HEAD"]);

const clean = (worktree: string): boolean =>
  spawnGit(["-C", worktree, "status", "--porcelain"]).stdout.trim().length === 0;

const commitsBeyond = (worktree: string, base: string): number =>
  Number(git(worktree, ["rev-list", "--count", `${base}..HEAD`]) || "0");

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

const ticketDetails = async (
  runPath: string,
  ticket: TicketInfo,
): Promise<{ title: string; criteria: string[] }> => {
  const text = (await readText(join(runPath, ticket.path))) ?? "";
  const title = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? `Ticket ${ticket.number}`;
  const criteria = [...text.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gmu)].map((match) =>
    match[1]!.trim(),
  );
  return { title, criteria };
};

/**
 * Production ticket operations over the helper library, Herdr, and Git.
 * Each operation converges on what RESUME.md and evidence already record.
 *
 * @param context - Engine context holding the lease.
 * @param overrides - Engine settings from the run script.
 * @returns A scoped Effect containing the ticket operations.
 */
export const builtinTicketOps = (
  context: EngineContext,
  overrides: Partial<BuiltinOptions>,
): Effect.Effect<TicketOps, WorkflowError, Scope.Scope> =>
  Effect.gen(function* () {
    const options: BuiltinOptions = {
      repository: overrides.repository ?? "",
      implementSkill: overrides.implementSkill,
      workspace: overrides.workspace ?? process.env.HERDR_WORKSPACE_ID,
      socketPath: overrides.socketPath ?? process.env.HERDR_SOCKET_PATH,
      gateConcurrency: overrides.gateConcurrency ?? 2,
      reviewChurnRound: overrides.reviewChurnRound ?? 5,
      answerPollMs: overrides.answerPollMs ?? 2_000,
      projectRemoteWrites: overrides.projectRemoteWrites ?? "forbidden",
      actuator: overrides.actuator,
    };
    if (options.repository.length === 0 || options.workspace === undefined) {
      return yield* Effect.fail(
        blocked(
          "runtime.options_missing",
          "workflow() needs `repository` and a Herdr workspace (HERDR_WORKSPACE_ID).",
          "Pass `{ repository: '<base checkout>' }` to workflow() and run the engine inside Herdr.",
        ),
      );
    }
    if (options.socketPath === undefined) {
      return yield* Effect.fail(
        blocked(
          "runtime.herdr_socket_missing",
          "HERDR_SOCKET_PATH is not set in the engine pane.",
          "Start the engine with `runtime.ts start` from inside Herdr.",
        ),
      );
    }
    const actuator = options.actuator ?? makeHerdrActuator();
    const hub: HerdrHub = yield* makeHerdrHub(options.socketPath);
    const gateSlots = yield* Semaphore.make(options.gateConcurrency);
    const { statePath, runPath } = context;
    const workspace = options.workspace;

    const markdown = Effect.promise(() => readFile(statePath, "utf8"));
    const config = markdown.pipe(
      Effect.flatMap((text) =>
        Effect.try({ try: () => readRunConfig(text), catch: toWorkflowError }),
      ),
    );
    const active = (ticket: TicketInfo) =>
      markdown.pipe(
        Effect.flatMap((text) =>
          Effect.try({ try: () => readActiveTicket(text, ticket.number), catch: toWorkflowError }),
        ),
      );
    const requireActive = (ticket: TicketInfo) =>
      active(ticket).pipe(
        Effect.flatMap((runtime) =>
          runtime === undefined
            ? Effect.fail(
                blocked(
                  "runtime.ticket_inactive",
                  `Ticket ${ticket.number} has no active runtime.`,
                  "Run implement() before later steps.",
                ),
              )
            : Effect.succeed(runtime),
        ),
      );

    /**
     * Runs one helper operation while holding the engine's state permit and lease.
     */
    const call = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, WorkflowError> =>
      context.exclusive(
        assertLease(context).pipe(Effect.andThen(effect), Effect.mapError(toWorkflowError)),
      );

    const emit = (
      type: string,
      ticket: string | null,
      data: Record<string, unknown>,
      attention = false,
    ) => context.emit(type, ticket, data, attention).pipe(Effect.ignore);

    const escalate = (
      ticket: TicketInfo,
      kind: EscalationKind,
      cycle: number,
      summary: string,
      detail: string,
    ): Effect.Effect<string, WorkflowError> =>
      Effect.gen(function* () {
        const names = yield* Effect.promise(() =>
          readdir(escalationDir(runPath)).catch(() => [] as string[]),
        );
        const prefix = `${ticket.number}-${kind}-${cycle}-`;
        const opened = names.filter(
          (name) =>
            name.startsWith(prefix) && name.endsWith(".json") && !name.endsWith(".answer.json"),
        );
        const answered = new Set(
          names.filter((name) => name.endsWith(".answer.json")).map((name) => name.slice(0, -12)),
        );
        const pending = opened.map((name) => name.slice(0, -5)).find((id) => !answered.has(id));
        const id = pending ?? escalationId(ticket.number, kind, cycle, opened.length + 1);
        const { created } = yield* openEscalation(runPath, {
          id,
          kind,
          ticket: ticket.number,
          summary,
          detail,
          opened_at: utc(),
        }).pipe(Effect.mapError(toWorkflowError));
        if (created) {
          yield* emit(`attention.${kind}`, ticket.number, { id, summary }, true);
        }
        const answer = yield* awaitAnswer(runPath, id, options.answerPollMs).pipe(
          Effect.mapError(toWorkflowError),
        );
        yield* emit("escalation.answered", ticket.number, { id, by: answer.answered_by });
        return answer.answer;
      });

    const deliver = (session: string, text: string) =>
      actuator.deliverPrompt(session, text).pipe(Effect.mapError(toWorkflowError));

    const questionPath = (ticket: TicketInfo) => join(runPath, "questions", `${ticket.number}.md`);

    const handleQuestion = (ticket: TicketInfo, runtime: ActiveTicket) =>
      Effect.gen(function* () {
        const path = questionPath(ticket);
        const question = yield* Effect.promise(() => readText(path));
        if (question === undefined) return false;
        const handled = yield* Effect.promise(() =>
          readdir(join(runPath, "questions")).catch(() => [] as string[]),
        );
        const sequence =
          handled.filter((name) => name.startsWith(`${ticket.number}-`) && name.endsWith(".md"))
            .length + 1;
        const answer = yield* escalate(
          ticket,
          "question",
          sequence,
          question
            .split("\n")
            .find((line) => line.trim().length > 0)
            ?.trim() ?? "Question",
          question,
        );
        yield* deliver(
          runtime.session,
          `Answer to your TICKET BLOCKED ${ticket.number} question:\n\n${answer}\n\nContinue the ticket with this decision.`,
        );
        yield* Effect.promise(() =>
          rename(path, join(runPath, "questions", `${ticket.number}-${sequence}.md`)),
        );
        return true;
      });

    const implementorPrompt = (ticket: TicketInfo) =>
      Effect.promise(async () => {
        const common = (await readText(join(runPath, "briefs", "common.md"))) ?? "";
        return [
          common.trim(),
          "",
          `Ticket ${ticket.number}: ${join(runPath, ticket.path)}`,
          `Specification: ${join(runPath, "spec.md")}`,
          "",
          `If you are blocked on a decision only the user can make, write the complete question to ${questionPath(ticket)}, then print \`TICKET BLOCKED ${ticket.number}\` and stop. The terminal transcript is not collected.`,
        ].join("\n");
      });

    const launch = (
      ticket: TicketInfo,
      attempt: number,
      cfg: RunConfig,
      bound: RoleRecord | undefined,
    ): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const slug = ticketSlug(ticket.path);
        const branch = renderBranch(cfg.branchTemplate, cfg.prefix, ticket.number, slug);
        const prepared = yield* call(
          prepareWorktree({
            statePath,
            repositoryPath: options.repository,
            baseBranch: cfg.base,
            branch,
            worktreeName: branch,
            expectedWorktreePath: undefined,
            policy: cfg.repositoryPolicy,
          }),
        );
        const tab = yield* actuator
          .ensureTab({
            workspace,
            cwd: prepared.worktree.path,
            label: `implement ${cfg.prefix} ${ticket.number} ${slug}`,
            env: {},
          })
          .pipe(Effect.mapError(toWorkflowError));
        const role = bound ?? cfg.implementor;
        const plan = yield* call(
          prepareImplementorLaunch({
            statePath,
            artifactPath: join(runPath, "briefs", `launch-${ticket.number}-a${attempt}.json`),
            ticket: ticket.number,
            worktreePath: prepared.worktree.path,
            branch: prepared.worktree.branch,
            session: `${cfg.prefix}-${ticket.number}`,
            tab: tab.tab_id,
            pane: tab.pane_id,
            role,
            implementSkillPath: role.harness === "pi" ? options.implementSkill : undefined,
            prompt: yield* implementorPrompt(ticket),
            attempt,
            maxAttempts: MAX_IMPLEMENTOR_ATTEMPTS,
          }),
        );
        const started = yield* actuator
          .run(plan.launch.start)
          .pipe(Effect.mapError(toWorkflowError));
        if (started.exitCode !== 0) {
          yield* call(
            recordImplementorLaunch({
              statePath,
              ticket: ticket.number,
              attempt,
              status: "failed",
              diagnostic: { stage: "start", exitCode: started.exitCode, stderr: started.stderr },
            }),
          );
          return yield* retryImplementor(ticket, attempt, "launch", started.stderr);
        }
        yield* deliver(`${cfg.prefix}-${ticket.number}`, plan.launch.prompt.args[3]!);
        yield* call(
          recordImplementorLaunch({
            statePath,
            ticket: ticket.number,
            attempt,
            status: "started",
            diagnostic: undefined,
          }),
        );
        yield* emit("implementor.launched", ticket.number, { attempt, pane: tab.pane_id });
      });

    /**
     * Finishes a launch an earlier engine prepared but never recorded: a live
     * session is recorded as started, anything else relaunches the same attempt.
     */
    const resumeLaunch = (ticket: TicketInfo, runtime: ActiveTicket, cfg: RunConfig) =>
      Effect.gen(function* () {
        const snapshot = yield* hub.snapshot().pipe(Effect.mapError(toWorkflowError));
        const live = snapshot.agents.some(
          (agent) =>
            agent.name === runtime.session ||
            agent.displayAgent === runtime.session ||
            agent.title === runtime.session,
        );
        if (!live) {
          yield* launch(ticket, runtime.attempt, cfg, runtime.implementor);
          return;
        }
        yield* call(
          recordImplementorLaunch({
            statePath,
            ticket: ticket.number,
            attempt: runtime.attempt,
            status: "started",
            diagnostic: undefined,
          }),
        );
        yield* emit("implementor.adopted", ticket.number, { attempt: runtime.attempt });
      });

    const retryImplementor = (
      ticket: TicketInfo,
      attempt: number,
      failure: "worker" | "herdr" | "launch",
      diagnostic: string,
    ): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        const retry = yield* call(
          recordInfrastructureRetry({
            statePath,
            ticket: ticket.number,
            attempt,
            failure,
            diagnostic: diagnostic.slice(0, 2_000) || failure,
          }),
        );
        if (retry.action === "block") {
          yield* escalateAndBlock(
            ticket,
            "retry_exhausted",
            attempt,
            `Ticket ${ticket.number} exhausted its ${failure} retries.`,
            diagnostic,
          );
        }
        yield* Effect.sleep(retry.delay_ms);
        const cfg = yield* config;
        yield* launch(ticket, attempt + 1, cfg, retry.binding.role);
      });

    const escalateAndBlock = (
      ticket: TicketInfo,
      kind: EscalationKind,
      cycle: number,
      summary: string,
      detail: string,
    ): Effect.Effect<never, WorkflowError> =>
      escalate(ticket, kind, cycle, summary, detail).pipe(
        Effect.flatMap((answer) =>
          Effect.fail(
            blocked(
              `runtime.${kind}`,
              `${summary} Answer recorded: ${answer}`,
              "Resolve the cause, then restart the engine to resume this ticket.",
            ),
          ),
        ),
      );

    /**
     * Waits for the ticket's implementor to reach `ready`, handling questions,
     * crashes, and stall assessments along the way.
     */
    const awaitWorker = (
      ticket: TicketInfo,
      purpose: string,
      ready: (runtime: ActiveTicket, cfg: RunConfig) => boolean,
    ): Effect.Effect<void, WorkflowError> =>
      Effect.gen(function* () {
        let previous: StallObservation | null = null;
        let sequence = 0;
        while (true) {
          const cfg = yield* config;
          const runtime = yield* requireActive(ticket);
          const outcome = yield* Effect.raceFirst(
            hub
              .awaitStatus({ session: runtime.session, paneId: runtime.pane }, [
                "idle",
                "done",
                "blocked",
                "exited",
              ])
              .pipe(Effect.map((result) => result.status as PaneStatus | "timeout")),
            Effect.sleep(cfg.stallIntervalMs).pipe(Effect.as("timeout" as const)),
          ).pipe(Effect.mapError(toWorkflowError));
          if (yield* handleQuestion(ticket, runtime)) continue;
          if (outcome !== "timeout" && outcome !== "exited" && ready(runtime, cfg)) return;
          if (outcome === "exited") {
            yield* emit("implementor.exited", ticket.number, { purpose }, true);
            yield* retryImplementor(ticket, runtime.attempt, "worker", "Implementor pane exited.");
            continue;
          }
          const details = yield* Effect.promise(() => ticketDetails(runPath, ticket));
          sequence += 1;
          const check: StallCheck = yield* runStallCheck(
            {
              runPath,
              ticket: {
                number: ticket.number,
                title: details.title,
                acceptanceCriteria: details.criteria,
              },
              worker: {
                session: runtime.session,
                paneId: runtime.pane,
                harness: runtime.implementor.harness,
                model: runtime.implementor.model,
                effort: runtime.implementor.effort,
                status:
                  outcome === "timeout" ? "working" : outcome === "blocked" ? "blocked" : "idle",
                phase: purpose,
              },
              worktree: runtime.worktree,
              base: cfg.base,
              sequence: Date.now() * 10 + (sequence % 10),
              previous,
            },
            actuator,
            {
              evaluate: (state) => Effect.runPromise(evaluateStallLive(state)),
              now: () => new Date(),
              monotonicNow: () => performance.now(),
            },
          ).pipe(Effect.mapError(toWorkflowError));
          previous = check.observation;
          yield* emit("stall.assessed", ticket.number, {
            action: check.action,
            reason: check.reason,
          });
          if (check.action === "retry-worker") {
            yield* retryImplementor(ticket, runtime.attempt, "worker", check.reason);
          } else if (check.action === "pause") {
            const answer = yield* escalate(
              ticket,
              "stall_pause",
              runtime.attempt,
              `Ticket ${ticket.number} stalled during ${purpose} (${check.reason}).`,
              check.observation.pane_tail.join("\n"),
            );
            yield* deliver(runtime.session, answer);
          } else if (check.action === "wait" && outcome !== "timeout") {
            yield* Effect.sleep(cfg.stallIntervalMs);
          }
        }
      });

    const implement: TicketOps["implement"] = (ticket) =>
      Effect.gen(function* () {
        const text = yield* markdown;
        if (readTicketStatus(text, ticket.number) === "landed") return;
        const cfg = yield* config;
        const existing = yield* active(ticket);
        if (existing === undefined) {
          yield* launch(ticket, 1, cfg, undefined);
        } else if (existing.phase === "launch prepared") {
          yield* resumeLaunch(ticket, existing, cfg);
        }
        yield* awaitWorker(
          ticket,
          "implementation",
          (runtime, current) =>
            clean(runtime.worktree) && commitsBeyond(runtime.worktree, current.base) > 0,
        );
      });

    const latestFixRequest = (ticket: TicketInfo, runtime: ActiveTicket) =>
      Effect.gen(function* () {
        const text = yield* markdown;
        const round = nextReviewRound(text, ticket.number) - 1;
        const failedRound = new RegExp(
          `Ticket ${ticket.number} round ${round} finalized: FAIL`,
          "u",
        );
        const fixes = join(runPath, "briefs", `fixes-${ticket.number}-round-${round}.md`);
        if (round > 0 && failedRound.test(text) && existsSync(fixes)) {
          return { kind: "review", path: fixes } as FixRequest;
        }
        const failed = yield* failedGates(ticket, runtime);
        if (failed.length > 0) return { kind: "gates", failed } as FixRequest;
        return undefined;
      });

    const failedGates = (ticket: TicketInfo, runtime: ActiveTicket) =>
      Effect.promise(async () => {
        const tip = head(runtime.worktree).slice(0, 12);
        const dir = join(runPath, "reviews");
        const names = await readdir(dir).catch(() => [] as string[]);
        const failed = new Set<string>();
        for (const name of names) {
          if (!name.startsWith(`${ticket.number}-${tip}-gate-`)) continue;
          const evidence = JSON.parse((await readText(join(dir, name))) ?? "{}") as {
            status?: string;
            gate?: { name?: string };
          };
          if (evidence.status === "failed" && evidence.gate?.name !== undefined) {
            failed.add(evidence.gate.name);
          }
        }
        return [...failed].toSorted();
      });

    const checkRebase = (ticket: TicketInfo, runtime: ActiveTicket) =>
      call(
        checkLandingRebase({
          statePath,
          repositoryPath: options.repository,
          worktreePath: runtime.worktree,
          ticket: ticket.number,
          completedAt: utc(),
        }),
      );

    const rebase: TicketOps["rebase"] = (ticket) =>
      Effect.gen(function* () {
        let rebased = false;
        while (true) {
          const runtime = yield* requireActive(ticket);
          const result: LandingRebaseResult = yield* checkRebase(ticket, runtime);
          if (result.action === "run-gates") return rebased ? "rebased" : "up_to_date";
          if (result.action === "land") return "ready_to_land";
          if (result.action === "rebase") {
            yield* emit("ticket.rebase_requested", ticket.number, { base_sha: result.base_sha });
            yield* deliver(runtime.session, result.prompt ?? "");
            yield* awaitWorker(
              ticket,
              "rebase",
              (current, cfg) =>
                !operationInProgress(current.worktree) &&
                clean(current.worktree) &&
                checkIntegration(current.worktree, cfg.base),
            );
            rebased = true;
            continue;
          }
          const pending = yield* latestFixRequest(ticket, runtime);
          if (pending !== undefined) {
            yield* fix(ticket, pending);
            continue;
          }
          const cfg = yield* config;
          yield* fixWith(
            ticket,
            runtime,
            `Your commits on this ticket do not satisfy the repository commit policy (${JSON.stringify(cfg.repositoryPolicy.commit)}). Reshape them in this worktree, keep the worktree clean, then print \`FIXES DONE ${ticket.number}\`.`,
          );
        }
      });

    const gates: TicketOps["gates"] = (ticket) =>
      Effect.gen(function* () {
        const cfg = yield* config;
        const runtime = yield* requireActive(ticket);
        const passed = new Set(runtime.integration?.passed_gates ?? []);
        const round = nextReviewRound(yield* markdown, ticket.number);
        const tip = head(runtime.worktree);
        const failed: string[] = [];
        for (const gate of cfg.reviewPolicy.gates) {
          if (passed.has(gate.name)) continue;
          const reviews = join(runPath, "reviews");
          yield* Effect.promise(() => mkdir(reviews, { recursive: true }));
          let attempt =
            (yield* Effect.promise(() => readdir(reviews))).filter((name) =>
              name.startsWith(`${ticket.number}-${tip.slice(0, 12)}-gate-${gate.name}-a`),
            ).length + 1;
          while (true) {
            yield* emit("gate.started", ticket.number, { name: gate.name, attempt });
            const run = yield* Semaphore.withPermits(
              gateSlots,
              1,
            )(runGateProcess(gate, runtime.worktree, process.env));
            const recorded = yield* call(
              recordGate({
                statePath,
                evidencePath: join(
                  reviews,
                  `${ticket.number}-${tip.slice(0, 12)}-gate-${gate.name}-a${attempt}.json`,
                ),
                worktreePath: runtime.worktree,
                ticket: ticket.number,
                round,
                name: gate.name,
                attempt,
                status: run.status,
                exitCode: run.exitCode ?? -1,
                stdout: run.stdout,
                stderr: run.stderr,
                completedAt: utc(),
              }),
            );
            yield* emit("gate.recorded", ticket.number, {
              name: gate.name,
              status: run.status,
              action: recorded.action,
            });
            if (recorded.action === "continue") break;
            if (recorded.action === "fix") {
              failed.push(gate.name);
              break;
            }
            if (recorded.action === "blocked") {
              return yield* escalateAndBlock(
                ticket,
                "retry_exhausted",
                runtime.integration?.cycle ?? 0,
                `Gate ${gate.name} could not run on ticket ${ticket.number}.`,
                run.stderr.slice(-4_000),
              );
            }
            yield* Effect.sleep((recorded.retry_delay_seconds ?? 1) * 1_000);
            attempt = recorded.next_attempt ?? attempt + 1;
          }
          if (failed.length > 0) break;
        }
        const after = yield* requireActive(ticket);
        return {
          passed: failed.length === 0,
          failed,
          readyToLand: failed.length === 0 && after.integration?.phase === "ready-to-land",
        } satisfies GateOutcome;
      });

    const selfReviewPaths = (ticket: TicketInfo, round: number) => {
      const path = join(runPath, "reviews", `${ticket.number}-r${round}-self-review.md`);
      return { path, draft: `${path}.draft.md` };
    };

    const selfReview: TicketOps["selfReview"] = (ticket) =>
      Effect.gen(function* () {
        const runtime = yield* requireActive(ticket);
        const round = nextReviewRound(yield* markdown, ticket.number);
        const { draft } = selfReviewPaths(ticket, round);
        if (existsSync(draft)) return;
        const request =
          runtime.implementor.harness === "claude"
            ? `Complete your implement workflow's self-review of the current branch now and write the complete self-review report to ${draft}.`
            : `Review your current branch in this session, without subagents: one Standards review against the repository instructions and one Spec review against the ticket and specification. Write a report with a \`## Standards\` section and a \`## Spec\` section to ${draft}.`;
        yield* deliver(runtime.session, `${request} Do not change code during this step.`);
        yield* awaitWorker(ticket, "self-review", () => existsSync(draft));
      });

    const review: TicketOps["review"] = (ticket, axis) =>
      Effect.gen(function* () {
        const text = yield* markdown;
        const cfg = yield* config;
        const runtime = yield* requireActive(ticket);
        const round = nextReviewRound(text, ticket.number);
        const reviews = join(runPath, "reviews");
        const tip = head(runtime.worktree);
        let previousArtifact: string | undefined;
        for (let attempt = 1; ; attempt++) {
          const base = join(reviews, `${ticket.number}-r${round}-${axis}-a${attempt}`);
          const artifactPath = `${base}.launch.json`;
          const reportPath = `${base}.md`;
          const evidence =
            (yield* Effect.promise(() => readText(`${reportPath}.json`))) ?? undefined;
          if (evidence !== undefined) {
            const stored = JSON.parse(evidence) as { status?: string; head_before?: string };
            if (stored.status === "accepted" && stored.head_before === tip) return;
            previousArtifact = artifactPath;
            continue;
          }
          yield* Effect.promise(() => mkdir(reviews, { recursive: true }));
          const tab = yield* actuator
            .ensureTab({
              workspace,
              cwd: runtime.worktree,
              label: `review ${cfg.prefix} ${ticket.number} r${round} ${axis} a${attempt}`,
              env: {},
            })
            .pipe(Effect.mapError(toWorkflowError));
          const gateEvidence = yield* Effect.promise(async () => {
            const names = await readdir(reviews).catch(() => [] as string[]);
            const paths: string[] = [];
            for (const name of names.filter((candidate) =>
              candidate.startsWith(`${ticket.number}-${tip.slice(0, 12)}-gate-`),
            )) {
              const stored = JSON.parse((await readText(join(reviews, name))) ?? "{}") as {
                status?: string;
              };
              if (stored.status === "passed") paths.push(join(reviews, name));
            }
            return paths.toSorted();
          });
          const landed = cfg.reviewPolicy.instruction_files;
          const prepared = yield* call(
            prepareReviewerLaunch({
              statePath,
              previousArtifactPath: previousArtifact,
              artifactPath,
              reportPath,
              ticket: ticket.number,
              round,
              axis,
              worktreePath: runtime.worktree,
              branch: runtime.branch,
              baseRef: runtime.integration?.base_sha ?? cfg.base,
              pane: tab.pane_id,
              role: cfg.reviewer,
              contextPaths:
                axis === "standards"
                  ? landed.map((file) => join(options.repository, file))
                  : [join(runPath, "spec.md"), join(runPath, ticket.path)],
              landedTickets: [
                ...text.matchAll(/^\|\s*(\d+)\s*\|.*\|\s*landed\s*\|[^|]*\|\s*$/gmu),
              ].map((match) => match[1]!),
              gateEvidencePaths: gateEvidence,
              attempt,
            }),
          );
          const session = prepared.launch.prompt.args[2]!;
          if (!prepared.recovered) {
            const started = yield* actuator
              .run(prepared.launch.start)
              .pipe(Effect.mapError(toWorkflowError));
            if (started.exitCode === 0) {
              yield* deliver(session, prepared.launch.prompt.args[3]!);
            }
          }
          yield* emit("reviewer.launched", ticket.number, { axis, round, attempt });
          const status = yield* hub
            .awaitStatus({ session, paneId: tab.pane_id }, ["idle", "done", "blocked", "exited"])
            .pipe(Effect.mapError(toWorkflowError));
          const draft = yield* Effect.promise(() => readText(reviewDraftPath(reportPath)));
          const input = {
            statePath,
            artifactPath,
            status:
              draft === undefined ? ("infrastructure_failed" as const) : ("completed" as const),
            report: draft,
            diagnostic:
              draft === undefined
                ? {
                    stage: "report",
                    exitCode: 1,
                    stderr: `Reviewer finished (${status.status}) without writing ${reviewDraftPath(reportPath)}.`,
                  }
                : undefined,
            completedAt: utc(),
          };
          let recorded = yield* call(recordReviewerLaunch(input));
          if (recorded.action === "close-runtime") {
            yield* actuator.closePane(recorded.pane_id).pipe(Effect.mapError(toWorkflowError));
            recorded = yield* call(recordReviewerLaunch(input));
          }
          yield* emit("review.recorded", ticket.number, {
            axis,
            round,
            attempt,
            status: recorded.status,
            verdict: recorded.verdict,
          });
          const action =
            recorded.action === "close-runtime" ? recorded.after_close_action : recorded.action;
          if (action === "continue" || action === "fix") return;
          if (action === "retry") {
            previousArtifact = artifactPath;
            continue;
          }
          return yield* escalateAndBlock(
            ticket,
            action === "manual_cleanup" ? "stall_pause" : "retry_exhausted",
            round,
            `The ${axis} review of ticket ${ticket.number} round ${round} needs attention (${action}).`,
            recorded.report_path,
          );
        }
      });

    const acceptedEvidence = (ticket: TicketInfo, round: number, axis: ReviewAxis) =>
      Effect.promise(async () => {
        for (let attempt = 4; attempt >= 1; attempt--) {
          const path = join(
            runPath,
            "reviews",
            `${ticket.number}-r${round}-${axis}-a${attempt}.md.json`,
          );
          const stored = (await readText(path)) ?? undefined;
          if (
            stored !== undefined &&
            (JSON.parse(stored) as { status?: string }).status === "accepted"
          ) {
            return path;
          }
        }
        return undefined;
      });

    const finalizeRound: TicketOps["finalizeRound"] = (ticket) =>
      Effect.gen(function* () {
        const runtime = yield* requireActive(ticket);
        if (runtime.integration?.phase === "ready-to-land") {
          return { action: "land" as const, fixRequestPath: null };
        }
        const round = nextReviewRound(yield* markdown, ticket.number);
        const standards = yield* acceptedEvidence(ticket, round, "standards");
        const spec = yield* acceptedEvidence(ticket, round, "spec");
        const { path, draft } = selfReviewPaths(ticket, round);
        const report = yield* Effect.promise(() => readText(draft));
        if (standards === undefined || spec === undefined || report === undefined) {
          return yield* Effect.fail(
            blocked(
              "runtime.round_incomplete",
              `Ticket ${ticket.number} round ${round} lacks accepted reviews or a self-review.`,
              "Run selfReview() and both review() axes before finalizeRound().",
            ),
          );
        }
        const result = yield* call(
          finalizeReviewRound({
            statePath,
            ticket: ticket.number,
            round,
            standardsEvidencePath: standards,
            specEvidencePath: spec,
            selfReviewPath: path,
            selfReviewMethod:
              runtime.implementor.harness === "claude"
                ? "matt-implement"
                : "standards-spec-single-session",
            selfReviewReport: report,
            fixRequestPath: join(runPath, "briefs", `fixes-${ticket.number}-round-${round}.md`),
            completedAt: utc(),
          }),
        );
        yield* emit("review.round_finalized", ticket.number, {
          round,
          verdict: result.verdict,
          findings: result.findings.length,
        });
        if (result.action === "fix" && round + 1 >= options.reviewChurnRound) {
          yield* emit("attention.review_churn", ticket.number, { round }, true);
        }
        return { action: result.action, fixRequestPath: result.fix_request_path };
      });

    const fixWith = (ticket: TicketInfo, runtime: ActiveTicket, text: string) =>
      Effect.gen(function* () {
        const before = head(runtime.worktree);
        yield* deliver(runtime.session, text);
        yield* awaitWorker(
          ticket,
          "fix",
          (current) => clean(current.worktree) && head(current.worktree) !== before,
        );
      });

    const fix: TicketOps["fix"] = (ticket, request) =>
      Effect.gen(function* () {
        const runtime = yield* requireActive(ticket);
        const text =
          request.kind === "review"
            ? `Apply every finding in ${request.path}. Follow the fix-commit policy it states, rerun every required gate and your self-review, then print \`FIXES DONE ${ticket.number}\`.`
            : `These required gates failed on your current commit: ${request.failed.join(", ")}. Their full output is in ${join(runPath, "reviews")} (files starting with ${ticket.number}-${head(runtime.worktree).slice(0, 12)}-gate-). Fix the cause, commit per the repository policy, rerun every required gate, then print \`FIXES DONE ${ticket.number}\`.`;
        yield* emit("ticket.fix_requested", ticket.number, { kind: request.kind });
        yield* fixWith(ticket, runtime, text);
      });

    const land: TicketOps["land"] = (ticket) =>
      Effect.gen(function* () {
        for (let attempt = 1; ; attempt++) {
          const runtime = yield* requireActive(ticket);
          const input = {
            statePath,
            repositoryPath: options.repository,
            worktreePath: runtime.worktree,
            evidencePath: join(runPath, "reviews", `${ticket.number}-landed.json`),
            ticket: ticket.number,
            cleanupArgv: undefined,
            lockWaitSeconds: undefined,
            completedAt: utc(),
          };
          const outcome = yield* Effect.result(call(completeLanding(input)));
          if (Result.isFailure(outcome)) {
            const issue = outcome.failure.issue;
            if (issue.code === "landing.lock_timeout" && attempt < 3) continue;
            if (issue.code === "landing.base_dirty") {
              yield* escalate(
                ticket,
                "retry_exhausted",
                attempt,
                `The base checkout ${options.repository} is dirty, so ticket ${ticket.number} cannot land.`,
                issue.message,
              );
              continue;
            }
            return yield* Effect.fail(outcome.failure);
          }
          let result = outcome.success;
          if (result.action === "close-runtime") {
            yield* actuator.closePane(result.pane_id).pipe(Effect.mapError(toWorkflowError));
            result = yield* call(completeLanding(input));
          }
          if (result.action === "rebase") return "rebase_required";
          if (result.action === "schedule") {
            yield* emit("ticket.landed", ticket.number, { tip: result.landed_tip }, false);
            return "landed";
          }
        }
      });

    const runTicket: TicketInfo = { number: "run", path: "", blockedBy: [] };

    const beforeLaunch: TicketOps["beforeLaunch"] = () =>
      Effect.gen(function* () {
        for (let sequence = 1; ; sequence++) {
          const outcome = yield* Effect.result(
            checkSnapshot({
              runPath,
              statePath,
              writeback: undefined,
              projectRemoteWrites: options.projectRemoteWrites,
              acceptedAt: undefined,
            }),
          );
          if (Result.isSuccess(outcome) && outcome.success.scheduling_allowed) return;
          const detail = Result.isSuccess(outcome)
            ? JSON.stringify(outcome.success.changed_inputs, null, 2)
            : outcome.failure.issue.message;
          const revision = Result.isSuccess(outcome) ? outcome.success.revision : "invalid";
          yield* escalate(
            runTicket,
            "snapshot_changed",
            sequence,
            `The run snapshot is ${Result.isSuccess(outcome) ? outcome.success.status : "invalid"} (${revision}); new tickets will not launch until it is accepted.`,
            detail,
          );
        }
      });

    return {
      beforeLaunch,
      implement,
      rebase,
      gates,
      selfReview,
      review,
      finalizeRound,
      fix,
      land,
    } satisfies TicketOps;
  });
