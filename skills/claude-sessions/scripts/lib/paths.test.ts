import { describe, expect, it } from "bun:test";
import { decodeProjectDirLossy, encodeProjectDir } from "./paths.ts";

describe("encodeProjectDir", () => {
  it("replaces slashes with dashes", () => {
    expect(encodeProjectDir("/Users/john/projects/myapp")).toBe("-Users-john-projects-myapp");
  });

  it("replaces dots with dashes", () => {
    expect(encodeProjectDir("/Users/wyatt/repo/.claude/worktrees/foo")).toBe(
      "-Users-wyatt-repo--claude-worktrees-foo",
    );
  });

  it("matches a real observed encoding with a worktree suffix", () => {
    const cwd =
      "/Users/wyatt.johnson/Code/github.com/clerk/clerk-agent-approvals-workspace/.claude/worktrees/aie-1696-chunk-12";
    const encoded =
      "-Users-wyatt-johnson-Code-github-com-clerk-clerk-agent-approvals-workspace--claude-worktrees-aie-1696-chunk-12";
    expect(encodeProjectDir(cwd)).toBe(encoded);
  });
});

describe("decodeProjectDirLossy", () => {
  it("decodes root-prefixed paths", () => {
    expect(decodeProjectDirLossy("-Users-john-projects-myapp")).toBe("/Users/john/projects/myapp");
  });

  it("decodes paths without a root prefix", () => {
    expect(decodeProjectDirLossy("relative-path-here")).toBe("relative/path/here");
  });

  it("handles single-segment paths", () => {
    expect(decodeProjectDirLossy("-Users")).toBe("/Users");
  });

  it("is lossy: a hyphenated segment name decodes into extra path segments", () => {
    // "agent-toolkit" cannot be told apart from an encoded separator.
    const encoded = encodeProjectDir("/Users/wyatt/Code/agent-toolkit");
    expect(decodeProjectDirLossy(encoded)).toBe("/Users/wyatt/Code/agent/toolkit");
  });
});
