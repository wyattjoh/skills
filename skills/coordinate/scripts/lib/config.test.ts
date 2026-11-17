import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_BUILD_OUTPUT, expandHome, resolveConfig } from "./config.ts";
import { homedir } from "node:os";

const resolve = (raw: unknown) => Effect.runPromise(resolveConfig(raw, "/cfg.json"));
const fail = (raw: unknown) => Effect.runPromise(Effect.flip(resolveConfig(raw, "/cfg.json")));

describe("resolveConfig", () => {
  it("fills every default from an empty file", async () => {
    const config = await resolve({});
    expect(config.backlogDir).toBe(`${homedir()}/.config/coordinate/backlogs`);
    expect(config.stateDir).toBe(`${homedir()}/.local/state/coordinate`);
    expect(config.forges).toEqual({ "github.com": "github", "codeberg.org": "forgejo" });
    expect(config.buildOutput).toEqual([...DEFAULT_BUILD_OUTPUT]);
    expect(config.quietHours).toBe(24);
    expect(config.branchPrefix).toBe("wyattjoh/");
  });

  it("ignores retired upstream keys and merges forges", async () => {
    const config = await resolve({
      pr_limits: { a: 1 },
      inbox_store: null,
      forges: { "git.example.net": "forgejo" },
      build_output: ["out"],
    });
    expect(config.forges["git.example.net"]).toBe("forgejo");
    expect(config.buildOutput.at(-1)).toBe("out");
  });

  it("rejects unknown keys by name", async () => {
    const error = await fail({ nope: 1 });
    expect(error.constructor.name).toBe("ConfigError");
    expect(error.message.startsWith("unknown keys: nope.")).toBe(true);
  });

  it("rejects a wrong type", async () => {
    const error = await fail({ keep_running: "app" });
    expect(error.constructor.name).toBe("ConfigError");
  });

  it("rejects a non-object", async () => {
    expect((await fail([])).message).toBe("holds no JSON object");
  });
});

describe("expandHome", () => {
  it("expands a leading tilde only", () => {
    expect(expandHome("~/x")).toBe(`${homedir()}/x`);
    expect(expandHome("/a/~/b")).toBe("/a/~/b");
  });
});
