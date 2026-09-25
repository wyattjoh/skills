import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import type { CliIssue } from "./contract.ts";
import { replaceFileAtomically } from "./fs-atomic.ts";
import { spawnGit } from "./git.ts";
import { sectionText, ticketRows } from "./resume-sections.ts";
import { sha256Hex } from "./values.ts";

/**
 * Schema version of `runs/<run-id>.json`. Bump only when an existing field is
 * removed, renamed, or changes type; additive fields keep the version.
 */
export const GLOBAL_RUN_SCHEMA_VERSION = 1 as const;

/**
 * Schema version of `agreements/<repo-id>.json`, versioned independently.
 */
export const GLOBAL_AGREEMENTS_SCHEMA_VERSION = 1 as const;

/**
 * Default stall interval used when RESUME.md does not record one.
 */
export const DEFAULT_STALL_INTERVAL_MINUTES = 10;

/**
 * Inclusive bounds for a persisted `Stall interval:` value.
 */
export const STALL_INTERVAL_BOUNDS = { min: 2, max: 60 } as const;

/**
 * One ticket row as projected into the global run file.
 */
export type GlobalTicket = {
  number: string;
  status: string;
  harness: string | null;
  model: string | null;
  effort: string | null;
};

/**
 * One active implementor runtime as projected into the global run file.
 */
export type GlobalRuntime = {
  ticket: string;
  session: string | null;
  pane: string | null;
  phase: string | null;
  attempt: number | null;
};

/**
 * One stall pause recorded in `## Stall evidence`.
 */
export type GlobalPause = {
  ticket: string;
  reason: string;
  evidence_path: string | null;
};

/**
 * Curated, machine-local summary of one coordination run.
 */
export type GlobalRunFile = {
  kind: "run";
  schema_version: typeof GLOBAL_RUN_SCHEMA_VERSION;
  run_id: string;
  repo: { common_dir: string | null; base_checkout: string | null };
  run_folder: string;
  state_path: string;
  prefix: string | null;
  base: string | null;
  base_sha: string | null;
  mode: string | null;
  parallel_cap: number | null;
  stall_interval_minutes: number | null;
  run_status: "active" | "waiting" | "completed";
  summary_path: string | null;
  tickets: GlobalTicket[];
  active_runtimes: GlobalRuntime[];
  coordinator: { generation: number | null; pane: string | null; readiness: string | null };
  pauses: GlobalPause[];
  last_operation: string | null;
  updated_at: string;
  heartbeat_at: string | null;
};

/**
 * Shared-file assignment inside a cross-run agreement.
 */
export type SharedFileAssignment = {
  path: string;
  owner_prefix: string;
};

/**
 * Repository-wide cross-run agreement owned by one run.
 */
export type GlobalAgreementsFile = {
  kind: "agreements";
  schema_version: typeof GLOBAL_AGREEMENTS_SCHEMA_VERSION;
  common_dir: string;
  owner_run_id: string;
  merge_order: string[];
  shared_files: SharedFileAssignment[];
  updated_at: string;
};

const warnings: CliIssue[] = [];
let currentOperation: string | null = null;

/**
 * Records the helper operation that caused subsequent global writes.
 *
 * @param operation - Validated operation name, or null outside the CLI.
 */
export const setCurrentOperation = (operation: string | null): void => {
  currentOperation = operation;
};

/**
 * Records one non-fatal global-state problem for the current response.
 *
 * @param issue - Actionable warning.
 */
export const recordGlobalWarning = (issue: CliIssue): void => {
  warnings.push(issue);
};

/**
 * Returns and clears the warnings recorded during the current request.
 *
 * @returns Every warning recorded since the last drain.
 */
export const drainGlobalWarnings = (): CliIssue[] => warnings.splice(0, warnings.length);

/**
 * Resolves the machine-local state root, honoring an absolute `XDG_STATE_HOME`.
 *
 * @param env - Environment to read.
 * @returns Absolute `coordinate-implementation` state directory.
 */
export const globalStateRoot = (env: Record<string, string | undefined>): string => {
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, "coordinate-implementation");
  const home = env.HOME;
  if (home === undefined || !isAbsolute(home)) {
    throw new Error("Neither an absolute XDG_STATE_HOME nor HOME is set.");
  }
  return join(home, ".local", "state", "coordinate-implementation");
};

/**
 * Derives the stable agreements file id for one repository.
 *
 * @param commonDir - Realpath of the repository's Git common directory.
 * @returns First 12 hex characters of the path's SHA-256.
 */
export const repositoryId = (commonDir: string): string => sha256Hex(commonDir).slice(0, 12);

const RUN_ID_PATTERN = /^Run id:[ \t]*(\S+)[ \t]*$/mu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Reads the persisted run id when it is a well-formed UUID.
 *
 * @param markdown - RESUME.md text.
 * @returns The run id, or null when absent or malformed.
 */
export const parseRunId = (markdown: string): string | null => {
  const value = RUN_ID_PATTERN.exec(markdown)?.[1];
  return value !== undefined && UUID_PATTERN.test(value) ? value : null;
};

