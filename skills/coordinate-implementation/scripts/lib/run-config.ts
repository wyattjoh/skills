import { activeRuntimeBlockPattern, parseActiveRuntimeFields } from "./active-runtime.ts";
import type { RepositoryPolicy, RoleRecord } from "./contract.ts";
import { parseIntegration, type IntegrationRecord } from "./integration.ts";
import { parsePolicy, parseRoleBlock, type ReviewPolicy } from "./review.ts";
import type { SerializedRepositoryPolicy } from "./worktrees.ts";
import { WorkflowError } from "./workflow-runtime.ts";

/**
 * Run-wide settings the engine reads from RESUME.md before each step.
 */
export type RunConfig = {
  prefix: string;
  base: string;
  branchTemplate: string;
  stallIntervalMs: number;
  implementor: RoleRecord;
  reviewer: RoleRecord;
  reviewPolicy: ReviewPolicy;
  repositoryPolicy: RepositoryPolicy;
};

/**
 * One ticket's active runtime block.
 */
export type ActiveTicket = {
  worktree: string;
  branch: string;
  session: string;
  tab: string;
  pane: string;
  artifact: string;
  attempt: number;
  phase: string;
  implementor: RoleRecord;
  implementSkill: string;
  integration: IntegrationRecord | undefined;
};

const configError = (code: string, message: string): WorkflowError =>
  new WorkflowError({
    code,
    message,
    remediation: "Repair RESUME.md through the helper operations, then start the engine again.",
  });

const scalar = (markdown: string, name: string): string => {
  const matches = [...markdown.matchAll(new RegExp(`^${name}:[ \\t]*(\\S[^\\r\\n]*)$`, "gmu"))];
  if (matches.length !== 1) {
    throw configError(
      "runtime.config_malformed",
      `RESUME.md must contain exactly one \`${name}:\` field.`,
    );
  }
  return matches[0]![1]!.trim();
};

const repositoryPolicy = (markdown: string): RepositoryPolicy => {
  const match = /^## Repository policy\s*\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*$/mu.exec(
    markdown,
  );
  if (match === null) {
    throw configError(
      "runtime.repository_policy_missing",
      "RESUME.md has no persisted Repository policy.",
    );
  }
  const value = JSON.parse(match[1]!) as SerializedRepositoryPolicy;
  return {
    instructionFiles: value.instruction_files,
    worktree: {
      kind: value.worktree.kind,
      tool: value.worktree.tool,
      root: value.worktree.root ?? undefined,
      createArgv: value.worktree.create_argv ?? undefined,
    },
    branchNaming: value.branch_naming,
    setupArgvs: value.setup_argvs,
    cleanup: value.cleanup,
    remote: value.remote,
    remoteSyncArgv: value.remote_sync_argv ?? undefined,
    commit: value.commit,
  };
};

const withIssue = <A>(body: () => A): A => {
  try {
    return body();
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    if (typeof error === "object" && error !== null && "issue" in error) {
      throw new WorkflowError((error as { issue: WorkflowError["issue"] }).issue);
    }
    throw configError("runtime.config_malformed", String(error));
  }
};

/**
 * Reads the run-wide configuration.
 *
 * @param markdown - RESUME.md text.
 * @returns Parsed run configuration.
 */
export const readRunConfig = (markdown: string): RunConfig =>
  withIssue(() => {
    const interval = /^(\d+)m$/u.exec(scalar(markdown, "Stall interval"));
    return {
      prefix: scalar(markdown, "Prefix"),
      base: scalar(markdown, "Base"),
      branchTemplate: scalar(markdown, "Branch template"),
      stallIntervalMs: Number(interval?.[1] ?? "10") * 60_000,
      implementor: parseRoleBlock(markdown, "Implementor"),
      reviewer: parseRoleBlock(markdown, "Reviewer"),
      reviewPolicy: parsePolicy(markdown),
      repositoryPolicy: repositoryPolicy(markdown),
    };
  });

/**
 * Reads one ticket's active runtime block, or undefined when none exists.
 *
 * @param markdown - RESUME.md text.
 * @param ticket - Ticket number.
 * @returns The active runtime.
 */
export const readActiveTicket = (markdown: string, ticket: string): ActiveTicket | undefined =>
  withIssue(() => {
    const block = markdown.match(activeRuntimeBlockPattern(ticket))?.[0];
    if (block === undefined) return undefined;
    const fields = parseActiveRuntimeFields(block);
    return {
      worktree: fields.Worktree ?? "",
      branch: fields.Branch ?? "",
      session: fields.Session ?? "",
      tab: fields.Tab ?? "",
      pane: fields.Pane ?? "",
      artifact: fields.Artifact ?? "",
      attempt: Number(fields.Attempt ?? "1"),
      phase: fields.Phase ?? "",
      implementor: JSON.parse(fields.Implementor ?? "{}") as RoleRecord,
      implementSkill: fields["Implement skill"] ?? "/implement",
      integration: parseIntegration(markdown, ticket),
    };
  });

/**
 * Reads one ticket row's status from the `## Tickets` table.
 *
 * @param markdown - RESUME.md text.
 * @param ticket - Ticket number.
 * @returns The recorded status, or `queued` when the row is absent.
 */
export const readTicketStatus = (markdown: string, ticket: string): string => {
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length >= 9 && cells[1] === ticket) return cells[7]!;
  }
  return "queued";
};

/**
 * Next review round: one past the number of rounds already finalized for the ticket.
 *
 * @param markdown - RESUME.md text.
 * @param ticket - Ticket number.
 * @returns The round the next review uses.
 */
export const nextReviewRound = (markdown: string, ticket: string): number =>
  1 + [...markdown.matchAll(new RegExp(`Ticket ${ticket} round \\d+ finalized:`, "gu"))].length;

/**
 * Renders a branch name from the run's branch template.
 *
 * @param template - Persisted `Branch template:` value.
 * @param prefix - Run prefix.
 * @param ticket - Ticket number.
 * @param slug - Ticket slug from its file name.
 * @returns The branch name.
 */
export const renderBranch = (
  template: string,
  prefix: string,
  ticket: string,
  slug: string,
): string =>
  template.replaceAll("<prefix>", prefix).replaceAll("NN", ticket).replaceAll("<slug>", slug);

/**
 * Derives a ticket slug from its `NN-slug.md` file name.
 *
 * @param path - Ticket path from the snapshot.
 * @returns The slug.
 */
export const ticketSlug = (path: string): string =>
  (path.split("/").at(-1) ?? path).replace(/^\d+-/u, "").replace(/\.md$/u, "");
