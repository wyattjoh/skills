import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openDb } from "../lib/db.ts";
import { sync } from "../lib/ingest.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const CLI = join(HERE, "..", "cli.ts");
const FIXTURES_ROOT = join(HERE, "..", "testdata", "corpus");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let dbPath: string;
let homePath: string;

async function runCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env,
      HOME: homePath,
      CLAUDE_SESSIONS_DB: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-sql-"));
  dbPath = join(tempDir, "index.db");
  homePath = join(tempDir, "home");

  const db = openDb(dbPath);
  try {
    await sync({ root: FIXTURES_ROOT, db });
    const insert = db.query(
      `INSERT INTO sessions
        (id, session_id, project_dir, models, versions)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 205; i += 1) {
      const id = `extra-${String(i).padStart(3, "0")}`;
      insert.run(id, id, "-Users-testuser-Code-sample-project", "[]", "[]");
    }
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("sql command", () => {
  it("returns SELECT rows", async () => {
    const result = await runCli([
      "sql",
      "--no-sync",
      "SELECT session_id FROM sessions ORDER BY session_id",
      "--limit=2",
    ]);
    const document = JSON.parse(result.stdout) as {
      command: string;
      count: number;
      rows: Array<{ session_id: string }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.command).toBe("sql");
    expect(document.count).toBe(2);
    expect(document.rows).toEqual([{ session_id: "extra-000" }, { session_id: "extra-001" }]);
  });

  it("applies the default limit only when the statement has no LIMIT", async () => {
    const defaultLimit = await runCli(["sql", "--no-sync", "SELECT session_id FROM sessions"]);
    const explicitLimit = await runCli([
      "sql",
      "--no-sync",
      "SELECT session_id FROM sessions LIMIT 3",
    ]);

    expect(defaultLimit.code).toBe(0);
    expect(defaultLimit.stderr).toBe("");
    expect((JSON.parse(defaultLimit.stdout) as { count: number }).count).toBe(200);
    expect(explicitLimit.code).toBe(0);
    expect(explicitLimit.stderr).toBe("");
    expect((JSON.parse(explicitLimit.stdout) as { count: number }).count).toBe(3);
  });

  it("applies the default limit before trailing line and block comments", async () => {
    const statements = [
      "SELECT session_id FROM sessions -- trailing line comment",
      "SELECT session_id FROM sessions /* trailing block comment */",
      "SELECT session_id FROM sessions; -- trailing line comment",
      "SELECT session_id FROM sessions; /* trailing block comment */",
    ];

    for (const statement of statements) {
      const result = await runCli(["sql", "--no-sync", statement]);
      const document = JSON.parse(result.stdout) as { count: number };

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(document.count).toBe(200);
    }
  });

  it("rejects non-SELECT and multi-statement input", async () => {
    for (const statement of [
      "INSERT INTO sessions(id, session_id) VALUES ('bad', 'bad')",
      "DELETE FROM sessions",
      "PRAGMA user_version",
      "SELECT 1; SELECT 2",
    ]) {
      const result = await runCli(["sql", "--no-sync", statement]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Error: SQL must be a single SELECT statement\n");
    }
  });

  it("accepts a WITH SELECT and a trailing semicolon", async () => {
    const result = await runCli([
      "sql",
      "--no-sync",
      "WITH selected AS (SELECT 7 AS value) SELECT value FROM selected;",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "sql",
      count: 1,
      rows: [{ value: 7 }],
    });
  });

  it("prints every schema object needed to inspect the index", async () => {
    const result = await runCli(["sql", "--no-sync", "--schema"]);
    const document = JSON.parse(result.stdout) as {
      command: string;
      rows: Array<{ name: string; sql: string }>;
    };
    const names = new Set(document.rows.map((row) => row.name));

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.command).toBe("sql");
    for (const name of [
      "files",
      "projects",
      "sessions",
      "messages",
      "tool_calls",
      "judgments",
      "messages_fts",
      "tool_calls_fts",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    expect(document.rows.some((row) => row.sql.includes("CREATE VIRTUAL TABLE messages_fts"))).toBe(
      true,
    );
  });
});
