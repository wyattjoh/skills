/**
 * Stateless Cloudflare CI token bootstrap for an Alchemy stack.
 *
 * Canonical template from the `setup-alchemy` skill. Copy it into the target
 * repository, edit `CONFIG`, and delete the forge adapter the repository does
 * not use. Run it from a laptop, never from CI:
 *
 *     bun run bootstrap:ci            # first install; a rerun with both secrets present changes nothing
 *     bun run bootstrap:ci --rotate   # mint, verify, and install a replacement; old tokens stay valid
 *
 * Nothing is persisted: credentials live in memory, the new token goes
 * straight to the forge on stdin, and no state, `.env`, or metadata file is
 * written. That is why a plain rerun cannot verify the installed token's
 * scopes, and why changing scopes takes an explicit `--rotate`.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { Cause, Effect, Exit, Schema } from "effect";

class BootstrapEffectError extends Schema.TaggedError<BootstrapEffectError>()(
  "BootstrapEffectError",
  {
    message: Schema.String,
  },
) {}

class ForgeCommandError extends Schema.TaggedError<ForgeCommandError>()("ForgeCommandError", {
  message: Schema.String,
}) {}

const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";
const HEX32 = /^[a-f0-9]{32}$/i;
const ACCOUNT_READ_GROUPS = ["Account Settings Read", "Account Settings Write"];

/** The two forge secrets the deploy job reads; installed in this order. */
export const SECRET_NAMES = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

/** Where the secrets go. Written down, not derived from the Git remote. */
export type ForgeTarget = { kind: "forgejo" | "github"; host: string; repo: string };

export type BootstrapConfig = {
  /** Token names are `<prefix>-<timestamp>`; also how prior partial runs are detected. */
  tokenPrefix: string;
  forge: ForgeTarget;
  /** Account-scoped permission group names, exactly as Cloudflare's catalog names them. */
  accountGroups: readonly string[];
  /** Optional zone-scoped grants on one existing, active zone in the same account. */
  zone?: { hostname: string; groups: readonly string[] };
};

/**
 * Edit for the target repository. Keep `accountGroups` in step with what the
 * stack deploys (see the skill's permissions reference), then `--rotate`.
 */
export const CONFIG: BootstrapConfig = {
  tokenPrefix: "example-ci",
  forge: { kind: "github", host: "github.com", repo: "owner/example" },
  accountGroups: [
    "Account Settings Read",
    "Workers Scripts Write",
    "Workers Tail Read",
    "Secrets Store Write",
  ],
};

/** Safe operator-facing failure; never contains credentials or raw provider output. */
export class BootstrapFailure extends Error {}

export type CatalogEntry = { id: string; name: string; scopes: readonly string[] };

export type TokenPolicy = {
  effect: "allow";
  resources: Record<string, "*">;
  permission_groups: { id: string }[];
};

export type TokenPlan = { name: string; expires_on: string; policies: TokenPolicy[] };

