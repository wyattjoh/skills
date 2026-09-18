/**
 * Discover the on-disk shape of the conversation corpus under
 * ~/.claude/projects/ (or a configurable root): project directories,
 * top-level session files, and subagent transcripts nested at
 * `<session-id>/subagents/agent-*.jsonl`.
 *
 * This module only stats and lists paths; parsing file contents is
 * ingest.ts's job.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultCorpusRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export interface ProjectDirEntry {
  /** Encoded project directory name (see lib/paths.ts). */
  dir: string;
  /** Absolute path to the project directory. */
  path: string;
}

export interface CorpusFileEntry {
  /** Absolute path to the .jsonl file. */
  path: string;
  /** Encoded project directory name this file belongs to. */
  projectDir: string;
  /** Session id: the top-level filename for a session, the agent id for a subagent transcript. */
  sessionId: string;
  /** Session id of the transcript that spawned this subagent, if `kind` is "subagent". */
  parentSessionId?: string;
  /** Path to the subagent's `.meta.json` sidecar, if `kind` is "subagent" and it exists. */
  metaPath?: string;
  kind: "session" | "subagent";
  size: number;
  mtimeMs: number;
}

/** List every project directory under `root`. */
export async function discoverProjectDirs(
  root: string = defaultCorpusRoot(),
): Promise<ProjectDirEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return [];
    throw err;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: entry.name, path: join(root, entry.name) }))
    .toSorted((a, b) => a.dir.localeCompare(b.dir));
}

async function discoverSubagentFiles(
  projectDir: string,
  projectPath: string,
): Promise<CorpusFileEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: CorpusFileEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parentSessionId = entry.name;
    const subagentsDir = join(projectPath, parentSessionId, "subagents");

    let agentEntries: import("node:fs").Dirent[];
    try {
      agentEntries = await fs.readdir(subagentsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isFile()) continue;
      if (!agentEntry.name.startsWith("agent-") || !agentEntry.name.endsWith(".jsonl")) continue;

      const filePath = join(subagentsDir, agentEntry.name);
      const sessionId = agentEntry.name.slice("agent-".length, -".jsonl".length);
      const metaCandidate = join(subagentsDir, `agent-${sessionId}.meta.json`);

      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }

      let metaPath: string | undefined;
      try {
        await fs.stat(metaCandidate);
        metaPath = metaCandidate;
      } catch {
        metaPath = undefined;
      }

      results.push({
        path: filePath,
        projectDir,
        sessionId,
        parentSessionId,
        metaPath,
        kind: "subagent",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return results;
}

/** List every session file and subagent transcript in one project directory. */
export async function discoverProjectFiles(
  projectDir: string,
  projectPath: string,
): Promise<CorpusFileEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return [];
    throw err;
  }

  const sessions: CorpusFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = join(projectPath, entry.name);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    sessions.push({
      path: filePath,
      projectDir,
      sessionId: entry.name.slice(0, -".jsonl".length),
      kind: "session",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  const subagents = await discoverSubagentFiles(projectDir, projectPath);
  return [...sessions, ...subagents];
}

/** List every session file and subagent transcript across the whole corpus. */
export async function discoverCorpus(
  root: string = defaultCorpusRoot(),
): Promise<CorpusFileEntry[]> {
  const projectDirs = await discoverProjectDirs(root);
  const files: CorpusFileEntry[] = [];
  for (const project of projectDirs) {
    files.push(...(await discoverProjectFiles(project.dir, project.path)));
  }
  return files;
}
