import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./projects.ts";
import { openDb } from "../lib/db.ts";
import { sync } from "../lib/ingest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.ts");
const FIXTURES_ROOT = join(HERE, "..", "testdata", "corpus");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let databaseDir: string;
let databasePath: string;
let homeDir: string;

async function runCli(args: string[], dbPath = databasePath): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_SESSIONS_DB: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function makeDatabase(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-projects-db-"));
  return { dir, path: join(dir, "index.db") };
}

beforeAll(async () => {
  const database = await makeDatabase();
  databaseDir = database.dir;
  databasePath = database.path;
  homeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-projects-home-"));

  const db = openDb(databasePath);
  try {
    await sync({ root: FIXTURES_ROOT, db });
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await rm(databaseDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("projects command", () => {
  it("exposes the command shape and every real flag", () => {
    expect(command.name).toBe("projects");
    expect(typeof command.description).toBe("string");
    expect(command.options.map((option) => option.name)).toEqual([
      "project",
      "session",
      "since",
      "until",
      "model",
      "include-subagents",
      "limit",
      "search",
      "table",
      "redact",
    ]);
    expect(typeof command.run).toBe("function");
  });

  it("lists projects by activity with canonical row fields", async () => {
    const result = await runCli(["projects", "--no-sync"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "projects",
      count: 1,
      rows: [
        {
          project_dir: "-Users-testuser-Code-sample-project",
          cwd: "/Users/testuser/Code/sample-project",
          timestamp: "2026-09-08T02:37:39.965Z",
          session_count: 11,
        },
      ],
    });
  });

  it("matches search against the encoded project directory and cwd", async () => {
    const encoded = await runCli(["projects", "--no-sync", "--search=sample-project"]);
    const cwd = await runCli(["projects", "--no-sync", "--search=TESTUSER/code"]);

    expect(encoded.code).toBe(0);
    expect(encoded.stderr).toBe("");
    expect(JSON.parse(encoded.stdout).rows).toEqual([
      {
        project_dir: "-Users-testuser-Code-sample-project",
        cwd: "/Users/testuser/Code/sample-project",
        timestamp: "2026-09-08T02:37:39.965Z",
        session_count: 11,
      },
    ]);
    expect(cwd.code).toBe(0);
    expect(cwd.stderr).toBe("");
    expect(JSON.parse(cwd.stdout).count).toBe(1);
  });

  it("returns an exact zero-row response when search has no match", async () => {
    const result = await runCli(["projects", "--no-sync", "--search=does-not-exist"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ command: "projects", count: 0, rows: [] });
  });

  it("adds the parent path for projects inside a Claude worktree", async () => {
    const database = await makeDatabase();
    const db = openDb(database.path);
    try {
      await sync({ root: FIXTURES_ROOT, db });
      db.query(
        `INSERT INTO projects (dir, decoded_path, cwd, last_activity, session_count)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "-Users-testuser-Code-wyattjoh-skills",
        "/Users/testuser/Code/github/com/wyattjoh/skills",
        "/Users/testuser/Code/github.com/wyattjoh/skills/.claude/worktrees/demo",
        "2026-09-09T00:00:00.000Z",
        2,
      );
    } finally {
      db.close();
    }

    try {
      const result = await runCli(["projects", "--no-sync"], database.path);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).rows[0]).toEqual({
        project_dir: "-Users-testuser-Code-wyattjoh-skills",
        cwd: "/Users/testuser/Code/github.com/wyattjoh/skills/.claude/worktrees/demo",
        timestamp: "2026-09-09T00:00:00.000Z",
        session_count: 2,
        worktree_parent: "/Users/testuser/Code/github.com/wyattjoh/skills",
      });
    } finally {
      await rm(database.dir, { recursive: true, force: true });
    }
  });

  it("filters and limits projects through shared flags", async () => {
    const result = await runCli(["projects", "--no-sync", "--project=sample-project", "--limit=1"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      JSON.parse(result.stdout).rows.map((row: { project_dir: string }) => row.project_dir),
    ).toEqual(["-Users-testuser-Code-sample-project"]);
  });

  it("includes subagent sessions in the aggregate when requested", async () => {
    const result = await runCli(["projects", "--no-sync", "--include-subagents"]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<{ project_dir: string; session_count: number }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(
      document.rows.map(({ project_dir, session_count }) => ({ project_dir, session_count })),
    ).toEqual([{ project_dir: "-Users-testuser-Code-sample-project", session_count: 12 }]);
  });

  it("renders table output and command help for the declared flags", async () => {
    const table = await runCli(["projects", "--no-sync", "--table"]);
    const help = await runCli(["projects", "--help"]);

    expect(table.code).toBe(0);
    expect(table.stderr).toBe("");
    const tableLines = table.stdout.trimEnd().split("\n");
    expect(tableLines).toHaveLength(3);
    expect(tableLines[0]!.split(/\s{2,}/)).toEqual([
      "project_dir",
      "cwd",
      "timestamp",
      "session_count",
    ]);
    expect(tableLines[1]!.split(/\s{2,}/)).toEqual([
      "-----------------------------------",
      "-----------------------------------",
      "------------------------",
      "-------------",
    ]);
    expect(tableLines[2]!.split(/\s{2,}/)).toEqual([
      "-Users-testuser-Code-sample-project",
      "/Users/testuser/Code/sample-project",
      "2026-09-08T02:37:39.965Z",
      "11",
    ]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toBe(
      [
        "projects: List indexed project directories with cwd, activity, and session count.",
        "",
        "Usage: bun scripts/cli.ts projects [options]",
        "",
        "Options:",
        "  --project=<value> (repeatable)  Filter by substring of the encoded project dir or cwd (repeatable)",
        "  --session=<value> (repeatable)  Filter by session id (repeatable)",
        "  --since=<value>                 Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
        "  --until=<value>                 Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
        "  --model=<value>                 Filter by model name",
        "  --include-subagents             Include subagent transcript sessions (excluded by default)",
        "  --limit=<value>                 Maximum number of rows to return (default 100)",
        "  --search=<value>                Filter by substring of the encoded project dir or cwd",
        "  --table                         Print a human-readable table instead of JSON",
        "  --no-redact                     Redact secrets in output (default: on; use --no-redact to disable)",
        "",
        "Global options:",
        "  --no-sync   Skip the automatic index sync before running a read command",
      ].join("\n") + "\n",
    );
  });
});
