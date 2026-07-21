#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// User-configurable defaults for the orchestrator. Keeps machine- or
// person-specific choices (like the integration-branch namespace) out of the
// skill itself, so an installed copy resolves the operator's own values instead
// of a hardcoded prefix.
export interface Defaults {
  // Namespace for the default integration branch: `<branchPrefix>/<batch>`.
  branchPrefix: string;
  // Default number of simultaneous task pipelines when `--concurrency` is unset.
  concurrency: number;
}

export const DEFAULT_CONCURRENCY = 3;

// Resolve `~/.config/task-orchestrator/defaults.json`, honoring XDG_CONFIG_HOME
// when set. An explicit override wins (used by tests and `--config`).
export function resolveConfigPath(override?: string): string {
  if (override) return override;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "task-orchestrator", "defaults.json");
}

// Validate a git-ref-safe branch namespace. Mirrors the subset of
// git-check-ref-format that a single prefix component can violate in practice.
export function validateBranchPrefix(value: string): string {
  const v = value.trim();
  if (!v) throw new Error("branchPrefix must not be empty");
  if (/\s/.test(v)) throw new Error("branchPrefix must not contain whitespace");
  if (/[~^:?*[\\]/.test(v)) {
    throw new Error("branchPrefix must not contain any of: ~ ^ : ? * [ \\");
  }
  if (v.includes("..")) throw new Error("branchPrefix must not contain '..'");
  if (v.startsWith("/") || v.endsWith("/")) {
    throw new Error("branchPrefix must not start or end with '/'");
  }
  if (v.startsWith("-")) throw new Error("branchPrefix must not start with '-'");
  if (v.endsWith(".lock")) throw new Error("branchPrefix must not end with '.lock'");
  return v;
}

export function validateConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("concurrency must be an integer >= 1");
  }
  return value;
}

// Coerce untrusted JSON into a validated Defaults. concurrency is optional and
// falls back to DEFAULT_CONCURRENCY.
export function parseDefaults(raw: unknown): Defaults {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("defaults must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.branchPrefix !== "string") {
    throw new Error("defaults.branchPrefix is required and must be a string");
  }
  const branchPrefix = validateBranchPrefix(obj.branchPrefix);
  let concurrency = DEFAULT_CONCURRENCY;
  if (obj.concurrency !== undefined) {
    if (typeof obj.concurrency !== "number") {
      throw new Error("defaults.concurrency must be a number");
    }
    concurrency = validateConcurrency(obj.concurrency);
  }
  return { branchPrefix, concurrency };
}

export interface ReadResult {
  configured: boolean;
  path: string;
  branchPrefix?: string;
  concurrency?: number;
}

// Read the defaults file. A missing file is not an error (configured: false);
// a present-but-invalid file is, so a typo surfaces instead of being ignored.
export function readDefaults(path: string): ReadResult {
  if (!existsSync(path)) return { configured: false, path };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`defaults file at ${path} is not valid JSON: ${(cause as Error).message}`, {
      cause,
    });
  }
  return { configured: true, path, ...parseDefaults(raw) };
}

export function writeDefaults(path: string, defaults: Defaults): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(defaults, null, 2) + "\n");
}

function main(): void {
  const program = new Command();
  program
    .name("defaults")
    .description("Resolve or persist the operator's task-orchestrator defaults")
    .version("1.0.0");

  program
    .command("read")
    .description("Print the resolved defaults as JSON (configured:false when unset)")
    .option("--config <path>", "Override the defaults file path")
    .action((opts: { config?: string }) => {
      const path = resolveConfigPath(opts.config);
      try {
        const result = readDefaults(path);
        process.stdout.write(JSON.stringify(result) + "\n");
        process.exit(0);
      } catch (cause) {
        process.stderr.write(`error: ${(cause as Error).message}\n`);
        process.exit(1);
      }
    });

  program
    .command("write")
    .description("Validate and persist the defaults file")
    .requiredOption("--branch-prefix <prefix>", "Integration-branch namespace")
    .option("--concurrency <n>", "Default simultaneous task pipelines", (v) => parseInt(v, 10))
    .option("--config <path>", "Override the defaults file path")
    .action((opts: { branchPrefix: string; concurrency?: number; config?: string }) => {
      const path = resolveConfigPath(opts.config);
      try {
        const defaults = parseDefaults({
          branchPrefix: opts.branchPrefix,
          ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        });
        writeDefaults(path, defaults);
        process.stdout.write(JSON.stringify({ configured: true, path, ...defaults }) + "\n");
        process.exit(0);
      } catch (cause) {
        process.stderr.write(`error: ${(cause as Error).message}\n`);
        process.exit(1);
      }
    });

  program.parse();
}

if (import.meta.main) main();
