import { describe, expect, it } from "bun:test";
import { flagBoolean, flagString, flagStrings, parseArgv } from "./args.ts";

describe("parseArgv", () => {
  it("parses --key=value", () => {
    expect(parseArgv(["--project=myapp"])).toEqual({
      positionals: [],
      flags: { project: "myapp" },
    });
  });

  it("parses --key value as a separate token", () => {
    expect(parseArgv(["--project", "myapp"])).toEqual({
      positionals: [],
      flags: { project: "myapp" },
    });
  });

  it("parses a bare flag as boolean true", () => {
    expect(parseArgv(["--include-subagents"])).toEqual({
      positionals: [],
      flags: { "include-subagents": true },
    });
  });

  it("treats a bare flag followed by another flag as boolean true", () => {
    expect(parseArgv(["--errors-only", "--table"])).toEqual({
      positionals: [],
      flags: { "errors-only": true, table: true },
    });
  });

  it("collects repeated string flags into an array in declaration order", () => {
    expect(parseArgv(["--project=a", "--project=b", "--project", "c"])).toEqual({
      positionals: [],
      flags: { project: ["a", "b", "c"] },
    });
  });

  it("parses --no-x as an explicit false", () => {
    expect(parseArgv(["--no-redact"])).toEqual({
      positionals: [],
      flags: { redact: false },
    });
  });

  it("separates positionals from flags regardless of order", () => {
    expect(parseArgv(["search", "--limit=5", "hello world", "--table"])).toEqual({
      positionals: ["search", "hello world"],
      flags: { limit: "5", table: true },
    });
  });

  it("treats everything after a bare -- as positionals", () => {
    expect(parseArgv(["run", "--", "--not-a-flag", "--also-not"])).toEqual({
      positionals: ["run", "--not-a-flag", "--also-not"],
      flags: {},
    });
  });

  it("returns empty positionals and flags for an empty argv", () => {
    expect(parseArgv([])).toEqual({ positionals: [], flags: {} });
  });

  it("without a boolean flags list, a bare boolean flag swallows the next token", () => {
    // Documents the pre-fix hazard so a regression in the opposite
    // direction (dropping the schema entirely) is caught: callers that omit
    // `booleanFlags` for a flag they know is boolean will lose the token
    // that follows it.
    expect(parseArgv(["--table", "forgejo census"])).toEqual({
      positionals: [],
      flags: { table: "forgejo census" },
    });
  });

  it("does not consume the next token for a flag named in booleanFlags", () => {
    expect(parseArgv(["--table", "forgejo census"], ["table"])).toEqual({
      positionals: ["forgejo census"],
      flags: { table: true },
    });
  });

  it("keeps a query positional after a declared boolean flag for search", () => {
    expect(parseArgv(["--errors-only", "my query"], ["errors-only"])).toEqual({
      positionals: ["my query"],
      flags: { "errors-only": true },
    });
  });

  it("still parses --key=value for a flag named in booleanFlags", () => {
    expect(parseArgv(["--table=false"], ["table"])).toEqual({
      positionals: [],
      flags: { table: "false" },
    });
  });

  it("still parses --no-x for a flag named in booleanFlags", () => {
    expect(parseArgv(["--no-table"], ["table"])).toEqual({
      positionals: [],
      flags: { table: false },
    });
  });
});

describe("flagStrings", () => {
  it("returns an empty array when the flag is absent", () => {
    expect(flagStrings({}, "project")).toEqual([]);
  });

  it("wraps a single string value in an array", () => {
    expect(flagStrings({ project: "a" }, "project")).toEqual(["a"]);
  });

  it("returns the array as-is for a repeated flag", () => {
    expect(flagStrings({ project: ["a", "b"] }, "project")).toEqual(["a", "b"]);
  });

  it("returns an empty array for a boolean-valued flag", () => {
    expect(flagStrings({ project: true }, "project")).toEqual([]);
  });
});

describe("flagString", () => {
  it("returns undefined when the flag is absent", () => {
    expect(flagString({}, "model")).toBeUndefined();
  });

  it("returns the string value", () => {
    expect(flagString({ model: "opus" }, "model")).toBe("opus");
  });

  it("returns the last value for a repeated flag", () => {
    expect(flagString({ model: ["opus", "sonnet"] }, "model")).toBe("sonnet");
  });

  it("returns undefined for a boolean-valued flag", () => {
    expect(flagString({ model: true }, "model")).toBeUndefined();
  });
});

describe("flagBoolean", () => {
  it("returns the fallback when the flag is absent", () => {
    expect(flagBoolean({}, "table", false)).toBe(false);
  });

  it("returns true when the flag is present as a boolean true", () => {
    expect(flagBoolean({ table: true }, "table", false)).toBe(true);
  });

  it("returns false when the flag was negated with --no-x", () => {
    expect(flagBoolean({ redact: false }, "redact", true)).toBe(false);
  });

  it("defaults to false when no fallback is given", () => {
    expect(flagBoolean({}, "table")).toBe(false);
  });

  it("treats an explicit --flag=false as false", () => {
    expect(flagBoolean({ "include-subagents": "false" }, "include-subagents", false)).toBe(false);
  });

  it("treats an explicit --flag=0 as false", () => {
    expect(flagBoolean({ "include-subagents": "0" }, "include-subagents", false)).toBe(false);
  });

  it("treats an explicit --flag=no as false", () => {
    expect(flagBoolean({ "include-subagents": "no" }, "include-subagents", false)).toBe(false);
  });

  it("treats any other string value as true", () => {
    expect(flagBoolean({ "include-subagents": "true" }, "include-subagents", false)).toBe(true);
  });
});
