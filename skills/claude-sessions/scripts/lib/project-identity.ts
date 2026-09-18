import { realpathSync } from "node:fs";
import { dirname } from "node:path";

const GIT_LOCATION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

function gitEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  return env;
}

/**
 * Resolve a recorded checkout path to the real primary repository root.
 *
 * Linked worktrees resolve through Git's common directory, so every checkout
 * of one repository shares one identity. Missing paths and non-repositories
 * return null rather than guessing from path text.
 *
 * @param cwd Recorded checkout path.
 * @returns Canonical primary repository root, or null when it cannot be proven.
 */
export function resolveProjectIdentity(cwd: string | null): string | null {
  if (cwd === null) return null;

  try {
    const checkout = realpathSync(cwd);
    const result = Bun.spawnSync(
      ["git", "-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { env: gitEnvironment(), stderr: "ignore", stdout: "pipe" },
    );
    if (result.exitCode !== 0) return null;

    const commonDir = result.stdout.toString().trim();
    if (commonDir.length === 0) return null;
    return realpathSync(dirname(commonDir));
  } catch {
    return null;
  }
}

function globPattern(raw: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "*") {
      pattern += ".*";
      continue;
    }
    if (char === "?") {
      pattern += ".";
      continue;
    }
    if (char === "[") {
      const close = raw.indexOf("]", index + 1);
      if (close !== -1) {
        const contents = raw.slice(index + 1, close);
        pattern += `[${contents.replace(/\\/g, "\\\\")}]`;
        index = close;
        continue;
      }
    }
    pattern += "\\^$+?.()|{}[]".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`${pattern}$`);
}

/**
 * Match a canonical project identity against an exact value or shell-style glob.
 *
 * Matching is case-sensitive. Repeated project filters are combined by callers
 * with OR semantics.
 *
 * @param identity Canonical primary repository root.
 * @param pattern Exact path or pattern containing `*`, `?`, or `[...]`.
 * @returns Whether the identity matches the requested pattern.
 */
export function matchesProjectIdentity(identity: string, pattern: string): boolean {
  if (!/[?*[\]]/.test(pattern)) return identity === pattern;
  try {
    return globPattern(pattern).test(identity);
  } catch {
    return false;
  }
}
