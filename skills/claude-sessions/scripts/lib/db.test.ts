import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { judgeRows } from "./judge/client.ts";
import { CURRENT_SCHEMA_VERSION, openDb } from "./db.ts";

async function withDbPath(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "db-test-"));
  const path = join(dir, "nested", "index.db");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createV3Database(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      last_line INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      dir TEXT PRIMARY KEY,
      decoded_path TEXT,
      cwd TEXT,
      last_activity TEXT,
      session_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_dir TEXT,
      cwd TEXT,
      git_branch TEXT,
      parent_session_id TEXT,
      agent_name TEXT,
      first_prompt TEXT,
      started_at TEXT,
      ended_at TEXT,
      models TEXT NOT NULL DEFAULT '[]',
      versions TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      interruption_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_sessions_project_dir ON sessions(project_dir);
    CREATE INDEX idx_sessions_parent_session_id ON sessions(parent_session_id);
    CREATE INDEX idx_sessions_session_id ON sessions(session_id);
    CREATE TABLE messages (
      uuid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_uuid TEXT,
      ts TEXT,
      type TEXT NOT NULL,
      role TEXT,
      text TEXT NOT NULL DEFAULT '',
      is_injected INTEGER NOT NULL DEFAULT 0,
      is_interrupt_marker INTEGER NOT NULL DEFAULT 0,
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      effort TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, uuid)
    );
    CREATE INDEX idx_messages_type ON messages(type);
    CREATE TABLE tool_calls (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL,
      ts TEXT,
      name TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      result_text TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      result_ts TEXT,
      latency_ms INTEGER,
      subagent_type TEXT,
      skill_name TEXT,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX idx_tool_calls_name ON tool_calls(name);
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='rowid'
    );
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE VIRTUAL TABLE tool_calls_fts USING fts5(
      input,
      result_text,
      content='tool_calls',
      content_rowid='rowid'
    );
    CREATE TRIGGER tool_calls_fts_ai AFTER INSERT ON tool_calls BEGIN
      INSERT INTO tool_calls_fts(rowid, input, result_text) VALUES (new.rowid, new.input, new.result_text);
    END;
    CREATE TRIGGER tool_calls_fts_ad AFTER DELETE ON tool_calls BEGIN
      INSERT INTO tool_calls_fts(tool_calls_fts, rowid, input, result_text) VALUES('delete', old.rowid, old.input, old.result_text);
    END;
    CREATE TRIGGER tool_calls_fts_au AFTER UPDATE ON tool_calls BEGIN
      INSERT INTO tool_calls_fts(tool_calls_fts, rowid, input, result_text) VALUES('delete', old.rowid, old.input, old.result_text);
      INSERT INTO tool_calls_fts(rowid, input, result_text) VALUES (new.rowid, new.input, new.result_text);
    END;
    PRAGMA user_version = 3;
  `);
  return db;
}

describe("openDb", () => {
  it("creates the database file and its parent directory", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      expect(await Bun.file(path).exists()).toBe(true);
      db.close();
    });
  });

  it("enables WAL journal mode", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
      db.close();
    });
  });

  it("sets user_version to the current schema version", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      const row = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
      db.close();
    });
  });

  it("creates every table from the plan's schema", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name)
        .filter((name) => !name.startsWith("sqlite_"));

      for (const expected of [
        "files",
        "projects",
        "sessions",
        "messages",
        "tool_calls",
        "judgments",
      ]) {
        expect(tables).toContain(expected);
      }
      db.close();
    });
  });

  it("is idempotent: opening an already-migrated database does not error", async () => {
    await withDbPath(async (path) => {
      const first = openDb(path);
      first.close();
      const second = openDb(path);
      const row = second.query("PRAGMA user_version").get() as { user_version: number };
      expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
      second.close();
    });
  });

  it("upgrades a v3 database and supports judgment cache reads and writes", async () => {
    await withDbPath(async (path) => {
      await mkdir(dirname(path), { recursive: true });
      const v3 = createV3Database(path);
      try {
        const version = v3.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(3);
        expect(v3.query("SELECT name FROM sqlite_master WHERE name = 'judgments'").get()).toBe(
          null,
        );
      } finally {
        v3.close();
      }

      const db = openDb(path);
      try {
        const version = db.query("PRAGMA user_version").get() as { user_version: number };
        expect(version.user_version).toBe(CURRENT_SCHEMA_VERSION);

        let calls = 0;
        const client = {
          systemOne: async () => {
            calls += 1;
            return {
              model: "jev-latest",
              answers: {
                kind: {
                  type: "choice",
                  choice: "correction",
                  confidence: 0.8,
                  probabilities: {
                    correction: 0.8,
                    clarification: 0.1,
                    new_task: 0.03,
                    approval: 0.02,
                    abort: 0.05,
                  },
                },
                wrong_way: { type: "noul", noul: 0.2 },
              },
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        } as unknown as TypeSafeClient;
        const first = await judgeRows([{ value: "cached" }], "steering", {
          db,
          apiKey: "test-key",
          client,
          diagnostic: () => undefined,
        });
        const second = await judgeRows([{ value: "cached" }], "steering", {
          db,
          apiKey: "test-key",
          client,
          diagnostic: () => undefined,
        });

        expect(first.rows_judged).toBe(1);
        expect(second.rows_cached).toBe(1);
        expect(second.rows_judged).toBe(0);
        expect(calls).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("indexes inserted message text for full-text search via messages_fts", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      db.run(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "m1",
          "s1",
          "2026-01-01T00:00:00.000Z",
          "user",
          "user",
          "find the needle in this haystack",
        ],
      );
      const rows = db
        .query(
          "SELECT uuid FROM messages_fts JOIN messages ON messages.rowid = messages_fts.rowid WHERE messages_fts MATCH 'needle'",
        )
        .all();
      expect(rows).toEqual([{ uuid: "m1" }]);
      db.close();
    });
  });

  it("indexes inserted tool_calls input and result_text via tool_calls_fts", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      db.run(
        `INSERT INTO tool_calls (id, session_id, message_uuid, name, input, result_text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["t1", "s1", "m1", "Bash", '{"command":"ls"}', "directory listing here"],
      );
      const rows = db
        .query(
          "SELECT id FROM tool_calls_fts JOIN tool_calls ON tool_calls.rowid = tool_calls_fts.rowid WHERE tool_calls_fts MATCH 'listing'",
        )
        .all();
      expect(rows).toEqual([{ id: "t1" }]);
      db.close();
    });
  });

  it("removes a message from the fts index when the row is deleted", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      db.run(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["m1", "s1", "2026-01-01T00:00:00.000Z", "user", "user", "ephemeral content"],
      );
      db.run("DELETE FROM messages WHERE session_id = ? AND uuid = ?", ["s1", "m1"]);
      const rows = db
        .query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'ephemeral'")
        .all();
      expect(rows).toEqual([]);
      db.close();
    });
  });

  it("keeps messages_fts in sync when a duplicate (session_id, uuid) is upserted with ON CONFLICT DO UPDATE", async () => {
    await withDbPath(async (path) => {
      // ingest.ts writes messages with INSERT ... ON CONFLICT DO UPDATE, not
      // INSERT OR REPLACE, because REPLACE deletes and re-inserts under the
      // hood without firing the AFTER DELETE trigger (recursive_triggers is
      // off), leaving messages_fts pointing at a rowid the REPLACE
      // discarded. A true UPDATE fires the AFTER UPDATE trigger and keeps
      // the row's rowid stable, so the fts index never desyncs.
      const db = openDb(path);
      const upsert = db.query(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, uuid) DO UPDATE SET text = excluded.text`,
      );
      upsert.run("m1", "s1", "2026-01-01T00:00:00.000Z", "user", "user", "first draft haystack");
      upsert.run("m1", "s1", "2026-01-01T00:00:01.000Z", "user", "user", "second draft needle");

      const stale = db
        .query("SELECT rowid, text FROM messages_fts WHERE messages_fts MATCH 'haystack'")
        .all();
      expect(stale).toEqual([]);

      const fresh = db
        .query("SELECT rowid, text FROM messages_fts WHERE messages_fts MATCH 'needle'")
        .all();
      expect(fresh).toEqual([{ rowid: 1, text: "second draft needle" }]);
      db.close();
    });
  });

  it("keeps rows from two sessions that reuse the same message uuid", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      db.run(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["m1", "s1", "2026-01-01T00:00:00.000Z", "user", "user", "first session text"],
      );
      db.run(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["m1", "s2", "2026-01-01T00:00:01.000Z", "user", "user", "second session text"],
      );
      const rows = db
        .query("SELECT session_id, text FROM messages WHERE uuid = ? ORDER BY session_id")
        .all("m1");
      expect(rows).toEqual([
        { session_id: "s1", text: "first session text" },
        { session_id: "s2", text: "second session text" },
      ]);
      db.close();
    });
  });

  it("repairs a v1 database whose messages/tool_calls used a global primary key", async () => {
    await withDbPath(async (path) => {
      // Build a legacy v1 database by hand: `uuid`/`id` were the whole
      // primary key, so two sessions could not both keep a row for the
      // same uuid or tool_use id.
      await mkdir(dirname(path), { recursive: true });
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, last_line INTEGER, session_id TEXT, parent_session_id TEXT, ingested_at TEXT);
        CREATE TABLE messages (uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '');
        CREATE TABLE tool_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, result_text TEXT);
        PRAGMA user_version = 1;
      `);
      legacy.run(`INSERT INTO messages (uuid, session_id, text) VALUES ('m1', 's1', 'stale')`);
      legacy.close();

      const db = openDb(path);
      const version = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(CURRENT_SCHEMA_VERSION);

      // The repair drops and recreates the derived tables; the stale row is gone.
      const count = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };
      expect(count.n).toBe(0);

      // The composite primary key now lets two sessions share a uuid.
      db.run(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["m1", "s1", "2026-01-01T00:00:00.000Z", "user", "user", "session one"],
      );
      db.run(
        `INSERT INTO messages (uuid, session_id, ts, type, role, text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["m1", "s2", "2026-01-01T00:00:01.000Z", "user", "user", "session two"],
      );
      const rows = db
        .query("SELECT session_id, text FROM messages WHERE uuid = ? ORDER BY session_id")
        .all("m1");
      expect(rows).toEqual([
        { session_id: "s1", text: "session one" },
        { session_id: "s2", text: "session two" },
      ]);
      db.close();
    });
  });

  it("keeps tool_calls rows from two sessions that reuse the same tool_use id", async () => {
    await withDbPath(async (path) => {
      const db = openDb(path);
      db.run(
        `INSERT INTO tool_calls (id, session_id, message_uuid, name, input, result_text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["t1", "s1", "m1", "Bash", '{"command":"ls"}', "s1 result"],
      );
      db.run(
        `INSERT INTO tool_calls (id, session_id, message_uuid, name, input, result_text) VALUES (?, ?, ?, ?, ?, ?)`,
        ["t1", "s2", "m2", "Read", '{"file_path":"/x"}', "s2 result"],
      );
      const rows = db
        .query("SELECT session_id, result_text FROM tool_calls WHERE id = ? ORDER BY session_id")
        .all("t1");
      expect(rows).toEqual([
        { session_id: "s1", result_text: "s1 result" },
        { session_id: "s2", result_text: "s2 result" },
      ]);
      db.close();
    });
  });
});
