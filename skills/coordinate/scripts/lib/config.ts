import { availableParallelism, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Effect, Schema } from "effect";

/**
 * Which CLI answers pull-request questions for a remote host.
 */
export type ForgeKind = "github" | "forgejo";

/**
 * The resolved settings, every key filled.
 */
export type Config = {
  backlogDir: string;
  stateDir: string;
  keepRunning: string[];
  delegateClaudeArgs: string[];
  delegatePiArgs: string[];
  forges: Record<string, ForgeKind>;
  buildOutput: string[];
  quietHours: number;
  branchPrefix: string;
  cores: number;
  maxFleetDelegates: number;
  maxFleetDelegatesOverride: number | undefined;
  maxFleetDelegatesByMachine: Record<string, number>;
  /**
   * Where shared state lives: local files, or the home Herdr core's document store.
   */
  stateBackend: StateBackend;
  /**
   * The home's Herdr machine name (herdr-doc only).
   */
  stateHome: string | undefined;
};

/**
 * The storage backends for shared state.
 */
export type StateBackend = "files" | "herdr-doc";

/**
 * The config file could not be read or does not match its schema.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const Strings = Schema.Array(Schema.String);

/**
 * `config.json` on disk. Key names follow upstream coordinator where the key survives.
 */
const ConfigFile = Schema.Struct({
  backlog_dir: Schema.optionalKey(Schema.String),
  state_dir: Schema.optionalKey(Schema.String),
  keep_running: Schema.optionalKey(Strings),
  delegate_claude_args: Schema.optionalKey(Strings),
  delegate_pi_args: Schema.optionalKey(Strings),
  forges: Schema.optionalKey(Schema.Record(Schema.String, Schema.Literals(["github", "forgejo"]))),
  build_output: Schema.optionalKey(Strings),
  quiet_hours: Schema.optionalKey(Schema.Number),
  branch_prefix: Schema.optionalKey(Schema.String),
  max_fleet_delegates: Schema.optionalKey(Schema.Number),
  max_fleet_delegates_by_machine: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  state_backend: Schema.optionalKey(Schema.Literals(["files", "herdr-doc"])),
  state_home: Schema.optionalKey(Schema.String),
});

const KNOWN_KEYS = new Set([
  "backlog_dir",
  "state_dir",
  "keep_running",
  "delegate_claude_args",
  "delegate_pi_args",
  "forges",
  "build_output",
  "quiet_hours",
  "branch_prefix",
  "max_fleet_delegates",
  "max_fleet_delegates_by_machine",
  "state_backend",
  "state_home",
]);

/**
 * Upstream keys this fork dropped. They are ignored rather than rejected, so a
 * shared config file keeps working.
 */
export const RETIRED_KEYS: ReadonlySet<string> = new Set([
  "pr_limits",
  "delegate_codex_overrides",
  "inbox_store",
]);

/**
 * Folders a build makes again; removing a worktree drops them instead of parking them.
 */
export const DEFAULT_BUILD_OUTPUT: readonly string[] = [
  "node_modules",
  ".devenv",
  ".direnv",
  "result",
  ".derived-data",
  "DerivedData",
  "dist",
  "build",
  ".build",
  ".next",
  "target",
  ".turbo",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".swiftpm",
  "Pods",
  ".expo",
  ".cache",
  ".vercel",
  "test-results",
  "playwright-report",
  ".svelte-kit",
  ".parcel-cache",
  "storybook-static",
  ".DS_Store",
  ".eslintcache",
];

/**
 * Hosts known without configuration. Anything else must be named in `forges`.
 */
export const DEFAULT_FORGES: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "codeberg.org": "forgejo",
};

/**
 * The shell's current folder no longer exists, so a relative path has nothing to resolve against.
 */
