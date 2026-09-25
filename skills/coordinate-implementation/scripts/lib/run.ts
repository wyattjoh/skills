import { Data, Effect } from "effect";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliIssue, RoleRecord, RunFinalizeInput, WritebackMode } from "./contract.ts";
import { checkSnapshot } from "./snapshot.ts";
import { mutateStateFile, StateMutationError } from "./state-mutation.ts";

/**
 * Tracker work that remains after local run completion.
 */
export type TrackerAction = {
  mode: WritebackMode;
  status: "not-applicable" | "pending" | "forbidden";
  workflow: string | null;
};

/**
 * Deterministic terminal-state result returned by the run finalizer.
 */
export type RunFinalizeResult = {
  status: "active" | "waiting" | "completed";
  landed_tickets: string[];
  blocked_tickets: string[];
  closed_tickets: string[];
  runnable_tickets: string[];
  summary_path: string | null;
  tracker_action: TrackerAction;
};

/**
 * Controlled lifecycle hooks used to coordinate deterministic finalization tests.
 */
export type RunFinalizeHooks = {
  afterSnapshotCheck?: () => Promise<void>;
};

/**
 * Typed malformed-state, authorization, or persistence failure during run finalization.
 */
export class RunFinalizeError extends Data.TaggedError("RunFinalizeError")<{
  issue: CliIssue;
}> {}

type TicketRow = {
  number: string;
  harness: string;
  model: string;
  effort: string;
  status: string;
  sha: string;
};

type TicketTable = {
  start: number;
  end: number;
  lines: string[];
  rows: TicketRow[];
  statusIndex: number;
};

type SnapshotManifest = {
  tickets: Array<{ number: string; blocked_by: string[] }>;
};

type ActiveBlock = {
  ticket: string;
  text: string;
  branch: string | null;
};

type FinalizationUpdate = {
  result: RunFinalizeResult;
  summary: string | null;
};

const runError = (code: string, message: string, remediation: string): RunFinalizeError =>
  new RunFinalizeError({ issue: { code, message, remediation } });

const fromMutationError = (error: StateMutationError | RunFinalizeError): RunFinalizeError => {
  if (error instanceof RunFinalizeError) return error;
  return runError(
    error.kind === "lock_busy" ? "run.state_busy" : "run.state_io_failed",
    `Could not update terminal run state: ${error.message}`,
    "Verify RESUME.md is writable, then retry the same finalization request.",
  );
};

const sectionBounds = (markdown: string, name: string): { start: number; end: number } | null => {
  const heading = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "mu").exec(
    markdown,
  );
  if (heading === null) return null;
  const start = heading.index;
  const contentStart = heading.index + heading[0].length;
  const next = /^## /gmu;
  next.lastIndex = contentStart;
  return { start, end: next.exec(markdown)?.index ?? markdown.length };
};

const parseRole = (markdown: string, name: string): RoleRecord => {
  const match = new RegExp(
    `^${name}:\\s*\\n\\s+harness:\\s*(claude|pi)\\s*\\n\\s+model:\\s*(.+?)\\s*\\n\\s+effort:\\s*(\\S+)\\s*$`,
    "mu",
  ).exec(markdown);
  if (match === null) {
    throw runError(
      "run.role_malformed",
      `RESUME.md has no complete ${name} role record.`,
      "Repair the schema-2 role records before evaluating run completion.",
    );
  }
  return { harness: match[1] as RoleRecord["harness"], model: match[2]!, effort: match[3]! };
};

