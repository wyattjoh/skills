#!/usr/bin/env bun

/**
 * Search across all conversations in a project for content matching a pattern
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/search-content.ts <project-dir> --pattern="search term" [options]
 *
 * Options:
 *   --pattern=TERM         Search pattern (required, case-insensitive)
 *   --format=json|table    Output format (default: table)
 *   --limit=N              Maximum matches to return (default: 20)
 *   --context=N            Characters of context around match (default: 100)
 *   --type=all|user|assistant  Filter by message type (default: all)
 */

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import type { AssistantMessage, ConversationEntry, UserMessage } from "../references/types.ts";

export interface SearchMatch {
  sessionId: string;
  messageUuid: string;
  timestamp: string;
  type: "user" | "assistant";
  snippet: string;
  matchIndex: number;
}

interface Options {
  pattern: string;
  format: "json" | "table";
  limit: number;
  context: number;
  type: "all" | "user" | "assistant";
}

function parseOptions(args: string[]): { projectDir: string; options: Options } {
  const { values: parsed, positionals } = parseArgs({
    args,
    options: {
      pattern: { type: "string" },
      format: { type: "string", default: "table" },
      type: { type: "string", default: "all" },
      limit: { type: "string", default: "20" },
      context: { type: "string", default: "100" },
    },
    allowPositionals: true,
  });

  const projectDir = positionals[0];
  if (!projectDir) {
    console.error('Usage: search-content.ts <project-dir> --pattern="search term" [options]');
    console.error("");
    console.error("Options:");
    console.error("  --pattern=TERM         Search pattern (required, case-insensitive)");
    console.error("  --format=json|table    Output format (default: table)");
    console.error("  --limit=N              Maximum matches to return (default: 20)");
    console.error("  --context=N            Characters of context around match (default: 100)");
    console.error("  --type=all|user|assistant  Filter by message type (default: all)");
    process.exit(1);
  }

  if (!parsed.pattern) {
    console.error("Error: --pattern is required");
    console.error('Example: search-content.ts ~/.claude/projects/-path --pattern="authentication"');
    process.exit(1);
  }

  return {
    projectDir,
    options: {
      pattern: parsed.pattern,
      format: parsed.format as "json" | "table",
      limit: Number(parsed.limit),
      context: Number(parsed.context),
      type: parsed.type as "all" | "user" | "assistant",
    },
  };
}

export function extractTextContent(entry: ConversationEntry): string | null {
  if (entry.type === "user") {
    const userEntry = entry as UserMessage;
    const content = userEntry.message?.content;
    if (!content || !Array.isArray(content)) return null;

    return content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  if (entry.type === "assistant") {
    const assistantEntry = entry as AssistantMessage;
    const content = assistantEntry.message?.content;
    if (!content || !Array.isArray(content)) return null;

    return content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  return null;
}

export function extractSnippet(
  text: string,
  pattern: string,
  contextLen: number,
): { snippet: string; index: number } {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const index = lowerText.indexOf(lowerPattern);

  if (index === -1) return { snippet: "", index: -1 };

  const start = Math.max(0, index - contextLen);
  const end = Math.min(text.length, index + pattern.length + contextLen);

  let snippet = text.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  // Replace newlines with spaces for cleaner display
  snippet = snippet.replace(/\n+/g, " ").replace(/\s+/g, " ");

  return { snippet, index };
}

export async function* parseJsonl(filePath: string): AsyncGenerator<ConversationEntry> {
  const content = await Bun.file(filePath).text();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as ConversationEntry;
    } catch {
      // Skip malformed lines
    }
  }
}

export async function searchConversation(
  filePath: string,
  sessionId: string,
  options: Options,
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const patternLower = options.pattern.toLowerCase();

  for await (const entry of parseJsonl(filePath)) {
    // Filter by type
    if (options.type !== "all" && entry.type !== options.type) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const text = extractTextContent(entry);
    if (!text) continue;

    const textLower = text.toLowerCase();
    if (!textLower.includes(patternLower)) continue;

    const { snippet, index } = extractSnippet(text, options.pattern, options.context);
    if (index === -1) continue;

    matches.push({
      sessionId,
      messageUuid: (entry as UserMessage | AssistantMessage).uuid || "unknown",
      timestamp: (entry as UserMessage | AssistantMessage).timestamp || "",
      type: entry.type as "user" | "assistant",
      snippet,
      matchIndex: index,
    });
  }

  return matches;
}

export async function searchProject(projectDir: string, options: Options): Promise<SearchMatch[]> {
  const allMatches: SearchMatch[] = [];

  try {
    const dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.name.endsWith(".jsonl")) continue;

      const sessionId = entry.name.replace(".jsonl", "");
      const filePath = `${projectDir}/${entry.name}`;

      const matches = await searchConversation(filePath, sessionId, options);
      allMatches.push(...matches);

      // Check limit across all sessions
      if (allMatches.length >= options.limit) {
        return allMatches.slice(0, options.limit);
      }
    }
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      console.error(`Project directory not found: ${projectDir}`);
      process.exit(1);
    }
    throw err;
  }

  return allMatches;
}

function formatDate(isoString: string): string {
  if (!isoString) return "unknown";
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function outputTable(matches: SearchMatch[], pattern: string): void {
  if (matches.length === 0) {
    console.log(`No matches found for "${pattern}"`);
    return;
  }

  console.log(`Found ${matches.length} matches for "${pattern}":\n`);

  for (const match of matches) {
    const icon = match.type === "user" ? "👤" : "🤖";
    const typeLabel = match.type.toUpperCase().padEnd(9);
    const date = formatDate(match.timestamp);

    console.log(`${icon} ${typeLabel} ${date}`);
    console.log(`   Session: ${match.sessionId}`);
    console.log(`   ${match.snippet}`);
    console.log("");
  }

  console.log("─".repeat(80));
  console.log(`To view a full conversation, use:`);
  console.log(`  bun $SKILL_DIR/scripts/parse-conversation.ts <project-dir>/<session-id>.jsonl`);
}

function outputJson(matches: SearchMatch[]): void {
  console.log(JSON.stringify(matches, null, 2));
}

async function main(): Promise<void> {
  const { projectDir, options } = parseOptions(process.argv.slice(2));
  const matches = await searchProject(projectDir, options);

  if (options.format === "json") {
    outputJson(matches);
  } else {
    outputTable(matches, options.pattern);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
