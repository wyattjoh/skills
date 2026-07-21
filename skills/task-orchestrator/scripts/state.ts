#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Manifest } from "./plan-graph.ts";

// The canonical per-task lifecycle states. Derive the type from this array so the
// runtime guard (isTaskStatus) and the compile-time union can never drift.
export const TASK_STATUSES = [
  "queued", // eligible deps not all merged, or waiting for a slot
  "running", // implementer producing the first commit
  "review", // reviewer judging the current round
  "rebasing", // implementer rebasing onto integration HEAD
  "verifying", // coordinator running the verification gate
  "merged", // fast-forwarded into the integration branch
  "escalated", // 3 rounds without approval, or verification stuck
  "blocked", // a dependency did not merge, or implementer returned blocked
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const VALID_STATUSES: ReadonlySet<string> = new Set(TASK_STATUSES);

// Runtime guard for status values read from the (untrusted) journal or passed in
// a patch. Keeps a typo like "implementing" from reaching the durable record.
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && VALID_STATUSES.has(value);
}

export interface TaskState {
  status: TaskStatus;
  round: number;
  worktree: string | null;
  branch: string | null;
  implementerAgent: string | null; // SendMessage handle for soft resume
  reviewerAgent: string | null;
  lastVerdict: "approved" | "changes_requested" | null;
  outstandingComments: string[];
  mergedSha: string | null;
  statusSince: string | null; // ISO 8601 time the current status was entered
}

export interface OrchestratorState {
  batch: string;
  baseBranch: string;
  integrationBranch: string;
  concurrency: number;
  manifest: Manifest;
  tasks: Record<string, TaskState>;
}

export interface ResumeSummary {
  merged: string[];
  inFlight: Array<TaskState & { id: string }>;
  escalated: string[];
  blocked: string[];
  ready: string[];
}

const IN_FLIGHT: ReadonlySet<TaskStatus> = new Set(["running", "review", "rebasing", "verifying"]);

// Validates that a batch name is a safe simple identifier that cannot escape the
// configured state root via traversal, absolute paths, or path separators.
// Throws before any file I/O occurs so callers can rely on a clean failure.
export function validateBatchName(batch: string, root: string): void {
  if (batch.length === 0) {
    throw new Error("Batch name must not be empty");
  }
  if (isAbsolute(batch)) {
    throw new Error(`Batch name must not be an absolute path: "${batch}"`);
  }
  if (batch.includes("/") || batch.includes("\\")) {
    throw new Error(`Batch name must not contain path separators: "${batch}"`);
  }
  if (batch === "." || batch === "..") {
    throw new Error(`Batch name must not be a dot segment: "${batch}"`);
  }
  // Defense in depth: verify the resolved candidate stays within the resolved root.
  const resolvedRoot = resolve(root);
  const candidate = resolve(join(root, batch));
  if (!candidate.startsWith(resolvedRoot + sep)) {
    throw new Error(`Batch name "${batch}" resolves outside the state root`);
  }
}

// Scratch path, deliberately outside any worktree so it is never committed.
export function statePath(batch: string, root = ".claude/task-orchestrator"): string {
  validateBatchName(batch, root);
  return join(root, batch, "state.json");
}

function freshTask(now: string): TaskState {
  return {
    status: "queued",
    round: 0,
    worktree: null,
    branch: null,
    implementerAgent: null,
    reviewerAgent: null,
    lastVerdict: null,
    outstandingComments: [],
    mergedSha: null,
    statusSince: now,
  };
}

export function initState(input: {
  batch: string;
  baseBranch: string;
  integrationBranch: string;
  concurrency: number;
  manifest: Manifest;
}): OrchestratorState {
  const now = new Date().toISOString();
  const tasks: Record<string, TaskState> = {};
  for (const task of input.manifest.tasks) tasks[task.id] = freshTask(now);
  return { ...input, tasks };
}

export function updateTask(
  state: OrchestratorState,
  id: string,
  patch: Partial<TaskState>,
  now: string = new Date().toISOString(),
): OrchestratorState {
  const current = state.tasks[id];
  if (!current) throw new Error(`Unknown task "${id}"`);
  if (patch.status != null && !isTaskStatus(patch.status)) {
    throw new Error(
      `Invalid status "${patch.status}" for task "${id}"; expected one of ${TASK_STATUSES.join(", ")}`,
    );
  }
  // Reset the timer only on a real status transition; round/comment/handle
  // patches keep the existing statusSince so the dashboard timer is accurate.
  const statusChanged = patch.status != null && patch.status !== current.status;
  const stamped = statusChanged ? { statusSince: now } : {};
  return { ...state, tasks: { ...state.tasks, [id]: { ...current, ...patch, ...stamped } } };
}

