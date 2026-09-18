#!/usr/bin/env bun

/**
 * `interruptions`: interrupt markers, rejected tool calls, and user turns
 * that follow a tool_use mid-run. Each row carries the preceding assistant
 * text and the user's next text.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/cli.ts interruptions [options]
 */

import { booleanFlagNames, parseArgv } from "../lib/args.ts";
import type { SQLQueryBindings } from "bun:sqlite";
import { openDb } from "../lib/db.ts";
import {
  buildWhereFragments,
  parseFilters,
  SHARED_FILTER_OPTIONS,
  whereClause,
} from "../lib/filters.ts";
import {
  buildDocument,
  OUTPUT_OPTIONS,
  renderOptionsFromFlags,
  renderOutput,
  toIsoTimestamp,
} from "../lib/output.ts";
import type { Command, CommandOption } from "./index.ts";

const options: CommandOption[] = [...SHARED_FILTER_OPTIONS, ...OUTPUT_OPTIONS];

interface MessageQueryRow {
  row_id: number;
  uuid: string;
  internal_session_id: string;
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  type: string;
  text: string;
  is_injected: number;
  is_interrupt_marker: number;
  model: string | null;
}

interface ToolCallRow {
  session_id: string;
  message_uuid: string;
  timestamp: string | null;
  resultTimestamp: string | null;
}

interface InterruptionRow {
  kind: "interrupt" | "rejected_tool" | "mid_run_user_turn";
  assistant_text_before: string | null;
  user_text_after: string;
  session_id: string;
  project_dir: string | null;
  timestamp: string | null;
  uuid: string;
}

interface AssistantState {
  message: MessageQueryRow;
  toolCalls: ToolCallRow[];
}

const MAX_ASSISTANT_TEXT_CHARS = 400;

