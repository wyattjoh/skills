import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import { failureOf, runWith, tempDir } from "./fixture.ts";
import { preflightStart } from "./preflight.ts";
import { fakeProc, ok } from "./proc.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const machine = async () => {
  const state = tempDir();
  made.push(state);
  const home = join(state, "home");
  mkdirSync(join(home, ".claude", "skills", "coordinate"), { recursive: true });
  const config = await Effect.runPromise(
    resolveConfig(
      {
        state_dir: state,
        backlog_dir: join(state, "md"),
        state_backend: "herdr-doc",
        state_home: "homebase",
      },
      "/c",
    ),
  );
  return { config, env: { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" } };
};

describe("preflightStart", () => {
  it("looks for bun in this machine's login shell, the PATH its Herdr terminals get", async () => {
    const { config, env } = await machine();
    const fake = fakeProc((argv) => (argv[0] === "/bin/zsh" ? ok("") : ok("{}")));
    const error = await failureOf(preflightStart(config, "app", env), fake.layer);
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "fake-core lacks bun on its login PATH; setting up fake-core belongs to fake-core's own domain, so file it there",
    );
    expect(fake.calls[0]?.argv).toEqual(["/bin/zsh", "-lc", "command -v bun"]);
  });

  it("passes when the login shell finds bun", async () => {
    const { config, env } = await machine();
    const fake = fakeProc(() => ok("/opt/bun/bin/bun\n"));
    await runWith(preflightStart(config, "app", env), fake.layer);
    expect(fake.calls.map((call) => call.argv)).toEqual([["/bin/zsh", "-lc", "command -v bun"]]);
  });
});
