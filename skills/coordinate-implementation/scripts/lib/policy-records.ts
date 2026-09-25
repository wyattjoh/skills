/**
 * Readers for the fenced JSON policy records persisted in RESUME.md. Each reader reports
 * `missing` or `malformed` as a value so operations keep their own error codes.
 */
import type { SerializedRepositoryPolicy } from "./worktrees.ts";

/**
 * Why a persisted JSON record could not be read.
 */
export type JsonRecordProblem = { problem: "missing" | "malformed" };

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the single fenced JSON block under `## <name>`.
 *
 * @param markdown - Complete RESUME.md text.
 * @param name - Section heading after `## `.
 * @returns The parsed JSON value, or `missing` unless exactly one record exists, or `malformed`.
 */
export const readJsonSection = (
  markdown: string,
  name: string,
): { value: unknown } | JsonRecordProblem => {
  const pattern = new RegExp(
    `^## ${escapeRegExp(name)}\\s*\\r?\\n\\r?\\n\`\`\`json\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\`\\s*$`,
    "gmu",
  );
  const matches = [...markdown.matchAll(pattern)];
  if (matches.length !== 1) return { problem: "missing" };
  try {
    return { value: JSON.parse(matches[0]![1]!) as unknown };
  } catch {
    return { problem: "malformed" };
  }
};

const isArgv = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (argument) => typeof argument === "string" && argument.length > 0 && !/[\r\n]/u.test(argument),
  );

const isRepositoryPolicy = (value: unknown): value is SerializedRepositoryPolicy => {
  if (!isRecord(value) || !isRecord(value.commit)) return false;
  const { remote, remote_sync_argv: remoteSyncArgv, cleanup, commit } = value;
  return (
    ((remote === "local-only" && remoteSyncArgv === null) ||
      (remote === "repository" && isArgv(remoteSyncArgv))) &&
    (cleanup === "native-safe" || cleanup === "repository") &&
    (commit.commits === "multiple" || commit.commits === "single" || commit.commits === "squash") &&
    (commit.fixes === "append" || commit.fixes === "amend" || commit.fixes === "squash")
  );
};

/**
 * Reads and validates `## Repository policy`: remote synchronization, cleanup, and commit shape.
 *
 * @param markdown - Complete RESUME.md text.
 * @returns The persisted policy, or the problem that prevented reading it.
 */
export const readRepositoryPolicy = (
  markdown: string,
): { policy: SerializedRepositoryPolicy } | JsonRecordProblem => {
  const record = readJsonSection(markdown, "Repository policy");
  if ("problem" in record) return record;
  return isRepositoryPolicy(record.value) ? { policy: record.value } : { problem: "malformed" };
};
