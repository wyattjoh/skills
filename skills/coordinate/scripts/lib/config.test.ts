import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_BUILD_OUTPUT, expandHome, resolveConfig } from "./config.ts";
import { homedir } from "node:os";

const resolve = (raw: unknown, cores = 8) =>
  Effect.runPromise(resolveConfig(raw, "/cfg.json", cores));
const fail = (raw: unknown) => Effect.runPromise(Effect.flip(resolveConfig(raw, "/cfg.json", 8)));

describe("resolveConfig", () => {
  it("fills every default from an empty file", async () => {
    const config = await resolve({});
    expect(config.backlogDir).toBe(`${homedir()}/.config/coordinate/backlogs`);
    expect(config.stateDir).toBe(`${homedir()}/.local/state/coordinate`);
    expect(config.forges).toEqual({ "github.com": "github", "codeberg.org": "forgejo" });
    expect(config.buildOutput).toEqual([...DEFAULT_BUILD_OUTPUT]);
    expect(config.quietHours).toBe(24);
    expect(config.branchPrefix).toBe("wyattjoh/");
    expect(config.cores).toBe(8);
    expect(config.maxFleetDelegates).toBe(2);
    expect(config.maxFleetDelegatesOverride).toBe(undefined);
    expect(config.maxFleetDelegatesByMachine).toEqual({});
    expect([config.stateBackend, config.stateHome]).toEqual(["files", undefined]);
  });

  it("selects the herdr-doc backend with its home machine", async () => {
    const config = await resolve({ state_backend: "herdr-doc", state_home: "finbar" });
    expect([config.stateBackend, config.stateHome]).toEqual(["herdr-doc", "finbar"]);
  });

  it("takes the home's state dir as an absolute path, refusing a relative one", async () => {
    const config = await resolve({
      state_backend: "herdr-doc",
      state_home: "finbar",
      home_state_dir: "/Users/someone/.local/state/coordinate",
    });
    expect([config.homeStateDir, (await resolve({})).homeStateDir]).toEqual([
      "/Users/someone/.local/state/coordinate",
      undefined,
    ]);
    expect((await fail({ home_state_dir: "state" })).message).toBe(
      "home_state_dir must be an absolute path on the home machine",
    );
  });

  it("prefixes herdr-doc document names with cs. unless state_prefix names a test namespace", async () => {
    const [defaulted, chosen] = await Promise.all([
      resolve({}),
      resolve({ state_prefix: "ct1a2b3c." }),
    ]);
    expect([defaulted.statePrefix, chosen.statePrefix]).toEqual(["cs.", "ct1a2b3c."]);
    expect((await fail({ state_prefix: "Test." })).message).toBe(
      "state_prefix must start valid Herdr document names: Test.domains is not a Herdr document name (a-z 0-9 - _ . starting with a letter or digit)",
    );
  });

  it("refuses the herdr-doc backend without a home, and an unknown backend", async () => {
    const invalid = await Promise.all([
      fail({ state_backend: "herdr-doc" }),
      fail({ state_backend: "sqlite" }),
    ]);
    expect(invalid[0]?.message).toBe(
      "state_backend herdr-doc needs state_home, the Herdr machine name of the home that holds shared state",
    );
    expect(invalid[1]?.constructor.name).toBe("ConfigError");
  });

  it("sets the default fleet delegate budget from the injected core count", async () => {
    const config = await resolve({}, 16);
    expect(config.maxFleetDelegates).toBe(4);
  });

  it("accepts an explicit fleet delegate budget", async () => {
    const config = await resolve({ max_fleet_delegates: 6 });
    expect(config.maxFleetDelegates).toBe(6);
    expect(config.maxFleetDelegatesOverride).toBe(6);
  });

  it("accepts per-machine fleet delegate budget overrides", async () => {
    const config = await resolve({
      max_fleet_delegates: 6,
      max_fleet_delegates_by_machine: { local: 4, strix: 8 },
    });
    expect(config.maxFleetDelegates).toBe(6);
    expect(config.maxFleetDelegatesByMachine).toEqual({ local: 4, strix: 8 });
  });

  it("rejects non-positive or fractional per-machine budgets", async () => {
    const invalid = await Promise.all([
      fail({ max_fleet_delegates_by_machine: { strix: 0 } }),
      fail({ max_fleet_delegates_by_machine: { nigelsheldon: 1.5 } }),
    ]);
    expect(invalid.map((error) => error.message)).toEqual([
      "max_fleet_delegates_by_machine.strix must be a positive integer",
      "max_fleet_delegates_by_machine.nigelsheldon must be a positive integer",
    ]);
  });

  it("rejects a non-positive or fractional fleet delegate budget", async () => {
    const invalid = await Promise.all([
      fail({ max_fleet_delegates: 0 }),
      fail({ max_fleet_delegates: 1.5 }),
    ]);
    expect(invalid.map((error) => error.message)).toEqual([
      "max_fleet_delegates must be a positive integer",
      "max_fleet_delegates must be a positive integer",
    ]);
  });

  it("normalises state_dir, so backlog paths built on it have no doubled slash", async () => {
    const config = await resolve({ state_dir: "~/state/coordinate/" });
    expect(config.stateDir).toBe(`${homedir()}/state/coordinate`);
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
