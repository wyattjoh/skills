/**
 * Open and migrate the sqlite index at ~/.cache/claude-sessions/index.db
 * (overridable via CLAUDE_SESSIONS_DB, mainly for tests). WAL mode,
 * migrations tracked by `PRAGMA user_version`.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Return the default on-disk index path under the user's cache directory.
 *
 * @returns The default database path.
 */
export function defaultDbPath(): string {
  return join(homedir(), ".cache", "claude-sessions", "index.db");
}

/**
 * Resolve the index path, honoring the test and deployment override.
 *
 * @returns The configured database path.
 */
export function resolveDbPath(): string {
  return process.env.CLAUDE_SESSIONS_DB || defaultDbPath();
}

interface Migration {
  version: number;
  up: (db: Database) => void;
}

/**
 * Drop every table, trigger, and FTS index derived from the on-disk corpus.
 * Shared by repair migrations: the index is fully derived from
 * ~/.claude/projects, so the safe way to change how a row is keyed is to
 * drop the derived tables and let the next sync fully re-ingest, rather than
 * try to migrate rows in place.
 */
function dropDerivedTables(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    DROP TRIGGER IF EXISTS tool_calls_fts_ai;
    DROP TRIGGER IF EXISTS tool_calls_fts_ad;
    DROP TRIGGER IF EXISTS tool_calls_fts_au;
    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS tool_calls_fts;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS tool_calls;
    DROP TABLE IF EXISTS judgments;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS files;
  `);
}

/**
 * Create every table, index, and FTS trigger from scratch. Shared by the
 * initial migration and by repair migrations that drop and rebuild the
 * schema, so both always agree on the current shape.
 */
function createSchema(db: Database): void {
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
          project_identity TEXT,
          decoded_path TEXT,
          cwd TEXT,
          last_activity TEXT,
          session_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX idx_projects_identity ON projects(project_identity);

        -- id is "<project_dir>:<session_id>" (see ingest.ts sessionKey()),
        -- not the raw JSONL session id: that id is only unique within one
        -- project directory, and the same id can appear in two different
        -- project directories for an unrelated session. session_id below
        -- keeps the raw, human-visible id for display and filtering.
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_dir TEXT,
          project_identity TEXT,
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
        CREATE INDEX idx_sessions_project_identity ON sessions(project_identity);
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

        CREATE TABLE judgments (
          model TEXT NOT NULL,
          preset TEXT NOT NULL,
          question_hash TEXT NOT NULL,
          state_hash TEXT NOT NULL,
          answer TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (model, preset, question_hash, state_hash)
        );

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
  `);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => createSchema(db),
  },
  {
    // Repairs a v1 database created before messages.uuid and tool_calls.id
    // were scoped to (session_id, uuid/id). Under the old global primary
    // key, a resumed or forked session that reused a record uuid or
    // tool_use id silently overwrote (INSERT OR REPLACE) or deleted
    // (session-scoped DELETE racing a global PK) another session's rows.
    // The index is fully derived from the on-disk corpus, so the safe fix
    // is to drop every derived table, including `files`, and let the next
    // sync fully re-ingest: resetting only messages/tool_calls would leave
    // `files.last_line` pointing past data that no longer exists, so an
    // incremental sync would see those files as unchanged and never
    // refill them.
    version: 2,
    up: (db) => {
      dropDerivedTables(db);
      createSchema(db);
    },
  },
  {
    // Two fixes that both require re-deriving the index from disk:
    //
    // 1. ingest.ts used to key sessions/messages/tool_calls rows on the raw
    //    session id alone. That id is only unique within one project
    //    directory (filenames within a directory can't collide), but the
    //    same raw session id can legitimately appear as a .jsonl file in two
    //    different project directories (a relocated project or worktree
    //    move): verified 63 such ids in the real corpus, with disjoint
    //    content. ingest.ts now keys every row by
    //    `<project_dir>:<raw session id>` (see sessionKey() there) so two
    //    files can never share a key. `sessions.session_id` is added here to
    //    keep the raw id available for display/filtering.
    // 2. ingest.ts used to write messages/tool_calls with `INSERT OR
    //    REPLACE`, which SQLite treats as DELETE+INSERT but does NOT fire
    //    the AFTER DELETE trigger unless `PRAGMA recursive_triggers` is on
    //    (off by default). Real session files that repeat a uuid or
    //    tool_use id (resumed/continued sessions rewrite earlier history
    //    into the same file) left the messages_fts/tool_calls_fts external
    //    content index pointing at rows REPLACE had discarded, so
    //    `messages_fts`/`tool_calls_fts` queries intermittently threw
    //    "missing row from content table" or "database disk image is
    //    malformed". ingest.ts now uses `INSERT ... ON CONFLICT DO UPDATE`,
    //    a true SQL UPDATE that the existing AFTER UPDATE trigger handles
    //    correctly.
    //
    // Both are only fixed going forward by ingest.ts; a database already
    // built under the old scheme needs a full re-ingest to repair its keys
    // and its FTS index, so this drops every derived table again.
    version: 3,
    up: (db) => {
      dropDerivedTables(db);
      createSchema(db);
    },
  },
  {
    // v3 databases created before judgment caching do not have the table,
    // even though fresh schemas include it in createSchema().
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS judgments (
          model TEXT NOT NULL,
          preset TEXT NOT NULL,
          question_hash TEXT NOT NULL,
          state_hash TEXT NOT NULL,
          answer TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (model, preset, question_hash, state_hash)
        )
      `);
    },
  },
  {
    // Project filters now use a canonical real primary-repository root.
    // Existing rows remain readable without a project filter; a fresh sync
    // populates identities for resolvable repositories.
    version: 5,
    up: (db) => {
      const projectColumns = db.query("PRAGMA table_info(projects)").all() as Array<{
        name: string;
      }>;
      const sessionColumns = db.query("PRAGMA table_info(sessions)").all() as Array<{
        name: string;
      }>;
      if (!projectColumns.some((column) => column.name === "project_identity")) {
        db.exec("ALTER TABLE projects ADD COLUMN project_identity TEXT");
      }
      if (!sessionColumns.some((column) => column.name === "project_identity")) {
        db.exec("ALTER TABLE sessions ADD COLUMN project_identity TEXT");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_projects_identity ON projects(project_identity);
        CREATE INDEX IF NOT EXISTS idx_sessions_project_identity ON sessions(project_identity);
      `);
    },
  },
];

function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const pending = MIGRATIONS.filter((m) => m.version > current).toSorted(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    })();
  }
}

/**
 * Open, create, and migrate the index database.
 *
 * @param path Database path, defaulting to the configured index path.
 * @returns An open SQLite database connection.
 */
export function openDb(path: string = resolveDbPath()): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  // Wait out brief locks from another connection (a concurrent sync or a
  // closing writer) instead of failing with "database is locked".
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
