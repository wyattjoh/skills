/**
 * Incremental sync: walk the corpus, ingest new and changed files into the
 * index database, and prune rows for files that disappeared.
 *
 * A file is keyed by its path. Growth (size increased, mtime changed) tails
 * from the last ingested line. Anything else that changed (shrank, or same
 * size but a different mtime, i.e. rewritten) triggers a full re-ingest from
 * line 0 after clearing the session's prior rows.
 */

import type { Database } from "bun:sqlite";
import { relative } from "node:path";
import {
  discoverProjectDirs,
  discoverProjectFiles,
  defaultCorpusRoot,
  type CorpusFileEntry,
} from "./corpus.ts";
import { decodeProjectDirLossy } from "./paths.ts";
import { readJsonl } from "./jsonl.ts";
import {
  extractBlocks,
  extractRecordText,
  hasInjectedTag,
  hasInterruptMarker,
  isSkillToolResult,
  parseRecord,
  shouldStoreMessage,
  type AssistantRecord,
  type ExtractedBlock,
  type UserRecord,
} from "./records.ts";
import { openDb } from "./db.ts";

export interface SyncOptions {
  root?: string;
  db?: Database;
  /** Repeatable substring filters matched against the encoded project dir. */
  projects?: string[];
  onProgress?: (info: { filesProcessed: number; totalFiles: number }) => void;
  progressEvery?: number;
}

export interface SyncSummary {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  malformedLines: number;
  elapsedMs: number;
}

interface FilesRow {
  path: string;
  size: number;
  mtime: number;
  last_line: number;
  session_id: string;
  parent_session_id: string | null;
}

