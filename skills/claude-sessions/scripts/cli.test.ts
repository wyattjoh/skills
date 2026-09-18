import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeGlobalFlags } from "./cli.ts";
import { openDb } from "./lib/db.ts";
import { sync } from "./lib/ingest.ts";
import { buildDocument, renderOutput } from "./lib/output.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cli.ts");
const FIXTURES_ROOT = join(HERE, "testdata", "corpus");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let seededDbDir: string;
let seededDbPath: string;
let homeDir: string;

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_SESSIONS_DB: seededDbPath,
      ...env,
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
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-cli-db-"));
  const path = join(dir, "index.db");
  return { dir, path };
}

async function writeSession(root: string, project: string, session: string): Promise<void> {
  const projectDir = join(root, project);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${session}.jsonl`),
    `${JSON.stringify({
      type: "user",
      uuid: `${session}-user`,
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: session,
      cwd: "/Users/test/alternate",
      version: "2.1.0",
      message: { role: "user", content: "alternate corpus" },
    })}\n`,
  );
}

beforeAll(async () => {
  seededDbDir = (await makeDatabase()).dir;
  seededDbPath = join(seededDbDir, "index.db");
  homeDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-cli-home-"));

  const db = openDb(seededDbPath);
  try {
    await sync({ root: FIXTURES_ROOT, db });
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await rm(seededDbDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("cli", () => {
  it("prints root help with every registered command and exits successfully", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const name of [
      "sync",
      "projects",
      "sessions",
      "search",
      "messages",
      "tools",
      "errors",
      "interruptions",
      "stats",
      "sql",
      "plans",
    ]) {
      expect(result.stdout.includes(`  ${name}`)).toBe(true);
    }
  });

  it("prints command-specific help without running the command", async () => {
    const result = await runCli(["sync", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: bun scripts/cli.ts sync [options]");
    expect(result.stdout).toContain("--root=<value>");
    expect(result.stdout).toContain("--projects=<value> (repeatable)");
  });

  it("preserves --no-sync after -- as a literal search query", () => {
    expect(routeGlobalFlags(["--", "--no-sync"])).toEqual({
      noSync: false,
      forwardedArgv: ["--", "--no-sync"],
    });
  });

  it("reports an unknown command with a clean error and exit code 1", async () => {
    const result = await runCli(["does-not-exist"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      'Unknown command: does-not-exist\nRun "bun scripts/cli.ts --help" to list commands.\n',
    );
  });

  it("runs the projects command with a clean JSON response", async () => {
    const result = await runCli(["projects", "--no-sync"]);
    const document = JSON.parse(result.stdout) as {
      command: string;
      count: number;
      rows: unknown[];
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.command).toBe("projects");
    expect(document.count).toBe(1);
    expect(document.rows).toHaveLength(1);
  });

  it("renders read-command rows in the JSON envelope", () => {
    const document = buildDocument("projects", [{ dir: "-Users-testuser-Code-sample-project" }]);

    expect(JSON.parse(renderOutput(document))).toEqual({
      command: "projects",
      count: 1,
      rows: [{ dir: "-Users-testuser-Code-sample-project" }],
    });
  });

  it("strips --no-sync before forwarding arguments to the command", async () => {
    const database = await makeDatabase();
    try {
      const result = await runCli(["sync", "--no-sync", "--root", FIXTURES_ROOT, "--quiet"], {
        CLAUDE_SESSIONS_DB: database.path,
      });
      const summary = JSON.parse(result.stdout) as Record<string, number>;

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(summary.scanned).toBe(12);
      expect(summary.added).toBe(12);
      expect(summary.removed).toBe(0);
    } finally {
      await rm(database.dir, { recursive: true, force: true });
    }
  });

  it("does not run the automatic sync before the sync command", async () => {
    const database = await makeDatabase();
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-cli-auto-"));
    try {
      await writeSession(join(home, ".claude", "projects"), "-Users-test-alternate", "alternate");
      const result = await runCli(["sync", "--root", FIXTURES_ROOT, "--quiet"], {
        CLAUDE_SESSIONS_DB: database.path,
        HOME: home,
      });
      const summary = JSON.parse(result.stdout) as Record<string, number>;

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(summary.scanned).toBe(12);
      expect(summary.added).toBe(12);
      expect(summary.removed).toBe(0);
    } finally {
      await rm(database.dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