const parseTicketTable = (markdown: string): TicketTable => {
  const bounds = sectionBounds(markdown, "Tickets");
  if (bounds === null) {
    throw runError(
      "run.tickets_missing",
      "RESUME.md has no Tickets section.",
      "Restore the schema-2 ticket table before evaluating run completion.",
    );
  }
  const section = markdown.slice(bounds.start, bounds.end);
  const lines = section.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("| NN"));
  if (headerIndex < 0) {
    throw runError(
      "run.tickets_malformed",
      "RESUME.md ticket table has no NN header row.",
      "Repair the schema-2 ticket table before evaluating run completion.",
    );
  }
  const headers = lines[headerIndex]!.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const indexes = {
    number: headers.indexOf("NN"),
    harness: headers.indexOf("harness"),
    model: headers.indexOf("model"),
    effort: headers.indexOf("effort"),
    status: headers.indexOf("status"),
    sha: headers.indexOf("sha"),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw runError(
      "run.tickets_malformed",
      "RESUME.md ticket table is missing a required schema-2 column.",
      "Restore NN, harness, model, effort, status, and sha columns before finalization.",
    );
  }
  const rows = lines.slice(headerIndex + 2).flatMap((line) => {
    if (!line.trimStart().startsWith("|")) return [];
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const number = cells[indexes.number]!;
    return /^\d+$/u.test(number)
      ? [
          {
            number,
            harness: cells[indexes.harness]!,
            model: cells[indexes.model]!,
            effort: cells[indexes.effort]!,
            status: cells[indexes.status]!,
            sha: cells[indexes.sha]!,
          },
        ]
      : [];
  });
  if (rows.length === 0 || new Set(rows.map((row) => row.number)).size !== rows.length) {
    throw runError(
      "run.tickets_malformed",
      "RESUME.md ticket table is empty or contains duplicate tickets.",
      "Repair the schema-2 ticket table before evaluating run completion.",
    );
  }
  return { start: bounds.start, end: bounds.end, lines, rows, statusIndex: indexes.status };
};

const replaceTicketStatuses = (
  markdown: string,
  table: TicketTable,
  closedTickets: Set<string>,
): string => {
  if (closedTickets.size === 0) return markdown;
  const lines = table.lines.map((line) => {
    if (!line.trimStart().startsWith("|")) return line;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!closedTickets.has(cells[0]!)) return line;
    cells[table.statusIndex] = "closed";
    return `| ${cells.join(" | ")} |`;
  });
  return `${markdown.slice(0, table.start)}${lines.join("\n")}${markdown.slice(table.end)}`;
};

