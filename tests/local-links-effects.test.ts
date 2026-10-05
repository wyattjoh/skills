import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import {
  LocalLinkError,
  syncLocalLinks,
  syncLocalLinksEffect,
} from "../scripts/sync-local-links.ts";

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "effect-local-links-"));
  roots.push(root);
  mkdirSync(join(root, "skills", "example"), { recursive: true });
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "skills", "example", "SKILL.md"), "# Example\n");
  writeFileSync(join(root, "agents", "example.md"), "# Agent\n");
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local-link Effect pipeline", () => {
  it("defers filesystem work until the effect runs and can rerun safely", () => {
    const root = fixture();
    const program = syncLocalLinksEffect(root);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(Effect.runSync(program)).toEqual([
      "Created .claude/skills/example -> ../../skills/example",
      "Created .claude/agents/example.md -> ../../agents/example.md",
      "Created .agents/skills -> ../.claude/skills",
    ]);
    expect(Effect.runSync(program)).toEqual([]);
  });

  it("preserves the synchronous compatibility API", () => {
    const root = fixture();
    expect(syncLocalLinks(root).length).toBe(3);
    expect(syncLocalLinks(root)).toEqual([]);
  });

  it("returns typed ownership failures without modifying conflicting paths", () => {
    const root = fixture();
    const path = join(root, ".claude", "skills", "example");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.md"), "Keep this file.\n");
    const result = Effect.runSync(Effect.result(syncLocalLinksEffect(root)));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected an ownership failure");
    expect(result.failure instanceof LocalLinkError).toBe(true);
    expect(result.failure.message).toBe(
      "Refusing to replace existing path: .claude/skills/example",
    );
    expect(existsSync(join(path, "keep.md"))).toBe(true);
  });

  it("refuses unmanaged targets and leaves them untouched", () => {
    const root = fixture();
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    const path = join(root, ".claude", "skills", "example");
    symlinkSync("manual-target", path, "dir");
    const result = Effect.runSync(Effect.result(syncLocalLinksEffect(root)));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected an ownership failure");
    expect(result.failure.message).toBe(
      "Refusing to replace unmanaged symlink .claude/skills/example -> manual-target",
    );
    expect(readlinkSync(path)).toBe("manual-target");
  });

  it("normalizes missing-source failures with the original filesystem cause", () => {
    const root = fixture();
    rmSync(join(root, "agents"), { recursive: true });
    const result = Effect.runSync(Effect.result(syncLocalLinksEffect(root)));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected a missing-source failure");
    expect(result.failure instanceof LocalLinkError).toBe(true);
    expect(result.failure.cause instanceof Error).toBe(true);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });
});
