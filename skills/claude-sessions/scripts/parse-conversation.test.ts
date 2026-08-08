import { describe, it as test, expect } from "bun:test";
import type {
  AssistantMessage,
  FileHistorySnapshot,
  SessionEntry,
  SessionsIndex,
  SummaryMessage,
  SystemMessage,
  UserMessage,
} from "../references/types.ts";
import { isAssistantMessage, isContentMessage, isUserMessage } from "../references/types.ts";

// ═══════════════════════════════════════════════════════════════
// Test Data Fixtures
// ═══════════════════════════════════════════════════════════════

const createUserMessage = (text: string): UserMessage => ({
  type: "user",
  uuid: "test-uuid-user",
  parentUuid: null,
  timestamp: "2026-01-18T10:00:00.000Z",
  sessionId: "test-session",
  cwd: "/test/path",
  version: "2.1.0",
  gitBranch: "main",
  slug: "test-session",
  isSidechain: false,
  userType: "external",
  message: {
    role: "user",
    content: [{ type: "text", text }],
  },
});

const createAssistantMessage = (text: string): AssistantMessage => ({
  type: "assistant",
  uuid: "test-uuid-assistant",
  parentUuid: "test-uuid-user",
  timestamp: "2026-01-18T10:00:01.000Z",
  sessionId: "test-session",
  cwd: "/test/path",
  version: "2.1.0",
  gitBranch: "main",
  slug: "test-session",
  isSidechain: false,
  userType: "external",
  message: {
    model: "claude-opus-4-5-20251101",
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 50,
      output_tokens: 200,
      service_tier: "standard",
    },
  },
  requestId: "req_test",
});

const createFileSnapshot = (): FileHistorySnapshot => ({
  type: "file-history-snapshot",
  messageId: "test-snapshot",
  snapshot: {
    messageId: "test-snapshot",
    trackedFileBackups: {},
    timestamp: "2026-01-18T10:00:00.000Z",
  },
  isSnapshotUpdate: false,
});

const createSystemMessage = (): SystemMessage => ({
  type: "system",
  system: "Test system prompt",
});

const createSummaryMessage = (): SummaryMessage => ({
  type: "summary",
  summary: "Previous conversation was summarized",
});

// ═══════════════════════════════════════════════════════════════
// Type Guard Tests
// ═══════════════════════════════════════════════════════════════

