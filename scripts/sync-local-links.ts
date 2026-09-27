import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const relativeLinkTarget = (from: string, to: string): string =>
  relative(from, to).split(sep).join("/");

const ensureDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true });
  const stats = lstatSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to use a non-directory path: ${path}`);
  }
};

const existingPath = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const ensureSymlink = (
  root: string,
  linkPath: string,
  target: string,
  type: "dir" | "file",
  changes: string[],
): void => {
  const existing = existingPath(linkPath);
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace existing path: ${relative(root, linkPath)}`);
    }

    const existingTarget = readlinkSync(linkPath);
    if (existingTarget !== target) {
      throw new Error(
        `Refusing to replace unmanaged symlink ${relative(root, linkPath)} -> ${existingTarget}`,
      );
    }
    return;
  }

  symlinkSync(target, linkPath, type);
  changes.push(`Created ${relative(root, linkPath)} -> ${target}`);
};

const syncManagedLinks = (
  root: string,
  sourceDirectory: string,
  targetDirectory: string,
  sourcePaths: string[],
  type: "dir" | "file",
  changes: string[],
): void => {
  ensureDirectory(targetDirectory);
  const expectedNames = new Set(sourcePaths.map((sourcePath) => basename(sourcePath)));

  for (const sourcePath of sourcePaths) {
    const name = basename(sourcePath);
    const linkPath = join(targetDirectory, name);
    const target = relativeLinkTarget(targetDirectory, sourcePath);
    ensureSymlink(root, linkPath, target, type, changes);
  }

  for (const entry of readdirSync(targetDirectory, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || expectedNames.has(entry.name)) continue;

    const linkPath = join(targetDirectory, entry.name);
    const expectedTarget = relativeLinkTarget(targetDirectory, join(sourceDirectory, entry.name));
    if (readlinkSync(linkPath) !== expectedTarget) continue;

    unlinkSync(linkPath);
    changes.push(`Removed stale link ${relative(root, linkPath)}`);
  }
};

/**
 * Synchronizes repo-local Claude and agent-discovery symlinks with the
 * canonical skills and agents directories.
 *
 * @param root - Repository root whose links should be synchronized.
 * @returns Descriptions of links created or removed during synchronization.
 */
export function syncLocalLinks(root: string): string[] {
  const skillsDirectory = join(root, "skills");
  const agentsDirectory = join(root, "agents");
  const claudeDirectory = join(root, ".claude");
  const claudeSkillsDirectory = join(claudeDirectory, "skills");
  const claudeAgentsDirectory = join(claudeDirectory, "agents");
  const changes: string[] = [];

  const skillPaths = readdirSync(skillsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(skillsDirectory, entry.name, "SKILL.md")),
    )
    .map((entry) => join(skillsDirectory, entry.name))
    .toSorted();
  const agentPaths = readdirSync(agentsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(agentsDirectory, entry.name))
    .toSorted();

  syncManagedLinks(root, skillsDirectory, claudeSkillsDirectory, skillPaths, "dir", changes);
  syncManagedLinks(root, agentsDirectory, claudeAgentsDirectory, agentPaths, "file", changes);

  const agentSkillsDirectory = join(root, ".agents");
  ensureDirectory(agentSkillsDirectory);
  const agentSkillsLink = join(agentSkillsDirectory, "skills");
  const agentSkillsTarget = relativeLinkTarget(agentSkillsDirectory, claudeSkillsDirectory);
  ensureSymlink(root, agentSkillsLink, agentSkillsTarget, "dir", changes);

  return changes;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const changes = syncLocalLinks(root);
  console.log(changes.length > 0 ? changes.join("\n") : "Local links are up to date.");
}
