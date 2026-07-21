import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONCURRENCY,
  parseDefaults,
  readDefaults,
  resolveConfigPath,
  validateBranchPrefix,
  validateConcurrency,
  writeDefaults,
} from "./defaults.ts";

describe("resolveConfigPath", () => {
  it("returns the explicit override unchanged", () => {
    expect(resolveConfigPath("/custom/defaults.json")).toBe("/custom/defaults.json");
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg";
    try {
      expect(resolveConfigPath()).toBe("/xdg/task-orchestrator/defaults.json");
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(resolveConfigPath().endsWith("/.config/task-orchestrator/defaults.json")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("validateBranchPrefix", () => {
  it("accepts a plain namespace", () => {
    expect(validateBranchPrefix("wyattjoh")).toBe("wyattjoh");
  });

  it("accepts a slashed namespace and trims surrounding whitespace", () => {
    expect(validateBranchPrefix("  team/feature  ")).toBe("team/feature");
  });

  it("rejects an empty value", () => {
    expect(() => validateBranchPrefix("   ")).toThrow(/must not be empty/);
  });

  it("rejects internal whitespace", () => {
    expect(() => validateBranchPrefix("has space")).toThrow(/whitespace/);
  });

  it("rejects git-illegal characters", () => {
    expect(() => validateBranchPrefix("bad~ref")).toThrow(/~ \^ : \? \* \[/);
  });

  it("rejects a '..' sequence", () => {
    expect(() => validateBranchPrefix("a..b")).toThrow(/'\.\.'/);
  });

  it("rejects a trailing slash", () => {
    expect(() => validateBranchPrefix("trail/")).toThrow(/start or end with '\/'/);
  });

  it("rejects a leading dash", () => {
    expect(() => validateBranchPrefix("-dash")).toThrow(/start with '-'/);
  });

  it("rejects a '.lock' suffix", () => {
    expect(() => validateBranchPrefix("x.lock")).toThrow(/\.lock/);
  });
});

describe("validateConcurrency", () => {
  it("accepts a positive integer", () => {
    expect(validateConcurrency(3)).toBe(3);
  });

  it("rejects zero", () => {
    expect(() => validateConcurrency(0)).toThrow(/integer >= 1/);
  });

  it("rejects a non-integer", () => {
    expect(() => validateConcurrency(2.5)).toThrow(/integer >= 1/);
  });
});

describe("parseDefaults", () => {
  it("parses a full object", () => {
    expect(parseDefaults({ branchPrefix: "wyattjoh", concurrency: 5 })).toEqual({
      branchPrefix: "wyattjoh",
      concurrency: 5,
    });
  });

  it("defaults concurrency when omitted", () => {
    expect(parseDefaults({ branchPrefix: "wyattjoh" })).toEqual({
      branchPrefix: "wyattjoh",
      concurrency: DEFAULT_CONCURRENCY,
    });
  });

  it("rejects a missing branchPrefix", () => {
    expect(() => parseDefaults({ concurrency: 3 })).toThrow(/branchPrefix is required/);
  });

  it("rejects an array", () => {
    expect(() => parseDefaults(["wyattjoh"])).toThrow(/must be a JSON object/);
  });

  it("rejects a non-number concurrency", () => {
    expect(() => parseDefaults({ branchPrefix: "wyattjoh", concurrency: "3" })).toThrow(
      /concurrency must be a number/,
    );
  });
});

describe("readDefaults / writeDefaults", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-orch-defaults-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports configured:false for a missing file", () => {
    const path = join(dir, "missing", "defaults.json");
    expect(readDefaults(path)).toEqual({ configured: false, path });
  });

  it("round-trips a written file, creating parent directories", () => {
    const path = join(dir, "nested", "defaults.json");
    writeDefaults(path, { branchPrefix: "wyattjoh", concurrency: 4 });
    expect(readDefaults(path)).toEqual({
      configured: true,
      path,
      branchPrefix: "wyattjoh",
      concurrency: 4,
    });
  });

  it("writes pretty-printed JSON with a trailing newline", () => {
    const path = join(dir, "defaults.json");
    writeDefaults(path, { branchPrefix: "wyattjoh", concurrency: 3 });
    expect(readFileSync(path, "utf8")).toBe(
      '{\n  "branchPrefix": "wyattjoh",\n  "concurrency": 3\n}\n',
    );
  });

  it("throws on a present-but-corrupt file", () => {
    const path = join(dir, "defaults.json");
    writeFileSync(path, "{ not json");
    expect(() => readDefaults(path)).toThrow(/not valid JSON/);
  });
});
