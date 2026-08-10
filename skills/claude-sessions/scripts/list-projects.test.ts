import { describe, it, expect } from "bun:test";
import { decodeProjectPath, getProjectInfo, listProjects } from "./list-projects.ts";
import { dirname, join } from "node:path";

const testdataDir = join(dirname(import.meta.url.replace("file://", "")), "testdata");

describe("list-projects", () => {
  describe("decodeProjectPath", () => {
    it("decodes root-prefixed paths", () => {
      const encoded = "-Users-john-projects-myapp";
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe("/Users/john/projects/myapp");
    });

    it("decodes paths without root prefix", () => {
      const encoded = "relative-path-here";
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe("relative/path/here");
    });

    it("handles single segment paths", () => {
      const encoded = "-Users";
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe("/Users");
    });
  });

  describe("getProjectInfo", () => {
    const projectsDir = join(testdataDir, "projects");

    it("returns null for non-existent directory", async () => {
      const result = await getProjectInfo(projectsDir, "nonexistent-project-12345");
      expect(result).toBeNull();
    });

    it("retrieves info for an existing project", async () => {
      const result = await getProjectInfo(projectsDir, "-Users-test-project-myapp");

      expect(result?.encodedPath).toBe("-Users-test-project-myapp");
      expect(result?.decodedPath).toBe("/Users/test/project/myapp");
      expect(result?.sessionCount).toBe(3);
    });
  });

  describe("listProjects", () => {
    it("lists projects from testdata", async () => {
      const projects = await listProjects({
        format: "table",
        sort: "date",
        limit: 10,
        claudeDir: testdataDir,
      });

      expect(projects.length).toBe(1);
      expect(projects[0].encodedPath).toBe("-Users-test-project-myapp");
      expect(projects[0].sessionCount).toBe(3);
    });

    it("sorts by date (most recent first)", async () => {
      const projects = await listProjects({
        format: "table",
        sort: "date",
        limit: 100,
        claudeDir: testdataDir,
      });

      expect(projects.length).toBe(1);
    });

    it("sorts by session count", async () => {
      const projects = await listProjects({
        format: "table",
        sort: "sessions",
        limit: 100,
        claudeDir: testdataDir,
      });

      expect(projects.length).toBe(1);
      expect(projects[0].sessionCount).toBe(3);
    });

    it("respects the limit option", async () => {
      const projects = await listProjects({
        format: "table",
        sort: "date",
        limit: 0,
        claudeDir: testdataDir,
      });

      expect(projects.length).toBe(0);
    });

    it("filters by search term", async () => {
      const matched = await listProjects({
        format: "table",
        sort: "date",
        limit: 100,
        claudeDir: testdataDir,
        search: "myapp",
      });
      expect(matched.length).toBe(1);

      const noMatch = await listProjects({
        format: "table",
        sort: "date",
        limit: 100,
        claudeDir: testdataDir,
        search: "nonexistent-term",
      });
      expect(noMatch.length).toBe(0);
    });
  });
});
