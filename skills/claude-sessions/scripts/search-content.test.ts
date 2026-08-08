import { describe, it, expect } from "bun:test";
import {
  extractSnippet,
  extractTextContent,
  parseJsonl,
  searchConversation,
} from "./search-content.ts";
import type { AssistantMessage, ConversationEntry, UserMessage } from "../references/types.ts";
import { dirname, join } from "node:path";

const testdataDir = join(dirname(import.meta.url.replace("file://", "")), "testdata");
const testProjectDir = join(testdataDir, "projects", "-Users-test-project-myapp");

describe("search-content", () => {
  describe("extractTextContent", () => {
    it("extracts text from user message", () => {
      const entry: ConversationEntry = {
        type: "user",
        uuid: "test-uuid",
        parentUuid: null,
        timestamp: "2026-01-15T10:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Hello, Claude!" },
            { type: "text", text: "How are you?" },
          ],
        },
      } as UserMessage;

      const result = extractTextContent(entry);
      expect(result).toBe("Hello, Claude!\nHow are you?");
    });

    it("extracts text from assistant message", () => {
      const entry: ConversationEntry = {
        type: "assistant",
        uuid: "test-uuid",
        parentUuid: "parent-uuid",
        timestamp: "2026-01-15T10:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'm doing well, thank you!" }],
        },
      } as AssistantMessage;

      const result = extractTextContent(entry);
      expect(result).toBe("I'm doing well, thank you!");
    });

    it("returns null for non-user/assistant entries", () => {
      const entry: ConversationEntry = {
        type: "system",
      } as ConversationEntry;

      const result = extractTextContent(entry);
      expect(result).toBeNull();
    });

    it("handles undefined content gracefully", () => {
      const entry = {
        type: "user",
        uuid: "test-uuid",
        message: {},
      } as UserMessage;

      const result = extractTextContent(entry);
      expect(result).toBeNull();
    });
  });

  describe("extractSnippet", () => {
    it("extracts snippet around match with context", () => {
      const text = "This is a long text with a specific keyword in the middle of it.";
      const result = extractSnippet(text, "keyword", 10);

      expect(result.index).toBe(36);
      expect(result.snippet).toContain("keyword");
      expect(result.snippet.length).toBeLessThan(text.length);
    });

    it("is case-insensitive", () => {
      const text = "Looking for KEYWORD here";
      const result = extractSnippet(text, "keyword", 10);

      expect(result.index).toBe(12);
      expect(result.snippet).toContain("KEYWORD");
    });

    it("adds ellipsis when truncating start", () => {
      const text = "prefix content keyword suffix";
      const result = extractSnippet(text, "keyword", 5);

      expect(result.snippet.startsWith("...")).toBe(true);
    });

    it("adds ellipsis when truncating end", () => {
      const text = "keyword with lots of suffix content here";
      const result = extractSnippet(text, "keyword", 5);

      expect(result.snippet.endsWith("...")).toBe(true);
    });

    it("returns empty string and -1 index when no match", () => {
      const text = "No match here";
      const result = extractSnippet(text, "missing", 10);

      expect(result.snippet).toBe("");
      expect(result.index).toBe(-1);
    });

    it("handles match at start of text", () => {
      const text = "keyword at the start";
      const result = extractSnippet(text, "keyword", 5);

      expect(result.index).toBe(0);
      expect(result.snippet.startsWith("...")).toBe(false);
    });

    it("handles match at end of text", () => {
      const text = "text ending with keyword";
      const result = extractSnippet(text, "keyword", 5);

      expect(result.snippet.endsWith("...")).toBe(false);
    });
  });

  describe("parseJsonl", () => {
    it("parses testdata conversation file", async () => {
      const sessionPath = join(testProjectDir, "abc-123.jsonl");
      const entries: ConversationEntry[] = [];

      for await (const entry of parseJsonl(sessionPath)) {
        entries.push(entry);
      }

      // abc-123.jsonl has 7 entries: system, user, assistant, user (tool_result), assistant, summary, file-history-snapshot
      expect(entries.length).toBe(7);
      expect(entries[0].type).toBe("system");
      expect(entries[1].type).toBe("user");
      expect(entries[2].type).toBe("assistant");
      expect(entries[3].type).toBe("user");
      expect(entries[4].type).toBe("assistant");
      expect(entries[5].type).toBe("summary");
      expect(entries[6].type).toBe("file-history-snapshot");
    });
  });

  describe("searchConversation", () => {
    it("finds matches in testdata conversation", async () => {
      const sessionPath = join(testProjectDir, "abc-123.jsonl");

      const matches = await searchConversation(sessionPath, "abc-123", {
        pattern: "authentication",
        format: "table",
        limit: 10,
        context: 50,
        type: "all",
      });

      // "authentication" appears in the first user message
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches) {
        expect(match.sessionId).toBe("abc-123");
        expect(match.snippet.toLowerCase()).toContain("authentication");
      }
    });

    it("filters by message type", async () => {
      const sessionPath = join(testProjectDir, "abc-123.jsonl");

      const userMatches = await searchConversation(sessionPath, "abc-123", {
        pattern: "authentication",
        format: "table",
        limit: 20,
        context: 50,
        type: "user",
      });

      for (const match of userMatches) {
        expect(match.type).toBe("user");
      }

      const assistantMatches = await searchConversation(sessionPath, "abc-123", {
        pattern: "JWT",
        format: "table",
        limit: 20,
        context: 50,
        type: "assistant",
      });

      for (const match of assistantMatches) {
        expect(match.type).toBe("assistant");
      }
    });

    it("returns all matches from a single conversation", async () => {
      const sessionPath = join(testProjectDir, "abc-123.jsonl");

      const matches = await searchConversation(sessionPath, "abc-123", {
        pattern: "the",
        format: "table",
        limit: 100,
        context: 50,
        type: "all",
      });

      for (const match of matches) {
        expect(match.sessionId).toBe("abc-123");
      }
    });
  });
});
