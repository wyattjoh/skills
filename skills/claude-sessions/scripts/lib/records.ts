/**
 * Typed record model for Claude Code conversation JSONL entries.
 *
 * A conversation file interleaves many record shapes. This module types the
 * ten kinds the index cares about (user, assistant, system, summary,
 * queue-operation, attachment, last-prompt, ai-title, atis-latch,
 * file-history-snapshot) and provides text extraction, injected-block
 * detection, and interrupt-marker detection shared by every one of them.
 *
 * Control records with no extracted text are parsed as `UnknownRecord` and
 * skipped by ingest.ts rather than stored as conversational messages.
 * `attachment` and `last-prompt` records are also metadata/noise and are
 * skipped even when they contain rendered text.
 *
 * Every other record type observed in real corpora (progress, mode,
 * permission-mode, agent-name, agent-setting, agent-color, bridge-session,
 * custom-title, worktree-state, cost-state, relocated, continued-in,
 * file-history-delta, saved_hook_context, ...) parses fine as `UnknownRecord`
 * but carries no extracted text, so ingest.ts skips it.
 */

// =============================================================================
// Content blocks (user / assistant message.content)
// =============================================================================

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }> | unknown;
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string };

/** message.content as it appears on disk: a plain string, or an array of blocks. */
export type MessageContent = string | ContentBlock[] | undefined;

// =============================================================================
// Record shapes
// =============================================================================

export interface RecordBase {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  /** Present only inside <session>/subagents/agent-*.jsonl files. */
  agentId?: string;
}

export interface UserRecord extends RecordBase {
  type: "user";
  message: {
    role: "user";
    content: MessageContent;
  };
  thinkingMetadata?: { level?: "none" | "low" | "medium" | "high" };
}

export interface AssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AssistantRecord extends RecordBase {
  type: "assistant";
  message: {
    role: "assistant";
    model?: string;
    content: MessageContent;
    usage?: AssistantUsage;
  };
}

export interface SystemRecord extends RecordBase {
  type: "system";
  content?: string;
  subtype?: string;
}

export interface SummaryRecord extends RecordBase {
  type: "summary";
  summary?: string;
  leafUuid?: string;
}

export interface QueueOperationRecord extends RecordBase {
  type: "queue-operation";
  operation?: string;
  content?: string;
}

export interface AttachmentRecord extends RecordBase {
  type: "attachment";
  attachment?: unknown;
  rendered?: Array<{ content?: string }>;
}

export interface LastPromptRecord extends RecordBase {
  type: "last-prompt";
  lastPrompt?: string;
  leafUuid?: string;
}

export interface AiTitleRecord extends RecordBase {
  type: "ai-title";
  aiTitle?: string;
}

export interface AtisLatchRecord extends RecordBase {
  type: "atis-latch";
  atis?: string;
}

export interface FileHistorySnapshotRecord extends RecordBase {
  type: "file-history-snapshot";
  messageId?: string;
  isSnapshotUpdate?: boolean;
  snapshot?: {
    messageId?: string;
    trackedFileBackups?: Record<string, unknown>;
    timestamp?: string;
  };
}

export interface UnknownRecord extends RecordBase {
  type: Exclude<
    string,
    | "user"
    | "assistant"
    | "system"
    | "summary"
    | "queue-operation"
    | "attachment"
    | "last-prompt"
    | "ai-title"
    | "atis-latch"
    | "file-history-snapshot"
  >;
}

export type AnyRecord =
  | UserRecord
  | AssistantRecord
  | SystemRecord
  | SummaryRecord
  | QueueOperationRecord
  | AttachmentRecord
  | LastPromptRecord
  | AiTitleRecord
  | AtisLatchRecord
  | FileHistorySnapshotRecord
  | UnknownRecord;

const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "summary",
  "queue-operation",
  "attachment",
  "last-prompt",
  "ai-title",
  "atis-latch",
  "file-history-snapshot",
]);

/**
 * Discriminate a parsed JSON value into a typed record. Any object with a
 * string `type` field parses (even unrecognized types become
 * `UnknownRecord`); anything else returns null so callers can count it
 * alongside malformed lines.
 */
export function parseRecord(value: unknown): AnyRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;
  return obj as unknown as AnyRecord;
}

export function isKnownRecordType(type: string): boolean {
  return KNOWN_TYPES.has(type);
}

// =============================================================================
// Block extraction
// =============================================================================

export interface ExtractedBlock {
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "other";
  text: string;
  /** tool_use: the id of the call. tool_result: the tool_use id it answers. */
  toolUseId?: string;
  /** tool_use only. */
  toolName?: string;
  /** tool_use only. */
  input?: Record<string, unknown>;
  /** tool_result only. */
  isError?: boolean;
}

function toolResultText(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: "text"; text: string } =>
          !!c && typeof c === "object" && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

/**
 * Extract blocks from message.content, which is either a plain string (a
 * shorthand seen throughout the real corpus for a single text turn) or an
 * array of typed blocks (text, thinking, tool_use, tool_result).
 */