describe("Type Guards", () => {
  describe("isUserMessage", () => {
    test("returns true for user messages", () => {
      const msg = createUserMessage("Hello");
      expect(isUserMessage(msg)).toBe(true);
    });

    test("returns false for assistant messages", () => {
      const msg = createAssistantMessage("Hello");
      expect(isUserMessage(msg)).toBe(false);
    });

    test("returns false for file-history-snapshot", () => {
      const msg = createFileSnapshot();
      expect(isUserMessage(msg)).toBe(false);
    });
  });

  describe("isAssistantMessage", () => {
    test("returns true for assistant messages", () => {
      const msg = createAssistantMessage("Hello");
      expect(isAssistantMessage(msg)).toBe(true);
    });

    test("returns false for user messages", () => {
      const msg = createUserMessage("Hello");
      expect(isAssistantMessage(msg)).toBe(false);
    });

    test("returns false for system messages", () => {
      const msg = createSystemMessage();
      expect(isAssistantMessage(msg)).toBe(false);
    });
  });

  describe("isContentMessage", () => {
    test("returns true for user messages", () => {
      const msg = createUserMessage("Hello");
      expect(isContentMessage(msg)).toBe(true);
    });

    test("returns true for assistant messages", () => {
      const msg = createAssistantMessage("Hello");
      expect(isContentMessage(msg)).toBe(true);
    });

    test("returns false for file-history-snapshot", () => {
      const msg = createFileSnapshot();
      expect(isContentMessage(msg)).toBe(false);
    });

    test("returns false for system messages", () => {
      const msg = createSystemMessage();
      expect(isContentMessage(msg)).toBe(false);
    });

    test("returns false for summary messages", () => {
      const msg = createSummaryMessage();
      expect(isContentMessage(msg)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Sessions Index Tests
// ═══════════════════════════════════════════════════════════════

describe("SessionsIndex Type", () => {
  test("correctly types sessions index structure", () => {
    const index: SessionsIndex = {
      version: 1,
      entries: [
        {
          sessionId: "abc-123",
          fullPath: "/path/to/session.jsonl",
          fileMtime: 1705586400000,
          firstPrompt: "Hello, Claude!",
          messageCount: 10,
          created: "2026-01-18T10:00:00.000Z",
          modified: "2026-01-18T11:00:00.000Z",
          gitBranch: "main",
          projectPath: "/test/project",
          isSidechain: false,
        },
      ],
    };

    expect(index.version).toBe(1);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].sessionId).toBe("abc-123");
    expect(index.entries[0].isSidechain).toBe(false);
  });

  test("handles multiple entries", () => {
    const entries: SessionEntry[] = [
      {
        sessionId: "session-1",
        fullPath: "/path/1.jsonl",
        fileMtime: 1705586400000,
        firstPrompt: "First",
        messageCount: 5,
        created: "2026-01-18T10:00:00.000Z",
        modified: "2026-01-18T10:30:00.000Z",
        gitBranch: "main",
        projectPath: "/test",
        isSidechain: false,
      },
      {
        sessionId: "session-2",
        fullPath: "/path/2.jsonl",
        fileMtime: 1705590000000,
        firstPrompt: "Second",
        messageCount: 3,
        created: "2026-01-18T11:00:00.000Z",
        modified: "2026-01-18T11:15:00.000Z",
        gitBranch: "feature",
        projectPath: "/test",
        isSidechain: true,
      },
    ];

    expect(entries[0].gitBranch).toBe("main");
    expect(entries[1].isSidechain).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Conversation Entry Tests
// ═══════════════════════════════════════════════════════════════

describe("ConversationEntry Types", () => {
  test("user message with text content", () => {
    const msg = createUserMessage("Test message");

    expect(msg.type).toBe("user");
    expect(msg.message.role).toBe("user");
    expect(msg.message.content).toHaveLength(1);
    expect(msg.message.content[0].type).toBe("text");
  });

  test("user message with tool result", () => {
    const msg: UserMessage = {
      type: "user",
      uuid: "test-uuid",
      parentUuid: "prev-uuid",
      timestamp: "2026-01-18T10:00:00.000Z",
      sessionId: "test-session",
      cwd: "/test",
      version: "2.1.0",
      gitBranch: "main",
      slug: "test",
      isSidechain: false,
      userType: "external",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-123",
            content: "Result of tool execution",
          },
        ],
      },
    };

    expect(msg.message.content[0].type).toBe("tool_result");
  });

  test("assistant message with thinking and tool use", () => {
    const msg: AssistantMessage = {
      type: "assistant",
      uuid: "test-uuid",
      parentUuid: "prev-uuid",
      timestamp: "2026-01-18T10:00:00.000Z",
      sessionId: "test-session",
      cwd: "/test",
      version: "2.1.0",
      gitBranch: "main",
      slug: "test",
      isSidechain: false,
      userType: "external",
      message: {
        model: "claude-opus-4-5-20251101",
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think...", signature: "sig" },
          { type: "text", text: "Here's my response" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { path: "/test" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 50,
          service_tier: "standard",
        },
      },
      requestId: "req_test",
    };

    expect(msg.message.content).toHaveLength(3);
    expect(msg.message.content[0].type).toBe("thinking");
    expect(msg.message.content[1].type).toBe("text");
    expect(msg.message.content[2].type).toBe("tool_use");
    expect(msg.message.stop_reason).toBe("tool_use");
  });

  test("assistant message tracks token usage", () => {
    const msg = createAssistantMessage("Response");

    expect(msg.message.usage.input_tokens).toBe(100);
    expect(msg.message.usage.output_tokens).toBe(200);
    expect(msg.message.usage.cache_read_input_tokens).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════

describe("Edge Cases", () => {
  test("handles empty content array", () => {
    const msg: UserMessage = {
      ...createUserMessage(""),
      message: { role: "user", content: [] },
    };

    expect(msg.message.content).toHaveLength(0);
    expect(isUserMessage(msg)).toBe(true);
  });

  test("handles sidechain conversation", () => {
    const msg: UserMessage = {
      ...createUserMessage("Branched conversation"),
      isSidechain: true,
      parentUuid: "branch-point-uuid",
    };

    expect(msg.isSidechain).toBe(true);
    expect(msg.parentUuid).toBe("branch-point-uuid");
  });

  test("session entry with truncated prompt", () => {
    const entry: SessionEntry = {
      sessionId: "test",
      fullPath: "/path",
      fileMtime: 1705586400000,
      firstPrompt: "This is a very long prompt that gets truncated...",
      messageCount: 1,
      created: "2026-01-18T10:00:00.000Z",
      modified: "2026-01-18T10:00:00.000Z",
      gitBranch: "main",
      projectPath: "/test",
      isSidechain: false,
    };

    expect(entry.firstPrompt.endsWith("...")).toBe(true);
  });
});