const parseRuntimeBlocks = (markdown: string, sectionName: string): ActiveBlock[] => {
  const bounds = sectionBounds(markdown, sectionName);
  if (bounds === null) return [];
  const section = markdown.slice(bounds.start, bounds.end);
  const headings = [...section.matchAll(/^### (\d+)\s*$/gmu)];
  return headings.map((heading, index) => {
    const start = heading.index!;
    const end = index + 1 < headings.length ? headings[index + 1]!.index! : section.length;
    const text = section.slice(start, end).trim();
    const branch = /^Branch:\s*(.+)$/mu.exec(text)?.[1]?.trim() ?? null;
    return { ticket: heading[1]!, text, branch };
  });
};

const moveClosedRuntimeBlocks = (
  markdown: string,
  closedTickets: Set<string>,
  reasons: Map<string, string>,
  completedAt: string,
): { markdown: string; branches: string[] } => {
  if (closedTickets.size === 0) return { markdown, branches: [] };
  const blocks = parseRuntimeBlocks(markdown, "Active tickets");
  const closed = blocks.filter((block) => closedTickets.has(block.ticket));
  if (closed.length === 0) return { markdown, branches: [] };
  const activeBounds = sectionBounds(markdown, "Active tickets")!;
  const remaining = blocks.filter((block) => !closedTickets.has(block.ticket));
  const activeSection = `## Active tickets\n${remaining.length === 0 ? "" : `\n${remaining.map((block) => block.text).join("\n\n")}\n`}`;
  let updated = `${markdown.slice(0, activeBounds.start)}${activeSection}${markdown.slice(activeBounds.end)}`;
  const rendered = closed
    .map(
      (block) =>
        `${block.text}\nClosed at: ${completedAt}\nClose reason: ${reasons.get(block.ticket)!}`,
    )
    .join("\n\n");
  const closedBounds = sectionBounds(updated, "Closed ticket runtimes");
  if (closedBounds === null) {
    updated = `${updated.trimEnd()}\n\n## Closed ticket runtimes\n\n${rendered}\n`;
  } else {
    const existing = updated.slice(closedBounds.start, closedBounds.end).trimEnd();
    updated = `${updated.slice(0, closedBounds.start)}${existing}\n\n${rendered}\n${updated.slice(closedBounds.end)}`;
  }
  return {
    markdown: updated,
    branches: closed.flatMap((block) => (block.branch === null ? [] : [block.branch])),
  };
};

const replaceManagedSection = (markdown: string, name: string, body: string): string => {
  const section = `## ${name}\n\n${body.trim()}\n`;
  const bounds = sectionBounds(markdown, name);
  if (bounds === null) return `${markdown.trimEnd()}\n\n${section}`;
  return `${markdown.slice(0, bounds.start)}${section}${markdown.slice(bounds.end).trimStart()}`;
};

const appendDecision = (markdown: string, line: string): string => {
  const bounds = sectionBounds(markdown, "Decisions");
  if (bounds === null) {
    throw runError(
      "run.decisions_missing",
      "RESUME.md has no Decisions section.",
      "Restore the append-only Decisions section before closing blocked work.",
    );
  }
  const section = markdown.slice(bounds.start, bounds.end).trimEnd();
  if (section.split(/\r?\n/u).includes(line)) return markdown;
  return `${markdown.slice(0, bounds.start)}${section}\n${line}\n\n${markdown.slice(bounds.end).trimStart()}`;
};

const readManifest = async (runPath: string): Promise<SnapshotManifest> => {
  const raw = await readFile(resolve(runPath, "snapshot.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<SnapshotManifest>;
  if (
    !Array.isArray(parsed.tickets) ||
    parsed.tickets.some(
      (ticket) =>
        typeof ticket !== "object" ||
        ticket === null ||
        typeof ticket.number !== "string" ||
        !Array.isArray(ticket.blocked_by) ||
        ticket.blocked_by.some((dependency) => typeof dependency !== "string"),
    )
  ) {
    throw new Error("snapshot.json has no valid ticket graph");
  }
  return parsed as SnapshotManifest;
};

const linesInSection = (markdown: string, name: string): string[] => {
  const bounds = sectionBounds(markdown, name);
  if (bounds === null) return [];
  return markdown
    .slice(bounds.start, bounds.end)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("- "));
};

const roleDisplay = (role: RoleRecord): string =>
  `${role.harness} / ${role.model} / ${role.effort}`;

const ticketNumberList = (rows: TicketRow[]): string =>
  rows.length === 0 ? "none" : rows.map((row) => row.number).join(", ");

const renderSummary = (input: {
  title: string;
  completedAt: string;
  rows: TicketRow[];
  coordinator: RoleRecord;
  implementor: RoleRecord;
  reviewer: RoleRecord;
  reviewEvidence: string[];
  retainedBranches: string[];
  closedReasons: Map<string, string>;
  trackerAction: TrackerAction;
}): string => {
  const landed = input.rows.filter((row) => row.status === "landed");
  const blocked = input.rows.filter((row) => row.status === "blocked");
  const closed = input.rows.filter((row) => row.status === "closed");
  const tracker =
    input.trackerAction.status === "not-applicable"
      ? "Pending tracker action: none (writeback disabled)"
      : input.trackerAction.status === "forbidden"
        ? `Pending tracker action: ${input.trackerAction.mode} blocked by current project authority`
        : `Pending tracker action: ${input.trackerAction.mode} via ${input.trackerAction.workflow}`;
  return [
    `# ${input.title} final summary`,
    "",
    "Status: completed",
    `Completed at: ${input.completedAt}`,
    "",
    "## Tickets",
    "",
    `Landed: ${ticketNumberList(landed)}`,
    `Blocked: ${ticketNumberList(blocked)}`,
    `Closed: ${ticketNumberList(closed)}`,
    ...closed.map(
      (row) => `- ${row.number}: ${input.closedReasons.get(row.number) ?? "closed by user"}`,
    ),
    "",
    "## Role provenance",
    "",
    `Coordinator: ${roleDisplay(input.coordinator)}`,
    `Implementor default: ${roleDisplay(input.implementor)}`,
    `Reviewer: ${roleDisplay(input.reviewer)}`,
    "",
    "Ticket roles:",
    ...input.rows.map((row) => `- ${row.number}: ${row.harness} / ${row.model} / ${row.effort}`),
    "",
    "## Review evidence",
    "",
    ...(input.reviewEvidence.length === 0 ? ["- none"] : input.reviewEvidence),
    "",
    "## Retained branches",
    "",
    ...(input.retainedBranches.length === 0 ? ["- none"] : input.retainedBranches),
    "",
    "## Tracker",
    "",
    tracker,
    "",
  ].join("\n");
};

const ensureCanonicalRunPaths = (runPath: string, statePath: string, summaryPath: string): void => {
  const run = resolve(runPath);
  if (resolve(statePath) !== resolve(run, "RESUME.md")) {
    throw runError(
      "run.state_path_invalid",
      "Run finalization requires the canonical <run>/RESUME.md state document.",
      "Pass the RESUME.md inside the normalized run directory.",
    );
  }
  if (resolve(summaryPath) !== resolve(run, "SUMMARY.md")) {
    throw runError(
      "run.summary_path_invalid",
      "Run finalization requires the canonical <run>/SUMMARY.md output.",
      "Pass the SUMMARY.md path inside the normalized run directory.",
    );
  }
};

const writeSummary = async (path: string, content: string): Promise<void> => {
  if (existsSync(path)) {
    const existing = await readFile(path, "utf8");
    if (existing === content) return;
    throw runError(
      "run.summary_conflict",
      "The final summary path already contains different content.",
      "Preserve the existing summary and resolve the run-state conflict before retrying.",
    );
  }
  await writeFile(path, content, { flag: "wx" });
};

/**
 * Evaluates terminal run semantics, applies authorized closures, and writes a local summary.
 *
 * @param input - Run paths, closure authority, current project policy, and completion time.
 * @param hooks - Optional deterministic lifecycle hooks for tests.
 * @returns An Effect containing terminal status, ticket sets, summary path, and tracker action.
 */
export const finalizeRun = (
  input: RunFinalizeInput,
  hooks: RunFinalizeHooks | undefined = undefined,
): Effect.Effect<RunFinalizeResult, RunFinalizeError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => ensureCanonicalRunPaths(input.runPath, input.statePath, input.summaryPath),
      catch: (error) =>
        error instanceof RunFinalizeError
          ? error
          : runError(
              "run.summary_path_failed",
              `Could not validate the final summary path: ${(error as Error).message}`,
              "Choose a writable run-local summary path and retry.",
            ),
    });
    if (input.closures.length > 0 && !input.userAuthorized) {
      return yield* runError(
        "run.closure_authority_required",
        "Closing blocked tickets requires explicit user authority.",
        "Confirm the exact blocked tickets and reasons with the user, then retry.",
      );
    }
    if (new Set(input.closures.map((closure) => closure.ticket)).size !== input.closures.length) {
      return yield* runError(
        "run.closure_duplicate",
        "The finalization request contains duplicate blocked-ticket closures.",
        "Supply each explicitly closed ticket exactly once.",
      );
    }

    const snapshot = yield* checkSnapshot({
      runPath: input.runPath,
      statePath: input.statePath,
      writeback: undefined,
      projectRemoteWrites: "allowed",
      acceptedAt: undefined,
    }).pipe(
      Effect.mapError((error) =>
        runError(error.issue.code, error.issue.message, error.issue.remediation),
      ),
    );
    if (
      snapshot.status !== "unchanged" ||
      !snapshot.scheduling_allowed ||
      snapshot.writeback === null
    ) {
      return yield* runError(
        "run.snapshot_changed",
        "Run finalization requires the accepted snapshot to remain unchanged.",
        "Review and explicitly accept the current snapshot revision before finalization.",
      );
    }
    const afterSnapshotCheck = hooks?.afterSnapshotCheck;
    if (afterSnapshotCheck !== undefined) {
      yield* Effect.promise(afterSnapshotCheck);
    }
    const reasons = new Map(input.closures.map((closure) => [closure.ticket, closure.reason]));
    const closedTickets = new Set(reasons.keys());

    const update = yield* mutateStateFile(input.statePath, (markdown) =>
      Effect.gen(function* () {
        const lockedSnapshot = yield* checkSnapshot({
          runPath: input.runPath,
          statePath: input.statePath,
          writeback: undefined,
          projectRemoteWrites: "allowed",
          acceptedAt: undefined,
        }).pipe(
          Effect.mapError((error) =>
            runError(error.issue.code, error.issue.message, error.issue.remediation),
          ),
        );
        if (
          lockedSnapshot.status !== "unchanged" ||
          !lockedSnapshot.scheduling_allowed ||
          lockedSnapshot.writeback === null ||
          lockedSnapshot.revision !== snapshot.revision ||
          lockedSnapshot.accepted_revision !== snapshot.revision ||
          lockedSnapshot.writeback !== snapshot.writeback
        ) {
          return yield* runError(
            "run.snapshot_changed",
            "Run finalization requires the accepted snapshot to remain unchanged.",
            "Review and explicitly accept the current snapshot revision before finalization.",
          );
        }
        const manifest = yield* Effect.tryPromise({
          try: () => readManifest(input.runPath),
          catch: (error) =>
            runError(
              "run.snapshot_graph_invalid",
              `Could not read the normalized ticket graph: ${(error as Error).message}`,
              "Repair and accept snapshot.json before finalization.",
            ),
        });
        const trackerAction: TrackerAction = {
          mode: lockedSnapshot.writeback,
          status:
            lockedSnapshot.writeback === "none"
              ? "not-applicable"
              : input.projectRemoteWrites === "forbidden"
                ? "forbidden"
                : "pending",
          workflow: lockedSnapshot.source.tracker_workflow,
        };
        const computed = yield* Effect.try({
          try: (): { markdown: string; result: FinalizationUpdate } => {
            const table = parseTicketTable(markdown);
            const rowsByNumber = new Map(table.rows.map((row) => [row.number, row]));
            const manifestTickets = new Set(manifest.tickets.map((ticket) => ticket.number));
            if (
              manifestTickets.size !== rowsByNumber.size ||
              table.rows.some((row) => !manifestTickets.has(row.number))
            ) {
              throw runError(
                "run.ticket_graph_mismatch",
                "RESUME.md ticket rows do not exactly match the accepted snapshot graph.",
                "Repair run state from the accepted normalized snapshot before finalization.",
              );
            }
            const graphByNumber = new Map(
              manifest.tickets.map((ticket) => [ticket.number, ticket.blocked_by]),
            );
            for (const closure of input.closures) {
              const row = rowsByNumber.get(closure.ticket);
              const dependencies = graphByNumber.get(closure.ticket) ?? [];
              const dependencyBlocked =
                row?.status === "queued" &&
                dependencies.length > 0 &&
                dependencies.every((dependency) => {
                  const status = rowsByNumber.get(dependency)?.status;
                  return (
                    status === "landed" ||
                    status === "blocked" ||
                    status === "closed" ||
                    closedTickets.has(dependency)
                  );
                }) &&
                dependencies.some(
                  (dependency) => rowsByNumber.get(dependency)?.status !== "landed",
                );
              if (row === undefined || (row.status !== "blocked" && !dependencyBlocked)) {
                throw runError(
                  "run.closure_not_blocked",
                  `Ticket \`${closure.ticket}\` is not blocked and cannot be closed at finalization.`,
                  "Close only blocked or dependency-blocked queued tickets, or continue runnable work.",
                );
              }
            }

            let updated = replaceTicketStatuses(markdown, table, closedTickets);
            const moved = moveClosedRuntimeBlocks(
              updated,
              closedTickets,
              reasons,
              input.completedAt,
            );
            updated = moved.markdown;
            for (const closure of input.closures) {
              updated = appendDecision(
                updated,
                `- ${input.completedAt.slice(0, 10)} ticket ${closure.ticket} explicitly closed by user: ${closure.reason}`,
              );
            }

            const currentTable = parseTicketTable(updated);
            const statusByTicket = new Map(
              currentTable.rows.map((row) => [row.number, row.status]),
            );
            const runnable = manifest.tickets
              .filter((ticket) => {
                if (statusByTicket.get(ticket.number) !== "queued") return false;
                return ticket.blocked_by.every(
                  (dependency) => statusByTicket.get(dependency) === "landed",
                );
              })
              .map((ticket) => ticket.number)
              .toSorted((left, right) => Number(left) - Number(right));
            const landed = currentTable.rows
              .filter((row) => row.status === "landed")
              .map((row) => row.number);
            const blocked = currentTable.rows
              .filter((row) => row.status === "blocked")
              .map((row) => row.number);
            const closed = currentTable.rows
              .filter((row) => row.status === "closed")
              .map((row) => row.number);
            const completed = currentTable.rows.every(
              (row) => row.status === "landed" || row.status === "closed",
            );
            if (completed && parseRuntimeBlocks(updated, "Active tickets").length > 0) {
              throw runError(
                "run.terminal_runtime_present",
                "A completed run cannot retain an active runtime or its ticket integration.",
                "Close the runtime and finish or land its ticket integration before retrying.",
              );
            }
            const active = currentTable.rows.some((row) =>
              ["working", "review", "fixing"].includes(row.status),
            );
            const status = completed
              ? "completed"
              : active || runnable.length > 0
                ? "active"
                : "waiting";
            const result: RunFinalizeResult = {
              status,
              landed_tickets: landed,
              blocked_tickets: blocked,
              closed_tickets: closed,
              runnable_tickets: runnable,
              summary_path: completed ? input.summaryPath : null,
              tracker_action: trackerAction,
            };
            const outcome = {
              status,
              completed_at: completed ? input.completedAt : null,
              summary_path: completed ? input.summaryPath : null,
              landed_tickets: landed,
              blocked_tickets: blocked,
              closed_tickets: closed,
              runnable_tickets: runnable,
              tracker_action: trackerAction,
            };
            updated = replaceManagedSection(
              updated,
              "Run outcome",
              `\`\`\`json\n${JSON.stringify(outcome, null, 2)}\n\`\`\``,
            );
            if (!completed) return { markdown: updated, result: { result, summary: null } };

            const coordinator = parseRole(updated, "Coordinator");
            const implementor = parseRole(updated, "Implementor");
            const reviewer = parseRole(updated, "Reviewer");
            const title =
              /^# (.+?) implementation run\s*$/mu.exec(updated)?.[1] ?? "implementation run";
            const closedRuntimeBlocks = parseRuntimeBlocks(updated, "Closed ticket runtimes");
            const persistedReasons = new Map(
              closedRuntimeBlocks.flatMap((block) => {
                const reason = /^Close reason:\s*(.+)$/mu.exec(block.text)?.[1]?.trim();
                return reason === undefined ? [] : [[block.ticket, reason] as const];
              }),
            );
            const retained = [
              ...linesInSection(updated, "Retained landed branches"),
              ...closedRuntimeBlocks.flatMap((block) =>
                block.branch === null ? [] : [`- ${block.branch} (closed work retained)`],
              ),
            ];
            const summary = renderSummary({
              title,
              completedAt: input.completedAt,
              rows: currentTable.rows,
              coordinator,
              implementor,
              reviewer,
              reviewEvidence: linesInSection(updated, "Review evidence"),
              retainedBranches: [...new Set(retained)],
              closedReasons: new Map([...persistedReasons, ...reasons]),
              trackerAction,
            });
            return { markdown: updated, result: { result, summary } };
          },
          catch: (error) =>
            error instanceof RunFinalizeError
              ? error
              : runError(
                  "run.state_malformed",
                  `Could not evaluate terminal run state: ${(error as Error).message}`,
                  "Repair RESUME.md to the documented schema-2 format, then retry.",
                ),
        });
        if (computed.result.summary !== null) {
          yield* Effect.tryPromise({
            try: () => writeSummary(input.summaryPath, computed.result.summary!),
            catch: (error) =>
              error instanceof RunFinalizeError
                ? error
                : runError(
                    "run.summary_write_failed",
                    `Could not write the final local summary: ${(error as Error).message}`,
                    "Verify the run directory is writable, then retry the same finalization request.",
                  ),
          });
        }
        return computed;
      }),
    ).pipe(Effect.mapError(fromMutationError));

    return update.result;
  });
