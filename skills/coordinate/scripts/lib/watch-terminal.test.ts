import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import { runWith, tempDir } from "./fixture.ts";
import { fakeProc, ok } from "./proc.ts";
import { armWatcher, stopWatcher, WATCHER_DOMAIN_LABEL } from "./watch-terminal.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const config = async () => {
  const state = tempDir("coordinate-watcher-terminal-");
  made.push(state);
  return Effect.runPromise(
    resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
  );
};

const owner = JSON.stringify({
  address: "t1",
  name: "coordinator",
  state: "live",
  labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
});

describe("domain watcher terminal", () => {
  it("launches a child with explicit owner and domain labels, without delegate or no-notify flags", async () => {
    const cfg = await config();
    const fake = fakeProc((argv) => {
      if (argv[1] === "get" && argv[2] === "t1") return ok(owner);
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "run") return ok('{"address":"t7"}');
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const info = await runWith(armWatcher(cfg, "app", "t1"), fake.layer);
    const run = fake.calls.find((call) => call.argv[1] === "run");
    expect(info).toEqual({
      state: "starting",
      terminal: "t7",
      pid: undefined,
      detail: undefined,
    });
    expect(run?.argv).toContain("--parent");
    expect(run?.argv).toContain("t1");
    expect(run?.argv).toContain(`--label`);
    expect(run?.argv).toContain(`${WATCHER_DOMAIN_LABEL}=app`);
    expect(run?.argv).toContain("fleet.role=watcher");
    expect(run?.argv).toContain("--deliver");
    expect(run?.argv).toContain("--domain");
    expect(run?.argv).toContain("--owner");
    expect(run?.argv).toContain("t1");
    expect(run?.argv.includes("fleet.domain=app")).toBe(false);
    expect(run?.argv.includes("--no-notify")).toBe(false);
    expect(run?.argv.includes("--outlive-parent")).toBe(false);
  });

  it("reuses a live watcher instead of launching a second terminal", async () => {
    const cfg = await config();
    const fake = fakeProc((argv) => {
      if (argv[1] === "get" && argv[2] === "t1") return ok(owner);
      if (argv[1] === "ls" && argv.includes(`${WATCHER_DOMAIN_LABEL}=app`))
        return ok('{"terminals":[{"address":"t7","state":"live"}]}');
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    expect(await runWith(armWatcher(cfg, "app", "t1"), fake.layer)).toEqual({
      state: "starting",
      terminal: "t7",
      pid: undefined,
      detail: undefined,
    });
    expect(fake.calls.filter((call) => call.argv[1] === "run")).toHaveLength(0);
  });

  it("ends the domain watcher on request", async () => {
    const cfg = await config();
    const fake = fakeProc((argv) => {
      if (argv[1] === "get" && argv[2] === "t1") return ok(owner);
      if (argv[1] === "ls") return ok('{"terminals":[{"address":"t7","state":"live"}]}');
      return ok("{}");
    });

    expect(await runWith(stopWatcher(cfg, "app", "t1"), fake.layer)).toEqual([
      "stopped watcher t7",
    ]);
    expect(fake.calls.map((call) => call.argv.slice(0, 3))).toContainEqual(["hc", "kill", "t7"]);
  });
});