// Queued tasks whose every dependency has merged. Order follows the manifest.
export function computeReady(state: OrchestratorState): string[] {
  return state.manifest.tasks
    .filter((t) => state.tasks[t.id]?.status === "queued")
    .filter((t) => t.dependsOn.every((d) => state.tasks[d]?.status === "merged"))
    .map((t) => t.id);
}

// Git is the source of truth for "merged"; fold its verdict back into the journal.
export function reconcileWithGit(
  state: OrchestratorState,
  mergedIds: string[],
): { state: OrchestratorState; changed: string[] } {
  let next = state;
  const changed: string[] = [];
  for (const id of mergedIds) {
    if (next.tasks[id] && next.tasks[id].status !== "merged") {
      next = updateTask(next, id, { status: "merged" });
      changed.push(id);
    }
  }
  return { state: next, changed };
}

// A queued task with an escalated/blocked dependency cannot start; mark it blocked, transitively.
export function propagateBlocks(state: OrchestratorState): {
  state: OrchestratorState;
  blocked: string[];
} {
  let next = state;
  const blocked: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of next.manifest.tasks) {
      const ts = next.tasks[task.id];
      if (!ts || ts.status !== "queued") continue;
      const stuck = task.dependsOn.some(
        (d) => next.tasks[d]?.status === "escalated" || next.tasks[d]?.status === "blocked",
      );
      if (stuck) {
        next = updateTask(next, task.id, { status: "blocked" });
        blocked.push(task.id);
        changed = true;
      }
    }
  }
  return { state: next, blocked };
}

export function resumeSummary(state: OrchestratorState): ResumeSummary {
  const ids = Object.keys(state.tasks);
  return {
    merged: ids.filter((id) => state.tasks[id].status === "merged"),
    inFlight: ids
      .filter((id) => IN_FLIGHT.has(state.tasks[id].status))
      .map((id) => ({ id, ...state.tasks[id] })),
    escalated: ids.filter((id) => state.tasks[id].status === "escalated"),
    blocked: ids.filter((id) => state.tasks[id].status === "blocked"),
    ready: computeReady(state),
  };
}

export function readState(path: string): OrchestratorState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OrchestratorState;
  } catch {
    return null;
  }
}

// Atomic write: temp file + rename, so a crash mid-write never leaves a partial journal.
export function writeState(path: string, state: OrchestratorState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

function main(): void {
  const program = new Command()
    .name("state")
    .description("Inspect a task-orchestrator state journal")
    .version("1.0.0");

  program
    .command("init <batch>")
    .description("Create the initial state journal for a batch")
    .requiredOption("--manifest <file>", "Manifest JSON emitted by plan-graph.ts")
    .requiredOption("--base-branch <branch>", "Base branch for the batch")
    .requiredOption("--integration-branch <branch>", "Integration branch for the batch")
    .requiredOption("--concurrency <n>", "Concurrent task pipeline limit", parseConcurrency)
    .option("--root <dir>", "State root directory")
    .option("--force", "Overwrite an existing state journal", false)
    .action(
      (
        batch: string,
        opts: {
          manifest: string;
          baseBranch: string;
          integrationBranch: string;
          concurrency: number;
          root?: string;
          force: boolean;
        },
      ) => {
        const path = statePath(batch, opts.root);
        if (existsSync(path) && !opts.force) {
          process.stderr.write(`state journal already exists for batch "${batch}"\n`);
          process.exit(1);
        }

        const manifest = JSON.parse(readFileSync(opts.manifest, "utf8")) as Manifest;
        if (!manifest.ok) {
          process.stderr.write(`manifest for batch "${batch}" is not valid\n`);
          process.exit(1);
        }

        writeState(
          path,
          initState({
            batch,
            baseBranch: opts.baseBranch,
            integrationBranch: opts.integrationBranch,
            concurrency: opts.concurrency,
            manifest,
          }),
        );
        process.stdout.write(`${path}\n`);
      },
    );

  program
    .command("summary <batch>")
    .description("Print the resume summary for a batch")
    .option("--root <dir>", "State root directory")
    .action((batch: string, opts: { root?: string }) => {
      const state = readState(statePath(batch, opts.root));
      if (!state) {
        process.stderr.write(`no state journal for batch "${batch}"\n`);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(resumeSummary(state), null, 2) + "\n");
    });

  program.parse();
}

function parseConcurrency(value: string): number {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency "${value}"`);
  }
  return concurrency;
}

if (import.meta.main) main();
