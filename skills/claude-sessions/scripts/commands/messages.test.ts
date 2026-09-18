import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./messages.ts";
import { openDb } from "../lib/db.ts";
import { sync } from "../lib/ingest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.ts");
const FIXTURES_ROOT = join(HERE, "..", "testdata", "corpus");

type MessagesDocument = {
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
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-messages-db-"));
  return { dir, path: join(dir, "index.db") };
}

function aroundRecord(sessionId: string, uuid: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp,
    sessionId,
    cwd: "/tmp/around-project",
    message: { role: "user", content: text },
  });
}

async function runMessages(argv: string[], dbPath = databasePath): Promise<MessagesDocument> {
  const result = await runCli(["messages", "--no-sync", ...argv], dbPath);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as MessagesDocument;
}

beforeAll(async () => {
  const database = await makeDatabase();
  databaseDir = database.dir;
  databasePath = database.path;
  homeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-messages-home-"));

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

describe("messages command", () => {
  it("declares the message flags used by the CLI contract", () => {
    expect(command.options.map((option) => option.name).toSorted()).toEqual([
      "around",
      "include-subagents",
      "include-thinking",
      "include-tools",
      "limit",
      "model",
      "project",
      "redact",
      "session",
      "since",
      "table",
      "until",
    ]);
  });

  it("shows a string-content user message", async () => {
    const document = await runMessages(["--session=session-string-content"]);

    expect(document).toEqual({
      command: "messages",
      count: 1,
      rows: [
        {
          session_id: "session-string-content",
          project_dir: "-Users-testuser-Code-sample-project",
          timestamp: "2026-07-02T22:12:36.611Z",
          uuid: "uuid-0002",
          parent_uuid: "uuid-0001",
          type: "user",
          role: "user",
          text: "Juliet grove.lima amber onyx sierra kelp amber ember inlet onyx onyx juliet",
          is_injected: false,
          is_interrupt_marker: false,
          is_sidechain: false,
          model: null,
          effort: null,
        },
      ],
    });
  });

  it("returns turns in timestamp order and omits tool-only turns by default", async () => {
    const document = await runMessages(["--session=sample-parent-session"]);

    expect(document.rows.map((row) => row.uuid)).toEqual(["uuid-0001", "uuid-0003"]);
    expect(document.rows.map((row) => row.timestamp)).toEqual([
      "2026-02-18T11:10:44.424Z",
      "2026-02-18T11:10:46.734Z",
    ]);
  });

  it("adds tool blocks when --include-tools is enabled", async () => {
    const document = await runMessages(["--session=sample-parent-session", "--include-tools"]);

    expect(document.rows.map((row) => row.uuid)).toEqual(["uuid-0001", "uuid-0003", "uuid-0005"]);
    expect(document.rows[2]?.text).toContain("[Tool: Delta]");
  });

  it("toggles non-empty thinking blocks", async () => {
    const thinkingRoot = await mkdtemp(join("/tmp", "claude-sessions-thinking-root-"));
    const projectPath = join(thinkingRoot, "-Users-testuser-Code-sample-project");
    const thinkingPath = join(projectPath, "session-thinking.jsonl");
    const thinkingRecord = {
      type: "assistant",
      uuid: "thinking-0001",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "session-thinking",
      cwd: "/Users/testuser/Code/sample-project",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "visible answer" },
        ],
      },
    };
    await mkdir(projectPath, { recursive: true });
    await writeFile(thinkingPath, `${JSON.stringify(thinkingRecord)}\n`);

    const thinkingDatabase = await makeDatabase();
    const thinkingDb = openDb(thinkingDatabase.path);
    try {
      await sync({ root: thinkingRoot, db: thinkingDb });
    } finally {
      thinkingDb.close();
    }

    try {
      const withoutThinking = await runMessages(
        ["--session=session-thinking"],
        thinkingDatabase.path,
      );
      const withThinking = await runMessages(
        ["--session=session-thinking", "--include-thinking"],
        thinkingDatabase.path,
      );

      expect(withoutThinking.rows.map((row) => row.text)).toEqual(["visible answer"]);
      expect(withThinking.rows.map((row) => row.text)).toEqual([
        "[Thinking]\nprivate reasoning\n[/Thinking]\n\nvisible answer",
      ]);
    } finally {
      await rm(thinkingRoot, { recursive: true, force: true });
      await rm(thinkingDatabase.dir, { recursive: true, force: true });
    }
  });

  it("marks injected turns instead of dropping them", async () => {
    const document = await runMessages(["--session=session-injected"]);

    expect(document.count).toBe(1);
    expect(document.rows[0]).toMatchObject({
      session_id: "session-injected",
      uuid: "uuid-0002",
      is_injected: true,
    });
  });

  it("clips --around windows at the start and end of a session", async () => {
    const start = await runMessages(["--session=sample-parent-session", "--around=uuid-0001:2"]);
    const end = await runMessages(["--session=sample-parent-session", "--around=uuid-0003:2"]);

    expect(start.rows.map((row) => row.uuid)).toEqual(["uuid-0001", "uuid-0003"]);
    expect(end.rows.map((row) => row.uuid)).toEqual(["uuid-0001", "uuid-0003"]);
  });

  it("scopes --around to the target session across multiple selected sessions", async () => {
    const corpusRoot = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "claude-sessions-around-root-"),
    );
    const projectPath = join(corpusRoot, "project");
    const database = await makeDatabase();

    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "session-around-target.jsonl"),
      [
        aroundRecord(
          "session-around-target",
          "target-before",
          "2026-01-01T00:00:00.000Z",
          "target before",
        ),
        aroundRecord(
          "session-around-target",
          "target-middle",
          "2026-01-01T00:00:02.000Z",
          "target middle",
        ),
        aroundRecord(
          "session-around-target",
          "target-after",
          "2026-01-01T00:00:04.000Z",
          "target after",
        ),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(projectPath, "session-around-other.jsonl"),
      [
        aroundRecord(
          "session-around-other",
          "other-before",
          "2026-01-01T00:00:01.000Z",
          "other before",
        ),
        aroundRecord(
          "session-around-other",
          "other-after",
          "2026-01-01T00:00:03.000Z",
          "other after",
        ),
      ].join("\n") + "\n",
    );

    const db = openDb(database.path);
    try {
      await sync({ root: corpusRoot, db });
    } finally {
      db.close();
    }

    try {
      const document = await runMessages(
        [
          "--session=session-around-target",
          "--session=session-around-other",
          "--around=target-middle:1",
        ],
        database.path,
      );

      expect(document.rows.map((row) => row.uuid)).toEqual([
        "target-before",
        "target-middle",
        "target-after",
      ]);
      expect(document.rows.map((row) => row.session_id)).toEqual([
        "session-around-target",
        "session-around-target",
        "session-around-target",
      ]);
    } finally {
      await rm(corpusRoot, { recursive: true, force: true });
      await rm(database.dir, { recursive: true, force: true });
    }
  });

  it("selects sessions from a project and applies the row limit", async () => {
    const document = await runMessages([
      "--project=-Users-testuser-Code-sample-project",
      "--limit=1",
    ]);

    expect(document.count).toBe(1);
    expect(document.rows[0]?.session_id).toBe("sample-parent-session");
  });
});
