import { resolveProjectIdentity } from "../lib/project-identity.ts";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./search.ts";
import { openDb } from "../lib/db.ts";
import { sync } from "../lib/ingest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_IDENTITY = resolveProjectIdentity(".")!;
const CLI = join(HERE, "..", "cli.ts");
const FIXTURES_ROOT = join(HERE, "..", "testdata", "corpus");

type SearchDocument = {
  command: string;
  count: number;
  rows: Array<Record<string, unknown>>;
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let databaseDir: string;
let databasePath: string;
let homeDir: string;

async function runCli(
  args: string[],
  dbPath = databasePath,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env,
      ...extraEnv,
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
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-search-db-"));
  return { dir, path: join(dir, "index.db") };
}

function searchRecord(uuid: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp,
    sessionId: "session-regex-test",
    cwd: "/tmp/regex-test",
    message: { role: "user", content: text },
  });
}

async function makeIndexedCorpus(
  records: string[],
  prefix: string,
): Promise<{ corpusDir: string; databaseDir: string; databasePath: string }> {
  const corpusDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", `${prefix}-root-`));
  const projectDir = join(corpusDir, "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "session-regex-test.jsonl"), `${records.join("\n")}\n`);

  const database = await makeDatabase();
  const db = openDb(database.path);
  try {
    await sync({ root: corpusDir, db });
  } finally {
    db.close();
  }
  return { corpusDir, databaseDir: database.dir, databasePath: database.path };
}

async function runSearch(argv: string[]): Promise<SearchDocument> {
  const result = await runCli(["search", "--no-sync", ...argv]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as SearchDocument;
}

beforeAll(async () => {
  const database = await makeDatabase();
  databaseDir = database.dir;
  databasePath = database.path;
  homeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-search-home-"));

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

describe("search command", () => {
  it("declares the search flags used by the CLI contract", () => {
    expect(command.options.map((option) => option.name).toSorted()).toEqual([
      "cache",
      "context",
      "in",
      "include-injected",
      "include-subagents",
      "judge",
      "judge-file",
      "limit",
      "max-judge-rows",
      "min-confidence",
      "model",
      "project",
      "query",
      "redact",
      "regex",
      "session",
      "since",
      "table",
      "type",
      "until",
    ]);
    expect(command.options.find((option) => option.name === "regex")?.type).toBe("string");
  });

  it("keeps search rows when relevance is missing --query", async () => {
    const baseline = await runSearch(["Juliet"]);
    const result = await runCli(
      ["search", "Juliet", "--no-sync", "--judge=relevance"],
      databasePath,
      { TYPESAFE_API_KEY: "" },
    );
    const document = JSON.parse(result.stdout) as SearchDocument & {
      judge: Record<string, unknown>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("judge: skipped (bad_answer)\n");
    expect(document.command).toBe("search");
    expect(document.count).toBe(baseline.count);
    expect(document.judge).toEqual({
      status: "skipped",
      reason: "bad_answer",
      error_class: null,
      rows_judged: 0,
      rows_cached: 0,
      estimated_input_tokens: 0,
    });
    expect(document.rows.map(({ judge: _judge, ...row }) => row)).toEqual(baseline.rows);
    expect(document.rows.map((row) => row.judge)).toEqual(
      baseline.rows.map(() => ({
        status: "skipped",
        reason: "bad_answer",
        error_class: null,
      })),
    );
  });

  it("finds a string-content user message through FTS", async () => {
    const document = await runSearch([
      "Juliet",
      "--session=session-string-content",
      "--type=user",
      "--context=160",
    ]);

    expect(document).toEqual({
      command: "search",
      count: 1,
      rows: [
        {
          session_id: "session-string-content",
          project_dir: "-Users-testuser-Code-sample-project",
          project_identity: PROJECT_IDENTITY,
          timestamp: "2026-07-02T22:12:36.611Z",
          uuid: "uuid-0002",
          role: "user",
          snippet: "Juliet grove.lima amber onyx sierra kelp amber ember inlet onyx onyx juliet",
        },
      ],
    });
  });

  it("runs a regex-only search across the filtered scope", async () => {
    const document = await runSearch([
      "--regex=^Juliet",
      "--session=session-string-content",
      "--context=0",
    ]);

    expect(document.count).toBe(1);
    expect(document.rows.map((row) => row.uuid)).toEqual(["uuid-0002"]);
    expect(document.rows[0]?.snippet).toBe("Juliet...");
  });

  it("rejects regexes with nested quantifiers before evaluating candidates", async () => {
    const result = await runCli([
      "search",
      "--no-sync",
      "--regex=(a+)+$",
      "--session=session-string-content",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: Rejected --regex: nested or repeated quantified groups are not allowed.\n",
    );
  });

  it("allows one bounded variable repetition", async () => {
    const document = await runSearch([
      "--regex=^Juliet.{0,32}",
      "--session=session-string-content",
      "--context=0",
    ]);

    expect(document.count).toBe(1);
    expect(document.rows.map((row) => row.uuid)).toEqual(["uuid-0002"]);
  });

  it("rejects composed bounded repetitions", async () => {
    const result = await runCli([
      "search",
      "--no-sync",
      "--regex=a{0,999}a{0,999}b",
      "--session=session-string-content",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: Rejected --regex: multiple variable-length quantifiers are not allowed.\n",
    );
  });

  it("rejects oversized composed bounded repetitions", async () => {
    const result = await runCli([
      "search",
      "--no-sync",
      "--regex=a{0,999999999}a{0,999999999}a{0,999999999}b",
      "--session=session-string-content",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: Rejected --regex: repetition bounds must not exceed 32768 characters.\n",
    );
  });

  it("searches tool-call input with --in=tools", async () => {
    const document = await runSearch([
      "frost",
      "--in=tools",
      "--session=session-block-content",
      "--context=0",
    ]);

    expect(document.count).toBe(1);
    expect(document.rows).toEqual([
      {
        session_id: "session-block-content",
        project_dir: "-Users-testuser-Code-sample-project",
        project_identity: PROJECT_IDENTITY,
        timestamp: "2026-05-29T12:10:37.245Z",
        uuid: "uuid-0002",
        role: "tool",
        snippet: "...frost...",
        tool_name: "Delta",
      },
    ]);
  });

  it("filters message hits by role", async () => {
    const document = await runSearch(["Juliet", "--type=user", "--session=session-string-content"]);

    expect(document.rows.map((row) => row.role)).toEqual(["user"]);
    expect(document.rows.map((row) => row.session_id)).toEqual(["session-string-content"]);
  });

  it("excludes injected text unless it is explicitly included", async () => {
    const excluded = await runSearch(["caveat", "--session=session-injected"]);
    expect(excluded).toEqual({ command: "search", count: 0, rows: [] });

    const included = await runSearch([
      "caveat",
      "--session=session-injected",
      "--include-injected",
    ]);
    expect(included.count).toBe(1);
    expect(included.rows[0]).toMatchObject({
      session_id: "session-injected",
      uuid: "uuid-0002",
      role: "user",
    });
  });

  it("allows 1,000 regex candidates but rejects 1,001", async () => {
    const records = Array.from({ length: 1_001 }, (_, index) =>
      searchRecord(
        `boundary-${String(index).padStart(4, "0")}`,
        "2026-01-01T00:00:00.000Z",
        "boundary",
      ),
    );
    const allowedCorpus = await makeIndexedCorpus(
      records.slice(0, 1_000),
      "claude-sessions-regex-1000",
    );
    const rejectedCorpus = await makeIndexedCorpus(records, "claude-sessions-regex-1001");

    try {
      const allowed = await runCli(
        ["search", "--no-sync", "--regex=^boundary$", "--limit=1"],
        allowedCorpus.databasePath,
      );
      expect(allowed.code).toBe(0);
      expect(allowed.stderr).toBe("");
      expect((JSON.parse(allowed.stdout) as SearchDocument).count).toBe(1);

      const rejected = await runCli(
        ["search", "--no-sync", "--regex=^boundary$", "--limit=1"],
        rejectedCorpus.databasePath,
      );
      expect(rejected.code).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toBe("Error: Rejected --regex: candidate set exceeds 1000 rows.\n");
    } finally {
      await Promise.all([
        rm(allowedCorpus.corpusDir, { recursive: true, force: true }),
        rm(allowedCorpus.databaseDir, { recursive: true, force: true }),
        rm(rejectedCorpus.corpusDir, { recursive: true, force: true }),
        rm(rejectedCorpus.databaseDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("evaluates regexes against only the first 32 KiB of text", async () => {
    const corpus = await makeIndexedCorpus(
      [
        searchRecord(
          "long-text",
          "2026-01-01T00:00:00.000Z",
          `prefix ${"x".repeat(32 * 1024)}needle`,
        ),
      ],
      "claude-sessions-regex-text-limit",
    );

    try {
      const prefix = await runCli(
        ["search", "--no-sync", "--regex=^prefix", "--limit=1"],
        corpus.databasePath,
      );
      expect(prefix.code).toBe(0);
      expect(prefix.stderr).toBe("");
      expect((JSON.parse(prefix.stdout) as SearchDocument).count).toBe(1);

      const suffix = await runCli(
        ["search", "--no-sync", "--regex=needle", "--limit=1"],
        corpus.databasePath,
      );
      expect(suffix.code).toBe(0);
      expect(suffix.stderr).toBe("");
      expect((JSON.parse(suffix.stdout) as SearchDocument).count).toBe(0);
    } finally {
      await Promise.all([
        rm(corpus.corpusDir, { recursive: true, force: true }),
        rm(corpus.databaseDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("returns an empty envelope for a zero-hit query", async () => {
    const document = await runSearch(["term-that-is-not-in-the-fixtures"]);
    expect(document).toEqual({ command: "search", count: 0, rows: [] });
  });
});