export function extractBlocks(content: MessageContent): ExtractedBlock[] {
  if (content === undefined) return [];

  if (typeof content === "string") {
    if (content.length === 0) return [];
    return [{ kind: "text", text: content }];
  }

  if (!Array.isArray(content)) return [];

  const blocks: ExtractedBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as ContentBlock;

    switch (block.type) {
      case "text": {
        const text = (block as TextBlock).text ?? "";
        blocks.push({ kind: "text", text });
        break;
      }
      case "thinking": {
        const thinking = block as ThinkingBlock;
        blocks.push({ kind: "thinking", text: thinking.thinking ?? "" });
        break;
      }
      case "tool_use": {
        const toolUse = block as ToolUseBlock;
        blocks.push({
          kind: "tool_use",
          text: JSON.stringify(toolUse.input ?? {}),
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input ?? {},
        });
        break;
      }
      case "tool_result": {
        const toolResult = block as ToolResultBlock;
        blocks.push({
          kind: "tool_result",
          text: toolResultText(toolResult.content),
          toolUseId: toolResult.tool_use_id,
          isError: toolResult.is_error === true,
        });
        break;
      }
      default:
        blocks.push({ kind: "other", text: "" });
    }
  }
  return blocks;
}

/** Join every text-bearing block into one string, in block order. */
export function joinBlockText(blocks: ExtractedBlock[]): string {
  return blocks
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

// =============================================================================
// Text extraction per record kind
// =============================================================================

/**
 * Extract the searchable text for any known record kind. Returns an empty
 * string for record kinds that carry no meaningful text (and for unknown
 * types).
 */
export function extractRecordText(record: AnyRecord): string {
  switch (record.type) {
    case "user":
    case "assistant": {
      const message = (record as UserRecord | AssistantRecord).message;
      return joinBlockText(extractBlocks(message?.content));
    }
    case "system":
      return (record as SystemRecord).content ?? "";
    case "summary":
      return (record as SummaryRecord).summary ?? "";
    case "queue-operation":
      return (record as QueueOperationRecord).content ?? "";
    case "attachment": {
      const attachment = record as AttachmentRecord;
      if (Array.isArray(attachment.rendered)) {
        return attachment.rendered
          .map((r) => r.content ?? "")
          .filter((t) => t.length > 0)
          .join("\n\n");
      }
      return attachment.attachment ? JSON.stringify(attachment.attachment) : "";
    }
    case "last-prompt":
      return (record as LastPromptRecord).lastPrompt ?? "";
    case "ai-title":
      return (record as AiTitleRecord).aiTitle ?? "";
    case "atis-latch":
      return (record as AtisLatchRecord).atis ?? "";
    case "file-history-snapshot": {
      const snapshot = (record as FileHistorySnapshotRecord).snapshot;
      const paths = snapshot?.trackedFileBackups ? Object.keys(snapshot.trackedFileBackups) : [];
      return paths.join("\n");
    }
    default:
      return "";
  }
}

const NON_CONVERSATIONAL_RECORD_TYPES = new Set(["attachment", "last-prompt"]);

/**
 * Decide whether a parsed record should contribute a row to messages.
 * Records with no extracted text are control records or empty turns, and
 * attachment/last-prompt records are metadata noise even when rendered text
 * is present.
 */
export function shouldStoreMessage(record: AnyRecord, text: string): boolean {
  if (NON_CONVERSATIONAL_RECORD_TYPES.has(record.type)) return false;
  return text.trim().length > 0;
}

// =============================================================================
// Injected-block detection
// =============================================================================

const INJECTED_TAG_MARKERS = [
  "<local-command-caveat>",
  "<command-message>",
  "<command-name>",
  "<system-reminder>",
];

/**
 * True when text carries one of the literal tags Claude Code injects around
 * slash-command expansions, local-command output, or system reminders.
 */
export function hasInjectedTag(text: string): boolean {
  const trimmed = text.trim();
  if (/^<skill\s+name=(?:"[^"]+"|'[^']+')>[\s\S]*<\/skill>$/.test(trimmed)) return true;
  return INJECTED_TAG_MARKERS.some((marker) => text.includes(marker));
}

/**
 * True when a tool_result block answers a call to the Skill tool: the result
 * text is the injected body of the invoked skill, not user- or
 * assistant-authored content.
 */
export function isSkillToolResult(
  block: ExtractedBlock,
  toolNameById: ReadonlyMap<string, string>,
): boolean {
  if (block.kind !== "tool_result" || !block.toolUseId) return false;
  return toolNameById.get(block.toolUseId) === "Skill";
}

// =============================================================================
// Interrupt marker detection
// =============================================================================

const INTERRUPT_MARKERS = ["[Request interrupted by user", "The user doesn't want to proceed"];

/** True when text carries a user-interrupt or rejected-tool marker. */
export function hasInterruptMarker(text: string): boolean {
  return INTERRUPT_MARKERS.some((marker) => text.includes(marker));
}
