#!/usr/bin/env bun

/**
 * List Claude Code project directories with metadata
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/list-projects.ts [options]
 *
 * Options:
 *   --search=TERM          Filter projects containing TERM in path
 *   --format=json|table    Output format (default: table)
 *   --sort=date|sessions   Sort by last modified or session count (default: date)
 *   --limit=N              Show only N projects
 *   --claude-dir=PATH      Override ~/.claude directory location
 */

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import type { SessionsIndex } from "../references/types.ts";

export interface ProjectInfo {
  encodedPath: string;
  decodedPath: string;
  sessionCount: number;
  lastModified: string;
  lastModifiedTimestamp: number;
}

export interface Options {
  search?: string;
  format: "json" | "table";
  sort: "date" | "sessions";
  limit: number;
  claudeDir: string;
}

function parseOptions(args: string[]): Options {
  const { values: parsed, positionals } = parseArgs({
    args,
    options: {
      search: { type: "string" },
      format: { type: "string", default: "table" },
      sort: { type: "string", default: "date" },
      "claude-dir": { type: "string" },
      limit: { type: "string" },
    },
    allowPositionals: true,
  });

  void positionals;
  const homeDir = process.env.HOME || "~";
  const limit = parsed.limit ? Number(parsed.limit) : Infinity;

  return {
    search: parsed.search,
    format: parsed.format as "json" | "table",
    sort: parsed.sort as "date" | "sessions",
    limit,
    claudeDir: (parsed["claude-dir"] as string | undefined) || `${homeDir}/.claude`,
  };
}

export function decodeProjectPath(encoded: string): string {
  // Claude Code encodes paths by replacing / with -
  // The first character is always - (representing the root /)
  if (encoded.startsWith("-")) {
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }
  return encoded.replace(/-/g, "/");
}

export async function getProjectInfo(
  projectsDir: string,
  encodedPath: string,
): Promise<ProjectInfo | null> {
  const projectDir = `${projectsDir}/${encodedPath}`;

  try {
    const stat = await fs.stat(projectDir);
    if (!stat.isDirectory()) return null;

    let sessionCount = 0;
    let lastModifiedTimestamp = stat.mtime?.getTime() || 0;
    let actualProjectPath: string | null = null;

    // Try to read sessions-index.json for accurate data
    try {
      const indexPath = `${projectDir}/sessions-index.json`;
      const content = await Bun.file(indexPath).text();
      const index = JSON.parse(content) as SessionsIndex;
      sessionCount = index.entries?.length || 0;

      // Get the actual project path from the first entry
      if (index.entries && index.entries.length > 0) {
        actualProjectPath = index.entries[0].projectPath;
      }

      // Get the most recent session modification time
      for (const entry of index.entries || []) {
        const entryTime = new Date(entry.modified).getTime();
        if (entryTime > lastModifiedTimestamp) {
          lastModifiedTimestamp = entryTime;
        }
      }
    } catch {
      // Count .jsonl files if index is unavailable
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.endsWith(".jsonl")) {
          sessionCount++;
        }
      }
    }

    return {
      encodedPath,
      decodedPath: actualProjectPath || decodeProjectPath(encodedPath),
      sessionCount,
      lastModified: new Date(lastModifiedTimestamp).toISOString(),
      lastModifiedTimestamp,
    };
  } catch {
    return null;
  }
}

export async function listProjects(options: Options): Promise<ProjectInfo[]> {
  const projectsDir = `${options.claudeDir}/projects`;
  const projects: ProjectInfo[] = [];

  try {
    const dirEntries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;

      // Apply search filter early
      if (options.search) {
        const decoded = decodeProjectPath(entry.name);
        const searchLower = options.search.toLowerCase();
        if (
          !entry.name.toLowerCase().includes(searchLower) &&
          !decoded.toLowerCase().includes(searchLower)
        ) {
          continue;
        }
      }

      const info = await getProjectInfo(projectsDir, entry.name);
      if (info) {
        projects.push(info);
      }
    }
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      console.error(`Projects directory not found: ${projectsDir}`);
      process.exit(1);
    }
    throw err;
  }

  // Sort
  if (options.sort === "date") {
    projects.sort((a, b) => b.lastModifiedTimestamp - a.lastModifiedTimestamp);
  } else {
    projects.sort((a, b) => b.sessionCount - a.sessionCount);
  }

  // Limit
  if (options.limit < projects.length) {
    return projects.slice(0, options.limit);
  }

  return projects;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return "..." + str.slice(-(maxLen - 3));
}

function outputTable(projects: ProjectInfo[]): void {
  console.log(
    "┌────────────────────────────────────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│ Claude Code Projects                                                                       │",
  );
  console.log(
    "├──────────────────────────────────────────────────┬──────────────────────┬─────────────────┤",
  );
  console.log(
    "│ Project Path                                     │ Last Modified        │ Sessions        │",
  );
  console.log(
    "├──────────────────────────────────────────────────┼──────────────────────┼─────────────────┤",
  );

  for (const project of projects) {
    const path = truncate(project.decodedPath, 48).padEnd(48);
    const modified = formatDate(project.lastModified).padEnd(20);
    const sessions = String(project.sessionCount).padStart(15);
    console.log(`│ ${path} │ ${modified} │ ${sessions} │`);
  }

  console.log(
    "└──────────────────────────────────────────────────┴──────────────────────┴─────────────────┘",
  );
  console.log(`\nTotal: ${projects.length} projects`);
  console.log(`\nTo list sessions for a project, use:`);
  console.log(`  bun $SKILL_DIR/scripts/list-sessions.ts ~/.claude/projects/<encoded-path>`);
}

function outputJson(projects: ProjectInfo[]): void {
  console.log(JSON.stringify(projects, null, 2));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const projects = await listProjects(options);

  if (options.format === "json") {
    outputJson(projects);
  } else {
    outputTable(projects);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
