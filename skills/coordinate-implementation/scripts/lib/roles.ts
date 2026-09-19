import { Effect } from "effect";
import type { CliIssue, HarnessName, RoleName, RoleRecord, RoleValidateInput } from "./contract.ts";

/**
 * Model choices exposed by one installed harness.
 */
export type ModelChoices = {
  source: "aliases-plus-custom" | "installed-catalog";
  values: string[];
  custom: boolean;
};

/**
 * Installed capabilities used to configure one role harness.
 */
export type RoleHarnessDiscovery = {
  name: HarnessName;
  available: boolean;
  version: string | null;
  models: ModelChoices;
  efforts: string[];
};

/**
 * Complete role-discovery result returned by the helper.
 */
export type RolesDiscovery = {
  harnesses: RoleHarnessDiscovery[];
};

/**
 * Discovery output plus actionable inspection failures.
 */
export type RolesDiscoveryOutcome = {
  discovery: RolesDiscovery;
  errors: CliIssue[];
};

/**
 * Validated role output plus any rejection that prevented it.
 */
export type RoleValidationOutcome = {
  result: { role: RoleName; record: RoleRecord } | null;
  errors: CliIssue[];
};

type CommandOutput = {
  exitCode: number;
  stdout: string;
};

const run = (command: string, args: string[]): CommandOutput => {
  try {
    const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
};

const probeVersion = (harness: HarnessName): string | null => {
  const output = run(harness, ["--version"]);
  if (output.exitCode !== 0 || output.stdout.length === 0) return null;
  return output.stdout.split(/\r?\n/u)[0] ?? null;
};

const optionSection = (help: string, flag: string): string => {
  const lines = help.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(flag));
  if (start < 0) return "";
  const section = [lines[start]!];
  for (const line of lines.slice(start + 1, start + 4)) {
    if (/^\s*--[a-z]/u.test(line)) break;
    section.push(line);
  }
  return section.join(" ");
};

const parseEfforts = (help: string, flag: "--effort" | "--thinking"): string[] => {
  const section = optionSection(help, flag);
  const parenthesized = section.match(/\(([^)]+)\)/u)?.[1];
  const labelled = section.match(/(?:level|choices)\s*:\s*([^\n]+)/iu)?.[1];
  const values = parenthesized ?? labelled ?? "";
  return values
    .split(",")
    .map((value) => value.trim().replace(/[.)]+$/u, ""))
    .filter((value) => /^[a-z][a-z0-9-]*$/u.test(value));
};

const parsePiModels = (catalog: string): string[] => {
  const models: string[] = [];
  for (const line of catalog.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 2 || columns[0] === "provider") continue;
    const provider = columns[0]!;
    const model = columns[1]!;
    if (!/^[^/\s]+$/u.test(provider) || model.length === 0) continue;
    models.push(`${provider}/${model}`);
  }
  return models;
};

const inspectHarness = (
  name: HarnessName,
): { discovery: RoleHarnessDiscovery; errors: CliIssue[] } => {
  const version = probeVersion(name);
  if (version === null) {
    return {
      discovery: {
        name,
        available: false,
        version: null,
        models:
          name === "claude"
            ? { source: "aliases-plus-custom", values: ["fable", "opus", "sonnet"], custom: true }
            : { source: "installed-catalog", values: [], custom: false },
        efforts: [],
      },
      errors: [],
    };
  }

  const help = run(name, ["--help"]);
  const effortFlag = name === "claude" ? "--effort" : "--thinking";
  const efforts = help.exitCode === 0 ? parseEfforts(help.stdout, effortFlag) : [];
  const errors: CliIssue[] = [];
  if (efforts.length === 0) {
    errors.push({
      code: "role.effort_discovery_failed",
      message: `Could not read accepted effort values from the installed ${name} harness.`,
      remediation: `Verify \`${name} --help\` documents ${effortFlag}, then retry.`,
    });
  }

  if (name === "claude") {
    return {
      discovery: {
        name,
        available: true,
        version,
        models: {
          source: "aliases-plus-custom",
          values: ["fable", "opus", "sonnet"],
          custom: true,
        },
        efforts,
      },
      errors,
    };
  }

  const catalog = run("pi", ["--list-models"]);
  const models = catalog.exitCode === 0 ? parsePiModels(catalog.stdout) : [];
  if (models.length === 0) {
    errors.push({
      code: "role.model_discovery_failed",
      message: "Could not read any models from Pi's installed model catalog.",
      remediation: "Verify `pi --list-models` succeeds and returns provider and model columns.",
    });
  }
  return {
    discovery: {
      name,
      available: true,
      version,
      models: { source: "installed-catalog", values: models, custom: false },
      efforts,
    },
    errors,
  };
};

