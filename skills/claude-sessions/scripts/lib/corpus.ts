/** Discover project directories, session files and optional subagent transcripts. */
import { Effect } from "effect";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runEffectPromise, tryPromiseIO } from "./io.ts";

/** @returns The default conversation corpus root. */
export function defaultCorpusRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export interface ProjectDirEntry {
  /** Encoded project directory name. */
  dir: string;
  /** Absolute path to the project directory. */
  path: string;
}

export interface CorpusFileEntry {
  path: string;
  projectDir: string;
  sessionId: string;
  parentSessionId?: string;
  metaPath?: string;
  kind: "session" | "subagent";
  size: number;
  mtimeMs: number;
}

const readDirectory = Effect.fn("corpus.readDirectory")(function* (path: string) {
  return yield* tryPromiseIO(`list ${path}`, () => fs.readdir(path, { withFileTypes: true }));
});
const optionalDirectory = (path: string) =>
  readDirectory(path).pipe(Effect.catch(() => Effect.succeed([])));
const optionalStat = (path: string) =>
  tryPromiseIO(`stat ${path}`, () => fs.stat(path)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
const missingDirectory = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/**
 * List project directories lazily, preserving missing-root behavior.
 * @param root - Corpus root to inspect.
 * @returns Project directories in deterministic name order.
 */
export const discoverProjectDirsEffect = Effect.fn("corpus.projects")(function* (
  root: string = defaultCorpusRoot(),
) {
  const entries = yield* readDirectory(root).pipe(
    Effect.catch((error) =>
      missingDirectory(error.cause) ? Effect.succeed([]) : Effect.fail(error),
    ),
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: entry.name, path: join(root, entry.name) }))
    .toSorted((a, b) => a.dir.localeCompare(b.dir));
});

/**
 * Preserve the Promise interface for listing project directories.
 * @param root - Corpus root to inspect.
 * @returns Project directories in deterministic name order.
 */
export function discoverProjectDirs(
  root: string = defaultCorpusRoot(),
): Promise<ProjectDirEntry[]> {
  return runEffectPromise(discoverProjectDirsEffect(root));
}

const discoverSubagentFilesEffect = Effect.fn("corpus.subagents")(function* (
  projectDir: string,
  projectPath: string,
) {
  const entries = yield* optionalDirectory(projectPath);
  const results: CorpusFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parentSessionId = entry.name;
    const subagentsDir = join(projectPath, parentSessionId, "subagents");
    const agentEntries = yield* optionalDirectory(subagentsDir);
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isFile()) continue;
      if (!agentEntry.name.startsWith("agent-") || !agentEntry.name.endsWith(".jsonl")) continue;
      const filePath = join(subagentsDir, agentEntry.name);
      const sessionId = agentEntry.name.slice("agent-".length, -".jsonl".length);
      const stat = yield* optionalStat(filePath);
      if (stat === undefined) continue;
      const metaCandidate = join(subagentsDir, `agent-${sessionId}.meta.json`);
      const metaStat = yield* optionalStat(metaCandidate);
      results.push({
        path: filePath,
        projectDir,
        sessionId,
        parentSessionId,
        metaPath: metaStat === undefined ? undefined : metaCandidate,
        kind: "subagent",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return results;
});

/**
 * List sessions and subagents through individual directory and stat boundaries.
 * @param projectDir - Encoded project name.
 * @param projectPath - Absolute project directory.
 * @returns The files that still exist when inspected.
 */
export const discoverProjectFilesEffect = Effect.fn("corpus.projectFiles")(function* (
  projectDir: string,
  projectPath: string,
) {
  const entries = yield* readDirectory(projectPath).pipe(
    Effect.catch((error) =>
      missingDirectory(error.cause) ? Effect.succeed([]) : Effect.fail(error),
    ),
  );
  const sessions: CorpusFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = join(projectPath, entry.name);
    const stat = yield* optionalStat(filePath);
    if (stat === undefined) continue;
    sessions.push({
      path: filePath,
      projectDir,
      sessionId: entry.name.slice(0, -".jsonl".length),
      kind: "session",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return [...sessions, ...(yield* discoverSubagentFilesEffect(projectDir, projectPath))];
});

/**
 * Preserve the Promise interface for listing a project's files.
 * @param projectDir - Encoded project name.
 * @param projectPath - Absolute project directory.
 * @returns Sessions and optional subagent files.
 */
export function discoverProjectFiles(
  projectDir: string,
  projectPath: string,
): Promise<CorpusFileEntry[]> {
  return runEffectPromise(discoverProjectFilesEffect(projectDir, projectPath));
}

/**
 * Compose sequential discovery across the corpus.
 * @param root - Corpus root to inspect.
 * @returns Every discovered session and subagent file.
 */
export const discoverCorpusEffect = Effect.fn("corpus.discover")(function* (
  root: string = defaultCorpusRoot(),
) {
  const projectDirs = yield* discoverProjectDirsEffect(root);
  const files: CorpusFileEntry[] = [];
  for (const project of projectDirs) {
    files.push(...(yield* discoverProjectFilesEffect(project.dir, project.path)));
  }
  return files;
});

/**
 * Preserve the Promise interface for discovering the whole corpus.
 * @param root - Corpus root to inspect.
 * @returns Every discovered session and subagent file.
 */
export function discoverCorpus(root: string = defaultCorpusRoot()): Promise<CorpusFileEntry[]> {
  return runEffectPromise(discoverCorpusEffect(root));
}
