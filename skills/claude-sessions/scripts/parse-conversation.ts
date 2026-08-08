#!/usr/bin/env bun

/**
 * Parse and display Claude Code conversation content
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/parse-conversation.ts <conversation.jsonl> [options]
 *
 * Options:
 *   --format=json|readable|stats   Output format (default: readable)
 *   --include-thinking             Include thinking blocks in output
 *   --include-tools                Include tool calls in output
 *   --filter=user|assistant|all    Filter by message type (default: all)
 *   --search=TERM                  Only show messages containing TERM (case-insensitive)
 */

import { parseArgs } from "node:util";
import type {
  AssistantContent,
  AssistantMessage,
  ConversationEntry,
  UserContent,
  UserMessage,
} from "../references/types.ts";

export interface Options {
  format: "json" | "readable" | "stats";
  includeThinking: boolean;
  includeTools: boolean;
  filter: "user" | "assistant" | "all";
  search?: string;
}

export interface ConversationStats {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  systemMessages: number;
  summaryMessages: number;
  fileSnapshots: number;
  toolCalls: Record<string, number>;
  thinkingBlocks: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheHits: number;
  timeRange: {
    start: string;
    end: string;
    durationMinutes: number;
  } | null;
}

function parseOptions(args: string[]): { filePath: string; options: Options } {
  const { values: parsed, positionals } = parseArgs({
    args,
    options: {
      format: { type: "string", default: "readable" },
      filter: { type: "string", default: "all" },
      search: { type: "string" },
      "include-thinking": { type: "boolean", default: false },
      "include-tools": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const filePath = positionals[0];
  if (!filePath) {
    console.error("Usage: parse-conversation.ts <conversation.jsonl> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --format=json|readable|stats   Output format (default: readable)");
    console.error("  --include-thinking             Include thinking blocks in output");
    console.error("  --include-tools                Include tool calls in output");
    console.error("  --filter=user|assistant|all    Filter by message type (default: all)");
    console.error("  --search=TERM                  Only show messages containing TERM");
    process.exit(1);
  }

  return {
    filePath,
    options: {
      format: parsed.format as "json" | "readable" | "stats",
      includeThinking: parsed["include-thinking"] ?? false,
      includeTools: parsed["include-tools"] ?? false,
      filter: parsed.filter as "user" | "assistant" | "all",
      search: parsed.search,
    },
  };
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

export function extractUserText(content: UserContent[] | undefined): string {
  if (!content || !Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function extractAssistantText(
  content: AssistantContent[] | undefined,
  options: Options,
): string {
  if (!content || !Array.isArray(content)) return "";
  const parts: string[] = [];

  for (const item of content) {
    if (!item) continue;
    if (item.type === "text") {
      parts.push(item.text);
    } else if (item.type === "thinking" && options.includeThinking) {
      parts.push(`[Thinking]\n${item.thinking}\n[/Thinking]`);
    } else if (item.type === "tool_use" && options.includeTools) {
      parts.push(`[Tool: ${item.name}]\n${JSON.stringify(item.input, null, 2)}\n[/Tool]`);
    }
  }

  return parts.join("\n\n");
}

export function entryMatchesSearch(entry: ConversationEntry, search: string): boolean {
  const searchLower = search.toLowerCase();

  if (entry.type === "user" && "message" in entry && entry.message) {
    const userEntry = entry as UserMessage;
    const content = userEntry.message?.content;
    if (!content || !Array.isArray(content)) return false;

    for (const item of content) {
      if (item?.type === "text" && item.text.toLowerCase().includes(searchLower)) {
        return true;
      }
    }
  }

  if (entry.type === "assistant" && "message" in entry && entry.message) {
    const assistantEntry = entry as AssistantMessage;
    const content = assistantEntry.message?.content;
    if (!content || !Array.isArray(content)) return false;

    for (const item of content) {
      if (!item) continue;
      if (item.type === "text" && item.text.toLowerCase().includes(searchLower)) {
        return true;
      }
      if (item.type === "thinking" && item.thinking.toLowerCase().includes(searchLower)) {
        return true;
      }
      if (item.type === "tool_use") {
        const inputStr = JSON.stringify(item.input).toLowerCase();
        if (item.name.toLowerCase().includes(searchLower) || inputStr.includes(searchLower)) {
          return true;
        }
      }
    }
  }

  return false;
}

function formatReadable(entry: ConversationEntry, options: Options): string | null {
  if (entry.type === "user" && "message" in entry && entry.message) {
    if (options.filter === "assistant") return null;

    const userEntry = entry as UserMessage;
    const text = extractUserText(userEntry.message.content);
    if (!text) return null;

    return `\n${"─".repeat(80)}\n👤 USER (${entry.timestamp})\n${"─".repeat(80)}\n${text}`;
  }

  if (entry.type === "assistant" && "message" in entry && entry.message) {
    if (options.filter === "user") return null;

    const assistantEntry = entry as AssistantMessage;
    const text = extractAssistantText(assistantEntry.message.content, options);
    if (!text) return null;

    return `\n${"─".repeat(80)}\n🤖 ASSISTANT (${entry.timestamp})\n${"─".repeat(80)}\n${text}`;
  }

  return null;
}

export function computeStats(entries: ConversationEntry[]): ConversationStats {
  const stats: ConversationStats = {
    totalMessages: entries.length,
    userMessages: 0,
    assistantMessages: 0,
    systemMessages: 0,
    summaryMessages: 0,
    fileSnapshots: 0,
    toolCalls: {},
    thinkingBlocks: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheHits: 0,
    timeRange: null,
  };

  const timestamps: Date[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        stats.userMessages++;
        break;
      case "assistant": {
        stats.assistantMessages++;
        const assistantEntry = entry as AssistantMessage;
        const content = assistantEntry.message?.content;
        if (content && Array.isArray(content)) {
          for (const item of content) {
            if (!item) continue;
            if (item.type === "thinking") {
              stats.thinkingBlocks++;
            } else if (item.type === "tool_use") {
              stats.toolCalls[item.name] = (stats.toolCalls[item.name] || 0) + 1;
            }
          }
        }
        if (assistantEntry.message?.usage) {
          stats.totalInputTokens += assistantEntry.message.usage.input_tokens || 0;
          stats.totalOutputTokens += assistantEntry.message.usage.output_tokens || 0;
          stats.cacheHits += assistantEntry.message.usage.cache_read_input_tokens || 0;
        }
        break;
      }
      case "system":
        stats.systemMessages++;
        break;
      case "summary":
        stats.summaryMessages++;
        break;
      case "file-history-snapshot":
        stats.fileSnapshots++;
        break;
    }

    if ("timestamp" in entry && entry.timestamp) {
      const ts = new Date(entry.timestamp);
      if (!isNaN(ts.getTime())) {
        timestamps.push(ts);
      }
    }
  }

  if (timestamps.length > 0) {
    timestamps.sort((a, b) => a.getTime() - b.getTime());
    const start = timestamps[0];
    const end = timestamps[timestamps.length - 1];
    stats.timeRange = {
      start: start.toISOString(),
      end: end.toISOString(),
      durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
    };
  }

  return stats;
}

function outputStats(stats: ConversationStats): void {
  console.log("┌────────────────────────────────────────────────────────┐");
  console.log("│ Conversation Statistics                                │");
  console.log("├────────────────────────────────────────────────────────┤");
  console.log(`│ Total Messages:        ${String(stats.totalMessages).padStart(30)} │`);
  console.log(`│ User Messages:         ${String(stats.userMessages).padStart(30)} │`);
  console.log(`│ Assistant Messages:    ${String(stats.assistantMessages).padStart(30)} │`);
  console.log(`│ System Messages:       ${String(stats.systemMessages).padStart(30)} │`);
  console.log(`│ Summary Messages:      ${String(stats.summaryMessages).padStart(30)} │`);
  console.log(`│ File Snapshots:        ${String(stats.fileSnapshots).padStart(30)} │`);
  console.log("├────────────────────────────────────────────────────────┤");
  console.log(`│ Thinking Blocks:       ${String(stats.thinkingBlocks).padStart(30)} │`);
  console.log(`│ Total Input Tokens:    ${String(stats.totalInputTokens).padStart(30)} │`);
  console.log(`│ Total Output Tokens:   ${String(stats.totalOutputTokens).padStart(30)} │`);
  console.log(`│ Cache Hits (tokens):   ${String(stats.cacheHits).padStart(30)} │`);
  console.log("├────────────────────────────────────────────────────────┤");

  if (Object.keys(stats.toolCalls).length > 0) {
    console.log("│ Tool Calls:                                            │");
    for (const [tool, count] of Object.entries(stats.toolCalls).toSorted((a, b) => b[1] - a[1])) {
      console.log(`│   ${tool.padEnd(25)} ${String(count).padStart(25)} │`);
    }
    console.log("├────────────────────────────────────────────────────────┤");
  }

  if (stats.timeRange) {
    console.log(`│ Start:                 ${stats.timeRange.start.padStart(30)} │`);
    console.log(`│ End:                   ${stats.timeRange.end.padStart(30)} │`);
    console.log(
      `│ Duration:              ${String(stats.timeRange.durationMinutes + " minutes").padStart(
        30,
      )} │`,
    );
  }

  console.log("└────────────────────────────────────────────────────────┘");
}

async function main(): Promise<void> {
  const { filePath, options } = parseOptions(process.argv.slice(2));

  let entries: ConversationEntry[] = [];

  for await (const entry of parseJsonl(filePath)) {
    entries.push(entry);
  }

  // Apply search filter if provided
  if (options.search) {
    entries = entries.filter((entry) => entryMatchesSearch(entry, options.search!));
    if (entries.length === 0) {
      console.log(`No messages found matching "${options.search}"`);
      return;
    }
    console.log(`Found ${entries.length} messages matching "${options.search}":\n`);
  }

  switch (options.format) {
    case "json":
      console.log(JSON.stringify(entries, null, 2));
      break;

    case "stats":
      outputStats(computeStats(entries));
      break;

    case "readable":
    default:
      for (const entry of entries) {
        const formatted = formatReadable(entry, options);
        if (formatted) {
          console.log(formatted);
        }
      }
      break;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
