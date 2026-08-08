/**
 * Type definitions for Claude Code conversation files
 *
 * These types describe the structure of files stored in:
 * ~/.claude/projects/<encoded-project-path>/
 */

// =============================================================================
// Sessions Index (sessions-index.json)
// =============================================================================

/**
 * Root structure of sessions-index.json
 */
export interface SessionsIndex {
  version: number;
  entries: SessionEntry[];
}

/**
 * Metadata for a single conversation session
 */
export interface SessionEntry {
  /** UUID identifying this session */
  sessionId: string;

  /** Absolute path to the .jsonl conversation file */
  fullPath: string;

  /** File modification timestamp in milliseconds since epoch */
  fileMtime: number;

  /** First user prompt (truncated, may end with "...") */
  firstPrompt: string;

  /** Total number of messages in the conversation */
  messageCount: number;

  /** ISO 8601 timestamp when session was created */
  created: string;

  /** ISO 8601 timestamp when session was last modified */
  modified: string;

  /** Git branch name at session start */
  gitBranch: string;

  /** Absolute path to the project directory */
  projectPath: string;

  /** True if this is a branched/sidechain conversation */
  isSidechain: boolean;
}

// =============================================================================
// Conversation Messages (.jsonl files)
// =============================================================================

/**
 * Base fields present on all message types
 */
export interface BaseMessage {
  /** Message type discriminator */
  type: MessageType;

  /** Unique identifier for this message */
  uuid: string;

  /** UUID of parent message (null for root messages) */
  parentUuid: string | null;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Session this message belongs to */
  sessionId: string;

  /** Working directory at message time */
  cwd: string;

  /** Claude Code version */
  version: string;

  /** Git branch at message time */
  gitBranch: string;

  /** Human-readable session slug (e.g., "peaceful-painting-candle") */
  slug: string;

  /** Whether this is a sidechain/branch */
  isSidechain: boolean;

  /** User type (e.g., "external" for real users) */
  userType: string;
}

/**
 * All possible message types
 */
export type MessageType = "user" | "assistant" | "system" | "summary" | "file-history-snapshot";

// =============================================================================
// User Messages
// =============================================================================

export interface UserMessage extends BaseMessage {
  type: "user";
  message: {
    role: "user";
    content: UserContent[];
  };
  /** Todo items associated with this message */
  todos?: TodoItem[];
  /** Thinking metadata for extended thinking mode */
  thinkingMetadata?: ThinkingMetadata;
}

export type UserContent = TextContent | ToolResultContent;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | ToolResultPart[];
  is_error?: boolean;
}

export interface ToolResultPart {
  type: "text";
  text: string;
}

// =============================================================================
// Assistant Messages
// =============================================================================

export interface AssistantMessage extends BaseMessage {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: AssistantContent[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: UsageInfo;
  };
  requestId: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolUseContent;

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface UsageInfo {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  service_tier: string;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
}

// =============================================================================
// System Messages
// =============================================================================

export interface SystemMessage extends Partial<BaseMessage> {
  type: "system";
  /** System configuration or context */
  system?: string;
  /** Allowed tools for this session */
  allowedTools?: string[];
}

// =============================================================================
// Summary Messages
// =============================================================================

export interface SummaryMessage extends Partial<BaseMessage> {
  type: "summary";
  /** Summary of collapsed messages */
  summary?: string;
  /** UUIDs of messages that were summarized */
  summarizedMessageIds?: string[];
}

// =============================================================================
// File History Snapshots
// =============================================================================

export interface FileHistorySnapshot {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<string, FileBackup>;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

export interface FileBackup {
  path: string;
  content: string;
  encoding?: string;
}

// =============================================================================
// Supporting Types
// =============================================================================

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export interface ThinkingMetadata {
  level: "none" | "low" | "medium" | "high";
  disabled: boolean;
  triggers: string[];
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any message that can appear in a conversation file
 */
export type ConversationEntry =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | SummaryMessage
  | FileHistorySnapshot;

/**
 * Messages that contain actual conversation content
 */
export type ContentMessage = UserMessage | AssistantMessage;

/**
 * Type guard to check if entry is a content message
 */
export function isContentMessage(entry: ConversationEntry): entry is ContentMessage {
  return entry.type === "user" || entry.type === "assistant";
}

/**
 * Type guard to check if entry is a user message
 */
export function isUserMessage(entry: ConversationEntry): entry is UserMessage {
  return entry.type === "user";
}

/**
 * Type guard to check if entry is an assistant message
 */
export function isAssistantMessage(entry: ConversationEntry): entry is AssistantMessage {
  return entry.type === "assistant";
}
