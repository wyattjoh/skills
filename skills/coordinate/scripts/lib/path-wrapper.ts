import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

/**
 * The comment line that marks `~/.local/bin/coordinate` as this wrapper, so a rerun can tell it
 * from a command someone else installed.
 */
export const WRAPPER_MARK =
  "# coordinate PATH wrapper, written by coordinate start; safe to delete";

/**
 * Each harness's stable link to the coordinate skill, most preferred first. agent-toolkit points
 * every link at its own patched folder, so the script's real path tells them apart.
 * @param home Home folder.
 * @returns The links.
 */
export const skillLinks = (home: string): string[] => [
  join(home, ".claude", "skills", "coordinate"),
  join(home, ".pi", "agent", "skills", "coordinate"),
  join(home, ".agents", "skills", "coordinate"),
];

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/**
 * The skill link the running script was loaded through. Bun reports a script's real path, not the
 * link it was started through, so this picks the link that resolves to the same folder; failing
 * that, `~/.claude/skills/coordinate` when it exists.
 * @param home Home folder.
 * @param skillDir The running skill's folder.
 * @returns The link and whether it matched the script, or undefined when no link exists.
 */
export const loadingLink = (
  home: string,
  skillDir: string,
): { link: string; matched: boolean } | undefined => {
  const skill = real(skillDir);
  const links = skillLinks(home);
  const match = links.find((link) => skill !== undefined && real(link) === skill);
  if (match) return { link: match, matched: true };
  const claude = links[0]!;
  return existsSync(claude) ? { link: claude, matched: false } : undefined;
};

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The wrapper script: runs the skill link's CLI with an absolute bun, so it works from a shell
 * whose PATH has no bun.
 * @param bun Absolute bun path.
 * @param link Skill link.
 * @returns The file's content.
 */
export const wrapperScript = (bun: string, link: string): string =>
  `#!/bin/sh\n${WRAPPER_MARK}\nexec ${quote(bun)} ${quote(join(link, "scripts", "coordinate.ts"))} "$@"\n`;

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isWrapper = (path: string): boolean => {
  try {
    return readFileSync(path, "utf8").split("\n")[1] === WRAPPER_MARK;
  } catch {
    return false;
  }
};

const trimSlash = (dir: string): string => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir);

/**
 * Put `coordinate` on PATH as `~/.local/bin/coordinate` when no `coordinate` is there yet and
 * `~/.local/bin` is on PATH. Never replaces a file that is not this wrapper; refreshes this
 * wrapper when its bun or link changed.
 * @param env Environment (HOME and PATH are read from it).
 * @param skillDir The running skill's folder.
 * @returns At most one line to print: what was written, or why the short name is unavailable.
 */
export const ensurePathWrapper = (
  env: Record<string, string | undefined>,
  skillDir: string,
): string[] => {
  const home = env.HOME;
  if (!home) return ["short name coordinate unavailable: HOME is unset"];
  const bin = join(home, ".local", "bin");
  const target = join(bin, "coordinate");
  const dirs = (env.PATH ?? "").split(":").filter((dir) => dir !== "");
  const found = dirs.map((dir) => join(dir, "coordinate")).find(executable);
  const ours = isWrapper(target);
  if (found !== undefined && real(found) !== real(target))
    return [
      `short name coordinate unavailable: ${found} is another coordinate on PATH; left it alone`,
    ];
  if (existsSync(target) && !ours)
    return [
      `short name coordinate unavailable: ${target} exists and is not this wrapper; left it alone`,
    ];
  if (!dirs.map(trimSlash).includes(bin))
    return [
      `short name coordinate unavailable: ${bin} is not on PATH; add it and run coordinate start again`,
    ];
  const loaded = loadingLink(home, skillDir);
  if (!loaded)
    return [
      `short name coordinate unavailable: no coordinate skill link under ${home} (${skillLinks(home).join(", ")})`,
    ];
  const bun = Bun.which("bun", { PATH: env.PATH ?? "" }) ?? process.execPath;
  const script = wrapperScript(bun, loaded.link);
  if (ours && readFileSync(target, "utf8") === script) return [];
  try {
    mkdirSync(bin, { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, script, { mode: 0o755 });
    renameSync(temp, target);
  } catch (error) {
    return [`short name coordinate unavailable: could not write ${target}: ${String(error)}`];
  }
  const fallback = loaded.matched ? "" : " (could not tell which link loaded this script)";
  return [
    `${ours ? "updated" : "wrote"} ${target}: coordinate now runs ${loaded.link}/scripts/coordinate.ts${fallback}; allowlist prefix: coordinate *`,
  ];
};

/**
 * `ensurePathWrapper` for the running CLI.
 * @param skillDir The running skill's folder.
 * @returns Its lines.
 */
export const pathWrapper = (skillDir: string) =>
  Effect.sync(() => ensurePathWrapper(process.env, skillDir));