function truncateAssistantText(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length <= MAX_ASSISTANT_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_ASSISTANT_TEXT_CHARS - 3)}...`;
}

function resultTimestampKey(sessionId: string, timestamp: string): string {
  return `${sessionId}\u0000${timestamp}`;
}

function isToolResultMessage(
  message: MessageQueryRow,
  toolResultTimestamps: ReadonlySet<string>,
): boolean {
  return (
    message.timestamp !== null &&
    toolResultTimestamps.has(resultTimestampKey(message.internal_session_id, message.timestamp))
  );
}

function hasPendingToolUse(state: AssistantState, messageTimestamp: string | null): boolean {
  return state.toolCalls.some(
    (tool) =>
      tool.resultTimestamp === null ||
      (messageTimestamp !== null && tool.resultTimestamp > messageTimestamp),
  );
}

function isWithinTimeRange(
  timestamp: string | null,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (timestamp === null) return since === undefined && until === undefined;
  if (since !== undefined && timestamp < since) return false;
  if (until !== undefined && timestamp > until) return false;
  return true;
}

function messageMatchesModel(
  message: MessageQueryRow,
  state: AssistantState | undefined,
  model: string | undefined,
): boolean {
  if (model === undefined) return true;
  return (state?.message.model ?? message.model) === model;
}

function classifyMarker(text: string): "interrupt" | "rejected_tool" {
  return text.includes("The user doesn't want to proceed") ? "rejected_tool" : "interrupt";
}

function queryRows(db: ReturnType<typeof openDb>, argv: string[]): InterruptionRow[] {
  const booleanFlags = booleanFlagNames(options);
  const parsed = parseArgv(argv, booleanFlags);
  const filters = parseFilters(parsed.flags);
  const filterWhere = buildWhereFragments(filters, {
    project: ["s.project_dir", "s.cwd"],
    session: "s.session_id",
    subagentParent: "s.parent_session_id",
  });
  const messages = db
    .query(
      `SELECT
         m.rowid AS row_id,
         m.uuid,
         m.session_id AS internal_session_id,
         COALESCE(s.session_id, m.session_id) AS session_id,
         s.project_dir AS project_dir,
         m.ts AS timestamp,
         m.type,
         m.text,
         m.is_injected,
         m.is_interrupt_marker,
         m.model
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.session_id
       ${whereClause(filterWhere)}
       ORDER BY m.session_id, m.ts IS NULL, m.ts ASC, m.rowid ASC`,
    )
    .all(...(filterWhere.params as SQLQueryBindings[])) as MessageQueryRow[];

  const toolCallsByMessage = new Map<string, ToolCallRow[]>();
  const toolResultTimestamps = new Set<string>();
  const messageSessionIds = [...new Set(messages.map((message) => message.internal_session_id))];
  const toolCallRows =
    messageSessionIds.length === 0
      ? []
      : (db
          .query(
            `SELECT session_id, message_uuid, ts AS timestamp, result_ts AS resultTimestamp
             FROM tool_calls
             WHERE session_id IN (${messageSessionIds.map(() => "?").join(", ")})`,
          )
          .all(...messageSessionIds) as ToolCallRow[]);
  for (const tool of toolCallRows) {
    const toolKey = `${tool.session_id}\u0000${tool.message_uuid}`;
    const toolsForMessage = toolCallsByMessage.get(toolKey) ?? [];
    toolsForMessage.push(tool);
    toolCallsByMessage.set(toolKey, toolsForMessage);
    if (tool.resultTimestamp !== null) {
      toolResultTimestamps.add(resultTimestampKey(tool.session_id, tool.resultTimestamp));
    }
  }

  const output: InterruptionRow[] = [];
  let currentSession: string | undefined;
  let previousAssistant: AssistantState | undefined;

  for (const message of messages) {
    if (message.internal_session_id !== currentSession) {
      currentSession = message.internal_session_id;
      previousAssistant = undefined;
    }

    if (message.type === "assistant") {
      previousAssistant = {
        message,
        toolCalls:
          toolCallsByMessage.get(`${message.internal_session_id}\u0000${message.uuid}`) ?? [],
      };
      continue;
    }

    if (message.type !== "user") {
      previousAssistant = undefined;
      continue;
    }

    const toolResult = isToolResultMessage(message, toolResultTimestamps);
    const injected = message.is_injected === 1;
    const stateBeforeUser = previousAssistant;

    if (injected) continue;

    if (message.is_interrupt_marker === 1) {
      if (
        isWithinTimeRange(message.timestamp, filters.since, filters.until) &&
        messageMatchesModel(message, stateBeforeUser, filters.model)
      ) {
        output.push({
          kind: classifyMarker(message.text),
          assistant_text_before: truncateAssistantText(stateBeforeUser?.message.text),
          user_text_after: message.text,
          session_id: message.session_id,
          project_dir: message.project_dir,
          timestamp: toIsoTimestamp(message.timestamp),
          uuid: message.uuid,
        });
      }
      previousAssistant = undefined;
      continue;
    }

    if (toolResult) {
      previousAssistant = undefined;
      continue;
    }

    if (
      stateBeforeUser !== undefined &&
      hasPendingToolUse(stateBeforeUser, message.timestamp) &&
      isWithinTimeRange(message.timestamp, filters.since, filters.until) &&
      messageMatchesModel(message, stateBeforeUser, filters.model)
    ) {
      output.push({
        kind: "mid_run_user_turn",
        assistant_text_before: truncateAssistantText(stateBeforeUser.message.text),
        user_text_after: message.text,
        session_id: message.session_id,
        project_dir: message.project_dir,
        timestamp: toIsoTimestamp(message.timestamp),
        uuid: message.uuid,
      });
    }
    previousAssistant = undefined;
  }

  return output
    .toSorted((a, b) => {
      const timestampOrder = (a.timestamp ?? "").localeCompare(b.timestamp ?? "");
      if (timestampOrder !== 0) return timestampOrder;
      const sessionOrder = a.session_id.localeCompare(b.session_id);
      if (sessionOrder !== 0) return sessionOrder;
      return a.uuid.localeCompare(b.uuid);
    })
    .slice(0, filters.limit);
}

async function run(argv: string[]): Promise<void> {
  const db = openDb();
  try {
    const parsed = parseArgv(argv, booleanFlagNames(options));
    const rows = queryRows(db, argv);
    console.log(
      renderOutput(buildDocument("interruptions", rows), renderOptionsFromFlags(parsed.flags)),
    );
  } finally {
    db.close();
  }
}

export const command: Command = {
  name: "interruptions",
  description:
    "List interrupt markers, rejected tool calls, and user turns that follow a tool_use mid-run.",
  options,
  run,
};

if (import.meta.main) {
  command.run(process.argv.slice(2)).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
