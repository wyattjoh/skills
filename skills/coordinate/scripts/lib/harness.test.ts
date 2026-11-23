import { describe, expect, it } from "bun:test";
import { agentArgv, firstMessage, harnessOf, inLoginShell, skillPrefix } from "./harness.ts";

describe("skill prefix", () => {
  it("uses /name for Claude and /skill:name for pi", () => {
    expect(skillPrefix("claude", "implement")).toBe("/implement");
    expect(skillPrefix("pi", "implement-spec")).toBe("/skill:implement-spec");
    expect(
      firstMessage("pi", { kind: "skill", skill: "implement", args: ".scratch/spec.md" }),
    ).toBe("/skill:implement .scratch/spec.md");
    expect(
      firstMessage("claude", {
        kind: "skill",
        skill: "implement-spec",
        args: "3f2a via Tasks MCP. Keep one integration branch.",
        brief: "/w/.scratch/BRIEF.md",
      }),
    ).toBe(
      "/implement-spec 3f2a via Tasks MCP. Keep one integration branch. Also read /w/.scratch/BRIEF.md and follow its Boundary, Stop points and Report sections.",
    );
    expect(firstMessage("claude", { kind: "skill", skill: "pr-review", args: "42" })).toBe(
      "/pr-review 42",
    );
    expect(firstMessage("pi", { kind: "skill", skill: "pr-review", args: "42" })).toBe(
      "/skill:pr-review 42",
    );
    expect(firstMessage("claude", { kind: "brief", path: "/w/.scratch/BRIEF.md" })).toBe(
      "Read /w/.scratch/BRIEF.md and do what it says.",
    );
  });

  it("starts a coordinator with the domain as the coordinate skill's argument", () => {
    expect(firstMessage("claude", { kind: "skill", skill: "coordinate", args: "tasks" })).toBe(
      "/coordinate tasks",
    );
    expect(firstMessage("pi", { kind: "skill", skill: "coordinate", args: "tasks" })).toBe(
      "/skill:coordinate tasks",
    );
  });
});

describe("agentArgv", () => {
  const base = {
    name: "fix-a",
    session: "s-1",
    model: "openai/gpt",
    effort: "high",
    extraArgs: ["--x"],
    message: "go",
  };

  it("starts pi with a session id and thinking level", () => {
    expect(agentArgv({ ...base, harness: "pi", resume: false })).toEqual([
      "pi",
      "--session-id",
      "s-1",
      "--name",
      "fix-a",
      "--model",
      "openai/gpt",
      "--thinking",
      "high",
      "--x",
      "go",
    ]);
  });

  it("resumes pi with the same session id flag", () => {
    expect(
      agentArgv({ ...base, harness: "pi", resume: true, message: undefined, effort: undefined }),
    ).toEqual(["pi", "--session-id", "s-1", "--name", "fix-a", "--model", "openai/gpt", "--x"]);
  });

  it("starts and resumes Claude", () => {
    expect(agentArgv({ ...base, harness: "claude", model: "opus", resume: false })).toEqual([
      "claude",
      "--session-id",
      "s-1",
      "--name",
      "fix-a",
      "--model",
      "opus",
      "--effort",
      "high",
      "--x",
      "go",
    ]);
    expect(
      agentArgv({
        ...base,
        harness: "claude",
        model: undefined,
        effort: undefined,
        resume: true,
        message: undefined,
      }),
    ).toEqual(["claude", "--resume", "s-1", "--name", "fix-a", "--x"]);
  });
});

describe("inLoginShell", () => {
  it("execs the agent through a POSIX login shell", () => {
    expect(inLoginShell("/bin/zsh", ["pi"])).toEqual([
      "/bin/zsh",
      "-lic",
      'exec "$@"',
      "/bin/zsh",
      "pi",
    ]);
    expect(inLoginShell("/usr/bin/fish", ["pi"])).toEqual([
      "/bin/sh",
      "-lic",
      'exec "$@"',
      "/bin/sh",
      "pi",
    ]);
  });
});

describe("harnessOf", () => {
  it("maps hc app names", () => {
    expect([harnessOf("pi"), harnessOf("claude-code"), harnessOf("codex")]).toEqual([
      "pi",
      "claude",
      undefined,
    ]);
  });
});
