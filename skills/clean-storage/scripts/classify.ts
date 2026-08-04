/**
 * Pure classification and formatting logic for the clean-storage scan.
 *
 * Everything here is free of I/O so it can be unit tested directly. The
 * filesystem and shell work lives in scan.ts.
 */

/**
 * Categories of reclaimable directory.
 *
 * The first four are discovered by walking the configured roots. "cache" covers
 * well-known fixed cache locations, which are looked up directly rather than found.
 */
export type BuildCategory = "cargo" | "xcode" | "node-modules" | "swift" | "cache";

/** A directory found by the walker, before verification. */
export interface Discovered {
  readonly path: string;
  readonly category: BuildCategory;
}

/** A discovered directory after verification and sizing. */
export interface Candidate extends Discovered {
  readonly sizeKb: number;
  readonly verified: boolean;
  /** Why verification failed. Absent when verified. */
  readonly reason?: string;
}

/** The outcome of proving a candidate regenerable, carrying the reason on failure. */
export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Locations, relative to the home directory, that hold installed software rather
 * than build output.
 *
 * A globally installed CLI ships its dependencies in a node_modules beside a
 * package.json, which is indistinguishable from a project's installed
 * dependencies by that test alone. Nothing regenerates these from a build: they
 * require a reinstall, so they are excluded regardless of category.
 */
export const HOME_INSTALL_PREFIXES: readonly string[] = [
  ".ami",
  ".asdf",
  ".bun/install/global",
  ".cache/opencode",
  ".claude/plugins/cache",
  ".config/yarn/global",
  ".deno",
  ".local/share/fnm",
  ".local/share/mise",
  ".local/share/opencode",
  ".local/share/pnpm",
  ".npm-global",
  ".npm/_npx",
  ".nvm",
  ".pi",
  ".plannotator",
  ".volta",
  "Applications",
];

/** Absolute locations that hold installed software. */
export const SYSTEM_INSTALL_PREFIXES: readonly string[] = [
  "/Applications",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/lib/node_modules",
  "/usr/lib/node_modules",
  "/usr/local/lib/node_modules",
];

/**
 * Locations, relative to home, owned by a package manager's cache.
 *
 * These are reported as tool-managed caches with the vendor's cleanup command.
 * Without this exclusion the walker also finds individual node_modules inside
 * them, so the same bytes would be both deleted piecemeal and recommended for
 * `bun pm cache rm`, double-counting the reclaim and desyncing the tool's index.
 */
export const TOOL_CACHE_PREFIXES: readonly string[] = [
  ".bun/install/cache",
  ".cargo/registry",
  ".npm/_cacache",
  "Library/Caches/Homebrew",
  "Library/pnpm/store",
];

/** True when `path` is `prefix` itself or sits beneath it, respecting segment boundaries. */
export function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * True when the path belongs to installed software. Such directories look exactly
 * like build output to the per-category proofs, so this check runs first and
 * excludes them outright.
 */
export function isInstalledSoftware(path: string, home: string): boolean {
  const underHome = HOME_INSTALL_PREFIXES.some((prefix) =>
    isUnderPrefix(path, `${home}/${prefix}`),
  );
  return underHome || SYSTEM_INSTALL_PREFIXES.some((prefix) => isUnderPrefix(path, prefix));
}

/** True when the path sits inside a cache owned by a package manager. */
export function isToolManagedCache(path: string, home: string): boolean {
  return TOOL_CACHE_PREFIXES.some((prefix) => isUnderPrefix(path, `${home}/${prefix}`));
}

/** A tool-managed cache, cleaned via the vendor command rather than by rm. */
export interface ToolCache {
  readonly tool: string;
  readonly path: string;
  readonly sizeKb: number;
  /** The vendor's own cleanup command, which is safer than deleting the directory. */
  readonly command: string;
}

/**
 * Directory names the walker looks for, mapped to the category they imply.
 * A match is a candidate only, never a decision. Verification happens in scan.ts.
 */
export const CATEGORY_BY_DIRNAME: Readonly<Record<string, BuildCategory>> = {
  target: "cargo",
  DerivedData: "xcode",
  build: "xcode",
  node_modules: "node-modules",
  ".build": "swift",
};

/**
 * Directories never descended into. Skipping .git is a large speedup, and
 * skipping the others avoids walking package contents and VM images.
 */
export const PRUNE_DIRNAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "Library",
  "Applications",
  ".Trash",
]);

/** True when a directory should not be descended into during discovery. */
export function shouldPrune(dirName: string): boolean {
  return PRUNE_DIRNAMES.has(dirName) || dirName.endsWith(".app");
}

/**
 * The category implied by a directory name, or null when it is not a candidate.
 *
 * The own-property check is load-bearing. A bare index reads through
 * Object.prototype, so a directory literally named "constructor" or "toString"
 * would resolve to a built-in function and be reported as a candidate with a
 * category no verifier handles, which aborts the whole scan.
 */
export function categoryFor(dirName: string): BuildCategory | null {
  if (!Object.hasOwn(CATEGORY_BY_DIRNAME, dirName)) return null;
  return CATEGORY_BY_DIRNAME[dirName] ?? null;
}

/** Human-readable size. Uses whole megabytes below 1 GB to avoid a wall of 0.0G rows. */
export function formatSize(kb: number): string {
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${Math.round(kb / 1024)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}

/** Parse `du -sk` output into a size in kilobytes. Returns 0 when unparseable. */
export function parseDuKb(output: string): number {
  const first = output.trim().split(/\s+/)[0];
  const parsed = Number.parseInt(first ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Largest first, so the rows that matter are read first. */
export function bySizeDesc<T extends { readonly sizeKb: number }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => b.sizeKb - a.sizeKb);
}

/** Pluralize a noun against a count, e.g. 1 dir but 2 dirs. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Total kilobytes across the given items. */
export function totalKb(items: readonly { readonly sizeKb: number }[]): number {
  return items.reduce((sum, item) => sum + item.sizeKb, 0);
}

/** Per-category totals, largest first. */
export function summarizeByCategory(
  candidates: readonly Candidate[],
): { category: BuildCategory; count: number; sizeKb: number }[] {
  const totals = new Map<BuildCategory, { count: number; sizeKb: number }>();
  for (const candidate of candidates) {
    const current = totals.get(candidate.category) ?? { count: 0, sizeKb: 0 };
    totals.set(candidate.category, {
      count: current.count + 1,
      sizeKb: current.sizeKb + candidate.sizeKb,
    });
  }
  return [...totals.entries()]
    .map(([category, totalsForCategory]) => ({ category, ...totalsForCategory }))
    .toSorted((a, b) => b.sizeKb - a.sizeKb);
}

/**
 * A nested match is redundant once its ancestor is already being removed.
 * Dropping it prevents double-counting sizes in the reported total.
 */
export function dropNested<T extends { readonly path: string }>(items: readonly T[]): T[] {
  const sorted = items.toSorted((a, b) => a.path.length - b.path.length);
  const kept: T[] = [];
  for (const item of sorted) {
    const isNested = kept.some((ancestor) => item.path.startsWith(`${ancestor.path}/`));
    if (!isNested) kept.push(item);
  }
  return kept;
}
