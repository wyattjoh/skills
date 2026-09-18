import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getFileCreatedTime, searchPlans } from "./plans.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const CLI = join(HERE, "..", "cli.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let plansRoot: string;
let homePath: string;

async function runCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    env: {
      ...process.env,
      HOME: homePath,
      CLAUDE_SESSIONS_DB: join(tempDir, "unused.db"),
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
  tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "claude-sessions-plans-"));
  plansRoot = join(tempDir, "plans");
  homePath = join(tempDir, "home");
  await mkdir(plansRoot, { recursive: true });
  await mkdir(join(homePath, ".claude", "plans"), { recursive: true });
  await writeFile(
    join(plansRoot, "implement-auth.md"),
    "# Authentication\n\nChoose an authentication provider. Authentication tests cover the login flow.\n",
  );
  await writeFile(
    join(plansRoot, "refactor-database.md"),
    "# Database refactor\n\nMove the storage adapter behind the smaller interface for the migration.\n",
  );
  await writeFile(join(plansRoot, "notes.txt"), "Authentication in a non-plan file\n");
  await writeFile(join(homePath, ".claude", "plans", "home-plan.md"), "Home-only pattern\n");
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("plans command", () => {
  it("searches markdown plans under the overridden root", async () => {
    const result = await runCli([
      "plans",
      "--no-sync",
      `--root=${plansRoot}`,
      "--pattern=authentication",
      "--context=12",
    ]);
    const document = JSON.parse(result.stdout) as {
      command: string;
      count: number;
      rows: Array<{
        filename: string;
        filepath: string;
        timestamp: string;
        snippet: string;
        match_count: number;
      }>;
    };

    const row = document.rows[0];

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.command).toBe("plans");
    expect(document.count).toBe(1);
    expect(
      document.rows.map(({ filename, filepath, snippet, match_count }) => ({
        filename,
        filepath,
        snippet,
        match_count,
      })),
    ).toEqual([
      {
        filename: "implement-auth.md",
        filepath: join(plansRoot, "implement-auth.md"),
        snippet: "# Authentication Choose an ...",
        match_count: 3,
      },
    ]);
    expect(row?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("sorts by match count and respects the result limit", async () => {
    const result = await runCli([
      "plans",
      "--no-sync",
      `--root=${plansRoot}`,
      "--pattern=the ",
      "--limit=1",
    ]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<{ filename: string; match_count: number }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(document.rows.length).toBe(1);
    expect(document.rows.map(({ filename, match_count }) => ({ filename, match_count }))).toEqual([
      { filename: "refactor-database.md", match_count: 3 },
    ]);
  });

  it("skips a plan that disappears before its timestamp can be read", async () => {
    const racedFile = join(plansRoot, "raced-plan.md");
    await writeFile(racedFile, "raced plan content\n");

    try {
      const rows = await searchPlans(
        {
          pattern: "raced",
          root: plansRoot,
          limit: 10,
          context: 150,
        },
        {
          getFileCreatedTime: async (filepath) => {
            await rm(filepath, { force: true });
            return getFileCreatedTime(filepath);
          },
        },
      );

      expect(rows).toEqual([]);
    } finally {
      await rm(racedFile, { force: true });
    }
  });

  it("uses the shared table envelope", async () => {
    const result = await runCli([
      "plans",
      "--no-sync",
      `--root=${plansRoot}`,
      "--pattern=authentication",
      "--table",
    ]);

    const lines = result.stdout.trimEnd().split("\n");
    const header = lines[0]?.split(/\s{2,}/);
    const cells = lines[2]?.split(/\s{2,}/);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines.length).toBe(3);
    expect(header).toEqual(["filename", "filepath", "timestamp", "snippet", "match_count"]);
    expect(cells?.slice(0, 2)).toEqual(["implement-auth.md", join(plansRoot, "implement-auth.md")]);
    expect(cells?.[3]).toBe(
      "# Authentication Choose an authentication provider. Authentication tests cover the login flow.",
    );
    expect(cells?.[4]).toBe("3");
    expect(cells?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("uses HOME for the default plans root", async () => {
    const result = await runCli(["plans", "--no-sync", "--pattern=home-only"]);
    const document = JSON.parse(result.stdout) as {
      count: number;
      rows: Array<{ filename: string; match_count: number }>;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(document.count).toBe(1);
    expect(document.rows.map(({ filename, match_count }) => ({ filename, match_count }))).toEqual([
      { filename: "home-plan.md", match_count: 1 },
    ]);
  });

  it("requires a pattern", async () => {
    const result = await runCli(["plans", "--no-sync", `--root=${plansRoot}`]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: plans requires --pattern=<text>\n");
  });
});
