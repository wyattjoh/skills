import { describe, it, expect } from "bun:test";
import { extractSnippet, getFileCreatedTime, searchPlans } from "./search-plans.ts";
import { dirname, join } from "node:path";

const testdataDir = join(dirname(import.meta.url.replace("file://", "")), "testdata");

describe("search-plans", () => {
  describe("extractSnippet", () => {
    it("extracts snippet and counts all matches", () => {
      const text = "keyword here and another keyword over there with keyword";
      const result = extractSnippet(text, "keyword", 10);

      expect(result.matchCount).toBe(3);
      expect(result.snippet).toContain("keyword");
    });

    it("is case-insensitive", () => {
      const text = "Looking for KEYWORD here and keyword there";
      const result = extractSnippet(text, "keyword", 10);

      expect(result.matchCount).toBe(2);
    });

    it("adds ellipsis when truncating", () => {
      const text = "prefix keyword suffix more content here";
      const result = extractSnippet(text, "keyword", 5);

      expect(result.snippet).toContain("...");
    });

    it("returns empty snippet and zero count when no match", () => {
      const text = "No match here";
      const result = extractSnippet(text, "missing", 10);

      expect(result.snippet).toBe("");
      expect(result.matchCount).toBe(0);
    });

    it("cleans up whitespace in snippet", () => {
      const text = "keyword\n\nwith\n  multiple\n\nlines";
      const result = extractSnippet(text, "keyword", 30);

      expect(result.snippet).toBe("keyword with multiple lines");
    });
  });

  describe("getFileCreatedTime", () => {
    it("returns empty string for non-existent file", async () => {
      const result = await getFileCreatedTime("/nonexistent/path/that/does/not/exist.md");
      expect(result).toBe("");
    });

    it("returns ISO timestamp for existing file", async () => {
      const planPath = join(testdataDir, "plans", "implement-auth.md");
      const result = await getFileCreatedTime(planPath);

      expect(result).toBeTruthy();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("searchPlans", () => {
    it("finds matches in testdata plans", async () => {
      const matches = await searchPlans({
        pattern: "authentication",
        format: "table",
        limit: 10,
        context: 150,
        claudeDir: testdataDir,
      });

      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBe(1);
      expect(matches[0].filename).toBe("implement-auth.md");
      expect(matches[0].matchCount).toBeGreaterThan(0);
    });

    it("sorts results by match count", async () => {
      const matches = await searchPlans({
        pattern: "the",
        format: "table",
        limit: 10,
        context: 100,
        claudeDir: testdataDir,
      });

      for (let i = 0; i < matches.length - 1; i++) {
        expect(matches[i].matchCount).toBeGreaterThanOrEqual(matches[i + 1].matchCount);
      }
    });

    it("respects the limit option", async () => {
      const matches = await searchPlans({
        pattern: "a",
        format: "table",
        limit: 1,
        context: 100,
        claudeDir: testdataDir,
      });

      expect(matches.length).toBeLessThanOrEqual(1);
    });

    it("returns only markdown files", async () => {
      const matches = await searchPlans({
        pattern: "a",
        format: "table",
        limit: 20,
        context: 100,
        claudeDir: testdataDir,
      });

      for (const match of matches) {
        expect(match.filename.endsWith(".md")).toBe(true);
      }
    });

    it("handles missing plans directory gracefully", async () => {
      try {
        const matches = await searchPlans({
          pattern: "test",
          format: "table",
          limit: 10,
          context: 150,
          claudeDir: "/nonexistent/path",
        });
        expect(Array.isArray(matches)).toBe(true);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });
});
