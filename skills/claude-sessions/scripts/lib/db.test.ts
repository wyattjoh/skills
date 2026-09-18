import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
