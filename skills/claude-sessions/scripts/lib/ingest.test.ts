import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { sessionKey, sync } from "./ingest.ts";

const PROJECT_DIR = "-Users-test-myapp";
const s1 = sessionKey(PROJECT_DIR, "s1");
const s2 = sessionKey(PROJECT_DIR, "s2");

interface Ctx {
  root: string;
  db: Database;
}

async function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ingest-test-"));
  const db = openDb(":memory:");
  try {
    await fn({ root, db });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSession(
  root: string,
  projectDir: string,
  sessionId: string,
  lines: unknown[],
): Promise<string> {
  const projectPath = join(root, projectDir);
  await mkdir(projectPath, { recursive: true });
  const path = join(projectPath, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

interface StoredCounts {
  message_count: number;
  tool_call_count: number;
  error_count: number;
}

function readStoredCounts(db: Database, sessionId: string): StoredCounts {
  return db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE session_id = ?) as message_count,
         (SELECT COUNT(*) FROM tool_calls WHERE session_id = ?) as tool_call_count,
         (SELECT COUNT(*) FROM tool_calls WHERE session_id = ? AND is_error = 1) as error_count`,
    )
    .get(sessionId, sessionId, sessionId) as StoredCounts;
}

function userRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "s1",
    cwd: "/Users/test/myapp",
    version: "2.1.0",
    gitBranch: "main",
    message: { role: "user", content: "hello" },
    ...overrides,
  };
}

function assistantRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    parentUuid: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    sessionId: "s1",
    version: "2.1.0",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    ...overrides,
  };
}

function toolResultBlock(result: string, isError: boolean): unknown[] {
  return [{ type: "tool_result", tool_use_id: "shared-tool", content: result, is_error: isError }];
}

describe("sync", () => {
  it("indexes a user record with plain string content", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [userRecord({ uuid: "u1" })]);
      const summary = await sync({ root, db });
      expect(summary.added).toBe(1);

      const row = db.query("SELECT text, type FROM messages WHERE uuid = ?").get("u1") as {
        text: string;
        type: string;
      };
      expect(row).toEqual({ text: "hello", type: "user" });
    });
  });

  it("indexes an assistant record with block array content", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [assistantRecord({ uuid: "a1" })]);
      await sync({ root, db });

      const row = db.query("SELECT text, model FROM messages WHERE uuid = ?").get("a1") as {
        text: string;
        model: string;
      };
      expect(row).toEqual({ text: "hi", model: "claude-opus-4-7" });
    });
  });

  it("counts and skips a malformed line without failing the sync", async () => {
    await withCtx(async ({ root, db }) => {
      const path = await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({ uuid: "u1" }),
      ]);
      await appendFile(path, "not json at all\n");
      await appendFile(path, JSON.stringify(userRecord({ uuid: "u2" })) + "\n");

      const summary = await sync({ root, db });
      expect(summary.malformedLines).toBe(1);

      const count = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(count.n).toBe(2);
    });
  });

  it("links a subagent transcript to its parent session and agent name", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [userRecord({ uuid: "u1" })]);

      const subagentsDir = join(root, "-Users-test-myapp", "s1", "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await writeFile(
        join(subagentsDir, "agent-abc123.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "sub-u1",
          sessionId: "s1",
          agentId: "abc123",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "review this" },
        }) + "\n",
      );
      await writeFile(
        join(subagentsDir, "agent-abc123.meta.json"),
        JSON.stringify({ agentType: "general-purpose" }),
      );

      await sync({ root, db });

      const session = db
        .query("SELECT parent_session_id, agent_name FROM sessions WHERE id = ?")
        .get(sessionKey(PROJECT_DIR, "abc123")) as {
        parent_session_id: string;
        agent_name: string;
      };
      expect(session).toEqual({ parent_session_id: s1, agent_name: "general-purpose" });
    });
  });

  it("re-ingests only the new lines when a file grows", async () => {
    await withCtx(async ({ root, db }) => {
      const path = await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({ uuid: "u1" }),
      ]);
      const first = await sync({ root, db });
      expect(first.added).toBe(1);

      await appendFile(
        path,
        [
          assistantRecord({
            uuid: "a2",
            timestamp: "2026-01-01T00:00:05.000Z",
            message: {
              role: "assistant",
              model: "claude-opus-4-7",
              content: [
                { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } },
              ],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          }),
          userRecord({
            uuid: "u2",
            timestamp: "2026-01-01T00:00:06.000Z",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_2",
                  content: "not found",
                  is_error: true,
                },
              ],
            },
          }),
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      const second = await sync({ root, db });
      expect(second.updated).toBe(1);
      expect(second.added).toBe(0);

      const stored = readStoredCounts(db, s1);
      expect(stored).toEqual({ message_count: 3, tool_call_count: 1, error_count: 1 });

      const session = db
        .query("SELECT message_count, tool_call_count, error_count FROM sessions WHERE id = ?")
        .get(s1) as StoredCounts;
      expect(session).toEqual(stored);

      const freshDb = openDb(":memory:");
      try {
        await sync({ root, db: freshDb });
        const fresh = freshDb
          .query("SELECT message_count, tool_call_count, error_count FROM sessions WHERE id = ?")
          .get(s1) as StoredCounts;
        expect(session).toEqual(fresh);
      } finally {
        freshDb.close();
      }
    });
  });

  it("fully re-ingests a rewritten file with the same size but a new mtime", async () => {
    await withCtx(async ({ root, db }) => {
      const path = await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({ uuid: "u1", message: { role: "user", content: "aaaaa" } }),
      ]);
      await sync({ root, db });

      // Same length, different uuid and content: same size, different mtime.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(
        path,
        JSON.stringify(userRecord({ uuid: "u2", message: { role: "user", content: "bbbbb" } })) +
          "\n",
      );
      const second = await sync({ root, db });
      expect(second.updated).toBe(1);

      const count = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(count.n).toBe(1);

      const row = db.query("SELECT uuid FROM messages").get() as { uuid: string };
      expect(row.uuid).toBe("u2");

      const rebuilt = db
        .query("SELECT message_count, tool_call_count, error_count FROM sessions WHERE id = ?")
        .get(s1) as StoredCounts;
      const stored = readStoredCounts(db, s1);
      expect(rebuilt).toEqual(stored);

      const freshDb = openDb(":memory:");
      try {
        await sync({ root, db: freshDb });
        const fresh = freshDb
          .query("SELECT message_count, tool_call_count, error_count FROM sessions WHERE id = ?")
          .get(s1) as StoredCounts;
        expect(rebuilt).toEqual(fresh);
      } finally {
        freshDb.close();
      }
    });
  });

  it("does not re-ingest an unchanged file on a second sync", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [userRecord({ uuid: "u1" })]);
      await sync({ root, db });
      const second = await sync({ root, db });
      expect(second.added).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.unchanged).toBe(1);
    });
  });

  it("removes a file's rows when it disappears from disk", async () => {
    await withCtx(async ({ root, db }) => {
      const path = await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({ uuid: "u1" }),
      ]);
      await sync({ root, db });
      await rm(path);

      const summary = await sync({ root, db });
      expect(summary.removed).toBe(1);

      const count = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(count.n).toBe(0);
    });
  });

  it("does not store control and noise records as conversational messages", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        { type: "mode", uuid: "mode" },
        { type: "permission-mode", uuid: "permission-mode" },
        { type: "file-history-delta", uuid: "file-history-delta" },
        { type: "bridge-session", uuid: "bridge-session" },
        { type: "agent-name", uuid: "agent-name" },
        { type: "relocated", uuid: "relocated" },
        { type: "progress", uuid: "progress" },
        {
          type: "attachment",
          uuid: "attachment",
          rendered: [{ content: "<system-reminder>attachment noise</system-reminder>" }],
        },
        { type: "last-prompt", uuid: "last-prompt", lastPrompt: "last prompt noise" },
        userRecord({ uuid: "u1", message: { role: "user", content: "real prompt" } }),
      ]);
      await sync({ root, db });

      const rows = db
        .query("SELECT type, uuid FROM messages WHERE session_id = ? ORDER BY rowid")
        .all(s1) as Array<{ type: string; uuid: string }>;
      expect(rows).toEqual([{ type: "user", uuid: "u1" }]);

      const session = db.query("SELECT message_count FROM sessions WHERE id = ?").get(s1) as {
        message_count: number;
      };
      expect(session.message_count).toBe(1);
    });
  });

  it("flags text carrying an injected-block tag", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({
          uuid: "u1",
          message: { role: "user", content: "<system-reminder>ignore this</system-reminder>" },
        }),
      ]);
      await sync({ root, db });

      const row = db.query("SELECT is_injected FROM messages WHERE uuid = ?").get("u1") as {
        is_injected: number;
      };
      expect(row.is_injected).toBe(1);
    });
  });

  it("flags an interrupt marker", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({
          uuid: "u1",
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
          },
        }),
      ]);
      await sync({ root, db });

      const row = db.query("SELECT is_interrupt_marker FROM messages WHERE uuid = ?").get("u1") as {
        is_interrupt_marker: number;
      };
      expect(row.is_interrupt_marker).toBe(1);
      const session = db.query("SELECT interruption_count FROM sessions WHERE id = ?").get(s1) as {
        interruption_count: number;
      };
      expect(session.interruption_count).toBe(1);
    });
  });

  it("pairs a tool_result to its tool_use and computes latency", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        assistantRecord({
          uuid: "a1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        userRecord({
          uuid: "u1",
          timestamp: "2026-01-01T00:00:02.500Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "file1\nfile2",
                is_error: false,
              },
            ],
          },
        }),
      ]);
      await sync({ root, db });

      const row = db
        .query("SELECT name, result_text, is_error, latency_ms FROM tool_calls WHERE id = ?")
        .get("toolu_1") as {
        name: string;
        result_text: string;
        is_error: number;
        latency_ms: number;
      };
      expect(row).toEqual({
        name: "Bash",
        result_text: "file1\nfile2",
        is_error: 0,
        latency_ms: 2500,
      });

      const session = db
        .query("SELECT tool_call_count, error_count FROM sessions WHERE id = ?")
        .get(s1) as {
        tool_call_count: number;
        error_count: number;
      };
      expect(session).toEqual({ tool_call_count: 1, error_count: 0 });
    });
  });

  it("stores Task subagent_type and Skill skill_name from tool inputs", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        assistantRecord({
          uuid: "a1",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              {
                type: "tool_use",
                id: "task-1",
                name: "Task",
                input: { subagent_type: "Explore", prompt: "inspect this" },
              },
              {
                type: "tool_use",
                id: "skill-1",
                name: "Skill",
                input: { skill: "grilling", args: "stress test this" },
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ]);
      await sync({ root, db });

      const rows = db
        .query(
          "SELECT name, subagent_type, skill_name FROM tool_calls WHERE session_id = ? ORDER BY name",
        )
        .all(s1) as Array<{
        name: string;
        subagent_type: string | null;
        skill_name: string | null;
      }>;
      expect(rows).toEqual([
        { name: "Skill", subagent_type: null, skill_name: "grilling" },
        { name: "Task", subagent_type: "Explore", skill_name: null },
      ]);
    });
  });

  it("counts an errored tool_result against the session's error_count", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        assistantRecord({
          uuid: "a1",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        userRecord({
          uuid: "u1",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "not found", is_error: true },
            ],
          },
        }),
      ]);
      await sync({ root, db });

      const session = db.query("SELECT error_count FROM sessions WHERE id = ?").get(s1) as {
        error_count: number;
      };
      expect(session.error_count).toBe(1);
    });
  });

  it("computes sessions aggregates: first prompt, span, models, versions, counts, usage", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({
          uuid: "u1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "first real prompt" },
        }),
        assistantRecord({ uuid: "a1", timestamp: "2026-01-01T00:05:00.000Z" }),
      ]);
      await sync({ root, db });

      const session = db.query("SELECT * FROM sessions WHERE id = ?").get(s1) as Record<
        string,
        unknown
      >;
      expect(session.first_prompt).toBe("first real prompt");
      expect(session.started_at).toBe("2026-01-01T00:00:00.000Z");
      expect(session.ended_at).toBe("2026-01-01T00:05:00.000Z");
      expect(JSON.parse(session.models as string)).toEqual(["claude-opus-4-7"]);
      expect(JSON.parse(session.versions as string)).toEqual(["2.1.0"]);
      expect(session.message_count).toBe(2);
      expect(session.input_tokens).toBe(10);
      expect(session.output_tokens).toBe(5);
    });
  });

  it("skips an injected or interrupted user record when choosing the first prompt", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({
          uuid: "u0",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "<system-reminder>noise</system-reminder>" },
        }),
        userRecord({
          uuid: "u1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "the real question" },
        }),
      ]);
      await sync({ root, db });

      const session = db.query("SELECT first_prompt FROM sessions WHERE id = ?").get(s1) as {
        first_prompt: string;
      };
      expect(session.first_prompt).toBe("the real question");
    });
  });

  it("scopes sync to project dirs matching a --projects substring", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [userRecord({ uuid: "u1" })]);
      await writeSession(root, "-Users-test-other", "s2", [userRecord({ uuid: "u2" })]);

      const summary = await sync({ root, db, projects: ["myapp"] });
      expect(summary.scanned).toBe(1);
      expect(summary.added).toBe(1);

      const count = db.query("SELECT COUNT(*) as n FROM sessions").get() as { n: number };
      expect(count.n).toBe(1);
    });
  });

  it("calls the progress callback with the final file count", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [userRecord({ uuid: "u1" })]);
      await writeSession(root, "-Users-test-myapp", "s2", [userRecord({ uuid: "u2" })]);

      const calls: Array<{ filesProcessed: number; totalFiles: number }> = [];
      await sync({ root, db, progressEvery: 1, onProgress: (info) => calls.push(info) });

      expect(calls[calls.length - 1]).toEqual({ filesProcessed: 2, totalFiles: 2 });
    });
  });

  it("updates the projects table with session count and last activity", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({ uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z" }),
      ]);
      await writeSession(root, "-Users-test-myapp", "s2", [
        userRecord({ uuid: "u2", sessionId: "s2", timestamp: "2026-01-02T00:00:00.000Z" }),
      ]);

      await sync({ root, db });

      const project = db
        .query("SELECT session_count, cwd FROM projects WHERE dir = ?")
        .get("-Users-test-myapp") as {
        session_count: number;
        cwd: string;
      };
      expect(project.session_count).toBe(2);
      expect(project.cwd).toBe("/Users/test/myapp");
    });
  });

  it("keeps each session's rows separate when two sessions reuse the same record uuid", async () => {
    await withCtx(async ({ root, db }) => {
      // Claude Code reuses uuids/tool_use ids across a resumed or forked
      // session's files. Both sessions must keep their own row for the
      // shared uuid, not steal or delete each other's.
      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({
          uuid: "shared-uuid",
          sessionId: "s1",
          message: { role: "user", content: "from s1" },
        }),
      ]);
      await writeSession(root, "-Users-test-myapp", "s2", [
        userRecord({
          uuid: "shared-uuid",
          sessionId: "s2",
          message: { role: "user", content: "from s2" },
        }),
      ]);

      await sync({ root, db });

      const rows = db
        .query("SELECT session_id, text FROM messages WHERE uuid = ? ORDER BY session_id")
        .all("shared-uuid") as Array<{ session_id: string; text: string }>;
      expect(rows).toEqual([
        { session_id: s1, text: "from s1" },
        { session_id: s2, text: "from s2" },
      ]);

      // A full re-ingest (same size, new mtime) of one session must not
      // delete the other session's row for the same uuid.
      const path = join(root, "-Users-test-myapp", "s1.jsonl");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(
        path,
        JSON.stringify(
          userRecord({
            uuid: "shared-uuid",
            sessionId: "s1",
            message: { role: "user", content: "s1 fix2" }, // same length as "from s1"
          }),
        ) + "\n",
      );
      await sync({ root, db });

      const rowsAfter = db
        .query("SELECT session_id, text FROM messages WHERE uuid = ? ORDER BY session_id")
        .all("shared-uuid") as Array<{ session_id: string; text: string }>;
      expect(rowsAfter).toEqual([
        { session_id: s1, text: "s1 fix2" },
        { session_id: s2, text: "from s2" },
      ]);
    });
  });

  it("pairs a tool_result to the tool_use in its own session when both sessions reuse the same tool id", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [
        assistantRecord({
          uuid: "a1",
          sessionId: "s1",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              { type: "tool_use", id: "shared-tool", name: "Bash", input: { command: "ls" } },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        userRecord({
          uuid: "u1",
          sessionId: "s1",
          message: { role: "user", content: toolResultBlock("s1 result", false) },
        }),
      ]);
      await writeSession(root, "-Users-test-myapp", "s2", [
        assistantRecord({
          uuid: "a2",
          sessionId: "s2",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              { type: "tool_use", id: "shared-tool", name: "Read", input: { file_path: "/x" } },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        userRecord({
          uuid: "u2",
          sessionId: "s2",
          message: { role: "user", content: toolResultBlock("s2 result", true) },
        }),
      ]);

      await sync({ root, db });

      const rows = db
        .query(
          "SELECT session_id, name, result_text, is_error FROM tool_calls WHERE id = ? ORDER BY session_id",
        )
        .all("shared-tool") as Array<{
        session_id: string;
        name: string;
        result_text: string;
        is_error: number;
      }>;
      expect(rows).toEqual([
        { session_id: s1, name: "Bash", result_text: "s1 result", is_error: 0 },
        { session_id: s2, name: "Read", result_text: "s2 result", is_error: 1 },
      ]);
    });
  });

  it("refuses to prune the index when the corpus root has no project directories", async () => {
    await withCtx(async ({ root, db }) => {
      await writeSession(root, "-Users-test-myapp", "s1", [userRecord({ uuid: "u1" })]);
      await sync({ root, db });

      const beforeCount = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(beforeCount.n).toBe(1);

      await expect(sync({ root: join(root, "does-not-exist"), db })).rejects.toThrow();

      const afterCount = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(afterCount.n).toBe(1);
    });
  });

  it("keeps both files' rows when two project dirs share the same raw session id, including after a same-size rewrite of one", async () => {
    await withCtx(async ({ root, db }) => {
      // A relocated project or moved worktree can leave the same raw
      // session id as a .jsonl filename in two different project dirs.
      // Filenames are unique within one dir, so the two files hold
      // disjoint content and must never share a database row.
      const pathA = await writeSession(root, "-Users-test-dirA", "dup-id", [
        userRecord({ uuid: "au1", message: { role: "user", content: "from dir A" } }),
      ]);
      await writeSession(root, "-Users-test-dirB", "dup-id", [
        userRecord({ uuid: "bu1", message: { role: "user", content: "from dir B" } }),
      ]);

      await sync({ root, db });

      const dirAKey = sessionKey("-Users-test-dirA", "dup-id");
      const dirBKey = sessionKey("-Users-test-dirB", "dup-id");

      const before = db
        .query("SELECT session_id, text FROM messages ORDER BY session_id")
        .all() as Array<{ session_id: string; text: string }>;
      expect(before).toEqual([
        { session_id: dirAKey, text: "from dir A" },
        { session_id: dirBKey, text: "from dir B" },
      ]);

      // Same size, new mtime: triggers a full re-ingest of dir A's file
      // only. The old raw-session-id key would have cleared dir B's rows
      // too, since both files shared the id "dup-id".
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(
        pathA,
        JSON.stringify(
          userRecord({ uuid: "au2", message: { role: "user", content: "from dir C" } }),
        ) + "\n",
      );
      const second = await sync({ root, db });
      expect(second.updated).toBe(1);

      const after = db
        .query("SELECT session_id, text FROM messages ORDER BY session_id")
        .all() as Array<{ session_id: string; text: string }>;
      expect(after).toEqual([
        { session_id: dirAKey, text: "from dir C" },
        { session_id: dirBKey, text: "from dir B" },
      ]);

      const sessions = db.query("SELECT id, project_dir FROM sessions ORDER BY id").all() as Array<{
        id: string;
        project_dir: string;
      }>;
      expect(sessions).toEqual([
        { id: dirAKey, project_dir: "-Users-test-dirA" },
        { id: dirBKey, project_dir: "-Users-test-dirB" },
      ]);
    });
  });

  it("keeps messages_fts queryable after a file repeats a record uuid on tail growth", async () => {
    await withCtx(async ({ root, db }) => {
      // Resumed/continued sessions rewrite earlier history further down in
      // the same file. INSERT OR REPLACE does not fire the AFTER DELETE
      // trigger unless recursive_triggers is on, so a duplicate uuid used
      // to leave messages_fts pointing at a rowid the REPLACE discarded:
      // querying messages_fts would then throw "missing row ... from
      // content table" instead of returning the current text.
      const path = await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({
          uuid: "dup-uuid",
          message: { role: "user", content: "first draft haystack" },
        }),
      ]);
      await sync({ root, db });

      await appendFile(
        path,
        JSON.stringify(
          userRecord({
            uuid: "dup-uuid",
            timestamp: "2026-01-01T00:00:05.000Z",
            message: { role: "user", content: "second draft needle" },
          }),
        ) + "\n",
      );
      await sync({ root, db });

      const stale = db
        .query("SELECT rowid, text FROM messages_fts WHERE messages_fts MATCH 'haystack'")
        .all();
      expect(stale).toEqual([]);

      const fresh = db
        .query("SELECT rowid, text FROM messages_fts WHERE messages_fts MATCH 'needle'")
        .all() as Array<{ rowid: number; text: string }>;
      expect(fresh.length).toBe(1);
      expect(fresh[0]?.text).toBe("second draft needle");

      const row = db
        .query("SELECT text FROM messages WHERE session_id = ? AND uuid = ?")
        .get(s1, "dup-uuid") as { text: string };
      expect(row.text).toBe("second draft needle");
    });
  });

  it("counts stored rows when a file repeats message and tool ids", async () => {
    await withCtx(async ({ root, db }) => {
      const repeatedToolUse = (timestamp: string) =>
        assistantRecord({
          uuid: "dup-assistant",
          timestamp,
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [
              {
                type: "tool_use",
                id: "dup-tool",
                name: "Read",
                input: { file_path: "/missing" },
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        });
      const repeatedToolResult = (timestamp: string) =>
        userRecord({
          uuid: "dup-result",
          timestamp,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "dup-tool",
                content: "not found",
                is_error: true,
              },
            ],
          },
        });

      await writeSession(root, "-Users-test-myapp", "s1", [
        userRecord({ uuid: "dup-uuid", message: { role: "user", content: "v1" } }),
        userRecord({
          uuid: "dup-uuid",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "v2" },
        }),
        repeatedToolUse("2026-01-01T00:00:02.000Z"),
        repeatedToolUse("2026-01-01T00:00:03.000Z"),
        repeatedToolResult("2026-01-01T00:00:04.000Z"),
        repeatedToolResult("2026-01-01T00:00:05.000Z"),
      ]);
      await sync({ root, db });

      const stored = readStoredCounts(db, s1);
      expect(stored).toEqual({ message_count: 3, tool_call_count: 1, error_count: 1 });

      const session = db
        .query("SELECT message_count, tool_call_count, error_count FROM sessions WHERE id = ?")
        .get(s1) as StoredCounts;
      expect(session).toEqual(stored);
    });
  });
});