/**
 * Inserts `Run id:` after the schema marker when the header lacks one.
 *
 * @param markdown - RESUME.md text.
 * @param generate - UUID generator.
 * @returns Text guaranteed to contain a run id line when a schema marker exists.
 */
export const ensureRunId = (markdown: string, generate: () => string = randomUUID): string => {
  if (RUN_ID_PATTERN.test(markdown)) return markdown;
  const marker = /^Schema version:[^\r\n]*$/mu.exec(markdown);
  if (marker === null) return markdown;
  const end = marker.index + marker[0].length;
  return `${markdown.slice(0, end)}\nRun id: ${generate()}${markdown.slice(end)}`;
};

const headerValue = (markdown: string, label: string): string | null =>
  new RegExp(`^${label}:[ \\t]*(\\S.*?)[ \\t]*$`, "mu").exec(markdown)?.[1] ?? null;

const integerOrNull = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\d+$/u.test(value)) return null;
  return Number(value);
};

/**
 * Parses a persisted `Stall interval:` value in minutes.
 *
 * @param markdown - RESUME.md text.
 * @returns The interval, the default when absent, or null when invalid.
 */
export const parseStallInterval = (markdown: string): number | null => {
  const value = headerValue(markdown, "Stall interval");
  if (value === null) return DEFAULT_STALL_INTERVAL_MINUTES;
  const minutes = integerOrNull(/^(\d+)m$/u.exec(value)?.[1]);
  if (minutes === null) return null;
  return minutes >= STALL_INTERVAL_BOUNDS.min && minutes <= STALL_INTERVAL_BOUNDS.max
    ? minutes
    : null;
};

const dashToNull = (value: string | undefined): string | null =>
  value === undefined || value === "" || value === "-" ? null : value;

const parseTickets = (markdown: string): GlobalTicket[] =>
  ticketRows(markdown).flatMap((row) =>
    row.status === undefined
      ? []
      : [
          {
            number: row.NN,
            status: row.status,
            harness: dashToNull(row.harness),
            model: dashToNull(row.model),
            effort: dashToNull(row.effort),
          },
        ],
  );

const parseRuntimes = (markdown: string): GlobalRuntime[] => {
  const active = sectionText(markdown, "Active tickets") ?? "";
  return [...active.matchAll(/^### (\d+)[ \t]*$/gmu)].flatMap((heading) => {
    const block = activeRuntimeBlockPattern(heading[1]!).exec(active)?.[0];
    if (block === undefined) return [];
    const fields = parseActiveRuntimeFields(block);
    return [
      {
        ticket: heading[1]!,
        session: fields.Session ?? null,
        pane: fields.Pane ?? null,
        phase: fields.Phase ?? null,
        attempt: integerOrNull(fields.Attempt),
      },
    ];
  });
};

const parseOwnership = (markdown: string): GlobalRunFile["coordinator"] => {
  const block = /^Coordinator ownership:\r?\n((?: {2}[^\r\n]*(?:\r?\n|$))+)/mu.exec(markdown)?.[1];
  const fields: Record<string, string> = {};
  for (const line of (block ?? "").split(/\r?\n/u)) {
    const field = /^ {2}([a-z][a-z ]*):\s*(.*)$/u.exec(line);
    if (field !== null) fields[field[1]!] = field[2]!.trim();
  }
  return {
    generation: integerOrNull(fields.generation),
    pane: fields.pane ?? null,
    readiness: fields.readiness ?? null,
  };
};

const parsePauses = (markdown: string): GlobalPause[] =>
  [
    ...(sectionText(markdown, "Stall evidence") ?? "").matchAll(
      /^- Ticket (\d+) [^:\r\n]*: pause\/([^;\r\n]+)(?:;[^\r\n]*?evidence ([^;\s]+))?/gmu,
    ),
  ].map((match) => ({
    ticket: match[1]!,
    reason: match[2]!.trim(),
    evidence_path: match[3] ?? null,
  }));

const parseOutcome = (
  markdown: string,
): { status: GlobalRunFile["run_status"]; summaryPath: string | null } => {
  const json = /```json\s*\n([\s\S]*?)\n```/u.exec(sectionText(markdown, "Run outcome") ?? "")?.[1];
  if (json === undefined) return { status: "active", summaryPath: null };
  try {
    const value = JSON.parse(json) as { status?: unknown; summary_path?: unknown };
    const status =
      value.status === "waiting" || value.status === "completed" ? value.status : "active";
    return {
      status,
      summaryPath: typeof value.summary_path === "string" ? value.summary_path : null,
    };
  } catch {
    return { status: "active", summaryPath: null };
  }
};

/**
 * Identifies the repository that contains a run folder.
 *
 * @param runFolder - Absolute run directory.
 * @returns Realpaths of the Git common directory and checkout top level.
 */
export const resolveRepository = async (runFolder: string): Promise<GlobalRunFile["repo"]> => {
  const git = (args: string[]): string | null => {
    const result = spawnGit(args, { cwd: runFolder });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  };
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  return {
    common_dir: commonDir === null ? null : await realpath(commonDir).catch(() => commonDir),
    base_checkout: topLevel === null ? null : await realpath(topLevel).catch(() => topLevel),
  };
};

