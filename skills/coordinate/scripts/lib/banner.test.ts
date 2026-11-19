import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, runWith, tempDir } from "./fixture.ts";

const made: string[] = [];
const children: Bun.Subprocess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const cli = join(import.meta.dir, "..", "coordinate.ts");
const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };
const BANNER = "watcher for app is down; arm it (coordinate watch --follow)\n";
const self = { address: "t1", state: "live", name: "coord" };
const delegate = { address: "t2", state: "live", name: "fix-a", status: "working", turn: 1 };

const domain = async () => {
  const state = tempDir();
  made.push(state);
  const config = await Effect.runPromise(
    resolveConfig({ state_dir: state, backlog_dir: join(state, "md") }, "/c"),
  );
  await runWith(createDocument(config, "app"));
  return state;
};

const run = (env: Record<string, string>, args: string[]) => {
  const done = Bun.spawnSync(["bun", cli, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return { exit: done.exitCode, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
};

const members = (listing: unknown[]) => ({
  "fleet.role=coordinator": [self],
  "fleet.domain=app": listing,
});

const SHOW = ["backlog", "show", "--json", "--domain", "app"];

describe("watcher-down banner", () => {
  it("goes to stderr from a coordinator with a live delegate, leaving --json stdout as it was", async () => {
    const state = await domain();
    const quiet = run(cliEnv(state, COORDINATOR, undefined, {}, members([self])), SHOW);
    const shown = run(cliEnv(state, COORDINATOR, undefined, {}, members([self, delegate])), SHOW);
    expect(shown).toEqual({ exit: 0, stdout: quiet.stdout, stderr: BANNER });
    expect(JSON.parse(shown.stdout).domain).toBe("app");
  });

  it("keeps a refusal's exit code and message", async () => {
    const state = await domain();
    const env = cliEnv(state, COORDINATOR, undefined, {}, members([self, delegate]));
    expect(run(env, ["item", "add", ""])).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${BANNER}refused: title is empty\n`,
    });
  });

  it("is absent with no live delegate", async () => {
    const state = await domain();
    expect(run(cliEnv(state, COORDINATOR, undefined, {}, members([self])), SHOW).stderr).toBe("");
  });

  it("is absent while a watcher holds the domain's pid file", async () => {
    const state = await domain();
    const watcher = Bun.spawn(
      ["bun", "-e", "setTimeout(() => {}, 60_000)", "coordinate", "watch"],
      {
        env: process.env,
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    children.push(watcher);
    mkdirSync(join(state, "watch"), { recursive: true });
    writeFileSync(join(state, "watch", "app.pid"), `${watcher.pid}\n`);
    const env = cliEnv(state, COORDINATOR, undefined, {}, members([self, delegate]));
    expect(run(env, SHOW).stderr).toBe("");
    const calls = await Bun.file(join(state, "bin", "calls.log")).text();
    expect(calls.split("\n").filter((line) => line.startsWith("ls "))).toEqual([]);
  });

  it("is absent from a delegate terminal, item answer and watch", async () => {
    const state = await domain();
    const listing = members([self, delegate]);
    expect(run(cliEnv(state, { "fleet.domain": "app" }, undefined, {}, listing), SHOW).stderr).toBe(
      "",
    );
    const env = cliEnv(state, COORDINATOR, undefined, {}, listing);
    run(env, ["item", "add", "Pick a provider"]);
    run(env, ["item", "update", "i1", "--ask", "Which provider?"]);
    expect(run(env, ["item", "answer", "i1", "okta"]).stderr).toBe("");
    expect(run(env, ["watch", "--max-minutes", "0"]).stderr).toBe("");
  });

  it("is the first line of coordinate status, and not repeated on stderr", async () => {
    const state = await domain();
    const env = cliEnv(
      state,
      COORDINATOR,
      undefined,
      { t2: { ...delegate, status: { state: "working" }, labels: { "fleet.domain": "app" } } },
      members([self, delegate]),
    );
    const status = run(env, ["status"]);
    expect([status.exit, status.stdout.split("\n")[0], status.stderr]).toEqual([
      0,
      BANNER.trim(),
      "",
    ]);
  });
});
