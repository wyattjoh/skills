import { beforeAll, describe, it, expect } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { listProjects } from "./list-projects.ts";
import { loadSessionsIndex } from "./list-sessions.ts";
import { parseJsonl } from "./search-content.ts";
import type { AssistantMessage, UserMessage } from "../references/types.ts";

// Live schema validation tests.
//
// These tests read real ~/.claude/ data and validate it conforms to our
// TypeScript types. They auto-skip when ~/.claude/ is absent (CI, containers,
// fresh machines) so the rest of the suite stays green.
const homeDir = process.env.HOME;
const skipLiveValidation = !homeDir || !existsSync(`${homeDir}/.claude`);

describe.skipIf(skipLiveValidation)("live schema validation", () => {
  let claudeDir: string;
  let projectDir: string;

  beforeAll(async () => {
    claudeDir = `${homeDir}/.claude`;

    // Find first project that has a sessions-index.json
    const projects = await listProjects({
      format: "json",
      sort: "date",
      limit: Infinity,
      claudeDir,
    });

    const projectsDir = `${claudeDir}/projects`;
    let projectWithIndex: (typeof projects)[number] | undefined;
    for (const project of projects) {
      try {
        await fs.stat(`${projectsDir}/${project.encodedPath}/sessions-index.json`);
        projectWithIndex = project;
        break;
      } catch {
        // No sessions-index.json, try next
      }
    }

    if (!projectWithIndex) {
      throw new Error(
        "No projects with sessions-index.json found in ~/.claude/projects. Cannot run live validation.",
      );
    }

    projectDir = `${claudeDir}/projects/${projectWithIndex.encodedPath}`;
  });

  describe("sessions-index.json", () => {
    it("has valid structure with required fields", async () => {
      const index = await loadSessionsIndex(projectDir);

      expect(index.version).toBeDefined();
      expect(typeof index.version).toBe("number");
      expect(Array.isArray(index.entries)).toBe(true);
      expect(index.entries.length).toBeGreaterThan(0);

      for (const entry of index.entries) {
        expect(typeof entry.sessionId).toBe("string");
        expect(entry.sessionId.length).toBeGreaterThan(0);

        expect(typeof entry.fullPath).toBe("string");
        expect(entry.fullPath.endsWith(".jsonl")).toBe(true);

        expect(typeof entry.fileMtime).toBe("number");
        expect(entry.fileMtime).toBeGreaterThan(0);

        expect(typeof entry.firstPrompt).toBe("string");

        expect(typeof entry.messageCount).toBe("number");
        expect(entry.messageCount).toBeGreaterThanOrEqual(0);

        expect(typeof entry.created).toBe("string");
        expect(new Date(entry.created).getTime()).toBeGreaterThan(0);

        expect(typeof entry.modified).toBe("string");
        expect(new Date(entry.modified).getTime()).toBeGreaterThan(0);

        expect(typeof entry.gitBranch).toBe("string");

        expect(typeof entry.projectPath).toBe("string");

        expect(typeof entry.isSidechain).toBe("boolean");
      }
    });
  });

  describe("conversation .jsonl entries", () => {
    it("contains valid conversation entries matching type discriminator", async () => {
      const index = await loadSessionsIndex(projectDir);

      // Use the session with the most messages for better coverage
      const session = index.entries.reduce((max, e) =>
        e.messageCount > max.messageCount ? e : max,
      );

      const seenTypes = new Set<string>();
      let entryCount = 0;

      for await (const entry of parseJsonl(session.fullPath)) {
        expect(entry.type).toBeDefined();
        expect(typeof entry.type).toBe("string");
        seenTypes.add(entry.type);

        if (entry.type === "user") {
          const userMsg = entry as UserMessage;
          expect(userMsg.message).toBeDefined();
          expect(userMsg.message.role).toBe("user");
          // content may be an array (structured) or a string (inline prompt)
          expect(
            Array.isArray(userMsg.message.content) ||
              typeof (userMsg.message.content as unknown) === "string",
          ).toBe(true);
          expect(typeof userMsg.uuid).toBe("string");
          expect(typeof userMsg.timestamp).toBe("string");
        }

        if (entry.type === "assistant") {
          const assistantMsg = entry as AssistantMessage;
          expect(assistantMsg.message).toBeDefined();
          expect(assistantMsg.message.role).toBe("assistant");
          expect(Array.isArray(assistantMsg.message.content)).toBe(true);
          expect(typeof assistantMsg.message.model).toBe("string");
          expect(assistantMsg.message.usage).toBeDefined();
          expect(typeof assistantMsg.message.usage.input_tokens).toBe("number");
          expect(typeof assistantMsg.message.usage.output_tokens).toBe("number");
          expect(typeof assistantMsg.requestId).toBe("string");
        }

        if (entry.type === "file-history-snapshot") {
          const snapshot = entry as {
            type: string;
            snapshot?: { trackedFileBackups?: unknown };
          };
          expect(snapshot.snapshot).toBeDefined();
          expect(snapshot.snapshot?.trackedFileBackups).toBeDefined();
        }

        entryCount++;
        // Limit to first 50 entries to keep test fast
        if (entryCount >= 50) break;
      }

      // Should have seen at least user and assistant messages
      expect(seenTypes.has("user")).toBe(true);
      expect(seenTypes.has("assistant")).toBe(true);
    });
  });

  describe("plans directory", () => {
    it("contains readable markdown files if plans exist", async () => {
      const plansDir = `${claudeDir}/plans`;

      try {
        await fs.stat(plansDir);
      } catch {
        // Plans directory is optional, skip gracefully
        console.log("Skipping plans validation: ~/.claude/plans not found");
        return;
      }

      let foundPlan = false;
      const planEntries = await fs.readdir(plansDir, { withFileTypes: true });
      for (const entry of planEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

        const content = await Bun.file(`${plansDir}/${entry.name}`).text();
        expect(typeof content).toBe("string");
        expect(content.length).toBeGreaterThan(0);

        foundPlan = true;
        break; // Only need to validate one
      }

      if (!foundPlan) {
        console.log("Plans directory exists but contains no .md files");
      }
    });
  });
});
