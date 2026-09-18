import { resolveProjectIdentity } from "../lib/project-identity.ts";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./sessions.ts";
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
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-sessions-db-"));
  return { dir, path: join(dir, "index.db") };
}

function parseTableRow(line: string, separator: string): string[] {
  const widths = separator.split(/\s{2,}/).map((column) => column.length);
  let offset = 0;
  return widths.map((width, index) => {
    const value = line.slice(offset, offset + width).trim();
    offset += width + (index === widths.length - 1 ? 0 : 2);
    return value;
  });
}

beforeAll(async () => {
  const database = await makeDatabase();
  databaseDir = database.dir;
  databasePath = database.path;
  homeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-sessions-home-"));

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

describe("sessions command", () => {
  it("exposes the command shape and every real flag", () => {
    expect(command.name).toBe("sessions");
    expect(typeof command.description).toBe("string");
    expect(command.options.map((option) => option.name)).toEqual([
      "project",
      "session",
      "since",
      "until",
      "model",
      "include-subagents",
      "limit",
      "sort",
      "first-prompt",
      "table",
      "redact",
      "judge",
      "judge-file",
      "query",
      "min-confidence",
      "cache",
      "max-judge-rows",
    ]);
    expect(typeof command.run).toBe("function");
  });

  it("lists non-subagent sessions by date with exact metadata ordering", async () => {
    const result = await runCli(["sessions", "--no-sync"]);
    const document = JSON.parse(result.stdout) as {
      command: string;
      count: number;
      rows: Array<Record<string, unknown>>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.command).toBe("sessions");
    expect(document.count).toBe(11);
    expect(document.rows.map((row) => row.session_id)).toEqual([
      "session-attachment",
      "session-tool-error",
      "session-interrupt",
      "session-injected",
      "session-malformed",
      "session-string-content",
      "session-queue-operation",
      "session-block-content",
      "sample-parent-session",
      "session-ai-title",
      "session-summary",
    ]);
    expect(document.rows[0]).toEqual({
      session_id: "session-attachment",
      project_dir: "-Users-testuser-Code-sample-project",
      project_identity: PROJECT_IDENTITY,
      timestamp: "2026-09-08T02:37:39.965Z",
      cwd: ".",
      git_branch: "main",
      parent_session_id: null,
      agent_name: null,
      first_prompt: null,
      started_at: "2026-09-08T02:37:39.965Z",
      ended_at: "2026-09-08T02:37:39.965Z",
      models: [],
      versions: ["2.1.263"],
      message_count: 0,
      tool_call_count: 0,
      error_count: 0,
      interruption_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_create_tokens: 0,
    });
  });

  it("shows subagent sessions only when requested", async () => {
    const hidden = await runCli(["sessions", "--no-sync", "--session=sample0agent00id01"]);
    const shown = await runCli([
      "sessions",
      "--no-sync",
      "--include-subagents",
      "--session=sample0agent00id01",
    ]);

    expect(hidden.code).toBe(0);
    expect(hidden.stderr).toBe("");
    expect(JSON.parse(hidden.stdout)).toEqual({ command: "sessions", count: 0, rows: [] });
    expect(shown.code).toBe(0);
    expect(shown.stderr).toBe("");
    const row = JSON.parse(shown.stdout).rows[0] as Record<string, unknown>;
    expect(row).toEqual({
      session_id: "sample0agent00id01",
      project_dir: "-Users-testuser-Code-sample-project",
      project_identity: PROJECT_IDENTITY,
      timestamp: "2026-02-18T11:10:48.555Z",
      cwd: ".",
      git_branch: "main",
      parent_session_id: "-Users-testuser-Code-sample-project:sample-parent-session",
      agent_name: "general-purpose",
      first_prompt:
        "Inlet onyx thistle quebec ferry '/Inlet/mike.echo/Delta/Xenon Thistle Quebec - slate 17 Willow - 2026-02-17 ferry 19.28.35.zulu' alpha basalt oscar amber haven. Onyx quartz yankee willow mike onyx zul",
      started_at: "2026-02-18T11:10:44.424Z",
      ended_at: "2026-02-18T11:10:48.555Z",
      models: ["claude-sonnet-4-6"],
      versions: ["2.1.45"],
      message_count: 3,
      tool_call_count: 1,
      error_count: 0,
      interruption_count: 0,
      input_tokens: 6,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_create_tokens: 15252,
    });
  });

  it("applies project, session, model, prompt, and time filters", async () => {
    const project = await runCli([
      "sessions",
      "--no-sync",
      `--project=${PROJECT_IDENTITY}`,
      "--limit=2",
    ]);
    const session = await runCli(["sessions", "--no-sync", "--session=session-block-content"]);
    const model = await runCli(["sessions", "--no-sync", "--model=claude-opus-4-8"]);
    const prompt = await runCli(["sessions", "--no-sync", "--first-prompt=Juliet grove.lima"]);
    const time = await runCli([
      "sessions",
      "--no-sync",
      "--since=2026-08-27T00:00:00.000Z",
      "--until=2026-08-27T23:59:59.999Z",
    ]);

    expect(project.code).toBe(0);
    expect(project.stderr).toBe("");
    expect(
      JSON.parse(project.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-attachment", "session-tool-error"]);
    expect(session.code).toBe(0);
    expect(session.stderr).toBe("");
    expect(
      JSON.parse(session.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-block-content"]);
    expect(model.code).toBe(0);
    expect(model.stderr).toBe("");
    expect(
      JSON.parse(model.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-block-content"]);
    expect(prompt.code).toBe(0);
    expect(prompt.stderr).toBe("");
    expect(
      JSON.parse(prompt.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-malformed", "session-string-content"]);
    expect(time.code).toBe(0);
    expect(time.stderr).toBe("");
    expect(
      JSON.parse(time.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-tool-error", "session-interrupt"]);
  });

  it("sorts by messages, tokens, and errors and applies the limit", async () => {
    const messages = await runCli(["sessions", "--no-sync", "--sort=messages", "--limit=3"]);
    const tokens = await runCli(["sessions", "--no-sync", "--sort=tokens", "--limit=3"]);
    const errors = await runCli(["sessions", "--no-sync", "--sort=errors", "--limit=1"]);

    expect(messages.code).toBe(0);
    expect(messages.stderr).toBe("");
    expect(
      JSON.parse(messages.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["sample-parent-session", "session-tool-error", "session-interrupt"]);
    expect(tokens.code).toBe(0);
    expect(tokens.stderr).toBe("");
    expect(
      JSON.parse(tokens.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-tool-error", "session-block-content", "sample-parent-session"]);
    expect(errors.code).toBe(0);
    expect(errors.stderr).toBe("");
    expect(
      JSON.parse(errors.stdout).rows.map((row: { session_id: string }) => row.session_id),
    ).toEqual(["session-tool-error"]);
  });

  it("truncates long first prompts to exactly 200 characters", async () => {
    const database = await makeDatabase();
    const longPrompt = "x".repeat(250);
    const db = openDb(database.path);
    try {
      await sync({ root: FIXTURES_ROOT, db });
      db.query("UPDATE sessions SET first_prompt = ? WHERE session_id = ?").run(
        longPrompt,
        "session-string-content",
      );
    } finally {
      db.close();
    }

    try {
      const result = await runCli(
        ["sessions", "--no-sync", "--session=session-string-content"],
        database.path,
      );
      const row = JSON.parse(result.stdout).rows[0] as { first_prompt: string };

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(row.first_prompt).toBe("x".repeat(200));
      expect(row.first_prompt.length).toBe(200);
    } finally {
      await rm(database.dir, { recursive: true, force: true });
    }
  });

  it("renders table output and documents all flags in help", async () => {
    const table = await runCli(["sessions", "--no-sync", "--table", "--limit=1"]);
    const help = await runCli(["sessions", "--help"]);

    expect(table.code).toBe(0);
    expect(table.stderr).toBe("");
    const tableLines = table.stdout.trimEnd().split("\n");
    expect(tableLines).toHaveLength(3);
    expect(tableLines[0]!.split(/\s{2,}/)).toEqual([
      "session_id",
      "project_dir",
      "project_identity",
      "timestamp",
      "cwd",
      "git_branch",
      "parent_session_id",
      "agent_name",
      "first_prompt",
      "started_at",
      "ended_at",
      "models",
      "versions",
      "message_count",
      "tool_call_count",
      "error_count",
      "interruption_count",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_create_tokens",
    ]);
    expect(tableLines[1]!.split(/\s{2,}/)).toEqual([
      "------------------",
      "-----------------------------------",
      "----------------------------------------------------",
      "------------------------",
      "---",
      "----------",
      "-----------------",
      "----------",
      "------------",
      "------------------------",
      "------------------------",
      "------",
      "-----------",
      "-------------",
      "---------------",
      "-----------",
      "------------------",
      "------------",
      "-------------",
      "-----------------",
      "-------------------",
    ]);
    expect(parseTableRow(tableLines[2]!, tableLines[1]!)).toEqual([
      "session-attachment",
      "-Users-testuser-Code-sample-project",
      PROJECT_IDENTITY,
      "2026-09-08T02:37:39.965Z",
      ".",
      "main",
      "",
      "",
      "",
      "2026-09-08T02:37:39.965Z",
      "2026-09-08T02:37:39.965Z",
      "[]",
      '["2.1.263"]',
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toBe(
      [
        "sessions: List session metadata and counts.",
        "",
        "Usage: bun scripts/cli.ts sessions [options]",
        "",
        "Options:",
        "  --project=<value> (repeatable)  Filter by exact canonical project root or case-sensitive glob (repeatable)",
        "  --session=<value> (repeatable)  Filter by session id (repeatable)",
        "  --since=<value>                 Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
        "  --until=<value>                 Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
        "  --model=<value>                 Filter by model name",
        "  --include-subagents             Include subagent transcript sessions (excluded by default)",
        "  --limit=<value>                 Maximum number of rows to return (default 100)",
        "  --sort=<value>                  Sort by date, messages, tokens, or errors (default: date)",
        "  --first-prompt=<value>          Filter by substring of the session's first prompt",
        "  --table                         Print a human-readable table instead of JSON",
        "  --no-redact                     Redact secrets in output (default: on; use --no-redact to disable)",
        "  --judge=<value>                 Annotate supported rows with a TypeSafe preset",
        "  --judge-file=<value>            Load ad hoc TypeSafe questions and state fields from JSON",
        "  --query=<value>                 Query text required by the relevance preset",
        "  --min-confidence=<value>        Mark answers below this confidence as uncertain",
        "  --no-cache                      Use the judgment cache (default: on; use --no-cache to disable)",
        "  --max-judge-rows=<value>        Cap TypeSafe requests (default: 500)",
        "",
        "Global options:",
        "  --no-sync   Skip the automatic index sync before running a read command",
      ].join("\n") + "\n",
    );
  });

  it("returns an exact zero-row response", async () => {
    const result = await runCli(["sessions", "--no-sync", "--project=not-a-project"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ command: "sessions", count: 0, rows: [] });
  });
});
