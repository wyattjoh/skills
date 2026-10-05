#!/usr/bin/env bun

/** Checks domain availability through IANA RDAP servers. */
import { parseArgs } from "node:util";
import { Effect, Schema, type Scope } from "effect";

export interface CliOptions {
  names: string[];
  tlds: string[];
  json: boolean;
  help: boolean;
}
interface BootstrapData {
  services: [string[], string[]][];
}
interface RdapServerCache {
  servers: Map<string, string>;
  fetched: boolean;
}
export type DomainStatus = "available" | "registered" | "unknown";
export interface DomainCheckResult {
  domain: string;
  status: DomainStatus;
  error?: string;
}
interface JsonOutput {
  results: { domain: string; available: boolean; error?: string }[];
}

const HELP_TEXT = `
Domain Availability Checker

Usage:
  check-domains [options] <name1> [name2] [name3] ...

Options:
  --tlds=com,net,org    Comma-separated list of TLDs to check (default: com)
  --json                Output results as JSON
  --help                Show this help message

Examples:
  check-domains example
  check-domains --tlds=com,dev,io,app example mysite
  check-domains --json example
`;

/** Prints command help without performing network work. */
export function showHelp(): void {
  console.log(HELP_TEXT);
}
/** Parses command-line domain names and flags. */
export function parseCli(args: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tlds: { type: "string", default: "com" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  return {
    names: positionals.map((name) => name.toLowerCase()),
    tlds: (values.tlds as string)
      .split(",")
      .map((tld) => tld.trim().toLowerCase())
      .filter((tld) => tld.length > 0),
    json: values.json as boolean,
    help: values.help as boolean,
  };
}

const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const cache: RdapServerCache = { servers: new Map(), fetched: false };
/** Represents an IANA bootstrap request failure. */
class BootstrapError extends Schema.TaggedError<BootstrapError>()("BootstrapError", {
  message: Schema.String,
}) {}

const request = Effect.fn("rdap.request")(function* (
  url: string,
  fallback?: string,
): Effect.fn.Return<Response, BootstrapError, Scope.Scope> {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (active) => Effect.sync(() => active.abort()),
  );
  return yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30_000)]),
      }),
    catch: (cause) =>
      new BootstrapError({
        message: cause instanceof Error ? cause.message : (fallback ?? String(cause)),
      }),
  });
});

/** Fetches and caches the IANA RDAP bootstrap registry. */
export const fetchBootstrapEffect = Effect.fn("fetchBootstrap")(function* (): Effect.fn.Return<
  void,
  BootstrapError,
  Scope.Scope
> {
  if (cache.fetched) return;
  const response = yield* request(IANA_BOOTSTRAP_URL);
  if (!response.ok)
    return yield* new BootstrapError({
      message: `Failed to fetch RDAP bootstrap: ${response.status}`,
    });
  const data = yield* Effect.tryPromise({
    try: () => response.json() as Promise<BootstrapData>,
    catch: (cause) =>
      new BootstrapError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
  yield* Effect.try({
    try: () => {
      for (const [tlds, servers] of data.services) {
        const serverUrl = servers[0];
        if (serverUrl) for (const tld of tlds) cache.servers.set(tld.toLowerCase(), serverUrl);
      }
      cache.fetched = true;
    },
    catch: (cause) =>
      new BootstrapError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
}, Effect.scoped);

/** Resolves the authoritative RDAP server for a top-level domain. */
export const getRdapServerEffect = Effect.fn("getRdapServer")(function* (
  tld: string,
): Effect.fn.Return<string | null, BootstrapError> {
  yield* fetchBootstrapEffect();
  return cache.servers.get(tld.toLowerCase()) ?? null;
});
/** Promise compatibility bridge for existing callers. */
export function getRdapServer(tld: string): Promise<string | null> {
  return Effect.runPromise(getRdapServerEffect(tld));
}

/** Checks one domain, preserving unavailable-server and network-error semantics. */
export const checkDomainEffect = Effect.fn("checkDomain")(function* (
  domain: string,
): Effect.fn.Return<DomainCheckResult, BootstrapError, Scope.Scope> {
  const tld = domain.split(".").at(-1);
  if (!tld) return { domain, status: "unknown", error: "Invalid domain format" };
  const server = yield* getRdapServerEffect(tld);
  if (!server) return { domain, status: "unknown", error: `No RDAP server for .${tld}` };
  return yield* request(`${server}domain/${domain}`, "Network error").pipe(
    Effect.map((response): DomainCheckResult =>
      response.status === 404
        ? { domain, status: "available" }
        : response.status === 200
          ? { domain, status: "registered" }
          : { domain, status: "unknown", error: `Unexpected status: ${response.status}` },
    ),
    Effect.catchTag("BootstrapError", (error) =>
      Effect.succeed({ domain, status: "unknown" as const, error: error.message }),
    ),
  );
}, Effect.scoped);
/** Promise compatibility bridge for existing callers. */
export function checkDomain(domain: string): Promise<DomainCheckResult> {
  return Effect.runPromise(checkDomainEffect(domain));
}

/** Checks domains in batches of five with the existing delay between batches. */
export const checkBatchEffect = Effect.fn("checkBatch")(function* (
  names: string[],
  tlds: string[],
): Effect.fn.Return<DomainCheckResult[], BootstrapError> {
  yield* fetchBootstrapEffect();
  const domains = names.flatMap((name) => tlds.map((tld) => `${name}.${tld}`));
  const results: DomainCheckResult[] = [];
  for (let index = 0; index < domains.length; index += 5) {
    results.push(
      ...(yield* Effect.forEach(domains.slice(index, index + 5), checkDomainEffect, {
        concurrency: 5,
      })),
    );
    if (index + 5 < domains.length) yield* Effect.sleep("100 millis");
  }
  return results;
});
/** Promise compatibility bridge for existing callers. */
export function checkBatch(names: string[], tlds: string[]): Promise<DomainCheckResult[]> {
  return Effect.runPromise(checkBatchEffect(names, tlds));
}

/** Formats results in the stable JSON output schema. */
export function formatJson(results: DomainCheckResult[]): string {
  return JSON.stringify(
    {
      results: results.map((result) => ({
        domain: result.domain,
        available: result.status === "available",
        ...(result.error ? { error: result.error } : {}),
      })),
    } satisfies JsonOutput,
    null,
    2,
  );
}
/** Formats results as the human-readable table. */
export function formatTable(results: DomainCheckResult[]): string {
  return [
    "Domain              Status",
    "─".repeat(35),
    ...results.map(
      (result) =>
        `${result.domain.padEnd(20)}${result.status === "available" ? "Available ✓" : result.status === "registered" ? "Registered" : result.error ? `Unknown (${result.error})` : "Unknown"}`,
    ),
  ].join("\n");
}
/** Prints formatted results. */
export function printResults(results: DomainCheckResult[], asJson: boolean): void {
  console.log(asJson ? formatJson(results) : formatTable(results));
}

const main = Effect.fn("checkDomains.main")(function* (): Effect.fn.Return<void, BootstrapError> {
  const options = parseCli(Bun.argv.slice(2));
  if (options.help) return showHelp();
  if (options.names.length === 0) {
    console.error("Error: At least one domain name is required.");
    console.error("Run with --help for usage information.");
    process.exitCode = 1;
    return;
  }
  if (options.tlds.length === 0) {
    console.error("Error: At least one TLD is required.");
    process.exitCode = 1;
    return;
  }
  printResults(yield* checkBatchEffect(options.names, options.tlds), options.json);
});
if (import.meta.main) Effect.runPromise(main());
