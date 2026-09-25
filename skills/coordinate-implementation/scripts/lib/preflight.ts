import { Effect, Result } from "effect";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliIssue, PreflightInput } from "./contract.ts";
import { runProbe } from "./probe.ts";
import { validateStateFile, type StateSummary } from "./state.ts";
import { isRecord } from "./values.ts";

/**
 * Availability and version reported for one required executable.
 */
export type CommandCapability = {
  available: boolean;
  version: string | null;
};

/**
 * Herdr availability plus the machine API capabilities used by coordination.
 */
export type HerdrCapability = CommandCapability & {
  machine_api: boolean;
  normalized_context: boolean;
};

/**
 * Availability and version reported for one supported agent harness.
 */
export type HarnessCapability = CommandCapability & {
  name: "claude" | "pi";
};

/**
 * Availability and resolved path for one required Matt Pocock skill.
 */
export type SkillCapability = {
  name: "implement";
  available: boolean;
  path: string | null;
};

/**
 * Complete capability report returned by the preflight operation.
 */
export type PreflightReport = {
  platform: NodeJS.Platform;
  capabilities: {
    git: CommandCapability;
    bun: CommandCapability;
    flock: CommandCapability;
    herdr: HerdrCapability;
  };
  harnesses: HarnessCapability[];
  skills: SkillCapability[];
  state: StateSummary | null;
};

/**
 * Result of checking every baseline capability without short-circuiting.
 */
export type PreflightOutcome = {
  report: PreflightReport;
  errors: CliIssue[];
};

const probeCommand = (command: string, args: string[]): CommandCapability => {
  const result = runProbe([command, ...args]);
  const version = result.stdout.trim();
  if (result.exitCode !== 0 || version.length === 0) {
    return { available: false, version: null };
  }
  return { available: true, version: version.split(/\r?\n/u)[0]! };
};

const readHerdrSchema = (): unknown | undefined => {
  try {
    const result = runProbe(["herdr", "api", "schema", "--json"]);
    if (result.exitCode !== 0) return undefined;
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
};

const containsString = (value: unknown, expected: string): boolean => {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsString(item, expected));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => containsString(item, expected));
};

const exposesMachineApi = (schema: unknown): boolean =>
  containsString(schema, "session.snapshot") && containsString(schema, "events.subscribe");

const hasNormalizedContextProperties = (definition: unknown): boolean => {
  if (!isRecord(definition) || !isRecord(definition.properties)) return false;
  return (
    Object.hasOwn(definition.properties, "context_used") &&
    Object.hasOwn(definition.properties, "context_limit")
  );
};

// These are the machine-readable records Herdr uses for detected agents and
// their pane/status updates. Field names elsewhere in the API schema do not
// prove that coordinator panes expose normalized context usage.
const exposesNormalizedContext = (schema: unknown): boolean => {
  if (!isRecord(schema) || !isRecord(schema.schemas)) return false;
  const schemas = schema.schemas;
  const definitions = (
    schemaName: "event" | "subscription_event" | "success_response",
  ): Record<string, unknown> => {
    const section = schemas[schemaName];
    if (!isRecord(section) || !isRecord(section.$defs)) return {};
    return section.$defs;
  };
  const success = definitions("success_response");
  const event = definitions("event");
  const subscription = definitions("subscription_event");
  return [
    success.AgentInfo,
    success.PaneInfo,
    event.PaneInfo,
    subscription.PaneAgentStatusChangedEvent,
  ].some(hasNormalizedContextProperties);
};

const defaultSkillRoots = (): string[] => {
  const home = process.env.HOME || homedir();
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const piConfig = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  return [
    join(claudeConfig, "skills"),
    join(piConfig, "skills"),
    join(home, ".agents", "skills"),
    join(process.cwd(), ".claude", "skills"),
    join(process.cwd(), ".pi", "skills"),
    join(process.cwd(), ".agents", "skills"),
  ];
};

