#!/usr/bin/env bun

/**
 * Domain availability checker using RDAP (Registration Data Access Protocol).
 * Queries IANA bootstrap data to find authoritative RDAP servers, then checks
 * domain registration status via HTTP status codes.
 */

import { parseArgs } from "node:util";

// ── Types ────────────────────────────────────────────────────────────────────

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
  results: {
    domain: string;
    available: boolean;
    error?: string;
  }[];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

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

export function showHelp(): void {
  console.log(HELP_TEXT);
}

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

  const tlds = (values.tlds as string)
    .split(",")
    .map((tld: string) => tld.trim().toLowerCase())
    .filter((tld: string) => tld.length > 0);

  return {
    names: positionals.map((name: string) => name.toLowerCase()),
    tlds,
    json: values.json as boolean,
    help: values.help as boolean,
  };
}

// ── RDAP ─────────────────────────────────────────────────────────────────────

const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

const cache: RdapServerCache = {
  servers: new Map(),
  fetched: false,
};

async function fetchBootstrap(): Promise<void> {
  if (cache.fetched) return;

  const response = await fetch(IANA_BOOTSTRAP_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch RDAP bootstrap: ${response.status}`);
  }

  const data: BootstrapData = await response.json();

  for (const [tlds, servers] of data.services) {
    const serverUrl = servers[0];
    if (!serverUrl) continue;

    for (const tld of tlds) {
      cache.servers.set(tld.toLowerCase(), serverUrl);
    }
  }

  cache.fetched = true;
}

export async function getRdapServer(tld: string): Promise<string | null> {
  await fetchBootstrap();
  return cache.servers.get(tld.toLowerCase()) ?? null;
}

export async function checkDomain(domain: string): Promise<DomainCheckResult> {
  const parts = domain.split(".");
  const tld = parts[parts.length - 1];

  if (!tld) {
    return { domain, status: "unknown", error: "Invalid domain format" };
  }

  const server = await getRdapServer(tld);
  if (!server) {
    return { domain, status: "unknown", error: `No RDAP server for .${tld}` };
  }

  const url = `${server}domain/${domain}`;

  try {
    const response = await fetch(url);

    if (response.status === 404) {
      return { domain, status: "available" };
    }

    if (response.status === 200) {
      return { domain, status: "registered" };
    }

    return {
      domain,
      status: "unknown",
      error: `Unexpected status: ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    return { domain, status: "unknown", error: message };
  }
}

export async function checkBatch(names: string[], tlds: string[]): Promise<DomainCheckResult[]> {
  await fetchBootstrap();

  const domains: string[] = [];
  for (const name of names) {
    for (const tld of tlds) {
      domains.push(`${name}.${tld}`);
    }
  }

  const results: DomainCheckResult[] = [];
  const batchSize = 5;

  for (let i = 0; i < domains.length; i += batchSize) {
    const batch = domains.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(checkDomain));
    results.push(...batchResults);

    if (i + batchSize < domains.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

// ── Output ───────────────────────────────────────────────────────────────────

export function formatJson(results: DomainCheckResult[]): string {
  const output: JsonOutput = {
    results: results.map((r) => ({
      domain: r.domain,
      available: r.status === "available",
      ...(r.error ? { error: r.error } : {}),
    })),
  };
  return JSON.stringify(output, null, 2);
}

export function formatTable(results: DomainCheckResult[]): string {
  const header = "Domain              Status";
  const separator = "─".repeat(35);

  const rows = results.map((r) => {
    const domain = r.domain.padEnd(20);
    let status: string;

    switch (r.status) {
      case "available":
        status = "Available ✓";
        break;
      case "registered":
        status = "Registered";
        break;
      case "unknown":
        status = r.error ? `Unknown (${r.error})` : "Unknown";
        break;
    }

    return `${domain}${status}`;
  });

  return [header, separator, ...rows].join("\n");
}

export function printResults(results: DomainCheckResult[], asJson: boolean): void {
  if (asJson) {
    console.log(formatJson(results));
  } else {
    console.log(formatTable(results));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const options = parseCli(Bun.argv.slice(2));

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.names.length === 0) {
    console.error("Error: At least one domain name is required.");
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  if (options.tlds.length === 0) {
    console.error("Error: At least one TLD is required.");
    process.exit(1);
  }

  const results = await checkBatch(options.names, options.tlds);
  printResults(results, options.json);
}
