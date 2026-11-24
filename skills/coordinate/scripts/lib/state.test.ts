import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./fixture.ts";
import { archiveAppendScript } from "./state.ts";

const sh = (script: string, home: string) =>
  Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, HOME: home } }).exitCode;

describe("archive appends on the home", () => {
  test("append under the home user's HOME at this machine's state path, line after line", () => {
    const here = tempDir("coordinate-archive-here-");
    const there = tempDir("coordinate-archive-there-");
    const stateDir = join(here, ".local", "state", "coordinate");
    const first = [`{"id":"i1","title":"it's \\"quoted\\""}`];
    const second = ['{"id":"i2","title":"café"}', '{"id":"i3"}'];
    expect([
      sh(archiveAppendScript(stateDir, "app", first, here), there),
      sh(archiveAppendScript(stateDir, "app", second, here), there),
    ]).toEqual([0, 0]);
    expect(
      readFileSync(
        join(there, ".local", "state", "coordinate", "backlogs", "app.archive.jsonl"),
        "utf8",
      ),
    ).toBe(`${first[0]}\n${second[0]}\n${second[1]}\n`);
  });

  test("append at the same absolute path when the state dir is outside HOME", () => {
    const stateDir = tempDir("coordinate-archive-abs-");
    const elsewhere = tempDir("coordinate-archive-home-");
    expect(sh(archiveAppendScript(stateDir, "app", ["{}"], elsewhere), elsewhere)).toBe(0);
    expect(readFileSync(join(stateDir, "backlogs", "app.archive.jsonl"), "utf8")).toBe("{}\n");
  });
});
