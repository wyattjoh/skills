import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../lib/db.ts";
import { sync } from "../lib/ingest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.ts");
const FIXTURES_ROOT = join(HERE, "..", "testdata", "corpus");
const PROJECT_DIR = "-Users-testuser-Code-sample-project";
const FILTER_SESSION = "filter-session";
const FILTER_KEY = `${PROJECT_DIR}:${FILTER_SESSION}`;
const INTERRUPTION_SESSION = "interruption-session";
const INTERRUPTION_KEY = `${PROJECT_DIR}:${INTERRUPTION_SESSION}`;
const MULTI_RESULT_SESSION = "multi-result-session";
const MULTI_RESULT_KEY = `${PROJECT_DIR}:${MULTI_RESULT_SESSION}`;
const LATE_RESULT_SESSION = "late-result-session";
const LATE_RESULT_KEY = `${PROJECT_DIR}:${LATE_RESULT_SESSION}`;

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

let tempDir: string;
let dbPath: string;
let homeDir: string;

async function runCli(
  args: string[],
  databasePath = dbPath,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const env = {
    ...process.env,
    CLAUDE_SESSIONS_DB: databasePath,
    HOME: homeDir,
  } as Record<string, string>;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env,
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

function parseTable(output: string): { columns: string[]; rows: string[][] } {
  const lines = output.trimEnd().split("\n");
  const separator = lines[1] ?? "";
  const ranges: Array<readonly [number, number]> = [];
  for (const match of separator.matchAll(/-+/g)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }

  const parseRow = (line: string): string[] =>
    ranges.map(([start, end]) => line.slice(start, end).trim());
  return {
    columns: parseRow(lines[0] ?? ""),
    rows: lines.slice(2).map(parseRow),
  };
}

function insertSession(db: Database, id: string, sessionId: string): void {
  db.query(
    `INSERT INTO sessions (id, session_id, project_dir, cwd, models, versions)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    PROJECT_DIR,
    "/Users/testuser/Code/sample-project",
    '["claude-opus-4-7"]',
    '["2.1.0"]',
  );
}

function insertMessage(
  db: Database,
  sessionId: string,
  uuid: string,
  timestamp: string,
  type: "user" | "assistant",
  text: string,
  options: { isInjected?: number; isInterrupt?: number } = {},
): void {
  db.query(
    `INSERT INTO messages
      (uuid, session_id, ts, type, role, text, is_injected, is_interrupt_marker, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid,
    sessionId,
    timestamp,
    type,
    type,
    text,
    options.isInjected ?? 0,
    options.isInterrupt ?? 0,
    type === "assistant" ? "claude-opus-4-7" : null,
  );
}

function insertTool(
  db: Database,
  values: {
    id: string;
    sessionId: string;
    messageUuid: string;
    timestamp: string;
    name: string;
    input: Record<string, unknown>;
    resultText?: string;
    isError?: number;
    resultTimestamp?: string;
    latencyMs?: number;
    subagentType?: string;
    skillName?: string;
  },
): void {
  db.query(
    `INSERT INTO tool_calls
      (id, session_id, message_uuid, ts, name, input, result_text, is_error, result_ts, latency_ms, subagent_type, skill_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.id,
    values.sessionId,
    values.messageUuid,
    values.timestamp,
    values.name,
    JSON.stringify(values.input),
    values.resultText ?? null,
    values.isError ?? 0,
    values.resultTimestamp ?? null,
    values.latencyMs ?? null,
    values.subagentType ?? null,
    values.skillName ?? null,
  );
}

async function makeRegexDatabase(
  count: number,
  input: Record<string, unknown> = { value: "boundary" },
  resultText = "boundary",
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-regex-command-"));
  const path = join(dir, "index.db");
  const sessionId = "regex-boundary-session";
  const sessionKey = `${PROJECT_DIR}:${sessionId}`;
  const db = openDb(path);
  try {
    insertSession(db, sessionKey, sessionId);
    insertMessage(
      db,
      sessionKey,
      "regex-assistant",
      "2026-01-06T00:00:00.000Z",
      "assistant",
      "Regex boundary test",
    );
    for (let index = 0; index < count; index += 1) {
      insertTool(db, {
        id: `regex-tool-${String(index).padStart(4, "0")}`,
        sessionId: sessionKey,
        messageUuid: "regex-assistant",
        timestamp: "2026-01-06T00:00:00.000Z",
        name: "Regex",
        input,
        resultText,
        isError: 1,
        resultTimestamp: "2026-01-06T00:00:00.000Z",
      });
    }
  } finally {
    db.close();
  }
  return { dir, path };
}

async function seed(): Promise<void> {
  tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-command-test-"));
  dbPath = join(tempDir, "index.db");
  homeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-command-home-"));

  const db = openDb(dbPath);
  try {
    await sync({ root: FIXTURES_ROOT, db });

    insertSession(db, FILTER_KEY, FILTER_SESSION);
    insertMessage(
      db,
      FILTER_KEY,
      "filter-assistant",
      "2026-01-02T00:00:00.000Z",
      "assistant",
      "The task failed.",
    );
    insertTool(db, {
      id: "filter-agent",
      sessionId: FILTER_KEY,
      messageUuid: "filter-assistant",
      timestamp: "2026-01-02T00:00:00.000Z",
      name: "Task",
      input: { subagent_type: "Explore", prompt: "inspect" },
      subagentType: "Explore",
    });
    insertTool(db, {
      id: "filter-skill",
      sessionId: FILTER_KEY,
      messageUuid: "filter-assistant",
      timestamp: "2026-01-02T00:00:01.000Z",
      name: "Skill",
      input: { skill: "grilling", args: "stress test" },
      skillName: "grilling",
    });
    insertTool(db, {
      id: "filter-error",
      sessionId: FILTER_KEY,
      messageUuid: "filter-assistant",
      timestamp: "2026-01-02T00:00:02.000Z",
      name: "Bash",
      input: { command: "false" },
      resultText: "error output from task",
      isError: 1,
      resultTimestamp: "2026-01-02T00:00:02.250Z",
      latencyMs: 250,
    });
    insertTool(db, {
      id: "filter-long-error",
      sessionId: FILTER_KEY,
      messageUuid: "filter-assistant",
      timestamp: "2026-01-02T00:00:02.500Z",
      name: "Long",
      input: { command: "long" },
      resultText: "a".repeat(500),
      isError: 1,
      resultTimestamp: "2026-01-02T00:00:02.750Z",
      latencyMs: 250,
    });
    insertTool(db, {
      id: "filter-secret",
      sessionId: FILTER_KEY,
      messageUuid: "filter-assistant",
      timestamp: "2026-01-02T00:00:02.900Z",
      name: "Secret",
      input: { command: "echo TOKEN=abcd1234efgh" },
      resultText: "TOKEN=abcd1234efgh",
    });
    insertMessage(
      db,
      FILTER_KEY,
      "filter-next-assistant",
      "2026-01-02T00:00:03.000Z",
      "assistant",
      "I fixed the task after the error.",
    );

    insertSession(db, INTERRUPTION_KEY, INTERRUPTION_SESSION);
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "interrupt-assistant",
      "2026-01-03T00:00:00.000Z",
      "assistant",
      "I was about to make a change.",
    );
    insertTool(db, {
      id: "interrupt-tool",
      sessionId: INTERRUPTION_KEY,
      messageUuid: "interrupt-assistant",
      timestamp: "2026-01-03T00:00:00.000Z",
      name: "Bash",
      input: { command: "dangerous" },
    });
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "interrupt-user",
      "2026-01-03T00:00:01.000Z",
      "user",
      "[Request interrupted by user]",
      { isInterrupt: 1 },
    );
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "rejected-assistant",
      "2026-01-03T00:00:02.000Z",
      "assistant",
      "I proposed another tool call.",
    );
    insertTool(db, {
      id: "rejected-tool",
      sessionId: INTERRUPTION_KEY,
      messageUuid: "rejected-assistant",
      timestamp: "2026-01-03T00:00:02.000Z",
      name: "Bash",
      input: { command: "also-dangerous" },
    });
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "rejected-user",
      "2026-01-03T00:00:03.000Z",
      "user",
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      { isInterrupt: 1 },
    );
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "mid-run-assistant",
      "2026-01-03T00:00:04.000Z",
      "assistant",
      "I need to inspect the repository first.",
    );
    insertTool(db, {
      id: "mid-run-tool",
      sessionId: INTERRUPTION_KEY,
      messageUuid: "mid-run-assistant",
      timestamp: "2026-01-03T00:00:04.000Z",
      name: "Read",
      input: { file_path: "/tmp/file" },
    });
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "mid-run-user",
      "2026-01-03T00:00:05.000Z",
      "user",
      "Actually inspect the other file instead.",
    );
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "injected-user",
      "2026-01-03T00:00:06.000Z",
      "user",
      "<system-reminder>Injected text</system-reminder>",
      { isInjected: 1 },
    );
    insertMessage(
      db,
      INTERRUPTION_KEY,
      "result-user",
      "2026-01-03T00:00:07.000Z",
      "user",
      "file contents",
    );
    insertTool(db, {
      id: "result-tool",
      sessionId: INTERRUPTION_KEY,
      messageUuid: "mid-run-assistant",
      timestamp: "2026-01-03T00:00:04.000Z",
      name: "Read",
      input: { file_path: "/tmp/file" },
      resultText: "file contents",
      resultTimestamp: "2026-01-03T00:00:07.000Z",
    });

    insertSession(db, MULTI_RESULT_KEY, MULTI_RESULT_SESSION);
    insertMessage(
      db,
      MULTI_RESULT_KEY,
      "multi-result-assistant",
      "2026-01-04T00:00:00.000Z",
      "assistant",
      "I made several tool calls.",
    );
    insertTool(db, {
      id: "multi-result-first",
      sessionId: MULTI_RESULT_KEY,
      messageUuid: "multi-result-assistant",
      timestamp: "2026-01-04T00:00:00.000Z",
      name: "First",
      input: { value: 1 },
      resultText: "first result",
      resultTimestamp: "2026-01-04T00:00:01.000Z",
    });
    insertTool(db, {
      id: "multi-result-second",
      sessionId: MULTI_RESULT_KEY,
      messageUuid: "multi-result-assistant",
      timestamp: "2026-01-04T00:00:00.000Z",
      name: "Second",
      input: { value: 2 },
      resultText: "second result",
      resultTimestamp: "2026-01-04T00:00:01.000Z",
    });
    insertTool(db, {
      id: "multi-result-unresolved",
      sessionId: MULTI_RESULT_KEY,
      messageUuid: "multi-result-assistant",
      timestamp: "2026-01-04T00:00:00.000Z",
      name: "Unresolved",
      input: { value: 3 },
    });
    insertMessage(
      db,
      MULTI_RESULT_KEY,
      "multi-result-user",
      "2026-01-04T00:00:01.000Z",
      "user",
      "first result\n\nsecond result",
    );

    insertSession(db, LATE_RESULT_KEY, LATE_RESULT_SESSION);
    insertMessage(
      db,
      LATE_RESULT_KEY,
      "late-result-assistant",
      "2026-01-05T00:00:00.000Z",
      "assistant",
      "I need to wait for this tool result.",
    );
    insertTool(db, {
      id: "late-result-tool",
      sessionId: LATE_RESULT_KEY,
      messageUuid: "late-result-assistant",
      timestamp: "2026-01-05T00:00:00.000Z",
      name: "Later",
      input: { value: "later" },
      resultText: "later result",
      resultTimestamp: "2026-01-05T00:00:02.000Z",
    });
    insertMessage(
      db,
      LATE_RESULT_KEY,
      "late-result-user",
      "2026-01-05T00:00:01.000Z",
      "user",
      "I changed direction before the tool result.",
    );
    insertMessage(
      db,
      LATE_RESULT_KEY,
      "late-result-result",
      "2026-01-05T00:00:02.000Z",
      "user",
      "later result",
    );

    const acceptanceProject = "wyattjoh-skills";
    const acceptanceSession = "acceptance-session";
    const acceptanceKey = `${acceptanceProject}:${acceptanceSession}`;
    db.query(
      `INSERT INTO sessions (id, session_id, project_dir, cwd, models, versions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      acceptanceKey,
      acceptanceSession,
      acceptanceProject,
      "/Users/wyatt.johnson/Code/github.com/wyattjoh/skills",
      '["claude-opus-4-7"]',
      '["2.1.0"]',
    );
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const timestamp = `2026-01-06T00:00:${suffix}.000Z`;
      const assistantUuid = `acceptance-assistant-${suffix}`;
      insertMessage(
        db,
        acceptanceKey,
        assistantUuid,
        timestamp,
        "assistant",
        `I was about to make change ${suffix}.`,
      );
      insertTool(db, {
        id: `acceptance-tool-${suffix}`,
        sessionId: acceptanceKey,
        messageUuid: assistantUuid,
        timestamp,
        name: "Bash",
        input: { command: "dangerous" },
      });
      insertMessage(
        db,
        acceptanceKey,
        `acceptance-user-${suffix}`,
        `2026-01-06T00:00:${suffix}.500Z`,
        "user",
        "[Request interrupted by user]",
        { isInterrupt: 1 },
      );
    }
  } finally {
    db.close();
  }
}

beforeAll(seed);
afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("tools command", () => {
  it("returns a paired fixture call with parsed input and a missing result", async () => {
    const result = await runCli([
      "tools",
      "--no-sync",
      "--name=Delta",
      '--input=^\\{"command":"frost tango',
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "tools",
      count: 1,
      rows: [
        {
          id: "tool-0002",
          name: "Delta",
          input: {
            command: 'frost tango && india "---Ivory Zephyr---" && frost ivory --zephyr',
            description: "Frost acorn haven ember november quartz xenon",
          },
          result_text: null,
          is_error: false,
          latency_ms: null,
          session_id: "session-block-content",
          project_dir: PROJECT_DIR,
          timestamp: "2026-05-29T12:10:37.245Z",
          uuid: "uuid-0002",
        },
      ],
    });
  });

  it("supports errors-only, result truncation, agent type, and skill filters", async () => {
    const errors = await runCli([
      "tools",
      "--no-sync",
      "--errors-only",
      `--session=${FILTER_SESSION}`,
      "--name=Bash",
      "--result-chars=8",
    ]);
    expect(errors.code).toBe(0);
    expect(errors.stderr).toBe("");
    expect(JSON.parse(errors.stdout)).toEqual({
      command: "tools",
      count: 1,
      rows: [
        {
          id: "filter-error",
          name: "Bash",
          input: { command: "false" },
          result_text: "error...",
          is_error: true,
          latency_ms: 250,
          session_id: FILTER_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-02T00:00:02.000Z",
          uuid: "filter-assistant",
        },
      ],
    });

    const agent = await runCli(["tools", "--no-sync", "--agent-type=Explore"]);
    expect(JSON.parse(agent.stdout)).toEqual({
      command: "tools",
      count: 1,
      rows: [
        {
          id: "filter-agent",
          name: "Task",
          input: { subagent_type: "Explore", prompt: "inspect" },
          result_text: null,
          is_error: false,
          latency_ms: null,
          session_id: FILTER_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-02T00:00:00.000Z",
          uuid: "filter-assistant",
        },
      ],
    });

    const skill = await runCli(["tools", "--no-sync", "--skill=grilling"]);
    expect(JSON.parse(skill.stdout)).toEqual({
      command: "tools",
      count: 1,
      rows: [
        {
          id: "filter-skill",
          name: "Skill",
          input: { skill: "grilling", args: "stress test" },
          result_text: null,
          is_error: false,
          latency_ms: null,
          session_id: FILTER_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-02T00:00:01.000Z",
          uuid: "filter-assistant",
        },
      ],
    });
  });

  it("uses the default 400-character result limit", async () => {
    const result = await runCli([
      "tools",
      "--no-sync",
      `--session=${FILTER_SESSION}`,
      "--name=Long",
    ]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<{ result_text: string }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(document.rows[0]?.result_text).toBe(`${"a".repeat(397)}...`);
  });

  it("supports command help, table output, and redaction flags", async () => {
    const [toolsHelp, errorsHelp, interruptionsHelp] = await Promise.all([
      runCli(["tools", "--help"]),
      runCli(["errors", "--help"]),
      runCli(["interruptions", "--help"]),
    ]);

    const toolsHelpText = [
      "tools: List tool calls paired with their results.",
      "",
      "Usage: bun scripts/cli.ts tools [options]",
      "",
      "Options:",
      "  --project=<value> (repeatable)  Filter by substring of the encoded project dir or cwd (repeatable)",
      "  --session=<value> (repeatable)  Filter by session id (repeatable)",
      "  --since=<value>                 Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
      "  --until=<value>                 Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
      "  --model=<value>                 Filter by model name",
      "  --include-subagents             Include subagent transcript sessions (excluded by default)",
      "  --limit=<value>                 Maximum number of rows to return (default 100)",
      "  --name=<value> (repeatable)     Filter by tool name (repeatable)",
      "  --input=<value>                 Filter by regex over the tool input",
      "  --errors-only                   Only include calls whose result was an error",
      "  --agent-type=<value>            Filter Agent calls by subagent type",
      "  --skill=<value>                 Filter Skill calls by skill name",
      "  --result-chars=<value>          Maximum result text characters (default 400)",
      "  --table                         Print a human-readable table instead of JSON",
      "  --no-redact                     Redact secrets in output (default: on; use --no-redact to disable)",
      "",
      "Global options:",
      "  --no-sync   Skip the automatic index sync before running a read command",
      "",
    ].join("\n");
    const errorsHelpText = [
      "errors: List is_error tool results with the preceding call and the next assistant text.",
      "",
      "Usage: bun scripts/cli.ts errors [options]",
      "",
      "Options:",
      "  --project=<value> (repeatable)  Filter by substring of the encoded project dir or cwd (repeatable)",
      "  --session=<value> (repeatable)  Filter by session id (repeatable)",
      "  --since=<value>                 Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
      "  --until=<value>                 Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
      "  --model=<value>                 Filter by model name",
      "  --include-subagents             Include subagent transcript sessions (excluded by default)",
      "  --limit=<value>                 Maximum number of rows to return (default 100)",
      "  --name=<value>                  Filter by tool name",
      "  --pattern=<value>               Filter by regex over the error result text",
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
      "",
    ].join("\n");
    const interruptionsHelpText = [
      "interruptions: List interrupt markers, rejected tool calls, and user turns that follow a tool_use mid-run.",
      "",
      "Usage: bun scripts/cli.ts interruptions [options]",
      "",
      "Options:",
      "  --project=<value> (repeatable)  Filter by substring of the encoded project dir or cwd (repeatable)",
      "  --session=<value> (repeatable)  Filter by session id (repeatable)",
      "  --since=<value>                 Only include records at or after this time (ISO 8601, or relative like 3h, 6d, 2w)",
      "  --until=<value>                 Only include records at or before this time (ISO 8601, or relative like 3h, 6d, 2w)",
      "  --model=<value>                 Filter by model name",
      "  --include-subagents             Include subagent transcript sessions (excluded by default)",
      "  --limit=<value>                 Maximum number of rows to return (default 100)",
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
      "",
    ].join("\n");
    expect(toolsHelp).toEqual({ code: 0, stdout: toolsHelpText, stderr: "" });
    expect(errorsHelp).toEqual({ code: 0, stdout: errorsHelpText, stderr: "" });
    expect(interruptionsHelp).toEqual({
      code: 0,
      stdout: interruptionsHelpText,
      stderr: "",
    });

    const table = await runCli([
      "tools",
      "--no-sync",
      `--session=${FILTER_SESSION}`,
      "--name=Task",
      "--table",
    ]);
    expect(table.code).toBe(0);
    expect(table.stderr).toBe("");
    expect(parseTable(table.stdout)).toEqual({
      columns: [
        "id",
        "name",
        "input",
        "result_text",
        "is_error",
        "latency_ms",
        "session_id",
        "project_dir",
        "timestamp",
        "uuid",
      ],
      rows: [
        [
          "filter-agent",
          "Task",
          '{"subagent_type":"Explore","prompt":"inspect"}',
          "",
          "false",
          "",
          FILTER_SESSION,
          PROJECT_DIR,
          "2026-01-02T00:00:00.000Z",
          "filter-assistant",
        ],
      ],
    });

    const redacted = await runCli([
      "tools",
      "--no-sync",
      `--session=${FILTER_SESSION}`,
      "--name=Secret",
    ]);
    const unredacted = await runCli([
      "tools",
      "--no-sync",
      `--session=${FILTER_SESSION}`,
      "--name=Secret",
      "--no-redact",
    ]);
    expect(JSON.parse(redacted.stdout).rows[0]).toEqual({
      id: "filter-secret",
      name: "Secret",
      input: { command: "echo TOKEN=[redacted:env-secret]" },
      result_text: "TOKEN=[redacted:env-secret]",
      is_error: false,
      latency_ms: null,
      session_id: FILTER_SESSION,
      project_dir: PROJECT_DIR,
      timestamp: "2026-01-02T00:00:02.900Z",
      uuid: "filter-assistant",
    });
    expect(JSON.parse(unredacted.stdout).rows[0]).toEqual({
      id: "filter-secret",
      name: "Secret",
      input: { command: "echo TOKEN=abcd1234efgh" },
      result_text: "TOKEN=abcd1234efgh",
      is_error: false,
      latency_ms: null,
      session_id: FILTER_SESSION,
      project_dir: PROJECT_DIR,
      timestamp: "2026-01-02T00:00:02.900Z",
      uuid: "filter-assistant",
    });
  });

  it("reports fixture latency from the paired error result", async () => {
    const result = await runCli([
      "tools",
      "--no-sync",
      "--session=session-tool-error",
      "--name=Delta",
      "--errors-only",
    ]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<{ id: string; latency_ms: number; session_id: string }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(
      document.rows.map(({ id, latency_ms, session_id }) => ({ id, latency_ms, session_id })),
    ).toEqual([{ id: "tool-0002", latency_ms: 559, session_id: "session-tool-error" }]);
  });

  it("rejects catastrophic and composed regexes for tools and errors", async () => {
    const cases = [
      {
        args: ["tools", "--no-sync", "--input=(a+)+$"],
        stderr: "Error: Rejected --input: nested or repeated quantified groups are not allowed.\n",
      },
      {
        args: ["errors", "--no-sync", "--pattern=(a+)+$"],
        stderr:
          "Error: Rejected --pattern: nested or repeated quantified groups are not allowed.\n",
      },
      {
        args: ["tools", "--no-sync", "--input=a{0,999}a{0,999}b"],
        stderr: "Error: Rejected --input: multiple variable-length quantifiers are not allowed.\n",
      },
      {
        args: ["errors", "--no-sync", "--pattern=a{0,999}a{0,999}b"],
        stderr:
          "Error: Rejected --pattern: multiple variable-length quantifiers are not allowed.\n",
      },
    ];

    for (const testCase of cases) {
      const result = await runCli(testCase.args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(testCase.stderr);
    }
  });

  it("bounds regex candidates for tools and errors", async () => {
    const allowed = await makeRegexDatabase(1_000);
    const rejected = await makeRegexDatabase(1_001);

    try {
      const allowedTools = await runCli(
        ["tools", "--no-sync", "--session=regex-boundary-session", "--input=boundary", "--limit=1"],
        allowed.path,
      );
      const rejectedTools = await runCli(
        ["tools", "--no-sync", "--session=regex-boundary-session", "--input=boundary", "--limit=1"],
        rejected.path,
      );
      const allowedErrors = await runCli(
        [
          "errors",
          "--no-sync",
          "--session=regex-boundary-session",
          "--pattern=^boundary$",
          "--limit=1",
        ],
        allowed.path,
      );
      const rejectedErrors = await runCli(
        [
          "errors",
          "--no-sync",
          "--session=regex-boundary-session",
          "--pattern=^boundary$",
          "--limit=1",
        ],
        rejected.path,
      );

      expect(allowedTools.code).toBe(0);
      expect(allowedTools.stderr).toBe("");
      expect((JSON.parse(allowedTools.stdout) as { count: number }).count).toBe(1);
      expect(rejectedTools.code).toBe(1);
      expect(rejectedTools.stdout).toBe("");
      expect(rejectedTools.stderr).toBe(
        "Error: Rejected --input: candidate set exceeds 1000 rows.\n",
      );
      expect(allowedErrors.code).toBe(0);
      expect(allowedErrors.stderr).toBe("");
      expect((JSON.parse(allowedErrors.stdout) as { count: number }).count).toBe(1);
      expect(rejectedErrors.code).toBe(1);
      expect(rejectedErrors.stdout).toBe("");
      expect(rejectedErrors.stderr).toBe(
        "Error: Rejected --pattern: candidate set exceeds 1000 rows.\n",
      );
    } finally {
      await Promise.all([
        rm(allowed.dir, { recursive: true, force: true }),
        rm(rejected.dir, { recursive: true, force: true }),
      ]);
    }
  });

  it("evaluates tool and error regexes against only the first 32 KiB", async () => {
    const text = `prefix ${"x".repeat(32 * 1024)}needle`;
    const database = await makeRegexDatabase(1, { value: text }, text);

    try {
      const toolPrefix = await runCli(
        ["tools", "--no-sync", "--session=regex-boundary-session", "--input=prefix"],
        database.path,
      );
      const toolSuffix = await runCli(
        ["tools", "--no-sync", "--session=regex-boundary-session", "--input=needle"],
        database.path,
      );
      const errorPrefix = await runCli(
        ["errors", "--no-sync", "--session=regex-boundary-session", "--pattern=^prefix"],
        database.path,
      );
      const errorSuffix = await runCli(
        ["errors", "--no-sync", "--session=regex-boundary-session", "--pattern=needle"],
        database.path,
      );

      expect(toolPrefix.code).toBe(0);
      expect(toolPrefix.stderr).toBe("");
      expect((JSON.parse(toolPrefix.stdout) as { count: number }).count).toBe(1);
      expect(toolSuffix.code).toBe(0);
      expect(toolSuffix.stderr).toBe("");
      expect((JSON.parse(toolSuffix.stdout) as { count: number }).count).toBe(0);
      expect(errorPrefix.code).toBe(0);
      expect(errorPrefix.stderr).toBe("");
      expect((JSON.parse(errorPrefix.stdout) as { count: number }).count).toBe(1);
      expect(errorSuffix.code).toBe(0);
      expect(errorSuffix.stderr).toBe("");
      expect((JSON.parse(errorSuffix.stdout) as { count: number }).count).toBe(0);
    } finally {
      await rm(database.dir, { recursive: true, force: true });
    }
  });

  it("returns an empty document when no tool matches", async () => {
    const result = await runCli(["tools", "--no-sync", "--name=missing-tool"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ command: "tools", count: 0, rows: [] });
  });
});

describe("errors command", () => {
  it("pairs an error result with the call and following assistant text", async () => {
    const result = await runCli(["errors", "--no-sync", "--name=Bash", "--pattern=error output"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "errors",
      count: 1,
      rows: [
        {
          id: "filter-error",
          name: "Bash",
          input: { command: "false" },
          result_text: "error output from task",
          is_error: true,
          latency_ms: 250,
          session_id: FILTER_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-02T00:00:02.250Z",
          uuid: "filter-assistant",
          assistant_text_after: "I fixed the task after the error.",
        },
      ],
    });
  });

  it("returns an empty document when the error pattern does not match", async () => {
    const result = await runCli(["errors", "--no-sync", "--pattern=not-present"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ command: "errors", count: 0, rows: [] });
  });

  it("preserves rows and reports invalid judge files without failing the command", async () => {
    const baseline = await runCli([
      "errors",
      "--no-sync",
      `--session=${FILTER_SESSION}`,
      "--pattern=error output",
    ]);
    const result = await runCli([
      "errors",
      "--no-sync",
      `--session=${FILTER_SESSION}`,
      "--pattern=error output",
      "--judge-file={}",
    ]);
    const baselineDocument = JSON.parse(baseline.stdout) as {
      rows: Array<Record<string, unknown>>;
    };
    const document = JSON.parse(result.stdout) as {
      command: string;
      count: number;
      judge: Record<string, unknown>;
      rows: Array<Record<string, unknown>>;
    };

    expect(baseline.code).toBe(0);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("judge: skipped (bad_answer)\n");
    expect(document.command).toBe("errors");
    expect(document.count).toBe(baselineDocument.rows.length);
    expect(document.judge).toEqual({
      status: "skipped",
      reason: "bad_answer",
      error_class: null,
      rows_judged: 0,
      rows_cached: 0,
      estimated_input_tokens: 0,
    });
    expect(document.rows.map(({ judge: _judge, ...row }) => row)).toEqual(baselineDocument.rows);
    expect(document.rows.map((row) => row.judge)).toEqual([
      { status: "skipped", reason: "bad_answer", error_class: null },
    ]);
  });
});

describe("interruptions command", () => {
  it("preserves every row and reports no_api_key at the command boundary", async () => {
    const baseline = await runCli([
      "interruptions",
      "--project=wyattjoh-skills",
      "--no-sync",
      "--limit=5",
    ]);
    const result = await runCli(
      ["interruptions", "--project=wyattjoh-skills", "--no-sync", "--judge=steering", "--limit=5"],
      dbPath,
      { TYPESAFE_API_KEY: undefined },
    );
    const baselineDocument = JSON.parse(baseline.stdout) as {
      count: number;
      rows: Array<Record<string, unknown>>;
    };
    const document = JSON.parse(result.stdout) as {
      command: string;
      count: number;
      judge: Record<string, unknown>;
      rows: Array<Record<string, unknown>>;
    };

    expect(baseline.code).toBe(0);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("judge: estimated input tokens: 325\njudge: skipped (no_api_key)\n");
    expect(document.command).toBe("interruptions");
    expect(baselineDocument.count).toBe(5);
    expect(document.count).toBe(5);
    expect(baselineDocument.rows).toHaveLength(5);
    expect(document.rows).toHaveLength(5);
    expect(document.judge.status).toBe("skipped");
    expect(document.judge.reason).toBe("no_api_key");
    expect(document.judge.error_class).toBe(null);
    expect(document.judge.rows_judged).toBe(0);
    expect(document.judge.rows_cached).toBe(0);
    expect(typeof document.judge.estimated_input_tokens).toBe("number");
    expect(document.rows.map(({ judge: _judge, ...row }) => row)).toEqual(baselineDocument.rows);
    expect(document.rows.map((row) => row.judge)).toEqual(
      baselineDocument.rows.map(() => ({
        status: "skipped",
        reason: "no_api_key",
        error_class: null,
      })),
    );
  });

  it("returns interrupt, rejected-tool, and mid-run user rows in order", async () => {
    const result = await runCli([
      "interruptions",
      "--no-sync",
      `--session=${INTERRUPTION_SESSION}`,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "interruptions",
      count: 3,
      rows: [
        {
          kind: "interrupt",
          assistant_text_before: "I was about to make a change.",
          user_text_after: "[Request interrupted by user]",
          session_id: INTERRUPTION_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-03T00:00:01.000Z",
          uuid: "interrupt-user",
        },
        {
          kind: "rejected_tool",
          assistant_text_before: "I proposed another tool call.",
          user_text_after:
            "The user doesn't want to proceed with this tool use. The tool use was rejected.",
          session_id: INTERRUPTION_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-03T00:00:03.000Z",
          uuid: "rejected-user",
        },
        {
          kind: "mid_run_user_turn",
          assistant_text_before: "I need to inspect the repository first.",
          user_text_after: "Actually inspect the other file instead.",
          session_id: INTERRUPTION_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-03T00:00:05.000Z",
          uuid: "mid-run-user",
        },
      ],
    });
  });

  it("does not count injected text or joined tool results as steering turns", async () => {
    const injected = await runCli([
      "interruptions",
      "--no-sync",
      `--session=${INTERRUPTION_SESSION}`,
      "--since=2026-01-03T00:00:06.000Z",
    ]);
    const joinedResults = await runCli([
      "interruptions",
      "--no-sync",
      `--session=${MULTI_RESULT_SESSION}`,
    ]);

    expect(injected.code).toBe(0);
    expect(injected.stderr).toBe("");
    expect(JSON.parse(injected.stdout)).toEqual({ command: "interruptions", count: 0, rows: [] });
    expect(joinedResults.code).toBe(0);
    expect(joinedResults.stderr).toBe("");
    expect(JSON.parse(joinedResults.stdout)).toEqual({
      command: "interruptions",
      count: 0,
      rows: [],
    });
  });

  it("counts a user turn before its later tool result as steering", async () => {
    const result = await runCli(["interruptions", "--no-sync", `--session=${LATE_RESULT_SESSION}`]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "interruptions",
      count: 1,
      rows: [
        {
          kind: "mid_run_user_turn",
          assistant_text_before: "I need to wait for this tool result.",
          user_text_after: "I changed direction before the tool result.",
          session_id: LATE_RESULT_SESSION,
          project_dir: PROJECT_DIR,
          timestamp: "2026-01-05T00:00:01.000Z",
          uuid: "late-result-user",
        },
      ],
    });
  });
});
