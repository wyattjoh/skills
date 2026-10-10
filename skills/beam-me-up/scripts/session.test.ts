import { describe, expect, it } from "bun:test";
import {
  agentNameFor,
  diffSections,
  encodeProjectDir,
  formatManifest,
  includeConflicts,
  launchDirFor,
  mapToRemoteHome,
  parseLockPid,
  parseManifest,
  parseSections,
  transcriptContext,
  transcriptRelation,
} from "./session.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("transcriptRelation", () => {
  it("classifies every relation between the two copies", () => {
    expect(transcriptRelation(bytes("ab\n"), undefined)).toBe("missing");
    expect(transcriptRelation(bytes("ab\n"), bytes("ab\n"))).toBe("same");
    expect(transcriptRelation(bytes("ab\ncd\n"), bytes("ab\n"))).toBe("behind");
    expect(transcriptRelation(bytes("ab\n"), bytes("ab\ncd\n"))).toBe("ahead");
    expect(transcriptRelation(bytes("ab\ncd\n"), bytes("ab\nxy\n"))).toBe("diverged");
    expect(transcriptRelation(bytes("ab\ncd\n"), bytes("xy\n"))).toBe("diverged");
  });
});

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

describe("launchDirFor", () => {
  it("picks the cwd matching the project folder when the session moved into a worktree", () => {
    const cwds = ["/repo", "/repo/.claude/worktrees/x+y", "/repo/.claude/worktrees/x+y/sub"];
    expect(launchDirFor(cwds, "-repo--claude-worktrees-x-y")).toBe("/repo/.claude/worktrees/x+y");
  });

  it("returns undefined when no cwd matches the folder", () => {
    expect(launchDirFor(["/elsewhere"], "-repo")).toBeUndefined();
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
    const input = new TextEncoder().encode("a\n3\nx\ny\nmissing\n-1\n\nb\n0\n\n");
    const sections = parseSections(input);
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
  it("lists source sections that differ or are missing on the target, ignoring target-only ones", () => {
    expect(
      diffSections(
        { "code:head": "1", "session:x": "a", "session:z": "z", "probe:wt_dir": "1" },
        { "code:head": "1", "session:x": "b", "session:y": "c", "probe:wt_dir": "0" },
        ["code:", "session:"],
      ),
    ).toEqual(["session:x", "session:z"]);
  });
});

const hash = (c: string) => c.repeat(64);

describe("include manifest", () => {
  it("round-trips checksums and marks target-only files, including paths with spaces", () => {
    const manifest = formatManifest(
      { "include:.scratch/a b.md": hash("a"), "include:.pi/x": hash("b"), "code:head": hash("c") },
      { "include:.scratch/a b.md": hash("a") },
    );
    expect(manifest).toBe(`${hash("a")} .scratch/a b.md\n${hash("b")}*.pi/x\n`);
    expect([...parseManifest(manifest)]).toEqual([
      [".scratch/a b.md", { hash: hash("a"), sourced: true }],
      [".pi/x", { hash: hash("b"), sourced: false }],
    ]);
  });

  it("flags target files edited or created since the last move", () => {
    const source = {
      "include:same": hash("1"),
      "include:stale": hash("2"),
      "include:edited": hash("3"),
      "include:kept-then-sourced": hash("4"),
    };
    const target = {
      "include:same": hash("1"),
      "include:stale": hash("9"),
      "include:edited": hash("8"),
      "include:created": hash("7"),
      "include:deleted-at-source": hash("6"),
      "include:kept-target-only": hash("5"),
      "include:kept-then-sourced": hash("0"),
    };
    const manifest = new Map([
      ["stale", { hash: hash("9"), sourced: true }],
      ["edited", { hash: hash("5"), sourced: true }],
      ["deleted-at-source", { hash: hash("6"), sourced: true }],
      ["kept-target-only", { hash: hash("5"), sourced: false }],
      ["kept-then-sourced", { hash: hash("0"), sourced: false }],
    ]);
    // A target-only file accepted earlier stays safe until the source would overwrite it.
    expect(includeConflicts(source, target, manifest)).toEqual([
      "created",
      "edited",
      "kept-then-sourced",
    ]);
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
