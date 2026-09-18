import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./sync.ts";

describe("sync command", () => {
  it("exposes a stable command-module shape", () => {
    expect(command.name).toBe("sync");
    expect(typeof command.description).toBe("string");
    expect(Array.isArray(command.options)).toBe(true);
    expect(typeof command.run).toBe("function");
  });

  it("declares the documented options", () => {
    const names = command.options.map((o) => o.name).toSorted();
    expect(names).toEqual(["projects", "quiet", "redact", "root", "table", "vacuum"]);
  });

  it("prints a JSON summary to stdout for a small fixture corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-cmd-test-"));
    const dbDir = await mkdtemp(join(tmpdir(), "sync-cmd-db-"));
    const dbPath = join(dbDir, "index.db");

    const projectPath = join(root, "-Users-test-myapp");
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "s1.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        cwd: "/Users/test/myapp",
        version: "2.1.0",
        message: { role: "user", content: "hello" },
      }) + "\n",
    );

    const prevDb = process.env.CLAUDE_SESSIONS_DB;
    process.env.CLAUDE_SESSIONS_DB = dbPath;

    const originalLog = console.log;
    const logged: string[] = [];
    console.log = (msg: string) => logged.push(msg);

    try {
      await command.run(["--root", root, "--quiet"]);
    } finally {
      console.log = originalLog;
      if (prevDb === undefined) delete process.env.CLAUDE_SESSIONS_DB;
      else process.env.CLAUDE_SESSIONS_DB = prevDb;
      await rm(root, { recursive: true, force: true });
      await rm(dbDir, { recursive: true, force: true });
    }

    expect(logged).toHaveLength(1);
    const document = JSON.parse(logged[0]!);
    expect(document.command).toBe("sync");
    expect(document.count).toBe(1);
    expect(document.rows[0]).toMatchObject({
      scanned: 1,
      added: 1,
      updated: 0,
      removed: 0,
      unchanged: 0,
      malformed_lines: 0,
    });
    expect(typeof document.rows[0].elapsed_ms).toBe("number");
  });
});
