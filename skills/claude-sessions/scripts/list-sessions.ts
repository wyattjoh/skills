#!/usr/bin/env bun

/**
 * List Claude Code sessions from a project directory
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/list-sessions.ts <project-dir> [options]
 *
 * Options:
 *   --format=json|table    Output format (default: table)
 *   --sort=date|messages   Sort by date or message count (default: date)
 *   --limit=N              Show only N most recent sessions
 *   --search=TERM          Filter sessions containing TERM in first prompt
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import type { SessionEntry, SessionsIndex } from "../references/types.ts";

interface Options {
  format: "json" | "table";
  sort: "date" | "messages";
  limit: number;
  search?: string;
}

function parseOptions(args: string[]): { projectDir: string; options: Options } {
  const { values: parsed, positionals } = parseArgs({
    args,
    options: {
      format: { type: "string", default: "table" },
      sort: { type: "string", default: "date" },
      search: { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });

  const projectDir = positionals[0];
  if (!projectDir) {
    console.error("Usage: list-sessions.ts <project-dir> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --format=json|table    Output format (default: table)");
    console.error("  --sort=date|messages   Sort by date or message count (default: date)");
    console.error("  --limit=N              Show only N most recent sessions");
    console.error("  --search=TERM          Filter sessions containing TERM in first prompt");
    process.exit(1);
  }

  const limit = parsed.limit ? Number(parsed.limit) : Infinity;

  return {
    projectDir,
    options: {
      format: parsed.format as "json" | "table",
      sort: parsed.sort as "date" | "messages",
      limit,
      search: parsed.search,
    },
  };
}

export async function loadSessionsIndex(projectDir: string): Promise<SessionsIndex> {
  const indexPath = join(projectDir, "sessions-index.json");
  const content = await Bun.file(indexPath).text();
  return JSON.parse(content) as SessionsIndex;
}

export function filterSessions(entries: SessionEntry[], search?: string): SessionEntry[] {
  if (!search) return entries;
  const term = search.toLowerCase();
  return entries.filter(
    (e) =>
      e.firstPrompt.toLowerCase().includes(term) ||
      e.sessionId.includes(term) ||
      e.gitBranch.toLowerCase().includes(term),
  );
}

export function sortSessions(entries: SessionEntry[], sortBy: "date" | "messages"): SessionEntry[] {
  const sorted = [...entries];
  if (sortBy === "date") {
    sorted.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  } else {
    sorted.sort((a, b) => b.messageCount - a.messageCount);
  }
  return sorted;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function outputTable(sessions: SessionEntry[]): void {
  console.log(
    "┌─────────────────────────────────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│ Sessions                                                                                │",
  );
  console.log(
    "├──────────────────────────────────────┬──────────────────────┬───────┬───────────────────┤",
  );
  console.log(
    "│ Session ID                           │ Modified             │ Msgs  │ First Prompt      │",
  );
  console.log(
    "├──────────────────────────────────────┼──────────────────────┼───────┼───────────────────┤",
  );

  for (const session of sessions) {
    const id = session.sessionId;
    const modified = formatDate(session.modified).padEnd(20);
    const msgs = String(session.messageCount).padStart(5);
    const prompt = truncate(session.firstPrompt.replace(/\n/g, " "), 17).padEnd(17);
    console.log(`│ ${id} │ ${modified} │ ${msgs} │ ${prompt} │`);
  }

  console.log(
    "└──────────────────────────────────────┴──────────────────────┴───────┴───────────────────┘",
  );
  console.log(`\nTotal: ${sessions.length} sessions`);
}

function outputJson(sessions: SessionEntry[]): void {
  console.log(JSON.stringify(sessions, null, 2));
}

async function main(): Promise<void> {
  const { projectDir, options } = parseOptions(process.argv.slice(2));

  const index = await loadSessionsIndex(projectDir);
  let sessions = index.entries;

  // Filter
  sessions = filterSessions(sessions, options.search);

  // Sort
  sessions = sortSessions(sessions, options.sort);

  // Limit
  if (options.limit < sessions.length) {
    sessions = sessions.slice(0, options.limit);
  }

  // Output
  if (options.format === "json") {
    outputJson(sessions);
  } else {
    outputTable(sessions);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