/**
 * Projects RESUME.md into the curated global run summary. Unparseable sections
 * project as null or empty rather than failing.
 *
 * @param markdown - RESUME.md text containing a run id.
 * @param statePath - Absolute RESUME.md path.
 * @param repo - Repository identity for the run folder.
 * @param now - Observation timestamp.
 * @returns The projection, or null when the run id is missing.
 */
export const projectRun = (
  markdown: string,
  statePath: string,
  repo: GlobalRunFile["repo"],
  now: string,
): GlobalRunFile | null => {
  const runId = parseRunId(markdown);
  if (runId === null) return null;
  const outcome = parseOutcome(markdown);
  return {
    kind: "run",
    schema_version: GLOBAL_RUN_SCHEMA_VERSION,
    run_id: runId,
    repo,
    run_folder: dirname(statePath),
    state_path: statePath,
    prefix: headerValue(markdown, "Prefix"),
    base: headerValue(markdown, "Base"),
    base_sha: headerValue(markdown, "Base sha"),
    mode: headerValue(markdown, "Mode"),
    parallel_cap: integerOrNull(headerValue(markdown, "Parallel cap")),
    stall_interval_minutes: parseStallInterval(markdown),
    run_status: outcome.status,
    summary_path: outcome.summaryPath,
    tickets: parseTickets(markdown),
    active_runtimes: parseRuntimes(markdown),
    coordinator: parseOwnership(markdown),
    pauses: parsePauses(markdown),
    last_operation: currentOperation,
    updated_at: now,
    heartbeat_at: null,
  };
};

/**
 * Writes JSON through a same-directory temporary file and atomic rename.
 *
 * @param path - Destination file.
 * @param value - JSON-serializable value.
 */
export const writeJsonAtomically = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await replaceFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
};

const readJson = async <Value>(path: string): Promise<Value | null> =>
  readFile(path, "utf8")
    .then((raw) => JSON.parse(raw) as Value)
    .catch(() => null);

/**
 * Path of one run's global file.
 *
 * @param root - Global state root.
 * @param runId - Persisted run id.
 * @returns Absolute run file path.
 */
export const runFilePath = (root: string, runId: string): string =>
  join(root, "runs", `${runId}.json`);

/**
 * Path of one repository's agreements file.
 *
 * @param root - Global state root.
 * @param commonDir - Realpath of the repository's Git common directory.
 * @returns Absolute agreements file path.
 */
export const agreementsFilePath = (root: string, commonDir: string): string =>
  join(root, "agreements", `${repositoryId(commonDir)}.json`);

/**
 * Kind of global write: a state mutation refreshes the summary and keeps the
 * last heartbeat; a heartbeat refreshes liveness and keeps the mutation fields.
 */
export type PublishKind = "mutation" | "heartbeat";

/**
 * Publishes one run's projection. The caller must hold the run state lock so
 * mutation and heartbeat writers cannot interleave. Failures become warnings.
 *
 * @param statePath - RESUME.md path.
 * @param markdown - Current RESUME.md text.
 * @param kind - Which writer is publishing.
 * @param env - Environment used to resolve the state root.
 * @returns An Effect that never fails.
 */
export const publishRun = (
  statePath: string,
  markdown: string,
  kind: PublishKind,
  env: Record<string, string | undefined> = process.env,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => publishRunUnsafe(statePath, markdown, kind, env),
    catch: (error) => error as Error,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        recordGlobalWarning({
          code: "global_state.write_failed",
          message: `Could not publish global run state: ${error.message}`,
          remediation:
            "RESUME.md is unchanged by this failure. Fix the state directory or HOME, and the next mutation or wait republishes it.",
        }),
      ),
    ),
  );

const publishRunUnsafe = async (
  statePath: string,
  markdown: string,
  kind: PublishKind,
  env: Record<string, string | undefined>,
): Promise<void> => {
  const absolute = resolve(statePath);
  const now = new Date().toISOString();
  const repo = await resolveRepository(dirname(absolute));
  const projection = projectRun(markdown, absolute, repo, now);
  if (projection === null) {
    throw new Error("RESUME.md has no valid `Run id:` line.");
  }
  const path = runFilePath(globalStateRoot(env), projection.run_id);
  const existing = await readJson<GlobalRunFile>(path);
  const merged: GlobalRunFile =
    kind === "mutation"
      ? { ...projection, heartbeat_at: existing?.heartbeat_at ?? null }
      : {
          ...projection,
          last_operation: existing?.last_operation ?? null,
          updated_at: existing?.updated_at ?? now,
          heartbeat_at: now,
        };
  await writeJsonAtomically(path, merged);
};

/**
 * Reads an agreements file when present.
 *
 * @param path - Agreements file path.
 * @returns The parsed file, or null when absent or unreadable.
 */
export const readAgreements = (path: string): Promise<GlobalAgreementsFile | null> =>
  readJson<GlobalAgreementsFile>(path);