/**
 * Discovers installed supported harnesses, model choices, and effort vocabularies.
 *
 * @returns An Effect containing every harness record and any inspection errors.
 */
export const discoverRoles = (): Effect.Effect<RolesDiscoveryOutcome, never> =>
  Effect.sync(() => {
    const inspected = (["claude", "pi"] as const).map(inspectHarness);
    return {
      discovery: { harnesses: inspected.map((item) => item.discovery) },
      errors: inspected.flatMap((item) => item.errors),
    };
  });

const parseTriple = (triple: string): RoleRecord | null => {
  const values = triple.trim().split(/\s+/u);
  if (values.length !== 3) return null;
  const [harness, model, effort] = values;
  if ((harness !== "claude" && harness !== "pi") || !model || !effort) return null;
  return { harness, model, effort };
};

const issue = (code: string, message: string, remediation: string): RoleValidationOutcome => ({
  result: null,
  errors: [{ code, message, remediation }],
});

/**
 * Validates one role record against choices discovered from the installed harness.
 *
 * @param input - Role name plus either a quoted triple or structured record.
 * @returns An Effect containing the exact accepted record or one rejection with no substitution.
 */
export const validateRole = (
  input: RoleValidateInput,
): Effect.Effect<RoleValidationOutcome, never> =>
  Effect.gen(function* () {
    const parsed = input.triple === undefined ? input.record! : parseTriple(input.triple);
    if (parsed === null || parsed === undefined) {
      return issue(
        "role.triple_invalid",
        "Role triple must contain exactly `harness model effort`.",
        "Pass one quoted triple such as `pi openai-codex/gpt-5.6-sol high`.",
      );
    }

    const record = { ...parsed };
    const discovered = yield* discoverRoles();
    const harness = discovered.discovery.harnesses.find((item) => item.name === record.harness)!;
    if (!harness.available) {
      return issue(
        "role.harness_unavailable",
        `Harness \`${record.harness}\` is not installed or did not launch.`,
        "Choose an available harness returned by `roles.discover`; no substitute was selected.",
      );
    }
    const discoveryError =
      harness.efforts.length === 0
        ? discovered.errors.find((error) => error.code === "role.effort_discovery_failed")
        : record.harness === "pi" && harness.models.values.length === 0
          ? discovered.errors.find((error) => error.code === "role.model_discovery_failed")
          : undefined;
    if (discoveryError !== undefined) return { result: null, errors: [discoveryError] };

    const suffixIndex = record.model.lastIndexOf(":");
    const suffix = suffixIndex >= 0 ? record.model.slice(suffixIndex + 1) : "";
    if (harness.efforts.includes(suffix)) {
      if (suffix !== record.effort) {
        return issue(
          "role.effort_conflict",
          `Model effort suffix \`${suffix}\` conflicts with role effort \`${record.effort}\`.`,
          "Choose one effort and make the model suffix and explicit effort agree.",
        );
      }
      record.model = record.model.slice(0, suffixIndex);
    }

    if (!harness.efforts.includes(record.effort)) {
      return issue(
        "role.effort_invalid",
        `Effort \`${record.effort}\` is not accepted by the installed ${record.harness} harness.`,
        `Choose an exact effort returned for ${record.harness} by \`roles.discover\`; no substitute was selected.`,
      );
    }

    if (record.harness === "pi" && !harness.models.values.includes(record.model)) {
      return issue(
        "role.model_unavailable",
        `Model \`${record.model}\` is not present in Pi's installed model catalog.`,
        "Choose an exact model returned by `roles.discover`; no substitute was selected.",
      );
    }
    if (record.harness === "claude" && record.model.includes("/")) {
      return issue(
        "role.model_invalid",
        `Model \`${record.model}\` is provider-qualified and cannot launch through Claude Code.`,
        "Choose fable, opus, sonnet, or enter a Claude Code custom model value without a provider prefix.",
      );
    }

    return { result: { role: input.role, record }, errors: [] };
  });
