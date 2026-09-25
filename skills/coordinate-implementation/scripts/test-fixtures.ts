import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes an executable Bun script, for faking a command on a test PATH.
 *
 * @param directory - Directory that will be placed on PATH.
 * @param name - Command name.
 * @param body - Script body run by the current Bun executable.
 * @returns The command path.
 */
export const writeCommand = (directory: string, name: string, body: string): string => {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const DEFAULT_PI_MODELS = ["openai-codex  gpt-5.6-sol 272K"];

/**
 * Installs fake `pi` and `claude` harnesses that answer the version, help, and model probes
 * role validation runs.
 *
 * @param bin - Directory to create and install into.
 * @param piModels - Rows printed after the `pi --list-models` header.
 * @returns The bin directory.
 */
export const installFakeHarnesses = (bin: string, piModels = DEFAULT_PI_MODELS): string => {
  mkdirSync(bin, { recursive: true });
  const models = ["provider      model       context", ...piModels].join("\\n");
  writeCommand(
    bin,
    "pi",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("pi 0.80.3");
else if (args[0] === "--help") console.log("--thinking <level>  Set thinking level: off, minimal, low, medium, high, xhigh, max");
else if (args[0] === "--list-models") console.log("${models}");
else process.exit(1);
`,
  );
  writeCommand(
    bin,
    "claude",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("Claude Code 2.1.80");
else if (args[0] === "--help") console.log("--effort <level>  Effort level (low, medium, high, xhigh, max)");
else process.exit(1);
`,
  );
  return bin;
};

/**
 * Creates a minimal schema-2 RESUME.md in a fresh temporary run folder.
 *
 * @param prefix - Temporary directory name prefix.
 * @returns The RESUME.md path.
 */
export const tempStateFile = (prefix: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), prefix)), "RESUME.md");
  writeFileSync(path, "# Run\n\nSchema version: 2\n");
  return path;
};
