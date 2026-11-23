import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { BacklogError, holdingLocks, writeAtomic } from "./backlog-doc.ts";
import { documentPath } from "./backlog-store/paths.ts";
import type { Config } from "./config.ts";
import { Refused } from "./fleet.ts";

/**
 * Delegate harnesses currently supported by Coordinate.
 */
export const DELEGATE_HARNESSES = ["pi", "claude"] as const;

/**
 * A supported delegate harness.
 */
export type DelegateHarness = (typeof DELEGATE_HARNESSES)[number];

/**
 * The complete set of harnesses enabled for a policy scope, and its optional default.
 */
export type HarnessSelection = {
  enabled: DelegateHarness[];
  default: DelegateHarness | null;
};

/**
 * A valid policy document could not be read or written (exit 2, not a user refusal).
 */
export class HarnessPolicyError extends Schema.TaggedError<HarnessPolicyError>()(
  "HarnessPolicyError",
  { path: Schema.String, message: Schema.String },
) {}

/**
 * A versioned policy file. An omitted global value preserves the legacy behavior.
 */
export type HarnessPolicyDocument = {
  schemaVersion: 1;
  revision: number;
  global: HarnessSelection | undefined;
  domains: Record<string, HarnessSelection>;
};

/**
 * The value displayed for a domain, including whether it inherits or replaces the global policy.
 */
export type HarnessPolicyView = {
  schemaVersion: 1;
  revision: number;
  path: string;
  global: {
    source: "legacy" | "configured";
    policy: HarnessSelection;
  };
  domain: {
    name: string;
    mode: "inherit" | "replace";
    override: HarnessSelection | null;
    effective: HarnessSelection;
  } | null;
};

const POLICY_LOCK_DOMAIN = "@delegate-harness-policy";
const POLICY_FILE = "delegate-harness-policy.json";
const DOMAIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const HARNESS_ORDER = DELEGATE_HARNESSES;

/**
 * The legacy CLI accepts explicit Pi or Claude choices and has no implicit harness default.
 */
export const LEGACY_HARNESS_SELECTION: HarnessSelection = {
  enabled: ["pi", "claude"],
  default: null,
};

/**
 * The versioned policy document in Coordinate's configured state directory.
 * @param stateDir Coordinate state directory.
 * @returns The policy file path.
 */
export const harnessPolicyPath = (stateDir: string): string => join(stateDir, POLICY_FILE);

/**
 * Serialize a policy edit and the domain-rename policy guard against the same reserved lock,
 * alongside any domain locks needed by the operation. The reserved lock name starts with `@`,
 * which cannot be a domain name.
 * @param config Coordinate configuration.
 * @param domains Additional domain locks to acquire in the same sorted lock set.
 * @param effect Operation to run while all locks are held.
 * @returns The operation's result.
 */