interface SessionRow {
  id: string;
  session_id: string;
  project_dir: string | null;
  cwd: string | null;
  git_branch: string | null;
  parent_session_id: string | null;
  agent_name: string | null;
  first_prompt: string | null;
  started_at: string | null;
  ended_at: string | null;
  models: string;
  versions: string;
  message_count: number;
  tool_call_count: number;
  error_count: number;
  interruption_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

function matchesProjectFilter(projectDir: string, filters: string[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.some((f) => projectDir.includes(f));
}

/**
 * The raw session id in a .jsonl filename (or a subagent's agent id) is only
 * unique within its own project directory; filenames within a directory
 * can't collide, but the same id can appear as a file in two different
 * project directories (a relocated project or worktree move). Every row is
 * keyed by this composite so two such files never collide in
 * sessions/messages/tool_calls. The raw id is kept separately as
 * `sessions.session_id` for display and filtering.
 */
export function sessionKey(projectDir: string, sessionId: string): string {
  return `${projectDir}:${sessionId}`;
}

function projectDirForPath(path: string, root: string): string {
  const rel = relative(root, path);
  const [dir] = rel.split(/[\\/]/);
  return dir ?? "";
}

interface BatchAggregate {
  cwd: string | null;
  gitBranch: string | null;
  agentName: string | null;
  firstPrompt: string | null;
  firstPromptTs: string | null;
  startedAt: string | null;
  endedAt: string | null;
  models: Set<string>;
  versions: Set<string>;
}

function emptyBatchAggregate(): BatchAggregate {
  return {
    cwd: null,
    gitBranch: null,
    agentName: null,
    firstPrompt: null,
    firstPromptTs: null,
    startedAt: null,
    endedAt: null,
    models: new Set(),
    versions: new Set(),
  };
}

interface SessionCounts {
  messageCount: number;
  toolCallCount: number;
  errorCount: number;
  interruptionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/**
 * Count sessions.message_count/tool_call_count/error_count/interruption_count
 * and the token sums from the stored messages/tool_calls rows, not from
 * lines parsed during this ingest run. A file that repeats a uuid or
 * tool_use id (resumed/continued sessions rewrite earlier history into the
 * same file) collapses onto one stored row via `INSERT ... ON CONFLICT DO
 * UPDATE`, but a per-line running total would still count it once per
 * occurrence in the JSONL. Querying the actual row count/sum after ingest is
 * correct regardless of duplicates, and regardless of whether this ingest
 * was a tail or a full re-ingest.
 */
function computeSessionCounts(db: Database, sessionId: string): SessionCounts {
  const messageStats = db
    .query(
      `SELECT
         COUNT(*) as message_count,
         COALESCE(SUM(is_interrupt_marker), 0) as interruption_count,
         COALESCE(SUM(input_tokens), 0) as input_tokens,
         COALESCE(SUM(output_tokens), 0) as output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
         COALESCE(SUM(cache_create_tokens), 0) as cache_create_tokens
       FROM messages WHERE session_id = ?`,
    )
    .get(sessionId) as {
    message_count: number;
    interruption_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
  };

  const toolStats = db
    .query(
      `SELECT COUNT(*) as tool_call_count, COALESCE(SUM(is_error), 0) as error_count
       FROM tool_calls WHERE session_id = ?`,
    )
    .get(sessionId) as { tool_call_count: number; error_count: number };

  return {
    messageCount: messageStats.message_count,
    toolCallCount: toolStats.tool_call_count,
    errorCount: toolStats.error_count,
    interruptionCount: messageStats.interruption_count,
    inputTokens: messageStats.input_tokens,
    outputTokens: messageStats.output_tokens,
    cacheReadTokens: messageStats.cache_read_tokens,
    cacheCreateTokens: messageStats.cache_create_tokens,
  };
}

interface PendingToolUse {
  name: string;
  ts: string | undefined;
}

/** Ingest the lines of one file, inserting messages and tool_calls and accumulating session aggregates. */
function ingestLines(
  db: Database,
  file: CorpusFileEntry,
  lines: Array<{ lineNumber: number; value: unknown }>,
  agg: BatchAggregate,
): void {
  // A real INSERT ... ON CONFLICT DO UPDATE, not INSERT OR REPLACE. REPLACE
  // deletes and re-inserts under the hood, but does not fire the AFTER
  // DELETE trigger unless PRAGMA recursive_triggers is on (it is not), so
  // every duplicate uuid/tool_use id (resumed sessions rewrite earlier
  // history into the same file) left messages_fts/tool_calls_fts pointing at
  // a rowid the REPLACE had discarded. A true UPDATE fires the existing
  // AFTER UPDATE trigger correctly and keeps the row's rowid stable, so the
  // FTS index never desyncs.
  const insertMessage = db.query(
    `INSERT INTO messages
      (uuid, session_id, parent_uuid, ts, type, role, text, is_injected, is_interrupt_marker, is_sidechain, model, effort, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, uuid) DO UPDATE SET
       parent_uuid = excluded.parent_uuid,
       ts = excluded.ts,
       type = excluded.type,
       role = excluded.role,
       text = excluded.text,
       is_injected = excluded.is_injected,
       is_interrupt_marker = excluded.is_interrupt_marker,
       is_sidechain = excluded.is_sidechain,
       model = excluded.model,
       effort = excluded.effort,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cache_create_tokens = excluded.cache_create_tokens`,
  );
  const insertToolCall = db.query(
    `INSERT INTO tool_calls (id, session_id, message_uuid, ts, name, input, subagent_type, skill_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, id) DO UPDATE SET
       message_uuid = excluded.message_uuid,
       ts = excluded.ts,
       name = excluded.name,
       input = excluded.input,
       subagent_type = excluded.subagent_type,
       skill_name = excluded.skill_name`,
  );
  const updateToolResult = db.query(
    `UPDATE tool_calls SET result_text = ?, is_error = ?, result_ts = ?, latency_ms = ? WHERE session_id = ? AND id = ?`,
  );
  const selectToolCall = db.query(
    `SELECT ts, name FROM tool_calls WHERE session_id = ? AND id = ?`,
  );

  // tool_use id -> {name, ts} seen so far in this ingest run (this file's lines).
  const pendingToolUses = new Map<string, PendingToolUse>();
  const toolNameById = new Map<string, string>();

  for (const line of lines) {
    const record = parseRecord(line.value);
    if (!record) continue;

    const sessionId = sessionKey(file.projectDir, file.sessionId);
    const ts = record.timestamp;

    if (record.cwd) agg.cwd = record.cwd;
    if (record.gitBranch) agg.gitBranch = record.gitBranch;
    if (record.version) agg.versions.add(record.version);
    if (ts) {
      if (!agg.startedAt || ts < agg.startedAt) agg.startedAt = ts;
      if (!agg.endedAt || ts > agg.endedAt) agg.endedAt = ts;
    }

    const blocks: ExtractedBlock[] = [];
    if (record.type === "user" || record.type === "assistant") {
      const message = (record as UserRecord | AssistantRecord).message;
      blocks.push(...extractBlocks(message?.content));
    }

    const text =
      record.type === "user" || record.type === "assistant"
        ? blocks
            .map((b) => b.text)
            .filter((t) => t.length > 0)
            .join("\n\n")
        : extractRecordText(record);

    let isInjected = hasInjectedTag(text);
    let isInterrupt = hasInterruptMarker(text);

    // Register any tool_use blocks and pair any tool_result blocks.
    for (const block of blocks) {
      if (block.kind === "tool_use" && block.toolUseId) {
        pendingToolUses.set(block.toolUseId, { name: block.toolName ?? "unknown", ts });
        toolNameById.set(block.toolUseId, block.toolName ?? "unknown");

        const isSkillCall = block.toolName === "Skill";
        const subagentType =
          block.toolName === "Task"
            ? ((block.input?.subagent_type as string | undefined) ?? null)
            : null;
        const skillName = isSkillCall ? ((block.input?.skill as string | undefined) ?? null) : null;

        insertToolCall.run(
          block.toolUseId,
          sessionId,
          record.uuid ?? `${sessionId}:L${line.lineNumber}`,
          ts ?? null,
          block.toolName ?? "unknown",
          JSON.stringify(block.input ?? {}),
          subagentType,
          skillName,
        );
      }

      if (block.kind === "tool_result" && block.toolUseId) {
        if (isSkillToolResult(block, toolNameById)) isInjected = true;

        let toolUseTs = pendingToolUses.get(block.toolUseId)?.ts;
        if (toolUseTs === undefined) {
          const existing = selectToolCall.get(sessionId, block.toolUseId) as {
            ts: string | null;
            name: string;
          } | null;
          toolUseTs = existing?.ts ?? undefined;
        }

        const latencyMs = toolUseTs && ts ? Date.parse(ts) - Date.parse(toolUseTs) : null;
        updateToolResult.run(
          block.text,
          block.isError ? 1 : 0,
          ts ?? null,
          latencyMs,
          sessionId,
          block.toolUseId,
        );
      }
    }

    if (!shouldStoreMessage(record, text)) continue;

    if (
      !agg.firstPrompt &&
      record.type === "user" &&
      !isInjected &&
      !isInterrupt &&
      text.trim().length > 0
    ) {
      agg.firstPrompt = text;
      agg.firstPromptTs = ts ?? null;
    }

    let model: string | null = null;
    let usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    if (record.type === "assistant") {
      const assistantRecord = record as AssistantRecord;
      model = assistantRecord.message?.model ?? null;
      if (model) agg.models.add(model);
      const u = assistantRecord.message?.usage;
      if (u) {
        usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheCreate: u.cache_creation_input_tokens ?? 0,
        };
      }
    }

    let effort: string | null = null;
    if (record.type === "user") {
      effort = (record as UserRecord).thinkingMetadata?.level ?? null;
    }

    const uuid = record.uuid ?? `${sessionId}:L${line.lineNumber}`;
    const role = record.type === "user" ? "user" : record.type === "assistant" ? "assistant" : null;

    insertMessage.run(
      uuid,
      sessionId,
      record.parentUuid ?? null,
      ts ?? null,
      record.type,
      role,
      text,
      isInjected ? 1 : 0,
      isInterrupt ? 1 : 0,
      record.isSidechain ? 1 : 0,
      model,
      effort,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheCreate,
    );
  }
}

async function readAgentName(file: CorpusFileEntry): Promise<string | null> {
  if (!file.metaPath) return null;
  try {
    const meta = (await Bun.file(file.metaPath).json()) as { agentType?: string };
    return meta.agentType ?? null;
  } catch {
    return null;
  }
}

function mergeUniqueJsonArray(existingJson: string, additions: Set<string>): string {
  const existing = new Set<string>(JSON.parse(existingJson) as string[]);
  for (const value of additions) existing.add(value);
  return JSON.stringify([...existing].toSorted());
}

/**
 * `sessionId` is the composite key from sessionKey(), already scoped to
 * this file: ingestLines() has already inserted this batch's rows under it,
 * so `existing` (looked up by that same key) can only ever be this file's
 * own prior session row, never another file's.
 */
function upsertSession(
  db: Database,
  file: CorpusFileEntry,
  sessionId: string,
  agg: BatchAggregate,
): void {
  const existing = db
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as SessionRow | null;

  const models = mergeUniqueJsonArray(existing?.models ?? "[]", agg.models);
  const versions = mergeUniqueJsonArray(existing?.versions ?? "[]", agg.versions);

  const startedAt =
    existing?.started_at && (!agg.startedAt || existing.started_at < agg.startedAt)
      ? existing.started_at
      : agg.startedAt;
  const endedAt =
    existing?.ended_at && (!agg.endedAt || existing.ended_at > agg.endedAt)
      ? existing.ended_at
      : agg.endedAt;

  const firstPrompt = existing?.first_prompt ?? agg.firstPrompt;
  const counts = computeSessionCounts(db, sessionId);
  const parentSessionId = file.parentSessionId
    ? sessionKey(file.projectDir, file.parentSessionId)
    : null;

  db.query(
    `INSERT INTO sessions
      (id, session_id, project_dir, cwd, git_branch, parent_session_id, agent_name, first_prompt, started_at, ended_at, models, versions, message_count, tool_call_count, error_count, interruption_count, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       project_dir = excluded.project_dir,
       cwd = excluded.cwd,
       git_branch = excluded.git_branch,
       parent_session_id = excluded.parent_session_id,
       agent_name = excluded.agent_name,
       first_prompt = excluded.first_prompt,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       models = excluded.models,
       versions = excluded.versions,
       message_count = excluded.message_count,
       tool_call_count = excluded.tool_call_count,
       error_count = excluded.error_count,
       interruption_count = excluded.interruption_count,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cache_create_tokens = excluded.cache_create_tokens`,
  ).run(
    sessionId,
    file.sessionId,
    file.projectDir,
    agg.cwd ?? existing?.cwd ?? null,
    agg.gitBranch ?? existing?.git_branch ?? null,
    parentSessionId,
    agg.agentName ?? existing?.agent_name ?? null,
    firstPrompt ?? null,
    startedAt ?? null,
    endedAt ?? null,
    models,
    versions,
    counts.messageCount,
    counts.toolCallCount,
    counts.errorCount,
    counts.interruptionCount,
    counts.inputTokens,
    counts.outputTokens,
    counts.cacheReadTokens,
    counts.cacheCreateTokens,
  );
}

function clearSessionRows(db: Database, sessionId: string): void {
  db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
  db.query("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
  db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

function refreshProject(db: Database, projectDir: string): void {
  const stats = db
    .query(
      `SELECT COUNT(*) as session_count, MAX(ended_at) as last_activity
       FROM sessions WHERE project_dir = ? AND parent_session_id IS NULL`,
    )
    .get(projectDir) as { session_count: number; last_activity: string | null };

  const cwdRow = db
    .query(
      `SELECT cwd FROM sessions WHERE project_dir = ? AND cwd IS NOT NULL ORDER BY ended_at DESC LIMIT 1`,
    )
    .get(projectDir) as { cwd: string } | null;

  db.query(
    `INSERT INTO projects (dir, decoded_path, cwd, last_activity, session_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dir) DO UPDATE SET
       decoded_path = excluded.decoded_path,
       cwd = excluded.cwd,
       last_activity = excluded.last_activity,
       session_count = excluded.session_count`,
  ).run(
    projectDir,
    decodeProjectDirLossy(projectDir),
    cwdRow?.cwd ?? null,
    stats.last_activity,
    stats.session_count,
  );
}

async function ingestFile(
  db: Database,
  file: CorpusFileEntry,
  existing: FilesRow | null,
): Promise<{
  outcome: "added" | "updated";
  malformedLines: number;
}> {
  const sessionId = sessionKey(file.projectDir, file.sessionId);
  const parentSessionId = file.parentSessionId
    ? sessionKey(file.projectDir, file.parentSessionId)
    : null;
  const isFullReingest =
    existing !== null &&
    (file.size < existing.size || (file.size === existing.size && file.mtimeMs !== existing.mtime));
  const fromLine = existing && !isFullReingest ? existing.last_line : 0;

  if (isFullReingest) {
    clearSessionRows(db, sessionId);
  }

  const { lines, malformedCount, lastLineNumber } = await readJsonl(file.path, { fromLine });

  const agg = emptyBatchAggregate();
  if (file.parentSessionId) {
    agg.agentName = await readAgentName(file);
  }
  ingestLines(db, file, lines, agg);
  upsertSession(db, file, sessionId, agg);

  db.query(
    `INSERT INTO files (path, size, mtime, last_line, session_id, parent_session_id, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size,
       mtime = excluded.mtime,
       last_line = excluded.last_line,
       session_id = excluded.session_id,
       parent_session_id = excluded.parent_session_id,
       ingested_at = excluded.ingested_at`,
  ).run(
    file.path,
    file.size,
    file.mtimeMs,
    lastLineNumber,
    sessionId,
    parentSessionId,
    new Date().toISOString(),
  );

  return { outcome: existing === null ? "added" : "updated", malformedLines: malformedCount };
}

function removeStaleFiles(
  db: Database,
  root: string,
  discoveredPaths: Set<string>,
  projectFilter: string[] | undefined,
): number {
  const existingRows = db
    .query(
      "SELECT files.path as path, files.session_id as session_id, sessions.project_dir as project_dir FROM files LEFT JOIN sessions ON sessions.id = files.session_id",
    )
    .all() as Array<{
    path: string;
    session_id: string;
    project_dir: string | null;
  }>;

  let removed = 0;
  const touchedProjectDirs = new Set<string>();

  for (const row of existingRows) {
    const projectDir = row.project_dir ?? projectDirForPath(row.path, root);
    if (!matchesProjectFilter(projectDir, projectFilter)) continue;
    if (discoveredPaths.has(row.path)) continue;

    db.query("DELETE FROM files WHERE path = ?").run(row.path);
    clearSessionRows(db, row.session_id);
    touchedProjectDirs.add(projectDir);
    removed += 1;
  }

  for (const dir of touchedProjectDirs) refreshProject(db, dir);

  return removed;
}

/** Incrementally sync the on-disk corpus into the index database. */
export async function sync(options: SyncOptions = {}): Promise<SyncSummary> {
  const start = performance.now();
  const root = options.root ?? defaultCorpusRoot();
  const db = options.db ?? openDb();
  const progressEvery = options.progressEvery ?? 100;

  const projectDirs = await discoverProjectDirs(root);
  if (projectDirs.length === 0) {
    throw new Error(
      `Corpus root has no project directories: ${root}. Refusing to prune the index; check --root.`,
    );
  }

  const allFiles: CorpusFileEntry[] = [];
  for (const project of projectDirs) {
    allFiles.push(...(await discoverProjectFiles(project.dir, project.path)));
  }
  const files = allFiles.filter((f) => matchesProjectFilter(f.projectDir, options.projects));

  const summary: SyncSummary = {
    scanned: files.length,
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    malformedLines: 0,
    elapsedMs: 0,
  };

  const discoveredPaths = new Set<string>();
  const touchedProjectDirs = new Set<string>();
  let processed = 0;

  const getExisting = db.query("SELECT * FROM files WHERE path = ?");

  for (const file of files) {
    discoveredPaths.add(file.path);
    const existingRow = getExisting.get(file.path) as FilesRow | null;

    const unchanged =
      existingRow !== null && existingRow.size === file.size && existingRow.mtime === file.mtimeMs;
    if (unchanged) {
      summary.unchanged += 1;
    } else {
      const result = await ingestFile(db, file, existingRow);
      summary.malformedLines += result.malformedLines;
      if (result.outcome === "added") summary.added += 1;
      else summary.updated += 1;
      touchedProjectDirs.add(file.projectDir);
    }

    processed += 1;
    if (options.onProgress && processed % progressEvery === 0) {
      options.onProgress({ filesProcessed: processed, totalFiles: files.length });
    }
  }

  summary.removed = removeStaleFiles(db, root, discoveredPaths, options.projects);

  for (const dir of touchedProjectDirs) refreshProject(db, dir);

  if (options.onProgress) {
    options.onProgress({ filesProcessed: processed, totalFiles: files.length });
  }

  summary.elapsedMs = performance.now() - start;
  return summary;
}
