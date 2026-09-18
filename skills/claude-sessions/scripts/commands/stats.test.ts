import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
  const process = Bun.spawn([globalThis.process.execPath, CLI, ...args], {
    env: {
      ...globalThis.process.env,
      HOME: homePath,
      CLAUDE_SESSIONS_DB: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
}

function statsRow(group: string | null, values: Record<string, number>) {
  return {
    group,
    sessions: 0,
    messages: 0,
    tool_calls: 0,
    errors: 0,
    interruptions: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    duration_seconds: 0,
    ...values,
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-stats-"));
  dbPath = join(tempDir, "index.db");
  homePath = join(tempDir, "home");

  const seed = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { openDb } from ${JSON.stringify(join(HERE, "..", "lib", "db.ts"))};
import { sync } from ${JSON.stringify(join(HERE, "..", "lib", "ingest.ts"))};
const db = openDb(process.env.CLAUDE_SESSIONS_DB);
try { await sync({ root: process.env.FIXTURES_ROOT, db }); } finally { db.close(); }`,
    ],
    {
      env: {
        ...process.env,
        CLAUDE_SESSIONS_DB: dbPath,
        FIXTURES_ROOT,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(seed.exitCode).toBe(0);
  expect(seed.stderr.toString()).toBe("");
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("stats command", () => {
  it("aggregates the fixture corpus by project", async () => {
    const result = await runCli(["stats", "--no-sync"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      command: "stats",
      count: 1,
      rows: [
        {
          group: "-Users-testuser-Code-sample-project",
          sessions: 11,
          messages: 13,
          tool_calls: 3,
          errors: 1,
          interruptions: 1,
          input_tokens: 10,
          output_tokens: 8037,
          cache_read_tokens: 192524,
          cache_create_tokens: 23375,
          duration_seconds: 4.69,
        },
      ],
    });
  });

  it("returns exact model, version, and session groupings", async () => {
    const modelResult = await runCli(["stats", "--no-sync", "--by=model"]);
    const versionResult = await runCli(["stats", "--no-sync", "--by=version"]);
    const sessionResult = await runCli(["stats", "--no-sync", "--by=session"]);

    expect(modelResult.code).toBe(0);
    expect(modelResult.stderr).toBe("");
    expect(JSON.parse(modelResult.stdout).rows).toEqual([
      statsRow(null, { sessions: 8, messages: 7, interruptions: 1 }),
      statsRow("claude-opus-4-8", {
        sessions: 1,
        messages: 1,
        tool_calls: 1,
        input_tokens: 2,
        output_tokens: 283,
        cache_read_tokens: 48679,
        cache_create_tokens: 2370,
      }),
      statsRow("claude-opus-5", {
        sessions: 1,
        messages: 2,
        tool_calls: 1,
        errors: 1,
        input_tokens: 2,
        output_tokens: 7748,
        cache_read_tokens: 143845,
        cache_create_tokens: 5753,
        duration_seconds: 0.559,
      }),
      statsRow("claude-sonnet-4-6", {
        sessions: 1,
        messages: 3,
        tool_calls: 1,
        input_tokens: 6,
        output_tokens: 6,
        cache_create_tokens: 15252,
        duration_seconds: 4.131,
      }),
    ]);

    expect(versionResult.code).toBe(0);
    expect(versionResult.stderr).toBe("");
    expect(JSON.parse(versionResult.stdout).rows).toEqual([
      statsRow(null, { sessions: 3, messages: 3 }),
      statsRow("2.1.154", {
        sessions: 1,
        messages: 1,
        tool_calls: 1,
        input_tokens: 2,
        output_tokens: 283,
        cache_read_tokens: 48679,
        cache_create_tokens: 2370,
      }),
      statsRow("2.1.198", { sessions: 2, messages: 2 }),
      statsRow("2.1.246", {
        sessions: 2,
        messages: 3,
        tool_calls: 1,
        errors: 1,
        input_tokens: 2,
        output_tokens: 7748,
        cache_read_tokens: 143845,
        cache_create_tokens: 5753,
        duration_seconds: 0.559,
      }),
      statsRow("2.1.247", { sessions: 1, messages: 1, interruptions: 1 }),
      statsRow("2.1.263", { sessions: 1 }),
      statsRow("2.1.45", {
        sessions: 1,
        messages: 3,
        tool_calls: 1,
        input_tokens: 6,
        output_tokens: 6,
        cache_create_tokens: 15252,
        duration_seconds: 4.131,
      }),
    ]);

    expect(sessionResult.code).toBe(0);
    expect(sessionResult.stderr).toBe("");
    expect(JSON.parse(sessionResult.stdout).rows).toEqual([
      statsRow("sample-parent-session", {
        sessions: 1,
        messages: 3,
        tool_calls: 1,
        input_tokens: 6,
        output_tokens: 6,
        cache_create_tokens: 15252,
        duration_seconds: 4.131,
      }),
      statsRow("session-ai-title", { sessions: 1, messages: 1 }),
      statsRow("session-attachment", { sessions: 1 }),
      statsRow("session-block-content", {
        sessions: 1,
        messages: 1,
        tool_calls: 1,
        input_tokens: 2,
        output_tokens: 283,
        cache_read_tokens: 48679,
        cache_create_tokens: 2370,
      }),
      statsRow("session-injected", { sessions: 1, messages: 1 }),
      statsRow("session-interrupt", { sessions: 1, messages: 1, interruptions: 1 }),
      statsRow("session-malformed", { sessions: 1, messages: 1 }),
      statsRow("session-queue-operation", { sessions: 1, messages: 1 }),
      statsRow("session-string-content", { sessions: 1, messages: 1 }),
      statsRow("session-summary", { sessions: 1, messages: 1 }),
      statsRow("session-tool-error", {
        sessions: 1,
        messages: 2,
        tool_calls: 1,
        errors: 1,
        input_tokens: 2,
        output_tokens: 7748,
        cache_read_tokens: 143845,
        cache_create_tokens: 5753,
        duration_seconds: 0.559,
      }),
    ]);
  });

  it("includes subagent sessions when requested", async () => {
    const result = await runCli(["stats", "--no-sync", "--include-subagents"]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<Record<string, unknown>>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(document.rows).toEqual([
      {
        group: "-Users-testuser-Code-sample-project",
        sessions: 12,
        messages: 16,
        tool_calls: 4,
        errors: 1,
        interruptions: 1,
        input_tokens: 16,
        output_tokens: 8043,
        cache_read_tokens: 192524,
        cache_create_tokens: 38627,
        duration_seconds: 8.821,
      },
    ]);
  });

  it("groups sessions by their start day, including the missing timestamp group", async () => {
    const result = await runCli(["stats", "--no-sync", "--by=day"]);
    const document = JSON.parse(result.stdout) as {
      rows: Array<{
        group: string | null;
        sessions: number;
        messages: number;
        tool_calls: number;
        errors: number;
        interruptions: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_create_tokens: number;
        duration_seconds: number;
      }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.rows).toEqual([
      {
        group: null,
        sessions: 2,
        messages: 2,
        tool_calls: 0,
        errors: 0,
        interruptions: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        duration_seconds: 0,
      },
      {
        group: "2026-02-18",
        sessions: 1,
        messages: 3,
        tool_calls: 1,
        errors: 0,
        interruptions: 0,
        input_tokens: 6,
        output_tokens: 6,
        cache_read_tokens: 0,
        cache_create_tokens: 15252,
        duration_seconds: 4.131,
      },
      {
        group: "2026-05-29",
        sessions: 1,
        messages: 1,
        tool_calls: 1,
        errors: 0,
        interruptions: 0,
        input_tokens: 2,
        output_tokens: 283,
        cache_read_tokens: 48679,
        cache_create_tokens: 2370,
        duration_seconds: 0,
      },
      {
        group: "2026-07-02",
        sessions: 3,
        messages: 3,
        tool_calls: 0,
        errors: 0,
        interruptions: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        duration_seconds: 0,
      },
      {
        group: "2026-08-26",
        sessions: 1,
        messages: 1,
        tool_calls: 0,
        errors: 0,
        interruptions: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        duration_seconds: 0,
      },
      {
        group: "2026-08-27",
        sessions: 2,
        messages: 3,
        tool_calls: 1,
        errors: 1,
        interruptions: 1,
        input_tokens: 2,
        output_tokens: 7748,
        cache_read_tokens: 143845,
        cache_create_tokens: 5753,
        duration_seconds: 0.559,
      },
      {
        group: "2026-09-08",
        sessions: 1,
        messages: 0,
        tool_calls: 0,
        errors: 0,
        interruptions: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        duration_seconds: 0,
      },
    ]);
  });

  it("honors project and model filters", async () => {
    const result = await runCli([
      "stats",
      "--no-sync",
      "--by=project",
      "--project=sample-project",
      "--model=claude-opus-5",
    ]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<Record<string, unknown>>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(document.rows).toEqual([
      {
        group: "-Users-testuser-Code-sample-project",
        sessions: 1,
        messages: 2,
        tool_calls: 1,
        errors: 1,
        interruptions: 0,
        input_tokens: 2,
        output_tokens: 7748,
        cache_read_tokens: 143845,
        cache_create_tokens: 5753,
        duration_seconds: 0.559,
      },
    ]);
  });

  it("rejects an unknown grouping", async () => {
    const result = await runCli(["stats", "--no-sync", "--by=hour"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: Invalid --by: hour\n");
  });
});