export const holdingHarnessPolicyLocks = <A, E, R>(
  config: Config,
  domains: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BacklogError, R> =>
  holdingLocks(config, [POLICY_LOCK_DOMAIN, ...domains], effect);

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const canonicalEnabled = (values: readonly DelegateHarness[]): DelegateHarness[] =>
  HARNESS_ORDER.filter((harness) => values.includes(harness));

const validateSelection = (value: unknown, context: string): HarnessSelection => {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  if (!hasOnlyKeys(value, ["enabled", "default"])) throw new Error(`${context} has unknown fields`);
  if (!Array.isArray(value.enabled)) throw new Error(`${context}.enabled must be an array`);
  const enabled: DelegateHarness[] = [];
  for (const candidate of value.enabled) {
    if (typeof candidate !== "string" || !DELEGATE_HARNESSES.includes(candidate as DelegateHarness))
      throw new Error(`${context}.enabled contains an unsupported harness`);
    enabled.push(candidate as DelegateHarness);
  }
  if (new Set(enabled).size !== enabled.length)
    throw new Error(`${context}.enabled contains duplicate harnesses`);
  const defaultHarness = value.default;
  if (
    defaultHarness !== null &&
    (typeof defaultHarness !== "string" ||
      !DELEGATE_HARNESSES.includes(defaultHarness as DelegateHarness))
  )
    throw new Error(`${context}.default must be pi, claude or null`);
  if (defaultHarness !== null && !enabled.includes(defaultHarness as DelegateHarness))
    throw new Error(`${context}.default must also be enabled`);
  return {
    enabled: canonicalEnabled(enabled),
    default: defaultHarness as DelegateHarness | null,
  };
};

const validateDocument = (value: unknown): HarnessPolicyDocument => {
  if (!isRecord(value)) throw new Error("must be a JSON object");
  if (!hasOnlyKeys(value, ["schemaVersion", "revision", "global", "domains"]))
    throw new Error("contains unknown fields");
  if (value.schemaVersion !== 1)
    throw new Error(`unsupported schemaVersion ${String(value.schemaVersion)}`);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
    throw new Error("revision must be a positive safe integer");
  if (!isRecord(value.domains)) throw new Error("domains must be an object");

  const domains: Record<string, HarnessSelection> = {};
  for (const [domain, selection] of Object.entries(value.domains)) {
    if (!DOMAIN_NAME.test(domain)) throw new Error(`invalid domain name ${domain}`);
    domains[domain] = validateSelection(selection, `domains.${domain}`);
  }

  const global = Object.hasOwn(value, "global")
    ? validateSelection(value.global, "global")
    : undefined;
  return { schemaVersion: 1, revision: value.revision as number, global, domains };
};

const missingDocument = (): HarnessPolicyDocument => ({
  schemaVersion: 1,
  revision: 0,
  global: undefined,
  domains: {},
});

const readDocument = Effect.fn("readHarnessPolicyDocument")(function* (config: Config) {
  const path = harnessPolicyPath(config.stateDir);
  const text = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (hasCode(error, "ENOENT")) return null;
        throw error;
      }
    },
    catch: (cause) =>
      new HarnessPolicyError({
        path,
        message: `${path}: cannot read: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (text === null) return missingDocument();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    return validateDocument(parsed);
  } catch (cause) {
    return yield* new HarnessPolicyError({
      path,
      message: `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
});

const viewOf = (
  config: Config,
  state: HarnessPolicyDocument,
  domain: string | undefined,
): HarnessPolicyView => {
  const globalPolicy = state.global ?? LEGACY_HARNESS_SELECTION;
  const domainPolicy =
    domain !== undefined && Object.hasOwn(state.domains, domain)
      ? state.domains[domain]
      : undefined;
  return {
    schemaVersion: 1,
    revision: state.revision,
    path: harnessPolicyPath(config.stateDir),
    global: {
      source: state.global === undefined ? "legacy" : "configured",
      policy: globalPolicy,
    },
    domain:
      domain === undefined
        ? null
        : {
            name: domain,
            mode: domainPolicy === undefined ? "inherit" : "replace",
            override: domainPolicy ?? null,
            effective: domainPolicy ?? globalPolicy,
          },
  };
};

const selectionText = (selection: HarnessSelection): string =>
  `enabled ${selection.enabled.length > 0 ? selection.enabled.join(", ") : "none"}; default ${selection.default ?? "none"}`;

const renderView = (view: HarnessPolicyView, json: boolean): string[] => {
  if (json) return [JSON.stringify(view, null, 2)];
  const lines = [
    `harness policy revision ${view.revision} (${view.path})`,
    `global (${view.global.source}): ${selectionText(view.global.policy)}`,
  ];
  if (view.domain) {
    lines.push(
      `domain ${view.domain.name} (${view.domain.mode}): ${selectionText(view.domain.effective)}`,
    );
    if (view.domain.override) lines.push(`  replacement: ${selectionText(view.domain.override)}`);
  }
  return lines;
};

const validDomain = (domain: string): boolean => DOMAIN_NAME.test(domain);

const checkExpectedRevision = (
  current: HarnessPolicyDocument,
  expectedRevision: number,
): Effect.Effect<void, Refused> => {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    return Effect.fail(
      new Refused({ message: "--expected-revision must be a non-negative safe integer" }),
    );
  if (current.revision !== expectedRevision)
    return Effect.fail(
      new Refused({
        message: `stale harness policy revision: expected ${expectedRevision}, current ${current.revision}; run coordinate harness-policy show and retry with the current revision`,
      }),
    );
  if (current.revision >= Number.MAX_SAFE_INTEGER)
    return Effect.fail(
      new Refused({ message: "harness policy revision cannot be incremented safely" }),
    );
  return Effect.void;
};

const serializeDocument = (state: HarnessPolicyDocument): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      revision: state.revision,
      ...(state.global === undefined ? {} : { global: state.global }),
      domains: state.domains,
    },
    null,
    2,
  )}\n`;

const validateDomainArgument = (domain: string): Effect.Effect<void, Refused> =>
  validDomain(domain)
    ? Effect.void
    : Effect.fail(
        new Refused({
          message: `${domain} is not a domain name: lowercase letters, digits, . _ -`,
        }),
      );

/**
 * Show the stored global policy and, optionally, one domain's effective inherited or replacement value.
 * @param config Coordinate configuration.
 * @param domain Domain to resolve, if requested.
 * @param json Render JSON instead of text.
 * @returns Lines to print.
 */
export const showHarnessPolicy = Effect.fn("showHarnessPolicy")(function* (
  config: Config,
  domain: string | undefined,
  json: boolean,
) {
  if (domain !== undefined) yield* validateDomainArgument(domain);
  const state = yield* readDocument(config);
  return renderView(viewOf(config, state, domain), json);
});

/**
 * Replace either the global selection or one domain's complete replacement policy using a revision check.
 * @param config Coordinate configuration.
 * @param input Scope, domain, complete selection, expected revision and output format.
 * @returns Lines describing the committed policy.
 */
export const setHarnessPolicy = Effect.fn("setHarnessPolicy")(function* (
  config: Config,
  input: {
    scope: "global" | "domain";
    domain: string | undefined;
    selection: HarnessSelection;
    expectedRevision: number;
    json: boolean;
  },
) {
  if (input.scope === "domain") {
    if (input.domain === undefined)
      return yield* new Refused({ message: "domain scope requires a domain name" });
    yield* validateDomainArgument(input.domain);
  } else if (input.domain !== undefined) {
    return yield* new Refused({ message: "global scope does not accept a domain name" });
  }
  let selection: HarnessSelection;
  try {
    selection = validateSelection(input.selection, "policy");
  } catch (cause) {
    return yield* new Refused({
      message: `invalid harness policy: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  const state = yield* holdingHarnessPolicyLocks(
    config,
    [],
    Effect.gen(function* () {
      const current = yield* readDocument(config);
      yield* checkExpectedRevision(current, input.expectedRevision);
      if (input.scope === "domain") {
        const domain = input.domain ?? "";
        if (!existsSync(documentPath(config.stateDir, domain)))
          return yield* new Refused({
            message: `no backlog for ${domain} at ${documentPath(config.stateDir, domain)}; create the domain before setting an override`,
          });
        return {
          ...current,
          revision: current.revision + 1,
          domains: { ...current.domains, [domain]: selection },
        } satisfies HarnessPolicyDocument;
      }
      return {
        ...current,
        revision: current.revision + 1,
        global: selection,
      } satisfies HarnessPolicyDocument;
    }).pipe(
      Effect.tap((next) =>
        writeAtomic(harnessPolicyPath(config.stateDir), serializeDocument(next)),
      ),
    ),
  );
  return renderView(viewOf(config, state, input.domain), input.json);
});

