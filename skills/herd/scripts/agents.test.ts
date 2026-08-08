import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDefinition,
  AgentParseError,
  loadAgents,
  parseAgentFile,
  resolveShadowing,
} from "./agents.ts";

const agent = (
  name: string,
  scope: "user" | "project",
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  name,
  description: "",
  model: null,
  effort: null,
  memory: null,
  tools: null,
  permissionMode: null,
  source: `/${scope}/${name}.md`,
  scope,
  ...overrides,
});

describe("parseAgentFile", () => {
  it("reads the fields that decide how a worker reasons", () => {
    const content = [
      "---",
      "name: code-reviewer",
      "description: Reviews code",
      "model: opus",
      "effort: high",
      "memory: user",
      "permissionMode: plan",
      "---",
      "",
      "You are a reviewer.",
    ].join("\n");
    expect(parseAgentFile(content, "/u/code-reviewer.md", "user")).toEqual({
      name: "code-reviewer",
      description: "Reviews code",
      model: "opus",
      effort: "high",
      memory: "user",
      tools: null,
      permissionMode: "plan",
      source: "/u/code-reviewer.md",
      scope: "user",
    });
  });

  it("reports absent model and effort as null so the caller knows they inherit", () => {
    const parsed = parseAgentFile("---\nname: plain\n---\nbody", "/u/plain.md", "user");
    expect(parsed.model).toBe(null);
    expect(parsed.effort).toBe(null);
  });

  it("normalizes a YAML list of tools into a comma-separated string", () => {
    const content = ["---", "name: r", "tools:", "  - Read", "  - Grep", "---"].join("\n");
    expect(parseAgentFile(content, "/u/r.md", "user").tools).toBe("Read, Grep");
  });

  it("keeps a comma-separated tools string as written", () => {
    const content = ["---", "name: r", 'tools: "Read, Grep"', "---"].join("\n");
    expect(parseAgentFile(content, "/u/r.md", "user").tools).toBe("Read, Grep");
  });

  it("throws when the file has no frontmatter", () => {
    expect(() => parseAgentFile("just a body", "/u/x.md", "user")).toThrow(AgentParseError);
  });

  it("throws when name is missing", () => {
    expect(() => parseAgentFile("---\ndescription: d\n---\n", "/u/x.md", "user")).toThrow(
      "/u/x.md: missing required 'name'",
    );
  });

  it("throws on malformed YAML", () => {
    expect(() => parseAgentFile("---\nname: [unclosed\n---\n", "/u/x.md", "user")).toThrow(
      AgentParseError,
    );
  });
});

describe("resolveShadowing", () => {
  it("prefers the project definition over a user definition of the same name", () => {
    const resolved = resolveShadowing([agent("worker", "user"), agent("worker", "project")]);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.scope).toBe("project");
  });

  it("keeps agents that exist in only one scope", () => {
    const resolved = resolveShadowing([agent("a", "user"), agent("b", "project")]);
    expect(resolved.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("sorts the result by name", () => {
    const resolved = resolveShadowing([agent("zed", "user"), agent("alpha", "user")]);
    expect(resolved.map((r) => r.name)).toEqual(["alpha", "zed"]);
  });
});

describe("loadAgents", () => {
  it("finds agents nested in subdirectories and records parse failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-agents-"));
    mkdirSync(join(dir, "review"), { recursive: true });
    writeFileSync(join(dir, "top.md"), "---\nname: top\n---\nbody");
    writeFileSync(join(dir, "review", "deep.md"), "---\nname: deep\n---\nbody");
    writeFileSync(join(dir, "broken.md"), "no frontmatter here");
    writeFileSync(join(dir, "ignored.txt"), "---\nname: nope\n---");

    const { agents, errors } = loadAgents([{ dir, scope: "user" }]);
    expect(agents.map((a) => a.name).toSorted()).toEqual(["deep", "top"]);
    expect(errors.length).toBe(1);
  });

  it("returns empty results for a directory that does not exist", () => {
    const { agents, errors } = loadAgents([
      { dir: join(tmpdir(), "herd-no-agents-here"), scope: "user" },
    ]);
    expect(agents).toEqual([]);
    expect(errors).toEqual([]);
  });
});
