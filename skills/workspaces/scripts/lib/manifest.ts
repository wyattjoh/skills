import { Data, Effect } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

/**
 * Raised when no `workspace.yaml` is found walking upward from the start
 * directory.
 */
export class WorkspaceRootNotFoundError extends Data.TaggedError("WorkspaceRootNotFoundError")<{
  startDir: string;
}> {}

/**
 * Raised when `workspace.yaml` cannot be read or is not valid YAML.
 */
export class ManifestParseError extends Data.TaggedError("ManifestParseError")<{
  path: string;
  message: string;
}> {}

/**
 * Raised when `workspace.yaml` parses but violates the manifest schema. All
 * violations are collected into `issues` so one pass reports everything.
 */
export class ManifestValidationError extends Data.TaggedError("ManifestValidationError")<{
  path: string;
  issues: string[];
}> {}

/**
 * A member repository referenced by the workspace hub. `path` is relative to
 * the workspace root (members are sibling checkouts, never vendored).
 */
export type WorkspaceMember = {
  name: string;
  path: string;
  url: string | undefined;
  ref: string;
};

/**
 * One ordered context layer. The `enter` flow loads layer paths top to bottom;
 * `audit` verifies each path exists and appears in the curated index.
 */
export type ContextLayer = {
  name: string;
  path: string;
  description: string;
};

/**
 * The parsed and validated form of `workspace.yaml`, the workspace's source
 * of truth. Everything generated (CLAUDE.md, lock file) derives from this.
 */
export type WorkspaceManifest = {
  version: 1;
  name: string;
  slug: string;
  description: string;
  members: WorkspaceMember[];
  layers: ContextLayer[];
  skills: string[];
  stackPrefix: string;
  branchPrefix: string;
};

/**
 * File name of the workspace manifest at the hub root.
 */
export const MANIFEST_FILENAME = "workspace.yaml";

/**
 * File name of the frozen member-SHA lock at the hub root.
 */
export const LOCK_FILENAME = "workspace.lock";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Walks upward from `startDir` until a directory containing `workspace.yaml`
 * is found and returns that directory.
 */
