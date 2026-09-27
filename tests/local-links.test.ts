import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { syncLocalLinks } from "../scripts/sync-local-links.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const temporaryRoots: string[] = [];

const relativeLinkTarget = (from: string, to: string): string =>
  relative(from, to).split(sep).join("/");

const makeFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "skills-local-links-"));
  temporaryRoots.push(root);

  const skillDirectory = join(root, "skills", "example-skill");
  const agentsDirectory = join(root, "agents");
  mkdirSync(skillDirectory, { recursive: true });
  mkdirSync(agentsDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, "SKILL.md"), "# Example skill\n");
  writeFileSync(join(agentsDirectory, "example-agent.md"), "# Example agent\n");

  return root;
};

const directSymlinkNames = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .toSorted();

const publicSkillNames = (root: string): string[] => {
  const skillsDirectory = join(root, "skills");
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(skillsDirectory, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .toSorted();
};

const agentNames = (root: string): string[] =>
  readdirSync(join(root, "agents"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .toSorted();

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("repo-local discovery links", () => {
  it("keeps skill links in sync with skills/ and points each link at its source", () => {
    const skillNames = publicSkillNames(repositoryRoot);
    const claudeSkillsDirectory = join(repositoryRoot, ".claude", "skills");

    expect(directSymlinkNames(claudeSkillsDirectory)).toEqual(skillNames);
    for (const name of skillNames) {
      expect(readlinkSync(join(claudeSkillsDirectory, name))).toBe(
        relativeLinkTarget(claudeSkillsDirectory, join(repositoryRoot, "skills", name)),
      );
    }
  });

  it("keeps agent links in sync with agents/ and points each link at its source", () => {
    const names = agentNames(repositoryRoot);
    const claudeAgentsDirectory = join(repositoryRoot, ".claude", "agents");

    expect(directSymlinkNames(claudeAgentsDirectory)).toEqual(names);
    for (const name of names) {
      expect(readlinkSync(join(claudeAgentsDirectory, name))).toBe(
        relativeLinkTarget(claudeAgentsDirectory, join(repositoryRoot, "agents", name)),
      );
    }
  });

  it("keeps .agents/skills aliased to the Claude project skills directory", () => {
    const linkPath = join(repositoryRoot, ".agents", "skills");

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe("../.claude/skills");
  });
});

describe("syncLocalLinks", () => {
  it("creates missing links and is idempotent", () => {
    const root = makeFixture();
    const changes = syncLocalLinks(root);

    expect(changes).toEqual([
      "Created .claude/skills/example-skill -> ../../skills/example-skill",
      "Created .claude/agents/example-agent.md -> ../../agents/example-agent.md",
      "Created .agents/skills -> ../.claude/skills",
    ]);
    expect(syncLocalLinks(root)).toEqual([]);
  });

  it("removes stale managed links but leaves unrelated symlinks intact", () => {
    const root = makeFixture();
    syncLocalLinks(root);
    const manualLink = join(root, ".claude", "skills", "manual-skill");
    symlinkSync("manual-target", manualLink, "dir");
    rmSync(join(root, "skills", "example-skill"), { recursive: true });
    rmSync(join(root, "agents", "example-agent.md"));

    expect(syncLocalLinks(root)).toEqual([
      "Removed stale link .claude/skills/example-skill",
      "Removed stale link .claude/agents/example-agent.md",
    ]);
    expect(readlinkSync(manualLink)).toBe("manual-target");
  });

  it("refuses to replace a path that is not one of its symlinks", () => {
    const root = makeFixture();
    const conflictingPath = join(root, ".claude", "skills", "example-skill");
    mkdirSync(conflictingPath, { recursive: true });
    writeFileSync(join(conflictingPath, "local.md"), "Keep this file.\n");

    expect(() => syncLocalLinks(root)).toThrow(
      "Refusing to replace existing path: .claude/skills/example-skill",
    );
    expect(existsSync(join(conflictingPath, "local.md"))).toBe(true);
  });
});
