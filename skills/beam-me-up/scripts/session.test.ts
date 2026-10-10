import { describe, expect, it } from "bun:test";
import {
  agentNameFor,
  diffSections,
  encodeProjectDir,
  launchDirFromCwds,
  mapToRemoteHome,
  parseLockPid,
  parseSections,
  transcriptContext,
} from "./session.ts";

describe("encodeProjectDir", () => {
  it("matches Claude Code's folder for a worktree with + and . in its path", () => {
    expect(
      encodeProjectDir(
        "/Users/wyatt.johnson/Code/git.trex-neon.ts.net/wyattjoh/organismd/.claude/worktrees/wyattjoh+agents-no-service-cap",
      ),
    ).toBe(
      "-Users-wyatt-johnson-Code-git-trex-neon-ts-net-wyattjoh-organismd--claude-worktrees-wyattjoh-agents-no-service-cap",
    );
  });
});

describe("launchDirFromCwds", () => {
  it("picks the shortest recorded cwd", () => {
    expect(launchDirFromCwds(["/repo/wt/.scratch", "/repo/wt", "/repo/wt/sub"])).toBe("/repo/wt");
  });

  it("returns undefined when no cwd was recorded", () => {
    expect(launchDirFromCwds([])).toBeUndefined();
  });
});

describe("parseLockPid", () => {
  it("reads the pid from a Claude Code worktree lock", () => {
    expect(
      parseLockPid("claude session wyattjoh/x (pid 24013 start Thu Oct  8 06:52:44 2026)"),
    ).toBe(24013);
  });

  it("returns undefined for a lock without a pid", () => {
    expect(parseLockPid("locked by hand")).toBeUndefined();
  });
});

describe("mapToRemoteHome", () => {
  it("rewrites the home prefix", () => {
    expect(mapToRemoteHome("/Users/a/Code/x", "/Users/a", "/home/a")).toBe("/home/a/Code/x");
  });

  it("does not treat a sibling directory as inside home", () => {
    expect(mapToRemoteHome("/Users/ab/x", "/Users/a", "/home/a")).toBeUndefined();
  });
});

describe("agentNameFor", () => {
  it("slugs a label into a valid Herdr agent name", () => {
    expect(agentNameFor("wyattjoh+agents-no-service-cap", new Set())).toBe(
      "wyattjoh-agents-no-service-cap",
    );
  });

  it("truncates to Herdr's 32-character limit, leaving room for a suffix", () => {
    const long = "a".repeat(40);
    expect(agentNameFor(long, new Set())).toBe("a".repeat(32));
    expect(agentNameFor(long, new Set(["a".repeat(32)]))).toBe(`${"a".repeat(30)}-2`);
  });

  it("adds a numeric suffix when the name is live", () => {
    expect(agentNameFor("docs", new Set(["docs", "docs-2"]))).toBe("docs-3");
  });

  it("falls back to session for a label with no letters", () => {
    expect(agentNameFor("123", new Set())).toBe("session");
  });
});

describe("parseSections", () => {
  it("reads binary sections and marks failed ones undefined", () => {
    const bytes = new TextEncoder().encode("a\n3\nx\ny\nmissing\n-1\n\nb\n0\n\n");
    const sections = parseSections(bytes);
    expect([...sections.keys()]).toEqual(["a", "missing", "b"]);
    expect(new TextDecoder().decode(sections.get("a"))).toBe("x\ny");
    expect(sections.get("missing")).toBeUndefined();
    expect(sections.get("b")).toEqual(new Uint8Array());
  });

  it("rejects a truncated section", () => {
    expect(() => parseSections(new TextEncoder().encode("a\n10\nshort\n"))).toThrow(
      'Section "a" is truncated',
    );
  });
});

describe("diffSections", () => {
  it("lists changed and one-sided sections under the given prefixes", () => {
    expect(
      diffSections(
        { "code:head": "1", "session:x": "a", "probe:wt_dir": "1" },
        { "code:head": "1", "session:x": "b", "session:y": "c", "probe:wt_dir": "0" },
        ["code:", "session:"],
      ),
    ).toEqual(["session:x", "session:y"]);
  });
});

describe("transcriptContext", () => {
  it("collects cwd and gitBranch, skipping other lines", () => {
    const jsonl = [
      JSON.stringify({ type: "user", cwd: "/w", gitBranch: "main" }),
      'not json with "cwd"',
      JSON.stringify({ type: "summary" }),
      JSON.stringify({ cwd: "/w/sub" }),
    ].join("\n");
    expect(transcriptContext(jsonl)).toEqual({ cwds: ["/w", "/w/sub"], branches: ["main"] });
  });
});