export const findWorkspaceRoot = (
  startDir: string,
): Effect.Effect<string, WorkspaceRootNotFoundError> =>
  Effect.gen(function* () {
    let current = resolve(startDir);
    while (true) {
      if (existsSync(join(current, MANIFEST_FILENAME))) return current;
      const parent = dirname(current);
      if (parent === current) {
        return yield* new WorkspaceRootNotFoundError({ startDir });
      }
      current = parent;
    }
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (
  raw: Record<string, unknown>,
  field: string,
  issues: string[],
  label: string,
): string => {
  const value = raw[field];
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${label} must include a non-empty string "${field}"`);
    return "";
  }
  return value.trim();
};

const validateMember = (value: unknown, index: number, issues: string[]): WorkspaceMember => {
  if (!isRecord(value)) {
    issues.push(`members[${index}] must be a mapping`);
    return { name: "", path: "", url: undefined, ref: "main" };
  }
  const label = `members[${index}]`;
  const url = value.url;
  if (url !== undefined && typeof url !== "string") {
    issues.push(`${label} "url" must be a string when present`);
  }
  const ref = value.ref;
  if (ref !== undefined && (typeof ref !== "string" || !ref.trim())) {
    issues.push(`${label} "ref" must be a non-empty string when present`);
  }
  return {
    name: stringAt(value, "name", issues, label),
    path: stringAt(value, "path", issues, label),
    url: typeof url === "string" ? url : undefined,
    ref: typeof ref === "string" && ref.trim() ? ref.trim() : "main",
  };
};

const validateLayer = (value: unknown, index: number, issues: string[]): ContextLayer => {
  if (!isRecord(value)) {
    issues.push(`context.layers[${index}] must be a mapping`);
    return { name: "", path: "", description: "" };
  }
  const label = `context.layers[${index}]`;
  return {
    name: stringAt(value, "name", issues, label),
    path: stringAt(value, "path", issues, label),
    description: stringAt(value, "description", issues, label),
  };
};

/**
 * Validates a parsed YAML document against the workspace manifest schema,
 * collecting every violation before failing.
 */
export const validateManifest = (
  raw: unknown,
  path: string,
): Effect.Effect<WorkspaceManifest, ManifestValidationError> =>
  Effect.gen(function* () {
    const issues: string[] = [];
    if (!isRecord(raw)) {
      return yield* new ManifestValidationError({
        path,
        issues: ["manifest must be a YAML mapping"],
      });
    }

    if (raw.version !== 1) issues.push('manifest "version" must be 1');
    const name = stringAt(raw, "name", issues, "manifest");
    const slug = stringAt(raw, "slug", issues, "manifest");
    const description = stringAt(raw, "description", issues, "manifest");
    if (slug && !SLUG_PATTERN.test(slug)) {
      issues.push(`manifest "slug" must be kebab-case (got "${slug}")`);
    }

    const membersRaw = raw.members;
    const members = Array.isArray(membersRaw)
      ? membersRaw.map((member, index) => validateMember(member, index, issues))
      : [];
    if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
      issues.push('manifest must include a non-empty "members" list');
    }
    const memberNames = new Set<string>();
    for (const member of members) {
      if (member.name && memberNames.has(member.name)) {
        issues.push(`duplicate member name "${member.name}"`);
      }
      memberNames.add(member.name);
    }

    const contextRaw = raw.context;
    const layersRaw = isRecord(contextRaw) ? contextRaw.layers : undefined;
    const layers = Array.isArray(layersRaw)
      ? layersRaw.map((layer, index) => validateLayer(layer, index, issues))
      : [];
    if (!Array.isArray(layersRaw) || layersRaw.length === 0) {
      issues.push('manifest must include a non-empty "context.layers" list');
    }

    const skillsRaw = raw.skills;
    const skills = Array.isArray(skillsRaw)
      ? skillsRaw.filter((skill): skill is string => typeof skill === "string")
      : [];
    if (skillsRaw !== undefined && !Array.isArray(skillsRaw)) {
      issues.push('manifest "skills" must be a list when present');
    }

    const conventionsRaw = isRecord(raw.conventions) ? raw.conventions : {};
    const stackPrefixRaw = conventionsRaw["stack-prefix"];
    const branchPrefixRaw = conventionsRaw["branch-prefix"];
    const stackPrefix =
      typeof stackPrefixRaw === "string" && stackPrefixRaw.trim()
        ? stackPrefixRaw.trim()
        : `${slug}/`;
    const branchPrefix =
      typeof branchPrefixRaw === "string" && branchPrefixRaw.trim()
        ? branchPrefixRaw.trim()
        : `${slug}/`;
    if (stackPrefix.includes(".")) {
      issues.push(
        `stack-prefix "${stackPrefix}" must not contain dots (stack names are git-config subsections)`,
      );
    }

    if (issues.length > 0) {
      return yield* new ManifestValidationError({ path, issues });
    }

    return {
      version: 1,
      name,
      slug,
      description,
      members,
      layers,
      skills,
      stackPrefix,
      branchPrefix,
    };
  });

/**
 * Reads, parses, and validates `workspace.yaml` from a workspace root
 * directory.
 */
export const loadManifest = (
  rootDir: string,
): Effect.Effect<WorkspaceManifest, ManifestParseError | ManifestValidationError> =>
  Effect.gen(function* () {
    const path = join(rootDir, MANIFEST_FILENAME);
    const raw = yield* Effect.try({
      try: () => parse(readFileSync(path, "utf8")) as unknown,
      catch: (error) => new ManifestParseError({ path, message: String(error) }),
    });
    return yield* validateManifest(raw, path);
  });

/**
 * Resolves a member's checkout directory against the workspace root.
 */
export const resolveMemberPath = (rootDir: string, member: WorkspaceMember): string =>
  resolve(rootDir, member.path);
