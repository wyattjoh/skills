#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// A single unit of work discovered from a plan file or supplied inline.
export interface TaskInput {
  id: string;
  planPath: string | null;
  dependsOn: string[];
  title: string;
}

export interface ManifestError {
  type: "duplicate-id" | "unknown-dep" | "cycle";
  detail: string;
  task?: string;
  dep?: string;
}

export interface Manifest {
  tasks: TaskInput[];
  edges: Array<[string, string]>; // [dependency, dependent]
  readySet: string[]; // ids with no dependencies, eligible to start immediately
  errors: ManifestError[];
  ok: boolean;
}

// Extract the raw YAML frontmatter block (between leading `---` fences), or null.
export function extractFrontmatter(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return body.join("\n");
    body.push(lines[i]);
  }
  return null; // no closing fence
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

// Parse a `depends-on:` key supporting inline `[a, b]`, single scalar, and block list forms.
export function parseDependsOn(frontmatter: string): string[] {
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^depends-on:\s*(.*)$/);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline.startsWith("[")) {
      return inline
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(unquote)
        .filter(Boolean);
    }
    if (inline) return [unquote(inline)];
    const deps: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s*(.+)$/);
      if (!item) break;
      deps.push(unquote(item[1]));
    }
    return deps;
  }
  return [];
}

function parseTitle(frontmatter: string | null, body: string, fallback: string): string {
  if (frontmatter) {
    for (const line of frontmatter.split("\n")) {
      const match = line.match(/^title:\s*(.+)$/);
      if (match) return unquote(match[1]);
    }
  }
  const heading = body.split("\n").find((l) => /^#\s+/.test(l));
  if (heading) return heading.replace(/^#\s+/, "").trim();
  return fallback;
}

// Read one plan file into a TaskInput. id is the filename without extension.
export function parsePlanFile(path: string): TaskInput {
  const content = readFileSync(path, "utf8");
  const id = basename(path).replace(/\.[^.]+$/, "");
  const frontmatter = extractFrontmatter(content);
  return {
    id,
    planPath: resolve(path),
    dependsOn: frontmatter ? parseDependsOn(frontmatter) : [],
    title: parseTitle(frontmatter, content, id),
  };
}

// Expand directories to their *.md children; pass files through. Sorted for determinism.
export function discoverTasks(paths: string[]): TaskInput[] {
  const files: string[] = [];
  for (const path of paths) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).toSorted()) {
        if (entry.endsWith(".md")) files.push(join(path, entry));
      }
    } else {
      files.push(path);
    }
  }
  return files.map(parsePlanFile);
}

// Pure graph validation: duplicate ids, dangling deps, cycles, and the initial ready set.
export function buildManifest(tasks: TaskInput[]): Manifest {
  const sorted = tasks.toSorted((a, b) => a.id.localeCompare(b.id));
  const errors: ManifestError[] = [];

  const seen = new Set<string>();
  for (const task of sorted) {
    if (seen.has(task.id)) {
      errors.push({
        type: "duplicate-id",
        detail: `Duplicate task id "${task.id}"`,
        task: task.id,
      });
    }
    seen.add(task.id);
  }

  const ids = new Set(sorted.map((t) => t.id));
  const edges: Array<[string, string]> = [];
  for (const task of sorted) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        errors.push({
          type: "unknown-dep",
          detail: `Task "${task.id}" depends on unknown task "${dep}"`,
          task: task.id,
          dep,
        });
        continue;
      }
      edges.push([dep, task.id]);
    }
  }

  // Kahn's algorithm over valid edges; anything left over is part of a cycle.
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const [, dependent] of edges) indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
  let removed = 0;
  const work = [...ids].filter((id) => (indegree.get(id) ?? 0) === 0).toSorted();
  while (work.length) {
    const id = work.shift()!;
    removed++;
    for (const [dep, dependent] of edges) {
      if (dep !== id) continue;
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) work.push(dependent);
    }
  }
  if (removed < ids.size) {
    const inCycle = [...ids].filter((id) => (indegree.get(id) ?? 0) > 0).toSorted();
    errors.push({ type: "cycle", detail: `Dependency cycle among: ${inCycle.join(", ")}` });
  }

  const readySet = sorted.filter((t) => t.dependsOn.length === 0).map((t) => t.id);

  return { tasks: sorted, edges, readySet, errors, ok: errors.length === 0 };
}

function main(): void {
  const program = new Command()
    .name("plan-graph")
    .description("Discover work units, validate the dependency DAG, and emit a task manifest")
    .version("1.0.0")
    .argument("[paths...]", "Plan files and/or directories of plan files")
    .option("--from-json <file>", "Read task specs from a JSON array instead of plan files")
    .option("--pretty", "Pretty-print the manifest")
    .action((paths: string[], opts: { fromJson?: string; pretty?: boolean }) => {
      let tasks: TaskInput[];
      if (opts.fromJson) {
        const raw = JSON.parse(readFileSync(opts.fromJson, "utf8")) as Array<Partial<TaskInput>>;
        tasks = raw.map((t) => ({
          id: String(t.id),
          planPath: t.planPath ?? null,
          dependsOn: t.dependsOn ?? [],
          title: t.title ?? String(t.id),
        }));
      } else {
        if (!paths.length) {
          process.stderr.write("error: provide plan paths or --from-json <file>\n");
          process.exit(2);
        }
        tasks = discoverTasks(paths);
      }
      const manifest = buildManifest(tasks);
      process.stdout.write(JSON.stringify(manifest, null, opts.pretty ? 2 : 0) + "\n");
      process.exit(manifest.ok ? 0 : 1);
    });
  program.parse();
}

if (import.meta.main) main();
