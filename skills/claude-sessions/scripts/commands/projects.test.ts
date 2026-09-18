import { resolveProjectIdentity } from "../lib/project-identity.ts";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./projects.ts";
import { openDb } from "../lib/db.ts";
import { sync } from "../lib/ingest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_IDENTITY = resolveProjectIdentity(".")!;
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
          project_identity: PROJECT_IDENTITY,
          project_dirs: ["-Users-testuser-Code-sample-project"],
          cwd: PROJECT_IDENTITY,
          timestamp: "2026-09-08T02:37:39.965Z",
          session_count: 11,
        },
      ],
    });
  });

  it("matches search against the canonical project root", async () => {
    const lower = await runCli(["projects", "--no-sync", "--search=wyattjoh/skills"]);
    const upper = await runCli(["projects", "--no-sync", "--search=WYATTJOH/SKILLS"]);

    expect(lower.code).toBe(0);
    expect(lower.stderr).toBe("");
    expect(JSON.parse(lower.stdout).rows).toEqual([
      {
        project_identity: PROJECT_IDENTITY,
        project_dirs: ["-Users-testuser-Code-sample-project"],
        cwd: PROJECT_IDENTITY,
        timestamp: "2026-09-08T02:37:39.965Z",
        session_count: 11,
      },
    ]);
    expect(upper.code).toBe(0);
    expect(upper.stderr).toBe("");
    expect(JSON.parse(upper.stdout).count).toBe(1);
  });

  it("returns an exact zero-row response when search has no match", async () => {
    const result = await runCli(["projects", "--no-sync", "--search=does-not-exist"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ command: "projects", count: 0, rows: [] });
  });

  it("combines project directories that share one canonical identity", async () => {
    const database = await makeDatabase();
    const db = openDb(database.path);
    try {
      await sync({ root: FIXTURES_ROOT, db });
      db.query(
        `INSERT INTO sessions
          (id, session_id, project_dir, project_identity, cwd, ended_at, models, versions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "worktree-session",
        "worktree-session",
        "-worktree-checkout",
        PROJECT_IDENTITY,
        ".",
        "2026-09-09T00:00:00.000Z",
        "[]",
        "[]",
      );
    } finally {
      db.close();
    }

    try {
      const result = await runCli(["projects", "--no-sync"], database.path);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).rows[0]).toEqual({
        project_identity: PROJECT_IDENTITY,
        project_dirs: ["-Users-testuser-Code-sample-project", "-worktree-checkout"],
        cwd: PROJECT_IDENTITY,
        timestamp: "2026-09-09T00:00:00.000Z",
        session_count: 12,
      });
    } finally {
      await rm(database.dir, { recursive: true, force: true });
    }
  });

  it("filters and limits projects through shared flags", async () => {
    const result = await runCli([
      "projects",
      "--no-sync",
      `--project=${PROJECT_IDENTITY}`,
      "--limit=1",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      JSON.parse(result.stdout).rows.map(
        (row: { project_identity: string }) => row.project_identity,
      ),
    ).toEqual([PROJECT_IDENTITY]);
  });

  it("includes subagent sessions in the aggregate when requested", async () => {
    const result = await runCli(["projects", "--no-sync", "--include-subagents"]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<{ project_identity: string; session_count: number }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(
      document.rows.map(({ project_identity, session_count }) => ({
        project_identity,
        session_count,
      })),
    ).toEqual([{ project_identity: PROJECT_IDENTITY, session_count: 12 }]);
  });

  it("renders table output and command help for the declared flags", async () => {
    const table = await runCli(["projects", "--no-sync", "--table"]);
    const help = await runCli(["projects", "--help"]);

    expect(table.code).toBe(0);
    expect(table.stderr).toBe("");
    const tableLines = table.stdout.trimEnd().split("\n");
    expect(tableLines).toHaveLength(3);
    expect(tableLines[0]!.split(/\s{2,}/)).toEqual([
      "project_identity",
      "project_dirs",
      "cwd",
      "timestamp",
      "session_count",
    ]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toBe(
      [
        "projects: List canonical repository roots with activity and session counts.",
        "",
        "Usage: bun scripts/cli.ts projects [options]",
        "",
        "Options:",
        "  --project=<value> (repeatable)  Filter by exact canonical project root or case-sensitive glob (repeatable)",
        "  --session=<value> (repeatable)  Filter by session id (repeatable)",
        "  --since=<value>                 Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
        "  --until=<value>                 Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
        "  --model=<value>                 Filter by model name",
        "  --include-subagents             Include subagent transcript sessions (excluded by default)",
        "  --limit=<value>                 Maximum number of rows to return (default 100)",
        "  --search=<value>                Filter by substring of the canonical project root",
        "  --table                         Print a human-readable table instead of JSON",
        "  --no-redact                     Redact secrets in output (default: on; use --no-redact to disable)",
        "",
        "Global options:",
        "  --no-sync   Skip the automatic index sync before running a read command",
      ].join("\n") + "\n",
    );
  });
});
