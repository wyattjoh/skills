import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cliEnv, tempDir } from "./fixture.ts";
import { loadingLink, WRAPPER_MARK, wrapperScript } from "./path-wrapper.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const cli = join(import.meta.dir, "..", "coordinate.ts");
const skillDir = join(import.meta.dir, "..", "..");
const bun = Bun.which("bun") ?? process.execPath;

/**
 * A sandbox: HOME under state with a Claude Code skill link to this checkout, and a PATH of the
 * fixture stubs, `~/.local/bin` when `onPath`, bun's folder and the system folders.
 */
const sandbox = (onPath: boolean) => {
  const state = tempDir("coordinate-path-wrapper-");
  made.push(state);
  const home = join(state, "home");
  const link = join(home, ".claude", "skills", "coordinate");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(skillDir, link);
  const localBin = join(home, ".local", "bin");
  const base = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": "app" });
  const env = {
    ...base,
    HOME: home,
    PATH: [
      join(state, "bin"),
      ...(onPath ? [localBin] : []),
      dirname(bun),
      "/usr/bin",
      "/bin",
    ].join(":"),
  };
  const run = (args: string[]) => {
    const result = Bun.spawnSync([bun, cli, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const lines = result.stdout.toString().trimEnd().split("\n");
    return { exit: result.exitCode, last: lines.at(-1) ?? "", stdout: result.stdout.toString() };
  };
  const start = () => run(["start", "app"]);
  return { home, link, localBin, target: join(localBin, "coordinate"), run, start };
};

describe("coordinate PATH wrapper", () => {
  it("writes ~/.local/bin/coordinate on start when missing, then leaves it on a rerun", () => {
    const { link, target, start } = sandbox(true);
    const first = start();
    expect(first.exit).toBe(0);
    expect(first.last).toBe(
      `wrote ${target}: coordinate now runs ${link}/scripts/coordinate.ts; allowlist prefix: coordinate *`,
    );
    const script = wrapperScript(bun, link);
    expect(readFileSync(target, "utf8")).toBe(script);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    const second = start();
    expect(second.exit).toBe(0);
    expect(second.last).toBe("no delegate of app has been quiet for 24h");
    expect(readFileSync(target, "utf8")).toBe(script);
  });

  it("runs the CLI through the written wrapper", () => {
    const { target, start } = sandbox(true);
    expect(start().exit).toBe(0);
    const result = Bun.spawnSync([target, "--help"], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([result.exitCode, result.stdout.toString().split("\n")[0]]).toEqual([0, "DESCRIPTION"]);
  });

  it("leaves a coordinate that is not this wrapper alone", () => {
    const { localBin, target, start } = sandbox(true);
    mkdirSync(localBin, { recursive: true });
    writeFileSync(target, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    const result = start();
    expect(result.exit).toBe(0);
    expect(result.last).toBe(
      `short name coordinate unavailable: ${target} exists and is not this wrapper; left it alone`,
    );
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("skips writing when ~/.local/bin is not on PATH", () => {
    const { localBin, target, start } = sandbox(false);
    const result = start();
    expect(result.exit).toBe(0);
    expect(result.last).toBe(
      `short name coordinate unavailable: ${localBin} is not on PATH; add it and run coordinate start again`,
    );
    expect(existsSync(target)).toBe(false);
  });

  it("writes the wrapper from status --resume too", () => {
    const { link, target, run, start } = sandbox(true);
    expect(start().exit).toBe(0);
    rmSync(target);
    const resumed = run(["status", "--resume", "--domain", "app"]);
    expect(resumed.exit).toBe(0);
    expect(resumed.last).toBe(
      `wrote ${target}: coordinate now runs ${link}/scripts/coordinate.ts; allowlist prefix: coordinate *`,
    );
    expect(readFileSync(target, "utf8")).toBe(wrapperScript(bun, link));
  });
});

describe("loadingLink", () => {
  it("picks the harness link that resolves to the running skill folder", () => {
    const home = tempDir("coordinate-links-");
    made.push(home);
    const claudeTarget = join(home, "patched", "claude-code", "coordinate");
    const piTarget = join(home, "patched", "pi", "coordinate");
    mkdirSync(claudeTarget, { recursive: true });
    mkdirSync(piTarget, { recursive: true });
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
    symlinkSync(claudeTarget, join(home, ".claude", "skills", "coordinate"));
    symlinkSync(piTarget, join(home, ".pi", "agent", "skills", "coordinate"));
    expect(loadingLink(home, piTarget)).toEqual({
      link: join(home, ".pi", "agent", "skills", "coordinate"),
      matched: true,
    });
    expect(loadingLink(home, claudeTarget)).toEqual({
      link: join(home, ".claude", "skills", "coordinate"),
      matched: true,
    });
    expect(loadingLink(home, join(home, "elsewhere"))).toEqual({
      link: join(home, ".claude", "skills", "coordinate"),
      matched: false,
    });
  });

  it("finds no link when no harness links the skill", () => {
    const home = tempDir("coordinate-links-");
    made.push(home);
    expect(loadingLink(home, home)).toBe(undefined);
  });

  it("marks the wrapper on its second line", () => {
    expect(wrapperScript("/b/bun", "/h/link").split("\n").slice(0, 3)).toEqual([
      "#!/bin/sh",
      WRAPPER_MARK,
      "exec '/b/bun' '/h/link/scripts/coordinate.ts' \"$@\"",
    ]);
  });
});