const resolveSkill = (name: string, roots: string[]): string | undefined => {
  for (const root of roots) {
    const candidates = [join(root, name, "SKILL.md"), join(root, `${name}.md`)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

const dependencyIssue = (
  name: "git" | "bun" | "flock" | "herdr",
  displayName: "Git" | "Bun" | "flock" | "Herdr",
): CliIssue => ({
  code: `dependency.${name}_missing`,
  message: `${displayName} is unavailable or \`${name} --version\` failed.`,
  remediation: `Install ${displayName} and ensure \`${name}\` is on PATH.`,
});

/**
 * Checks all portable baseline dependencies and optionally validates existing run state.
 *
 * The check is read-only. It accumulates every independent capability failure so a user
 * can repair the machine once instead of discovering missing dependencies one at a time.
 *
 * @param input - Optional state path and skill roots from the versioned request.
 * @returns An Effect containing the complete report and all actionable failures.
 */
export const runPreflight = (input: PreflightInput): Effect.Effect<PreflightOutcome, never> =>
  Effect.gen(function* () {
    const errors: CliIssue[] = [];
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      errors.push({
        code: "platform.unsupported",
        message: `Platform ${platform} is unsupported; coordinate-implementation supports macOS and Linux.`,
        remediation: "Run the coordinator on macOS or Linux.",
      });
    }

    const git = probeCommand("git", ["--version"]);
    const bun = probeCommand("bun", ["--version"]);
    const flock = probeCommand("flock", ["--version"]);
    const herdrVersion = probeCommand("herdr", ["--version"]);
    const herdrSchema = herdrVersion.available ? readHerdrSchema() : undefined;
    const machineApi = herdrVersion.available && exposesMachineApi(herdrSchema);
    const normalizedContext = herdrVersion.available && exposesNormalizedContext(herdrSchema);
    const herdr: HerdrCapability = {
      ...herdrVersion,
      machine_api: machineApi,
      normalized_context: normalizedContext,
    };

    if (!git.available) errors.push(dependencyIssue("git", "Git"));
    if (!bun.available) errors.push(dependencyIssue("bun", "Bun"));
    if (!flock.available) errors.push(dependencyIssue("flock", "flock"));
    if (!herdr.available) {
      errors.push(dependencyIssue("herdr", "Herdr"));
    } else if (!machineApi) {
      errors.push({
        code: "herdr.machine_api_missing",
        message:
          "Herdr's machine-readable API does not expose `session.snapshot` and `events.subscribe`.",
        remediation: "Install Herdr 0.9.1 or later and verify `herdr api schema --json` succeeds.",
      });
    }

    const harnesses: HarnessCapability[] = [
      { name: "claude", ...probeCommand("claude", ["--version"]) },
      { name: "pi", ...probeCommand("pi", ["--version"]) },
    ];
    if (harnesses.every((harness) => !harness.available)) {
      errors.push({
        code: "harness.none_available",
        message: "Neither Pi nor Claude Code is available.",
        remediation:
          "Install at least one supported harness and ensure `pi` or `claude` is on PATH.",
      });
    }

    const skillPath = resolveSkill("implement", input.skillRoots ?? defaultSkillRoots());
    const skills: SkillCapability[] = [
      {
        name: "implement",
        available: skillPath !== undefined,
        path: skillPath ?? null,
      },
    ];
    if (skillPath === undefined) {
      errors.push({
        code: "skill.implement_missing",
        message: "The required Matt Pocock `implement` skill was not found.",
        remediation:
          "Install Matt Pocock's `implement` skill for the selected harness or pass its parent directory in `skill_roots`.",
      });
    }

    let state: StateSummary | null = null;
    if (input.statePath !== undefined) {
      const validation = yield* Effect.result(validateStateFile(input.statePath));
      if (Result.isFailure(validation)) {
        errors.push(validation.failure.issue);
      } else {
        state = validation.success;
      }
    }

    return {
      report: {
        platform,
        capabilities: { git, bun, flock, herdr },
        harnesses,
        skills,
        state,
      },
      errors,
    };
  });
