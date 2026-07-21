#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DecompositionTask {
  id: string;
  title: string;
  dependsOn: string[];
  context: string;
  implementation: string;
  acceptance: string[];
}

export interface WrittenPlan {
  id: string;
  filename: string;
  path: string;
}

const TASK_ID = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A managed plan file is exactly `<task-id>.md`. Cleanup is scoped to this
// pattern so scaffolding into a directory that also holds unrelated Markdown
// (a SKILL.md, a README) never deletes those files.
const PLAN_FILE = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function requireString(value: unknown, field: string, id: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Task "${id}" must include a non-empty ${field} string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string, id: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Task "${id}" must include a ${field} array`);
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Task "${id}" ${field} must contain only non-empty strings`);
  }
  return value;
}

export function validateTask(value: unknown, index: number): DecompositionTask {
  if (!value || typeof value !== "object") {
    throw new Error(`Task at index ${index} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id ? raw.id : `#${index + 1}`;
  return {
    id: requireString(raw.id, "id", id),
    title: requireString(raw.title, "title", id),
    dependsOn: requireStringArray(raw.dependsOn, "dependsOn", id),
    context: requireString(raw.context, "context", id),
    implementation: requireString(raw.implementation, "implementation", id),
    acceptance: requireStringArray(raw.acceptance, "acceptance", id),
  };
}

export function loadDecomposition(path: string): DecompositionTask[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Decomposition JSON must be an array");
  return parsed.map(validateTask);
}

function validateForPlan(task: DecompositionTask): void {
  if (!TASK_ID.test(task.id)) throw new Error(`Task id "${task.id}" must match NN-slug`);
  if (!task.acceptance.length) {
    throw new Error(`Task "${task.id}" must include at least one acceptance criterion`);
  }
}

function yamlInline(values: string[]): string {
  return `[${values.join(", ")}]`;
}

function bullets(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

export function formatPlanFile(task: DecompositionTask): string {
  validateForPlan(task);
  return `---
title: ${task.title}
depends-on: ${yamlInline(task.dependsOn)}
---

# ${task.title}

## Context
${task.context}

## Implementation
${task.implementation}

## Acceptance criteria
${bullets(task.acceptance)}
`;
}

export function scaffoldPlans(tasks: DecompositionTask[], outDir: string): WrittenPlan[] {
  mkdirSync(outDir, { recursive: true });
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir)) {
      if (PLAN_FILE.test(entry)) rmSync(join(outDir, entry));
    }
  }

  return tasks
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((task) => {
      const filename = `${task.id}.md`;
      const path = join(outDir, filename);
      writeFileSync(path, formatPlanFile(task));
      return { id: task.id, filename, path };
    });
}

function main(): void {
  const program = new Command()
    .name("scaffold")
    .description("Emit task-orchestrator plan files from a decomposition JSON array")
    .version("1.0.0")
    .argument("<json-file>", "Decomposition JSON file")
    .requiredOption("--out <dir>", "Output plan directory")
    .option("--pretty", "Print written files as formatted JSON")
    .action((jsonFile: string, opts: { out: string; pretty?: boolean }) => {
      const tasks = loadDecomposition(jsonFile);
      const written = scaffoldPlans(tasks, opts.out);
      process.stdout.write(JSON.stringify(written, null, opts.pretty ? 2 : 0) + "\n");
    });
  program.parse();
}

if (import.meta.main) main();
