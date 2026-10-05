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
import { Console, Effect, Schema } from "effect";

/**
 * An expected filesystem or ownership failure while synchronizing local links.
 */
export class LocalLinkError extends Schema.TaggedError<LocalLinkError>()("LocalLinkError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const relativeLinkTarget = (from: string, to: string): string =>
  relative(from, to).split(sep).join("/");

const attempt = <A>(operation: () => A): Effect.Effect<A, LocalLinkError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      new LocalLinkError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const missingPath = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

const ensureDirectory = Effect.fn("localLinks.ensureDirectory")(function* (path: string) {
  yield* attempt(() => mkdirSync(path, { recursive: true }));
  const stats = yield* attempt(() => lstatSync(path));
  if (!stats.isDirectory()) {
    return yield* new LocalLinkError({
      message: `Refusing to use a non-directory path: ${path}`,
      cause: undefined,
    });
  }
});

const existingPath = (path: string): Effect.Effect<Stats | undefined, LocalLinkError> =>
  attempt(() => lstatSync(path)).pipe(
    Effect.catch((error) =>
      missingPath(error.cause) ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );

const ensureSymlink = Effect.fn("localLinks.ensureSymlink")(function* (
  root: string,
  linkPath: string,
  target: string,
  type: "dir" | "file",
  changes: string[],
) {
  const existing = yield* existingPath(linkPath);
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      return yield* new LocalLinkError({
        message: `Refusing to replace existing path: ${relative(root, linkPath)}`,
        cause: undefined,
      });
    }

    const existingTarget = yield* attempt(() => readlinkSync(linkPath));
    if (existingTarget !== target) {
      return yield* new LocalLinkError({
        message: `Refusing to replace unmanaged symlink ${relative(root, linkPath)} -> ${existingTarget}`,
        cause: undefined,
      });
    }
    return;
  }

  yield* attempt(() => symlinkSync(target, linkPath, type));
  changes.push(`Created ${relative(root, linkPath)} -> ${target}`);
});

const syncManagedLinks = Effect.fn("localLinks.syncManagedLinks")(function* (
  root: string,
  sourceDirectory: string,
  targetDirectory: string,
  sourcePaths: string[],
  type: "dir" | "file",
  changes: string[],
) {
  yield* ensureDirectory(targetDirectory);
  const expectedNames = new Set(sourcePaths.map((sourcePath) => basename(sourcePath)));

  for (const sourcePath of sourcePaths) {
    const name = basename(sourcePath);
    const linkPath = join(targetDirectory, name);
    const target = relativeLinkTarget(targetDirectory, sourcePath);
    yield* ensureSymlink(root, linkPath, target, type, changes);
  }

  const entries = yield* attempt(() => readdirSync(targetDirectory, { withFileTypes: true }));
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || expectedNames.has(entry.name)) continue;

    const linkPath = join(targetDirectory, entry.name);
    const expectedTarget = relativeLinkTarget(targetDirectory, join(sourceDirectory, entry.name));
    const actualTarget = yield* attempt(() => readlinkSync(linkPath));
    if (actualTarget !== expectedTarget) continue;

    yield* attempt(() => unlinkSync(linkPath));
    changes.push(`Removed stale link ${relative(root, linkPath)}`);
  }
});

/**
 * Builds a lazy, synchronous Effect that synchronizes repo-local discovery links.
 *
 * @param root - Repository root whose links should be synchronized.
 * @returns An Effect yielding the descriptions of created or removed links.
 */
export const syncLocalLinksEffect = Effect.fn("localLinks.sync")(function* (root: string) {
  const skillsDirectory = join(root, "skills");
  const agentsDirectory = join(root, "agents");
  const claudeDirectory = join(root, ".claude");
  const claudeSkillsDirectory = join(claudeDirectory, "skills");
  const claudeAgentsDirectory = join(claudeDirectory, "agents");
  const changes: string[] = [];

  const skillEntries = yield* attempt(() => readdirSync(skillsDirectory, { withFileTypes: true }));
  const skillPaths: string[] = [];
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(skillsDirectory, entry.name);
    const hasSkill = yield* attempt(() => existsSync(join(sourcePath, "SKILL.md")));
    if (hasSkill) skillPaths.push(sourcePath);
  }
  skillPaths.sort();

  const agentEntries = yield* attempt(() => readdirSync(agentsDirectory, { withFileTypes: true }));
  const agentPaths = agentEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(agentsDirectory, entry.name))
    .toSorted();

  yield* syncManagedLinks(root, skillsDirectory, claudeSkillsDirectory, skillPaths, "dir", changes);
  yield* syncManagedLinks(
    root,
    agentsDirectory,
    claudeAgentsDirectory,
    agentPaths,
    "file",
    changes,
  );

  const agentSkillsDirectory = join(root, ".agents");
  yield* ensureDirectory(agentSkillsDirectory);
  const agentSkillsLink = join(agentSkillsDirectory, "skills");
  const agentSkillsTarget = relativeLinkTarget(agentSkillsDirectory, claudeSkillsDirectory);
  yield* ensureSymlink(root, agentSkillsLink, agentSkillsTarget, "dir", changes);

  return changes;
});

/**
 * Synchronizes repo-local Claude and agent-discovery symlinks with the
 * canonical skills and agents directories.
 *
 * @param root - Repository root whose links should be synchronized.
 * @returns Descriptions of links created or removed during synchronization.
 */
export function syncLocalLinks(root: string): string[] {
  return Effect.runSync(syncLocalLinksEffect(root));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  Effect.runSync(
    Effect.gen(function* () {
      const changes = yield* syncLocalLinksEffect(root);
      yield* Console.log(changes.length > 0 ? changes.join("\n") : "Local links are up to date.");
    }),
  );
}
