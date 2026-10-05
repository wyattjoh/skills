#!/usr/bin/env bun

/** Fetches npm package metadata and writes structured JSON for CLI callers. */
import { Effect, Schema } from "effect";

const FETCH_TIMEOUT_MS = 10_000;

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

/** Represents a failed npm registry operation. */
class RegistryRequestError extends Schema.TaggedError<RegistryRequestError>()(
  "RegistryRequestError",
  {
    message: Schema.String,
  },
) {}

/** Extracts a browser-friendly repository URL from registry metadata. */
export function extractRepository(repo: string | RegistryRepository | undefined): string | null {
  if (!repo) return null;
  if (typeof repo === "string") return repo;
  if (!repo.url) return null;
  return repo.url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** Extracts the SPDX license string when registry metadata provides one. */
export function extractLicense(license: string | { type?: string } | undefined): string | null {
  if (!license) return null;
  return typeof license === "string" ? license : (license.type ?? null);
}

/** Extracts maintainer names from registry metadata. */
export function extractMaintainers(maintainers: RegistryMaintainer[] | undefined): string[] {
  return maintainers?.map((maintainer) => maintainer.name) ?? [];
}

/** Converts a registry response to the stable npm-info JSON shape. */
export function parseRegistryResponse(data: RegistryResponse): NpmPackageInfo {
  const distTags = data["dist-tags"] ?? {};
  const latestVersion = distTags.latest;
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

/** Fetches package metadata, cancelling the request and timer when its scope closes. */
export const fetchPackageInfoEffect = Effect.fn("fetchPackageInfo")(function* (
  packageName: string,
): Effect.fn.Return<NpmPackageInfo | NpmError> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const request = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          return { controller, timeoutId };
        }),
        ({ controller, timeoutId }) =>
          Effect.sync(() => {
            clearTimeout(timeoutId);
            controller.abort();
          }),
      );
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            signal: request.controller.signal,
            headers: { Accept: "application/json" },
          }),
        catch: (cause) =>
          new RegistryRequestError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      if (response.status === 404)
        return { error: `Package "${packageName}" not found`, package: packageName };
      if (!response.ok)
        return { error: `Registry returned HTTP ${response.status}`, package: packageName };
      const data = yield* Effect.tryPromise({
        try: () => response.json() as Promise<RegistryResponse>,
        catch: (cause) =>
          new RegistryRequestError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      return parseRegistryResponse(data);
    }),
  ).pipe(
    Effect.catchTag("RegistryRequestError", (error) =>
      Effect.succeed({ error: `Failed to fetch: ${error.message}`, package: packageName }),
    ),
  );
  return result;
});

/** Promise compatibility bridge for callers that do not run Effects directly. */
export function fetchPackageInfo(packageName: string): Promise<NpmPackageInfo | NpmError> {
  return Effect.runPromise(fetchPackageInfoEffect(packageName));
}

const main = Effect.fn("npmInfo.main")(function* (): Effect.fn.Return<void> {
  const packageName = Bun.argv.slice(2)[0];
  if (!packageName) {
    console.error(JSON.stringify({ error: "Usage: npm-info.ts <package-name>", package: "" }));
    process.exitCode = 1;
    return;
  }
  const result = yield* fetchPackageInfoEffect(packageName);
  if ("error" in result) {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
});

if (import.meta.main) Effect.runPromise(main());
