#!/usr/bin/env bun

/**
 * npm-info.ts - Fetch npm package metadata from the registry
 *
 * Outputs structured JSON with package info, README, maintainers, etc.
 * Handles errors gracefully - never throws, returns structured error info instead.
 */

const FETCH_TIMEOUT_MS = 10_000; // 10s - registries typically respond in <2s

// Types

interface NpmPackageInfo {
  name: string;
  description: string;
  version: string;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  maintainers: string[];
  keywords: string[];
  readme: string | null;
  deprecated: string | false;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  distTags: Record<string, string>;
}

interface NpmError {
  error: string;
  package: string;
}

// Raw registry types (subset of what the API returns)

interface RegistryMaintainer {
  name: string;
  email?: string;
}

interface RegistryRepository {
  type?: string;
  url?: string;
}

interface RegistryVersionInfo {
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  deprecated?: string;
}

interface RegistryResponse {
  name: string;
  description?: string;
  "dist-tags"?: Record<string, string>;
  license?: string | { type?: string };
  homepage?: string;
  repository?: string | RegistryRepository;
  maintainers?: RegistryMaintainer[];
  keywords?: string[];
  readme?: string;
  versions?: Record<string, RegistryVersionInfo>;
}

// Pure extraction functions (exported for testing)

export function extractRepository(repo: string | RegistryRepository | undefined): string | null {
  if (!repo) return null;

  if (typeof repo === "string") return repo;

  if (!repo.url) return null;

  // Normalize git+https://github.com/foo/bar.git -> https://github.com/foo/bar
  return repo.url.replace(/^git\+/, "").replace(/\.git$/, "");
}

export function extractLicense(license: string | { type?: string } | undefined): string | null {
  if (!license) return null;
  if (typeof license === "string") return license;
  return license.type ?? null;
}

export function extractMaintainers(maintainers: RegistryMaintainer[] | undefined): string[] {
  if (!maintainers) return [];
  return maintainers.map((m) => m.name);
}

export function parseRegistryResponse(data: RegistryResponse): NpmPackageInfo {
  const distTags = data["dist-tags"] ?? {};
  const latestVersion = distTags["latest"];

  // Get version-specific info from the latest version
  const versionInfo = latestVersion ? data.versions?.[latestVersion] : undefined;

  return {
    name: data.name,
    description: data.description ?? "",
    version: latestVersion ?? "unknown",
    license: extractLicense(data.license),
    homepage: data.homepage ?? null,
    repository: extractRepository(data.repository),
    maintainers: extractMaintainers(data.maintainers),
    keywords: data.keywords ?? [],
    readme: data.readme ?? null,
    deprecated: versionInfo?.deprecated ?? false,
    engines: versionInfo?.engines ?? {},
    dependencies: versionInfo?.dependencies ?? {},
    distTags,
  };
}

// Fetch logic

async function fetchPackageInfo(packageName: string): Promise<NpmPackageInfo | NpmError> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (response.status === 404) {
      return {
        error: `Package "${packageName}" not found`,
        package: packageName,
      };
    }

    if (!response.ok) {
      return {
        error: `Registry returned HTTP ${response.status}`,
        package: packageName,
      };
    }

    const data: RegistryResponse = await response.json();
    return parseRegistryResponse(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch: ${message}`, package: packageName };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Main

async function main(): Promise<void> {
  const packageName = Bun.argv.slice(2)[0];

  if (!packageName) {
    console.error(
      JSON.stringify({
        error: "Usage: npm-info.ts <package-name>",
        package: "",
      }),
    );
    process.exit(1);
  }

  const result = await fetchPackageInfo(packageName);

  if ("error" in result) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main();
}