export class MissingFolder extends Schema.TaggedError<MissingFolder>()("MissingFolder", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * The current folder, or `undefined` when it was removed (Bun's `process.cwd()` throws then).
 * @returns The folder.
 */
export const currentFolder = (): string | undefined => {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
};

/**
 * Make a path absolute against the current folder. An absolute path never consults it. When the
 * current folder was removed, Bun's `resolve` silently falls back to its own binary's folder, so
 * this throws `MissingFolder` instead; the CLI boundary reports it and exits 2.
 * @param path Any path.
 * @param env Environment (`PWD`, to name the missing folder).
 * @returns The absolute path.
 */
export const absolutePath = (
  path: string,
  env: Record<string, string | undefined> = process.env,
): string => {
  if (isAbsolute(path)) return resolve(path);
  const folder = currentFolder();
  if (folder !== undefined) return resolve(folder, path);
  const missing = env.PWD ?? "the current folder";
  throw new MissingFolder({
    path,
    message: `${missing} no longer exists, so the relative path ${JSON.stringify(path)} cannot be resolved: cd to an existing folder or pass an absolute path`,
  });
};

/**
 * Expand a leading `~`.
 * @param path A path that may start with `~`.
 * @returns The absolute path.
 */
export const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/**
 * Where the config file lives: `COORDINATE_CONFIG`, else `~/.config/coordinate/config.json`.
 * @param env Environment to read.
 * @returns The path.
 */
export const configPath = (env: Record<string, string | undefined> = process.env): string =>
  expandHome(env.COORDINATE_CONFIG ?? "~/.config/coordinate/config.json");

/**
 * Resolve parsed JSON into a full config.
 * @param raw Parsed file contents (`{}` when missing).
 * @param path File path, for messages.
 * @returns The config, or a typed error naming the bad key.
 */
export const resolveConfig = Effect.fn("resolveConfig")(function* (
  raw: unknown,
  path: string,
  cores: number = availableParallelism(),
) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return yield* new ConfigError({ path, message: "holds no JSON object" });
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key) && !RETIRED_KEYS.has(key));
  if (unknown.length > 0)
    return yield* new ConfigError({
      path,
      message: `unknown keys: ${unknown.join(", ")}. Known keys: ${[...KNOWN_KEYS].join(", ")}`,
    });
  const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => KNOWN_KEYS.has(key)));
  const file = yield* Schema.decodeUnknownEffect(ConfigFile)(kept).pipe(
    Effect.mapError((error) => new ConfigError({ path, message: error.message })),
  );
  if (
    file.max_fleet_delegates !== undefined &&
    (!Number.isInteger(file.max_fleet_delegates) || file.max_fleet_delegates < 1)
  )
    return yield* new ConfigError({
      path,
      message: "max_fleet_delegates must be a positive integer",
    });
  const invalidMachineBudget = Object.entries(file.max_fleet_delegates_by_machine ?? {}).find(
    ([, budget]) => !Number.isInteger(budget) || budget < 1,
  );
  if (invalidMachineBudget)
    return yield* new ConfigError({
      path,
      message: `max_fleet_delegates_by_machine.${invalidMachineBudget[0]} must be a positive integer`,
    });
  const stateBackend = file.state_backend ?? "files";
  if (stateBackend === "herdr-doc" && (file.state_home ?? "") === "")
    return yield* new ConfigError({
      path,
      message:
        "state_backend herdr-doc needs state_home, the Herdr machine name of the home that holds shared state",
    });
  return {
    stateBackend,
    stateHome: file.state_home,
    cores,
    maxFleetDelegates: file.max_fleet_delegates ?? Math.max(2, Math.floor(cores / 4)),
    maxFleetDelegatesOverride: file.max_fleet_delegates,
    maxFleetDelegatesByMachine: { ...file.max_fleet_delegates_by_machine },
    backlogDir: absolutePath(expandHome(file.backlog_dir ?? "~/.config/coordinate/backlogs")),
    // Resolved, so paths built on it by string (backlog-store/paths.ts) never double a slash.
    stateDir: absolutePath(expandHome(file.state_dir ?? "~/.local/state/coordinate")),
    keepRunning: [...(file.keep_running ?? [])],
    delegateClaudeArgs: [...(file.delegate_claude_args ?? [])],
    delegatePiArgs: [...(file.delegate_pi_args ?? [])],
    forges: { ...DEFAULT_FORGES, ...file.forges },
    buildOutput: [...DEFAULT_BUILD_OUTPUT, ...(file.build_output ?? [])],
    quietHours: file.quiet_hours ?? 24,
    branchPrefix: file.branch_prefix ?? "wyattjoh/",
  } satisfies Config;
});

/**
 * Read the config file; a missing file means every default.
 * @param path File to read.
 * @returns The config.
 */
export const loadConfig = Effect.fn("loadConfig")(function* (path: string = configPath()) {
  const handle = Bun.file(path);
  const exists = yield* Effect.promise(() => handle.exists());
  if (!exists) return yield* resolveConfig({}, path);
  const raw = yield* Effect.tryPromise({
    try: () => handle.json(),
    catch: (cause) => new ConfigError({ path, message: `cannot read: ${String(cause)}` }),
  });
  return yield* resolveConfig(raw, path);
});
