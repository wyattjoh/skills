import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCorpus, discoverProjectDirs, discoverProjectFiles } from "./corpus.ts";

async function withCorpus(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "corpus-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildSampleCorpus(root: string): Promise<void> {
  const projectDir = "-Users-test-myapp";
  const projectPath = join(root, projectDir);
  await mkdir(projectPath, { recursive: true });

  await writeFile(join(projectPath, "session-a.jsonl"), '{"type":"user"}\n');
  await writeFile(join(projectPath, "session-b.jsonl"), '{"type":"user"}\n');

  const subagentsDir = join(projectPath, "session-a", "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(join(subagentsDir, "agent-abc123.jsonl"), '{"type":"user"}\n');
  await writeFile(join(subagentsDir, "agent-abc123.meta.json"), '{"agentType":"general-purpose"}');
}

describe("discoverProjectDirs", () => {
  it("lists project directories sorted by name", async () => {
    await withCorpus(async (root) => {
      await mkdir(join(root, "-Users-b-project"), { recursive: true });
      await mkdir(join(root, "-Users-a-project"), { recursive: true });
      const dirs = await discoverProjectDirs(root);
      expect(dirs.map((d) => d.dir)).toEqual(["-Users-a-project", "-Users-b-project"]);
    });
  });

  it("returns an empty array when the root does not exist", async () => {
    await withCorpus(async (root) => {
      const dirs = await discoverProjectDirs(join(root, "nonexistent"));
      expect(dirs).toEqual([]);
    });
  });

  it("ignores non-directory entries", async () => {
    await withCorpus(async (root) => {
      await writeFile(join(root, "stray-file.txt"), "hi");
      await mkdir(join(root, "-Users-a-project"), { recursive: true });
      const dirs = await discoverProjectDirs(root);
      expect(dirs.map((d) => d.dir)).toEqual(["-Users-a-project"]);
    });
  });
});

describe("discoverProjectFiles", () => {
  it("lists top-level session files and nested subagent transcripts", async () => {
    await withCorpus(async (root) => {
      await buildSampleCorpus(root);
      const projectDir = "-Users-test-myapp";
      const files = await discoverProjectFiles(projectDir, join(root, projectDir));

      const sessions = files.filter((f) => f.kind === "session");
      const subagents = files.filter((f) => f.kind === "subagent");

      expect(sessions.map((f) => f.sessionId).toSorted()).toEqual(["session-a", "session-b"]);
      expect(subagents.map((f) => f.sessionId)).toEqual(["abc123"]);
      expect(subagents[0]?.parentSessionId).toBe("session-a");
      expect(subagents[0]?.metaPath).toBe(
        join(root, projectDir, "session-a", "subagents", "agent-abc123.meta.json"),
      );
    });
  });

  it("exposes size and mtime for each file", async () => {
    await withCorpus(async (root) => {
      const projectDir = "-Users-test-myapp";
      const projectPath = join(root, projectDir);
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, "session-a.jsonl"), '{"type":"user"}\n');

      const files = await discoverProjectFiles(projectDir, projectPath);
      expect(files).toHaveLength(1);
      expect(files[0]?.size).toBe(16);
      expect(typeof files[0]?.mtimeMs).toBe("number");
    });
  });

  it("returns an empty array for a subagent transcript with no meta.json", async () => {
    await withCorpus(async (root) => {
      const projectDir = "-Users-test-myapp";
      const projectPath = join(root, projectDir);
      const subagentsDir = join(projectPath, "session-a", "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await writeFile(join(subagentsDir, "agent-noMeta.jsonl"), '{"type":"user"}\n');

      const files = await discoverProjectFiles(projectDir, projectPath);
      expect(files).toHaveLength(1);
      expect(files[0]?.metaPath).toBeUndefined();
    });
  });
});

describe("discoverCorpus", () => {
  it("combines files across every project directory", async () => {
    await withCorpus(async (root) => {
      await buildSampleCorpus(root);
      await mkdir(join(root, "-Users-test-other"), { recursive: true });
      await writeFile(join(root, "-Users-test-other", "session-c.jsonl"), '{"type":"user"}\n');

      const files = await discoverCorpus(root);
      expect(files.map((f) => f.sessionId).toSorted()).toEqual([
        "abc123",
        "session-a",
        "session-b",
        "session-c",
      ]);
    });
  });
});