const fail = (message: string): never => {
  throw new BootstrapFailure(message);
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("Unexpected response shape; details withheld.");

const array = (value: unknown, what: string): unknown[] =>
  Array.isArray(value) ? value : fail(`${what} is malformed; details withheld.`);

/** Parses Cloudflare's permission-group catalog into the fields the plan needs. */
export function parseCatalog(value: unknown): CatalogEntry[] {
  return array(value, "Cloudflare permission catalog").map((raw) => {
    const entry = object(raw);
    const scopes = array(entry.scopes, "Cloudflare permission catalog");
    if (
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      !scopes.every((scope) => typeof scope === "string")
    )
      fail("Cloudflare permission catalog is malformed; details withheld.");
    return { id: entry.id as string, name: entry.name as string, scopes: scopes as string[] };
  });
}

/**
 * Builds the exact token policy from the live catalog; credentials never enter it.
 * @param zoneId - Required exactly when `config.zone` is set.
 * @param days - Lifetime in whole days, 1 to 365.
 * @param now - Creation time; the expiry drops fractional seconds, which Cloudflare rejects.
 */
export function tokenPlan(
  config: BootstrapConfig,
  accountId: string,
  zoneId: string | undefined,
  catalog: readonly CatalogEntry[],
  days: number,
  now: Date,
): TokenPlan {
  if (!HEX32.test(accountId)) fail("Account ID must be 32 hex characters.");
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isFinite(now.getTime()))
    fail("Token lifetime must be between 1 and 365 days, with a valid creation time.");
  // The new token proves it can read the account before any secret is installed.
  if (!config.accountGroups.some((name) => ACCOUNT_READ_GROUPS.includes(name)))
    fail(
      "accountGroups must include Account Settings Read (or Write) so the token can be verified.",
    );
  const group = (name: string, scope: string) => {
    const matches = catalog.filter((entry) => entry.name === name && entry.scopes.includes(scope));
    if (matches.length !== 1)
      fail(`Permission group "${name}" is not uniquely available for ${scope}; no token minted.`);
    return { id: matches[0]!.id };
  };
  const policies: TokenPolicy[] = [
    {
      effect: "allow",
      resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" },
      permission_groups: config.accountGroups.map((name) => group(name, ACCOUNT_SCOPE)),
    },
  ];
  if (config.zone) {
    if (zoneId === undefined || !HEX32.test(zoneId)) fail("Zone ID must be 32 hex characters.");
    // The new token proves it can resolve the zone before any secret is installed.
    if (!config.zone.groups.includes("Zone Read"))
      fail("zone.groups must include Zone Read so the token can be verified.");
    policies.push({
      effect: "allow",
      resources: { [`${ZONE_SCOPE}.${zoneId}`]: "*" },
      permission_groups: config.zone.groups.map((name) => group(name, ZONE_SCOPE)),
    });
  }
  return {
    name: `${config.tokenPrefix}-${now.toISOString().replace(/[:.]/g, "-")}`,
    expires_on: new Date(now.getTime() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    policies,
  };
}

/** The forge boundary. Every method throws `BootstrapFailure` on any failure. */
export type Forge = {
  describe: string;
  ensureReady: () => void;
  secretNames: () => ReadonlySet<string>;
  installSecret: (name: string, value: string) => void;
};

export type BootstrapCredentials = { email: string; key: string; accountId: string };

export type BootstrapOptions = { rotate: boolean; days: number };

export type BootstrapDependencies = {
  credentials: () => Promise<BootstrapCredentials>;
  fetch: typeof fetch;
  forge: Forge;
  confirm: (message: string) => Promise<boolean>;
  log: (message: string) => void;
  now: () => Date;
};

export type BootstrapOutcome =
  | { kind: "unchanged" }
  | { kind: "installed"; tokenId: string; expiresOn: string };

const normalizePolicies = (policies: unknown): string[] =>
  array(policies, "Token policy")
    .map((raw) => {
      const policy = object(raw);
      return JSON.stringify({
        effect: policy.effect,
        resources: Object.entries(object(policy.resources)).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ),
        groups: array(policy.permission_groups, "Token grants")
          .map((entry) => String(object(entry).id))
          .toSorted(),
      });
    })
    .toSorted();

/**
 * Installs a verified, least-privilege CI token, or leaves a complete installation alone.
 * @returns A safe outcome containing no credentials.
 */
