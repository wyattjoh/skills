import { describe, it, expect } from "bun:test";
import { filterSessions, loadSessionsIndex, sortSessions } from "./list-sessions.ts";
import type { SessionEntry } from "../references/types.ts";
import { dirname, join } from "node:path";

const testdataDir = join(dirname(import.meta.url.replace("file://", "")), "testdata");
const testProjectDir = join(testdataDir, "projects", "-Users-test-project-myapp");

describe("list-sessions", () => {
  describe("loadSessionsIndex", () => {
    it("loads sessions index from testdata", async () => {
      const index = await loadSessionsIndex(testProjectDir);

      expect(index).toBeDefined();
      expect(index.version).toBe(1);
      expect(Array.isArray(index.entries)).toBe(true);
      expect(index.entries.length).toBe(3);

      const first = index.entries[0];
      expect(first.sessionId).toBe("abc-123");
      expect(typeof first.fullPath).toBe("string");
      expect(typeof first.messageCount).toBe("number");
      expect(typeof first.modified).toBe("string");
    });

    it("throws for non-existent project", async () => {
      await expect(loadSessionsIndex("/nonexistent/path/that/does/not/exist")).rejects.toThrow();
    });
  });

  describe("filterSessions", () => {
    const mockEntries: SessionEntry[] = [
      {
        sessionId: "abc-123",
        fullPath: "/path/to/abc-123.jsonl",
        fileMtime: 1705316400000,
        firstPrompt: "Help me implement authentication",
        messageCount: 10,
        created: "2026-01-15T10:00:00Z",
        modified: "2026-01-15T11:00:00Z",
        gitBranch: "feature-auth",
        projectPath: "/Users/test/project",
        isSidechain: false,
      },
      {
        sessionId: "def-456",
        fullPath: "/path/to/def-456.jsonl",
        fileMtime: 1705402800000,
        firstPrompt: "Fix the database query",
        messageCount: 5,
        created: "2026-01-16T10:00:00Z",
        modified: "2026-01-16T11:00:00Z",
        gitBranch: "main",
        projectPath: "/Users/test/project",
        isSidechain: false,
      },
      {
        sessionId: "ghi-789",
        fullPath: "/path/to/ghi-789.jsonl",
        fileMtime: 1705489200000,
        firstPrompt: "Add user authentication flow",
        messageCount: 15,
        created: "2026-01-17T10:00:00Z",
        modified: "2026-01-17T11:00:00Z",
        gitBranch: "feature-auth",
        projectPath: "/Users/test/project",
        isSidechain: false,
      },
    ];

    it("returns all entries when no search term", () => {
      const result = filterSessions(mockEntries);
      expect(result.length).toBe(3);
    });

    it("filters by first prompt content", () => {
      const result = filterSessions(mockEntries, "authentication");
      expect(result.length).toBe(2);
      expect(result[0].sessionId).toBe("abc-123");
      expect(result[1].sessionId).toBe("ghi-789");
    });

    it("filters by session ID", () => {
      const result = filterSessions(mockEntries, "def-456");
      expect(result.length).toBe(1);
      expect(result[0].sessionId).toBe("def-456");
    });

    it("filters by git branch", () => {
      const result = filterSessions(mockEntries, "feature-auth");
      expect(result.length).toBe(2);
    });

    it("is case-insensitive", () => {
      const result = filterSessions(mockEntries, "DATABASE");
      expect(result.length).toBe(1);
      expect(result[0].sessionId).toBe("def-456");
    });

    it("returns empty array when no matches", () => {
      const result = filterSessions(mockEntries, "nonexistent");
      expect(result.length).toBe(0);
    });
  });

  describe("sortSessions", () => {
    const mockEntries: SessionEntry[] = [
      {
        sessionId: "old",
        fullPath: "/path/to/old.jsonl",
        fileMtime: 1705316400000,
        firstPrompt: "Oldest session",
        messageCount: 5,
        created: "2026-01-15T10:00:00Z",
        modified: "2026-01-15T11:00:00Z",
        gitBranch: "main",
        projectPath: "/Users/test/project",
        isSidechain: false,
      },
      {
        sessionId: "new",
        fullPath: "/path/to/new.jsonl",
        fileMtime: 1705489200000,
        firstPrompt: "Newest session",
        messageCount: 20,
        created: "2026-01-17T10:00:00Z",
        modified: "2026-01-17T11:00:00Z",
        gitBranch: "main",
        projectPath: "/Users/test/project",
        isSidechain: false,
      },
      {
        sessionId: "mid",
        fullPath: "/path/to/mid.jsonl",
        fileMtime: 1705402800000,
        firstPrompt: "Middle session",
        messageCount: 10,
        created: "2026-01-16T10:00:00Z",
        modified: "2026-01-16T11:00:00Z",
        gitBranch: "main",
        projectPath: "/Users/test/project",
        isSidechain: false,
      },
    ];

    it("sorts by date (most recent first)", () => {
      const result = sortSessions(mockEntries, "date");
      expect(result[0].sessionId).toBe("new");
      expect(result[1].sessionId).toBe("mid");
      expect(result[2].sessionId).toBe("old");
    });

    it("sorts by message count (highest first)", () => {
      const result = sortSessions(mockEntries, "messages");
      expect(result[0].sessionId).toBe("new");
      expect(result[1].sessionId).toBe("mid");
      expect(result[2].sessionId).toBe("old");
    });

    it("does not mutate the original array", () => {
      const original = [...mockEntries];
      sortSessions(mockEntries, "date");
      expect(mockEntries[0].sessionId).toBe(original[0].sessionId);
    });
  });

  describe("integration with testdata", () => {
    it("loads, filters, and sorts session data", async () => {
      const index = await loadSessionsIndex(testProjectDir);

      const filtered = filterSessions(index.entries, "");
      expect(filtered.length).toBe(3);

      const sorted = sortSessions(filtered, "date");

      // ghi-789 is newest (2026-01-19), abc-123 middle (2026-01-18), def-456 oldest (2026-01-17)
      expect(sorted[0].sessionId).toBe("ghi-789");
      expect(sorted[1].sessionId).toBe("abc-123");
      expect(sorted[2].sessionId).toBe("def-456");
    });
  });
});
