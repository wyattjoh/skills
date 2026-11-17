import { homedir } from "node:os";
import { join } from "node:path";
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
};

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
export const resolveConfig = Effect.fn("resolveConfig")(function* (raw: unknown, path: string) {
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
  return {
    backlogDir: expandHome(file.backlog_dir ?? "~/.config/coordinate/backlogs"),
    stateDir: expandHome(file.state_dir ?? "~/.local/state/coordinate"),
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
