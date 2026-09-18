#!/usr/bin/env bun

/**
 * `messages`: ordered turns of one or more sessions.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts messages [options]
 */

import type { Database } from "bun:sqlite";
import { booleanFlagNames, flagBoolean, flagString, parseArgv } from "../lib/args.ts";
import {
  buildWhereFragments,
  parseFilters,
  whereClause,
  SHARED_FILTER_OPTIONS,
} from "../lib/filters.ts";
import { openDb } from "../lib/db.ts";
import { readJsonl } from "../lib/jsonl.ts";
import {
  extractBlocks,
  parseRecord,
  type AnyRecord,
  type AssistantRecord,
  type MessageContent,
  type UserRecord,
} from "../lib/records.ts";
import {
  OUTPUT_OPTIONS,
  buildDocument,
  renderOptionsFromFlags,
  renderOutput,
  toIsoTimestamp,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";

const options = [
  ...SHARED_FILTER_OPTIONS,
  {
    name: "include-tools",
    type: "boolean",
    description: "Include tool_use and tool_result blocks",
  },
  { name: "include-thinking", type: "boolean", description: "Include thinking blocks" },
  { name: "around", type: "string", description: "Context window around a message: <uuid>:<n>" },
  ...OUTPUT_OPTIONS,
] as CommandOption[];

type StoredMessage = {
  session_key: string;
  session_id: string;
  project_dir: string | null;
  project_identity: string | null;
  timestamp: string | null;
  uuid: string;
  parent_uuid: string | null;
  type: string;
  role: string | null;
  text: string;
  is_injected: number;
  is_interrupt_marker: number;
  is_sidechain: number;
  model: string | null;
  effort: string | null;
};

type MessageTurn = {
  session_id: string;
  project_dir: string | null;
  project_identity: string | null;
  timestamp: string | null;
  uuid: string;
  parent_uuid: string | null;
  type: string;
  role: string | null;
  text: string;
  is_injected: boolean;
  is_interrupt_marker: boolean;
  is_sidechain: boolean;
  model: string | null;
  effort: string | null;
};

type QueryParam = string | number | boolean | bigint | null;

type RawRecords = Map<string, AnyRecord>;

const BOOLEAN_FLAGS = booleanFlagNames(options);

function messageWhere(filters: ReturnType<typeof parseFilters>): {
  sql: string;
  params: QueryParam[];
} {
  const fragment = buildWhereFragments(filters, {
    project: "s.project_identity",
    session: "s.session_id",
    timestamp: "m.ts",
    model: "m.model",
    subagentParent: "s.parent_session_id",
  });
  const clauses = ["m.role IN ('user', 'assistant')", ...fragment.clauses];
  const params = fragment.params as QueryParam[];
  return {
    sql: whereClause({ clauses, params }),
    params,
  };
}

function readMessageContent(record: AnyRecord): MessageContent {
  if (record.type !== "user" && record.type !== "assistant") return undefined;
  return (record as UserRecord | AssistantRecord).message?.content;
}

function renderBlockText(
  block: ReturnType<typeof extractBlocks>[number],
  includeTools: boolean,
  includeThinking: boolean,
): string | undefined {
  if (block.kind === "text") return block.text;
  if (block.kind === "thinking") {
    if (!includeThinking || block.text.length === 0) return undefined;
    return `[Thinking]\n${block.text}\n[/Thinking]`;
  }
  if (block.kind === "tool_use") {
    if (!includeTools) return undefined;
    return `[Tool: ${block.toolName ?? "unknown"}]\n${block.text}\n[/Tool]`;
  }
  if (block.kind === "tool_result") {
    if (!includeTools || block.text.length === 0) return undefined;
    const label = block.isError ? "[Tool result: error]" : "[Tool result]";
    return `${label}\n${block.text}\n[/Tool result]`;
  }
  return undefined;
}

function renderMessageText(
  stored: StoredMessage,
  record: AnyRecord | undefined,
  includeTools: boolean,
  includeThinking: boolean,
): string {
  if (record === undefined) return stored.text;
  const blocks = extractBlocks(readMessageContent(record));
  if (blocks.length === 0) return stored.text;
  return blocks
    .map((block) => renderBlockText(block, includeTools, includeThinking))
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join("\n\n");
}

async function loadRawRecords(db: Database, sessionKey: string): Promise<RawRecords> {
  const records: RawRecords = new Map();
  const files = db
    .query("SELECT path FROM files WHERE session_id = ? ORDER BY path")
    .all(sessionKey) as Array<{
    path: string;
  }>;

  for (const file of files) {
    try {
      const result = await readJsonl(file.path);
      for (const line of result.lines) {
        const record = parseRecord(line.value);
        if (record === null) continue;
        const uuid = record.uuid ?? `${sessionKey}:L${line.lineNumber}`;
        records.set(uuid, record);
      }
    } catch {
      // The indexed row remains usable if the source file was moved or pruned.
    }
  }
  return records;
}

async function renderTurns(
  db: Database,
  rows: StoredMessage[],
  includeTools: boolean,
  includeThinking: boolean,
): Promise<MessageTurn[]> {
  const rawBySession = new Map<string, RawRecords>();
  const turns: MessageTurn[] = [];

  for (const row of rows) {
    let raw = rawBySession.get(row.session_key);
    if (raw === undefined) {
      raw = await loadRawRecords(db, row.session_key);
      rawBySession.set(row.session_key, raw);
    }

    const text = renderMessageText(row, raw.get(row.uuid), includeTools, includeThinking);
    if (text.length === 0) continue;

    turns.push({
      session_id: row.session_id,
      project_dir: row.project_dir,
      project_identity: row.project_identity,
      timestamp: toIsoTimestamp(row.timestamp),
      uuid: row.uuid,
      parent_uuid: row.parent_uuid,
      type: row.type,
      role: row.role,
      text,
      is_injected: row.is_injected !== 0,
      is_interrupt_marker: row.is_interrupt_marker !== 0,
      is_sidechain: row.is_sidechain !== 0,
      model: row.model,
      effort: row.effort,
    });
  }

  return turns;
}

function parseAround(raw: string | undefined): { uuid: string; radius: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(.+):(\d+)$/.exec(raw);
  if (match === null || match[1]!.length === 0) {
    throw new Error(`Invalid --around: ${raw}. Expected <uuid>:<n>.`);
  }
  return { uuid: match[1]!, radius: Number(match[2]) };
}

function sortTurns(a: StoredMessage, b: StoredMessage): number {
  const aTime = a.timestamp ?? "";
  const bTime = b.timestamp ?? "";
  return (
    aTime.localeCompare(bTime) ||
    a.session_key.localeCompare(b.session_key) ||
    a.uuid.localeCompare(b.uuid)
  );
}

async function run(argv: string[]): Promise<void> {
  const { flags } = parseArgv(argv, BOOLEAN_FLAGS);
  const filters = parseFilters(flags);
  const hasProjectLimit = filters.projects.length > 0 && flagString(flags, "limit") !== undefined;
  if (filters.sessions.length === 0 && !hasProjectLimit) {
    throw new Error("messages requires --session or --project with --limit to select sessions.");
  }

  const around = parseAround(flagString(flags, "around"));
  const includeTools = flagBoolean(flags, "include-tools");
  const includeThinking = flagBoolean(flags, "include-thinking");
  const filter = messageWhere(filters);
  const db = openDb();

  try {
    const sql = `
      SELECT
        m.session_id AS session_key,
        s.session_id AS session_id,
        s.project_dir AS project_dir,
      s.project_identity AS project_identity,
        m.ts AS timestamp,
        m.uuid AS uuid,
        m.parent_uuid AS parent_uuid,
        m.type AS type,
        m.role AS role,
        m.text AS text,
        m.is_injected AS is_injected,
        m.is_interrupt_marker AS is_interrupt_marker,
        m.is_sidechain AS is_sidechain,
        m.model AS model,
        m.effort AS effort
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      ${filter.sql}
      ORDER BY m.ts ASC, m.session_id ASC, m.uuid ASC
      ${around === undefined ? "LIMIT ?" : ""}`;
    const queryParams =
      around === undefined ? [...filter.params, filters.limit * 4] : filter.params;
    const stored = (db.query(sql).all(...queryParams) as StoredMessage[]).toSorted(sortTurns);

    let aroundSessionKey: string | undefined;
    if (around !== undefined) {
      const target = stored.find((row) => row.uuid === around.uuid);
      if (target === undefined) throw new Error(`Message not found for --around: ${around.uuid}`);
      aroundSessionKey = target.session_key;
    }

    const rowsToRender =
      aroundSessionKey === undefined
        ? stored
        : stored.filter((row) => row.session_key === aroundSessionKey);
    const turns = await renderTurns(db, rowsToRender, includeTools, includeThinking);

    let selected = turns;
    if (around !== undefined) {
      const index = turns.findIndex((turn) => turn.uuid === around.uuid);
      if (index === -1) throw new Error(`Message not found for --around: ${around.uuid}`);
      selected = turns.slice(
        Math.max(0, index - around.radius),
        Math.min(turns.length, index + around.radius + 1),
      );
    } else {
      selected = turns.slice(0, filters.limit);
    }

    const document = buildDocument("messages", selected);
    console.log(renderOutput(document, renderOptionsFromFlags(flags)));
  } finally {
    db.close();
  }
}

/**
 * List the ordered turns stored in the conversation index.
 */
export const command: Command = {
  name: "messages",
  description: "List the ordered turns of one or more sessions.",
  options,
  usage: undefined,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