const bootstrapCiProgram = Effect.fn("bootstrapCi")(function* (
  config: BootstrapConfig,
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
) {
  const { forge, log } = dependencies;
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365)
    fail("Token lifetime must be between 1 and 365 days.");

  // Forge state is read before any Cloudflare credential is collected.
  yield* Effect.try({
    try: () => forge.ensureReady(),
    catch: (cause) =>
      new BootstrapEffectError({
        message:
          cause instanceof Error
            ? cause.message
            : "Forge authentication is not ready; nothing provisioned.",
      }),
  });
  const names = yield* Effect.try({
    try: () => forge.secretNames(),
    catch: (cause) =>
      new BootstrapEffectError({
        message:
          cause instanceof Error
            ? cause.message
            : "Forge secret metadata could not be read; stopped.",
      }),
  });
  const present = SECRET_NAMES.filter((name) => names.has(name));
  if (!options.rotate && present.length === SECRET_NAMES.length) {
    log(
      "Cloudflare CI secrets already exist; unchanged. Their values and scopes were not verified. Use --rotate to install current scopes.",
    );
    return { kind: "unchanged" as const };
  }
  if (!options.rotate && present.length > 0)
    fail(
      "Cloudflare CI secrets are partially configured. Inspect the installation, then explicitly use --rotate; no token minted.",
    );

  const credentials = yield* Effect.tryPromise({
    try: () => dependencies.credentials(),
    catch: (cause) =>
      new BootstrapEffectError({
        message:
          cause instanceof BootstrapFailure
            ? cause.message
            : "Cloudflare credentials could not be collected; details withheld.",
      }),
  });
  if (
    !credentials.email.includes("@") ||
    /[\r\n]/.test(credentials.email) ||
    credentials.key.length < 16 ||
    /[\r\n]/.test(credentials.key) ||
    !HEX32.test(credentials.accountId)
  )
    fail(
      "An explicit Cloudflare user email, Global API key, and account ID are required; no saved-profile fallback.",
    );

  const call = Effect.fn("cloudflareRequest")(function* (
    path: string,
    body?: unknown,
    bearer?: string,
  ) {
    const method = body === undefined ? "GET" : "POST";
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (request) => Effect.sync(() => request.abort()),
    );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        dependencies.fetch(`https://api.cloudflare.com/client/v4${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(bearer === undefined
              ? { "X-Auth-Email": credentials.email, "X-Auth-Key": credentials.key }
              : { Authorization: `Bearer ${bearer}` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          // Combine Effect interruption with the existing request deadline.
          signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(20_000)]),
        }),
      catch: () =>
        new BootstrapEffectError({
          message:
            "Cloudflare request failed or timed out; details withheld. No alternate credential used.",
        }),
    });
    const rawEnvelope = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new BootstrapEffectError({
          message: "Cloudflare returned unreadable data; details withheld.",
        }),
    });
    const envelope = yield* Effect.try({
      try: () => object(rawEnvelope),
      catch: () =>
        new BootstrapEffectError({
          message: "Cloudflare returned unreadable data; details withheld.",
        }),
    });
    if (!response.ok || envelope.success !== true) {
      return yield* new BootstrapEffectError({
        message: `Cloudflare ${method} ${path.split("?")[0]} failed (HTTP ${response.status}); details withheld. No alternate credential used.`,
      });
    }
    return envelope.result;
  }, Effect.scoped);

  const { accountId } = credentials;
  const accountPath = `/accounts/${accountId}`;
  if (object(yield* call(accountPath)).id !== accountId)
    fail("Cloudflare account does not match the explicit target.");

  let zoneId: string | undefined;
  const zonePath = config.zone
    ? `/zones?account.id=${accountId}&name=${encodeURIComponent(config.zone.hostname)}&per_page=50`
    : undefined;
  if (config.zone && zonePath) {
    const zones = array(yield* call(zonePath), "Cloudflare zone list");
    const zone = zones.length === 1 ? object(zones[0]) : undefined;
    if (
      !zone ||
      zone.name !== config.zone.hostname ||
      zone.status !== "active" ||
      typeof zone.id !== "string" ||
      !HEX32.test(zone.id) ||
      object(zone.account).id !== accountId
    )
      fail(
        `Expected exactly one active ${config.zone.hostname} zone in the chosen account; no token minted.`,
      );
    zoneId = zone!.id as string;
  }

  const catalog = parseCatalog(yield* call("/user/tokens/permission_groups"));
  const plan = tokenPlan(config, accountId, zoneId, catalog, options.days, dependencies.now());

  if (!options.rotate) {
    const prior = array(yield* call("/user/tokens"), "Cloudflare token list").some((raw) => {
      const token = object(raw);
      return (
        typeof token.name === "string" &&
        token.name.startsWith(`${config.tokenPrefix}-`) &&
        token.status === "active"
      );
    });
    if (prior)
      fail(
        `Active ${config.tokenPrefix}-* tokens exist without complete forge secrets. Inspect the partial setup, then explicitly use --rotate; no duplicate minted.`,
      );
  }

  log(`Target: ${forge.describe}; account ${accountId}.`);
  for (const name of config.accountGroups) log(`Account grant: ${name}`);
  if (config.zone)
    for (const name of config.zone.groups)
      log(`Zone grant: ${name} on ${config.zone.hostname} (${zoneId}) only.`);
  log(`Expires ${plan.expires_on}. Writes only ${SECRET_NAMES.join(" and ")}; revokes nothing.`);
  const approved = yield* Effect.tryPromise({
    try: () =>
      dependencies.confirm(
        options.rotate
          ? "Mint a NEW CI token and replace both forge secrets? Old tokens remain valid."
          : "Mint a CI token and install both forge secrets?",
      ),
    catch: () =>
      new BootstrapEffectError({
        message: "Confirmation failed; no token minted or secrets changed.",
      }),
  });
  if (!approved) fail("Confirmation declined; no token minted or secrets changed.");

  const minted = object(yield* call("/user/tokens", plan));
  const id = minted.id;
  const value = minted.value;
  if (
    typeof id !== "string" ||
    !HEX32.test(id) ||
    typeof value !== "string" ||
    !value.trim() ||
    value === credentials.key
  )
    return fail("Cloudflare did not return a distinct scoped token; no forge secret changed.");
  log(
    `Created token ID ${id} (value withheld). If a later step fails, inspect this token before another explicit --rotate; it is not revoked automatically.`,
  );

  const verified = object(yield* call("/user/tokens/verify", undefined, value));
  if (verified.id !== id || verified.status !== "active")
    fail("New token verification failed; no forge secret changed.");
  const metadata = object(yield* call(`/user/tokens/${id}`));
  const expiresOn = typeof metadata.expires_on === "string" ? Date.parse(metadata.expires_on) : NaN;
  if (
    metadata.id !== id ||
    metadata.name !== plan.name ||
    metadata.status !== "active" ||
    !Number.isFinite(expiresOn) ||
    Math.abs(expiresOn - Date.parse(plan.expires_on)) >= 1_000 ||
    JSON.stringify(normalizePolicies(metadata.policies)) !==
      JSON.stringify(normalizePolicies(plan.policies))
  )
    fail(
      "New token metadata does not match the exact requested policy and expiry; no forge secret changed.",
    );
  if (object(yield* call(accountPath, undefined, value)).id !== accountId)
    fail("New token cannot read the chosen account; no forge secret changed.");
  if (zonePath) {
    const visible = array(yield* call(zonePath, undefined, value), "Cloudflare zone list");
    if (visible.length !== 1 || object(visible[0]).id !== zoneId)
      fail("New token cannot resolve the chosen zone; no forge secret changed.");
  }

  const values: Record<(typeof SECRET_NAMES)[number], string> = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: value,
  };
  for (const name of SECRET_NAMES) {
    yield* Effect.try({
      try: () => forge.installSecret(name, values[name]),
      catch: (cause) =>
        new BootstrapEffectError({
          message:
            cause instanceof Error
              ? cause.message
              : `Forge ${name} installation failed; setup may be partial.`,
        }),
    });
    log(`Installed forge secret ${name}.`);
  }
  log(
    `Verified scopes installed; expires ${plan.expires_on}. Old tokens remain valid. The next CI deploy is the live check.`,
  );
  return { kind: "installed" as const, tokenId: id, expiresOn: plan.expires_on };
});

/** Preserves the public Promise API while running the setup program through Effect. */
export const bootstrapCi = (
  config: BootstrapConfig,
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
): Promise<BootstrapOutcome> =>
  Effect.runPromiseExit(bootstrapCiProgram(config, options, dependencies)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const cause = Cause.squash(exit.cause);
    throw cause instanceof BootstrapFailure
      ? cause
      : new BootstrapFailure(
          cause instanceof Error ? cause.message : "CI bootstrap failed; details withheld.",
        );
  });

/** Runs a forge CLI. Must throw `BootstrapFailure` when the process cannot run or times out. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  input?: string,
) => { exitCode: number; stdout: string };

const parseJson = (stdout: string, what: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return fail(`${what} returned no typed outcome; output withheld.`);
  }
};

/**
 * Forgejo through the `forgejo` CLI's `--agent` JSON envelopes. Secret writes
 * need an approval round trip: the first PUT returns one grant, the second
 * PUT presents it.
 */
export function forgejoForge(target: ForgeTarget, run: RunCommand): Forge {
  const secretPath = `/repos/${target.repo}/actions/secrets`;
  const forgejo = (args: readonly string[], input?: string) =>
    object(parseJson(run("forgejo", args, input).stdout, "Forgejo"));
  const api = (method: string, path: string) => [
    "api",
    "--agent",
    "--host",
    target.host,
    "--method",
    method,
    path,
  ];
  return {
    describe: `${target.host}/${target.repo} (Forgejo)`,
    ensureReady: () => {
      if (forgejo(["auth", "status", "--agent", "--host", target.host]).status !== "success")
        fail("Forgejo authentication is not ready; nothing provisioned.");
    },
    secretNames: () => {
      const names = new Set<string>();
      // 50 per page; ten pages is far beyond any real repository's secret count.
      for (let page = 1; page <= 10; page++) {
        const outcome = forgejo(api("GET", `${secretPath}?page=${page}&limit=50`));
        if (outcome.status !== "success")
          fail("Forgejo secret metadata could not be read; stopped.");
        const body = object(outcome.result).body;
        const entries = array(
          typeof body === "string" ? parseJson(body, "Forgejo") : body,
          "Forgejo secret metadata",
        );
        for (const entry of entries) {
          const name = object(entry).name;
          if (typeof name !== "string") fail("Forgejo secret metadata is malformed.");
          names.add(name as string);
        }
        if (entries.length < 50) return names;
      }
      return fail("Forgejo secret pagination limit reached; stopped.");
    },
    installSecret: (name, value) => {
      const args = [
        ...api("PUT", `${secretPath}/${name}`),
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
      ];
      const input = JSON.stringify({ data: value });
      const proposal = forgejo(args, input);
      if (proposal.status !== "error" || object(proposal.error).code !== "approval.required")
        fail(
          `Forgejo did not request approval for ${name}; installation may be partial. Token value withheld; old token not revoked.`,
        );
      const steps = Array.isArray(proposal.next_steps) ? proposal.next_steps : [];
      const grants = steps.map(object).filter((step) => step.action === "approve");
      const grant = grants.length === 1 ? grants[0]!.grant : undefined;
      if (typeof grant !== "string" || !grant)
        fail(
          "Forgejo approval was absent or ambiguous; installation may be partial. No retry or token revocation.",
        );
      if (forgejo([...args, "--approve", grant as string], input).status !== "success")
        fail(
          `Forgejo ${name} installation failed; setup may be partial. Token value withheld; old token not revoked.`,
        );
    },
  };
}

/** GitHub through the `gh` CLI; secret values travel on stdin, never in argv. */
export function githubForge(target: ForgeTarget, run: RunCommand): Forge {
  const repo = `${target.host}/${target.repo}`;
  return {
    describe: `${repo} (GitHub)`,
    ensureReady: () => {
      if (run("gh", ["auth", "status", "--hostname", target.host]).exitCode !== 0)
        fail("GitHub CLI authentication is not ready; nothing provisioned.");
    },
    secretNames: () => {
      const listed = run("gh", [
        "secret",
        "list",
        "--repo",
        repo,
        "--app",
        "actions",
        "--json",
        "name",
      ]);
      if (listed.exitCode !== 0) fail("GitHub secret metadata could not be read; stopped.");
      const names = new Set<string>();
      for (const entry of array(parseJson(listed.stdout, "GitHub"), "GitHub secret metadata")) {
        const name = object(entry).name;
        if (typeof name !== "string") fail("GitHub secret metadata is malformed.");
        names.add(name as string);
      }
      return names;
    },
    installSecret: (name, value) => {
      if (
        run("gh", ["secret", "set", name, "--repo", repo, "--app", "actions"], value).exitCode !== 0
      )
        fail(
          `GitHub ${name} installation failed; setup may be partial. Token value withheld; old token not revoked.`,
        );
    },
  };
}

export const forgeFor = (target: ForgeTarget, run: RunCommand): Forge =>
  target.kind === "forgejo" ? forgejoForge(target, run) : githubForge(target, run);

/** Runs a forge CLI with credentials stripped, preserving its bounded synchronous contract. */
const runCommandEffect = Effect.fn("runForgeCommand")(function* (
  command: string,
  args: readonly string[],
  input?: string,
) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("CLOUDFLARE_") || name.startsWith("ALCHEMY_")) delete env[name];
  const result = yield* Effect.try({
    try: () =>
      spawnSync(command, [...args], {
        input,
        env,
        encoding: "utf8",
        // Forge APIs answer in seconds; 30s bounds a hung CLI without cutting off a slow link.
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    catch: () =>
      new ForgeCommandError({ message: `${command} failed to run or timed out; output withheld.` }),
  });
  if (result.error || result.signal) {
    return yield* new ForgeCommandError({
      message: `${command} failed to run or timed out; output withheld.`,
    });
  }
  return { exitCode: result.status ?? 1, stdout: result.stdout };
});

/** Spawns a forge CLI with Cloudflare and Alchemy credentials stripped from its environment. */
export const runCommand: RunCommand = (command, args, input) => {
  try {
    return Effect.runSync(runCommandEffect(command, args, input));
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : `${command} failed to run or timed out; output withheld.`,
    );
  }
};

const question = async (label: string, hidden = false): Promise<string> => {
  if (!process.stdin.isTTY)
    fail(
      "An interactive terminal is required for missing credentials or confirmation; no saved-profile fallback.",
    );
  const output = hidden
    ? new Writable({ write: (_chunk, _encoding, done) => done() })
    : process.stdout;
  if (hidden) process.stdout.write(label);
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const cancel = new AbortController();
  reader.once("SIGINT", () => cancel.abort());
  try {
    return await reader.question(hidden ? "" : label, {
      // Five minutes to paste a credential; an abandoned prompt should not hold the terminal.
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(300_000)]),
    });
  } catch {
    return fail("Operator input cancelled or timed out; details withheld.");
  } finally {
    reader.close();
    if (hidden) {
      output.destroy();
      process.stdout.write("\n");
    }
  }
};

const help = (
  config: BootstrapConfig,
) => `Usage: bun run bootstrap:ci [--rotate] [--days 1..365] [--yes]

Mints a Cloudflare CI token and installs ${SECRET_NAMES.join(" and ")} into
${config.forge.host}/${config.forge.repo}. Nothing else is changed.

Without --rotate, existing secrets are left unchanged. --rotate mints a
replacement with the current scopes; old tokens are NOT revoked.
Account grants: ${config.accountGroups.join(", ")}.${
  config.zone ? `\nZone grants on ${config.zone.hostname}: ${config.zone.groups.join(", ")}.` : ""
}

Needs an authenticated ${config.forge.kind === "forgejo" ? "forgejo" : "gh"} CLI. Missing CLOUDFLARE_EMAIL,
CLOUDFLARE_API_KEY (Global API key, hidden), and CLOUDFLARE_ACCOUNT_ID are prompted.
Credentials stay in memory. --days sets the lifetime (default 90). --yes approves
minting non-interactively for fully supplied, reviewed credentials.`;

if (import.meta.main) {
  try {
    let flags: { rotate: boolean; yes: boolean; help: boolean; days: string };
    try {
      flags = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: false,
        options: {
          rotate: { type: "boolean", default: false },
          yes: { type: "boolean", default: false },
          help: { type: "boolean", default: false },
          days: { type: "string", default: "90" },
        },
      }).values;
    } catch {
      throw new BootstrapFailure(
        "Invalid bootstrap:ci arguments; use --help. Argument values withheld.",
      );
    }
    if (flags.help) console.log(help(CONFIG));
    else
      await bootstrapCi(
        CONFIG,
        { rotate: flags.rotate, days: Number(flags.days) },
        {
          fetch,
          forge: forgeFor(CONFIG.forge, runCommand),
          now: () => new Date(),
          log: (line) => console.log(line),
          confirm: async (message) =>
            flags.yes || /^(?:y|yes)$/i.test((await question(`${message} [y/N] `)).trim()),
          credentials: async () => ({
            email:
              process.env.CLOUDFLARE_EMAIL?.trim() ||
              (await question("Cloudflare user email: ")).trim(),
            key:
              process.env.CLOUDFLARE_API_KEY?.trim() ||
              (await question("Global API key (hidden): ", true)).trim(),
            accountId:
              process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
              (await question("Deployment account ID (32 hex): ")).trim(),
          }),
        },
      );
  } catch (error) {
    console.error(
      error instanceof BootstrapFailure
        ? error.message
        : "CI bootstrap failed; credentials and response details withheld. No retry or alternate credential used.",
    );
    process.exitCode = 1;
  }
}