/**
 * Remove a domain replacement so it inherits the current global policy, with a stale-write check.
 * @param config Coordinate configuration.
 * @param domain Domain whose override is removed.
 * @param expectedRevision Revision returned by the most recent show.
 * @param json Render JSON instead of text.
 * @returns Lines describing the resulting policy.
 */
export const resetHarnessPolicy = Effect.fn("resetHarnessPolicy")(function* (
  config: Config,
  domain: string,
  expectedRevision: number,
  json: boolean,
) {
  yield* validateDomainArgument(domain);
  const state = yield* holdingHarnessPolicyLocks(
    config,
    [],
    Effect.gen(function* () {
      const current = yield* readDocument(config);
      yield* checkExpectedRevision(current, expectedRevision);
      if (!Object.hasOwn(current.domains, domain)) return current;
      const domains = { ...current.domains };
      delete domains[domain];
      const next = { ...current, revision: current.revision + 1, domains };
      yield* writeAtomic(harnessPolicyPath(config.stateDir), serializeDocument(next));
      return next;
    }),
  );
  return renderView(viewOf(config, state, domain), json);
});

/**
 * Refuse a rename that would silently move or activate a domain-specific harness replacement.
 * Call while holding `holdingHarnessPolicyLocks` so policy edits cannot race the check.
 * @param config Coordinate configuration.
 * @param from Existing domain name.
 * @param to Target domain name.
 * @returns Nothing when neither name has a replacement.
 */
export const checkHarnessPolicyDomainRename = Effect.fn("checkHarnessPolicyDomainRename")(
  function* (config: Config, from: string, to: string) {
    const state = yield* readDocument(config);
    for (const domain of [from, to]) {
      if (Object.hasOwn(state.domains, domain))
        return yield* new Refused({
          message: `cannot rename ${from} to ${to} while ${domain} has a harness policy replacement; inspect it with coordinate harness-policy show --domain ${domain}, then reset it explicitly with coordinate harness-policy domain-reset ${domain} --expected-revision ${state.revision}`,
        });
    }
  },
);
