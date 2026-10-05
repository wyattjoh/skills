#!/usr/bin/env bun
import { Command } from "commander";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { Effect } from "effect";

// Lists the agent definitions a worker session can be launched with, along with
// the frontmatter that decides how it will reason.
//
// The coordinator picks a worker's agent by matching ticket intent against these
// descriptions. `model` and `effort` matter as much as the match: when an agent
// declares them, the launch must NOT pass competing --model/--effort flags, and
// when it omits them the worker silently inherits whatever the CLI defaults to.
// Reading them here is what makes that choice deliberate instead of accidental.

export interface AgentDefinition {
  name: string;
  description: string;
  // null means the field is absent, so the launched session inherits it.
  model: string | null;
  effort: string | null;
  memory: string | null;
  tools: string | null;
  permissionMode: string | null;
  source: string;
  scope: "user" | "project";
}

export class AgentParseError extends Error {}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

// Agents accept `tools` as either a comma-separated string or a YAML list;
// normalize both into one comma-separated string so callers compare like for
// like.
function asToolList(value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length > 0 ? items.join(", ") : null;
  }
  return asString(value);
}

export function parseAgentFile(
  content: string,
  source: string,
  scope: "user" | "project",
): AgentDefinition {
  const match = FRONTMATTER.exec(content);
  if (!match) throw new AgentParseError(`${source}: no YAML frontmatter`);

  let raw: unknown;
  try {
    raw = parseYaml(match[1]!);
  } catch (error) {
    throw new AgentParseError(`${source}: invalid YAML — ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentParseError(`${source}: frontmatter is not a mapping`);
  }

  const obj = raw as Record<string, unknown>;
  const name = asString(obj.name);
  if (!name) throw new AgentParseError(`${source}: missing required 'name'`);

  return {
    name,
    description: asString(obj.description) ?? "",
    model: asString(obj.model),
    effort: asString(obj.effort),
    memory: asString(obj.memory),
    tools: asToolList(obj.tools),
    permissionMode: asString(obj.permissionMode),
    source,
    scope,
  };
}

export interface AgentFileSystem {
  readDir(dir: string): string[];
  statIsDirectory(path: string): boolean;
  readFile(path: string): string;
}

const nodeFileSystem: AgentFileSystem = {
  readDir: readdirSync,
  statIsDirectory: (path) => statSync(path).isDirectory(),
  readFile: (path) => readFileSync(path, "utf8"),
};

const readDirectory = (fileSystem: AgentFileSystem, dir: string) =>
  Effect.try({
    try: () => fileSystem.readDir(dir),
    catch: () => undefined,
  }).pipe(
    // An absent user or project agents directory is expected and means it has
    // no definitions, rather than making the entire discovery command fail.
    Effect.catch(() => Effect.succeed([])),
  );

const isDirectory = (fileSystem: AgentFileSystem, path: string) =>
  Effect.try({
    try: () => fileSystem.statIsDirectory(path),
    catch: () => undefined,
  }).pipe(
    // A file may disappear while walking a user-managed agents directory.
    Effect.catch(() => Effect.succeed(false)),
  );

export const markdownFilesInEffect = Effect.fn("agents.markdownFilesIn")(function* (
  dir: string,
  fileSystem: AgentFileSystem = nodeFileSystem,
) {
  const found: string[] = [];
  const walk = Effect.fnUntraced(function* (current: string): Effect.fn.Return<void> {
    const names = yield* readDirectory(fileSystem, current);
    for (const entry of names) {
      const full = join(current, entry);
      if (yield* isDirectory(fileSystem, full)) yield* walk(full);
      else if (entry.endsWith(".md")) found.push(full);
    }
  });
  yield* walk(dir);
  return found.toSorted();
});

export const loadAgentsEffect = Effect.fn("agents.loadAgents")(function* (
  dirs: readonly { dir: string; scope: "user" | "project" }[],
  fileSystem: AgentFileSystem = nodeFileSystem,
) {
  const agents: AgentDefinition[] = [];
  const errors: string[] = [];
  for (const { dir, scope } of dirs) {
    for (const file of yield* markdownFilesInEffect(dir, fileSystem)) {
      const parsed = yield* Effect.try({
        try: () => parseAgentFile(fileSystem.readFile(file), file, scope),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        // Per-file reads and parsing are deliberately accumulated, so one
        // broken definition cannot hide every usable worker agent.
        Effect.catch((error) => Effect.succeed({ error })),
      );
      if ("error" in parsed) errors.push(parsed.error);
      else agents.push(parsed);
    }
  }
  return { agents, errors };
});

/**
 * Synchronous compatibility bridge for callers that predate the Effect API.
 */
export function loadAgents(dirs: readonly { dir: string; scope: "user" | "project" }[]): {
  agents: AgentDefinition[];
  errors: string[];
} {
  return Effect.runSync(loadAgentsEffect(dirs));
}

// A project agent shadows a user agent of the same name, matching how Claude
// Code resolves `--agent`. Reporting the loser would let the coordinator plan
// around a definition that will never actually load.
export function resolveShadowing(agents: readonly AgentDefinition[]): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of agents) {
    const existing = byName.get(agent.name);
    if (!existing || (existing.scope === "user" && agent.scope === "project")) {
      byName.set(agent.name, agent);
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
  const program = new Command()
    .name("agents")
    .description("List agent definitions available to launch a worker session with")
    .option("--project-root <dir>", "repository root whose .claude/agents to include")
    .option("--user-dir <dir>", "override the user agents directory")
    .option("--json", "emit JSON instead of a table")
    .parse();

  const opts = program.opts<{ projectRoot?: string; userDir?: string; json?: boolean }>();
  const dirs: { dir: string; scope: "user" | "project" }[] = [
    { dir: opts.userDir ?? join(homedir(), ".claude", "agents"), scope: "user" },
  ];
  if (opts.projectRoot) {
    dirs.push({ dir: join(opts.projectRoot, ".claude", "agents"), scope: "project" });
  }

  const exit = Effect.runSync(
    Effect.gen(function* () {
      const { agents, errors } = yield* loadAgentsEffect(dirs);
      const resolved = resolveShadowing(agents);
      yield* Effect.sync(() => {
        if (opts.json) {
          console.log(JSON.stringify({ agents: resolved, errors }, null, 2));
          return;
        }
        for (const agent of resolved) {
          const model = agent.model ?? "inherit";
          const effort = agent.effort ?? "inherit";
          const memory = agent.memory ?? "none";
          console.log(`${agent.name}  [model=${model} effort=${effort} memory=${memory}]`);
          console.log(`  ${agent.description.replace(/\s+/g, " ").slice(0, 200)}`);
          console.log(`  ${relative(process.cwd(), agent.source)}`);
        }
        for (const error of errors) console.error(`skipped: ${error}`);
      });
      return 0;
    }),
  );
  process.exit(exit);
}
