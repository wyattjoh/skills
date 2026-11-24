import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./fixture.ts";
import { archiveAppendScript, homeArchivePath } from "./state.ts";

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
      sh(archiveAppendScript({ stateDir, homeStateDir: undefined }, "app", first, here), there),
      sh(archiveAppendScript({ stateDir, homeStateDir: undefined }, "app", second, here), there),
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
    expect(
      sh(
        archiveAppendScript({ stateDir, homeStateDir: undefined }, "app", ["{}"], elsewhere),
        elsewhere,
      ),
    ).toBe(0);
    expect(readFileSync(join(stateDir, "backlogs", "app.archive.jsonl"), "utf8")).toBe("{}\n");
  });

  test("append in home_state_dir when the config names it", () => {
    const here = tempDir("coordinate-archive-named-here-");
    const named = tempDir("coordinate-archive-named-");
    const paths = { stateDir: join(here, "state"), homeStateDir: join(named, "it's state") };
    expect(sh(archiveAppendScript(paths, "app", ["{}"], here), here)).toBe(0);
    expect(readFileSync(join(named, "it's state", "backlogs", "app.archive.jsonl"), "utf8")).toBe(
      "{}\n",
    );
  });
});

describe("the archive path on the home", () => {
  test("is home_state_dir when set, else this machine's state path under the home user's HOME", () => {
    expect([
      homeArchivePath(
        { stateDir: "/Users/me/.local/state/coordinate", homeStateDir: "/srv/coordinate" },
        "app",
        "/home/them",
        "/Users/me",
      ),
      homeArchivePath(
        { stateDir: "/Users/me/.local/state/coordinate", homeStateDir: undefined },
        "app",
        "/home/them",
        "/Users/me",
      ),
      homeArchivePath(
        { stateDir: "/var/coordinate", homeStateDir: undefined },
        "app",
        "/home/them",
        "/Users/me",
      ),
    ]).toEqual([
      "/srv/coordinate/backlogs/app.archive.jsonl",
      "/home/them/.local/state/coordinate/backlogs/app.archive.jsonl",
      "/var/coordinate/backlogs/app.archive.jsonl",
    ]);
  });
});
