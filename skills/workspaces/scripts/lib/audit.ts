import { Effect } from "effect";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { headSha, isGitRepo, trackedWorkflowArtifacts } from "./git.ts";
import { parseLock, renderClaudeMd } from "./generate.ts";
import {
  LOCK_FILENAME,
  loadManifest,
  type ManifestParseError,
  type ManifestValidationError,
  resolveMemberPath,
  type WorkspaceManifest,
} from "./manifest.ts";

/**
 * Severity of an audit finding. Errors make `audit` exit non-zero; warnings
 * are reported but do not fail the run.
 */
export type AuditLevel = "error" | "warn";

/**
 * One audit finding with a stable machine-readable id, a severity, and a
 * human-facing message that includes the remediation.
 */
export type AuditFinding = {
  id: string;
  level: AuditLevel;
  message: string;
};

const readFileOrNull = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

const auditGeneratedFiles = (root: string, manifest: WorkspaceManifest): AuditFinding[] => {
  const findings: AuditFinding[] = [];

  const claudeMd = readFileOrNull(join(root, "CLAUDE.md"));
  if (claudeMd === null) {
    findings.push({
      id: "claude-md-missing",
      level: "error",
      message: "CLAUDE.md is missing; run `just sync` to generate it from workspace.yaml",
    });
  } else if (claudeMd !== renderClaudeMd(manifest)) {
    findings.push({
      id: "claude-md-stale",
      level: "error",
      message:
        "CLAUDE.md does not match workspace.yaml; run `just sync` (hand edits are overwritten by design)",
    });
  }

  const agentsMd = join(root, "AGENTS.md");
  if (!existsSync(agentsMd)) {
    findings.push({
      id: "agents-md-missing",
      level: "error",
      message: "AGENTS.md is missing; create it as a symlink to CLAUDE.md",
    });
  } else {
    const isLinkToClaudeMd =
      lstatSync(agentsMd).isSymbolicLink() && readlinkSync(agentsMd) === "CLAUDE.md";
    if (!isLinkToClaudeMd) {
      findings.push({
        id: "agents-md-not-link",
        level: "error",
        message: "AGENTS.md must be a symlink to CLAUDE.md so both agents read the same context",
      });
    }
  }

  return findings;
};

/**
 * Returns true for link targets that are external URLs or bare anchors.
 * These must not be treated as local file references when checking manifest
 * layer coverage.
 */
const isExternalOrAnchor = (target: string): boolean =>
  target.startsWith("#") || /^(?:https?:|\/{2})/i.test(target);

/**
 * Parse a Markdown document and return the set of workspace-root-relative
 * paths that its local inline links resolve to. indexDir is the directory
 * containing the index file relative to the workspace root (e.g. "docs").
 * Anchors, external URLs, and empty targets are ignored. Trailing slashes are
 * stripped after joining so that directory links ("adr/") compare cleanly
 * against manifest layer paths ("docs/adr" or "docs/adr/").
 */
const extractIndexedPaths = (content: string, indexDir: string): Set<string> => {
  const paths = new Set<string>();
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const raw = m[1].trim();
    if (isExternalOrAnchor(raw)) continue;
    // Strip any inline fragment (#section) before resolving the path
    const withoutFragment = raw.split("#")[0];
    if (!withoutFragment) continue;
    // Normalize: join resolves ".." segments; strip trailing slash so that
    // "adr/" and "adr" both compare equal to a manifest layer path "docs/adr"
    paths.add(join(indexDir, withoutFragment).replace(/\/$/, ""));
  }
  return paths;
};

const auditLayers = (root: string, manifest: WorkspaceManifest): AuditFinding[] => {
  const findings: AuditFinding[] = [];
  const index = readFileOrNull(join(root, "docs/index.md"));
  if (index === null) {
    findings.push({
      id: "index-missing",
      level: "warn",
      message: "docs/index.md (curated context index) is missing; seed it from the skill template",
    });
  }

  const indexedPaths = index !== null ? extractIndexedPaths(index, "docs") : new Set<string>();

  for (const layer of manifest.layers) {
    if (!existsSync(join(root, layer.path))) {
      findings.push({
        id: "layer-missing",
        level: "error",
        message: `context layer "${layer.name}" points at missing path ${layer.path}`,
      });
      continue;
    }
    // Normalize trailing slash so "docs/adr/" and "docs/adr" compare equal
    const normalizedLayerPath = layer.path.replace(/\/$/, "");
    if (index !== null && !indexedPaths.has(normalizedLayerPath)) {
      findings.push({
        id: "layer-unindexed",
        level: "warn",
        message: `context layer "${layer.name}" (${layer.path}) is not referenced by docs/index.md; add an annotated entry`,
      });
    }
  }

  if (!existsSync(join(root, "JOURNAL.md"))) {
    findings.push({
      id: "journal-missing",
      level: "error",
      message: "JOURNAL.md is missing; the deviation journal is a required workspace artifact",
    });
  }

  return findings;
};

/**
 * Checks the compaction archive. `docs/adr/archive/` holds ADRs retired by
 * the compact flow; it is history, not context, so it must carry a README.md
 * mapping manifest recording which archived ADRs collapsed into which live
 * ones. Archived ADRs without that manifest are untraceable compaction.
 */
const auditAdrArchive = (root: string): AuditFinding[] => {
  const archiveDir = join(root, "docs/adr/archive");
  if (!existsSync(archiveDir)) return [];
  const archivedAdrs = readdirSync(archiveDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md",
  );
  if (archivedAdrs.length > 0 && !existsSync(join(archiveDir, "README.md"))) {
    return [
      {
        id: "adr-archive-unmanifested",
        level: "warn",
        message:
          "docs/adr/archive/ holds archived ADRs but no README.md mapping manifest; record which archived ADRs collapsed into which live ADR so the compaction stays traceable",
      },
    ];
  }
  return [];
};

const auditMembers = (root: string, manifest: WorkspaceManifest): Effect.Effect<AuditFinding[]> =>
  Effect.gen(function* () {
    const findings: AuditFinding[] = [];
    for (const member of manifest.members) {
      const memberPath = resolveMemberPath(root, member);
      if (!existsSync(memberPath)) {
        findings.push({
          id: "member-missing",
          level: "error",
          message: `member "${member.name}" not found at ${memberPath}; clone it or fix its path in workspace.yaml`,
        });
        continue;
      }
      if (!isGitRepo(memberPath)) {
        findings.push({
          id: "member-not-git",
          level: "error",
          message: `member "${member.name}" at ${memberPath} is not a git repository`,
        });
        continue;
      }
      const artifacts = yield* Effect.orElseSucceed(
        trackedWorkflowArtifacts(memberPath),
        () => [] as string[],
      );
      if (artifacts.length > 0) {
        findings.push({
          id: "member-workflow-artifacts",
          level: "warn",
          message: `member "${member.name}" tracks workflow runtime files (${artifacts[0]}${artifacts.length > 1 ? ", …" : ""}); the workspace is a developer tool and member repos must not commit its artifacts`,
        });
      }
    }
    return findings;
  });

const auditLock = (root: string, manifest: WorkspaceManifest): Effect.Effect<AuditFinding[]> =>
  Effect.gen(function* () {
    const lock = readFileOrNull(join(root, LOCK_FILENAME));
    if (lock === null) return [];
    const findings: AuditFinding[] = [];
    for (const entry of parseLock(lock)) {
      const member = manifest.members.find((candidate) => candidate.name === entry.name);
      if (!member) {
        findings.push({
          id: "lock-unknown-member",
          level: "warn",
          message: `workspace.lock references unknown member "${entry.name}"; run \`just freeze\` to refresh`,
        });
        continue;
      }
      const memberPath = resolveMemberPath(root, member);
      if (!existsSync(memberPath) || !isGitRepo(memberPath)) continue;
      const sha = yield* Effect.orElseSucceed(headSha(memberPath), () => "");
      if (sha !== "" && sha !== entry.sha) {
        findings.push({
          id: "lock-stale",
          level: "warn",
          message: `member "${entry.name}" HEAD (${sha.slice(0, 12)}) differs from frozen SHA (${entry.sha.slice(0, 12)}); run \`just freeze\` if intentional`,
        });
      }
    }
    return findings;
  });

/**
 * Runs every workspace integrity check and returns the combined findings,
 * ordered errors first. Manifest load failures propagate as typed errors
 * because nothing else is checkable without a valid manifest.
 */
export const auditWorkspace = (
  root: string,
): Effect.Effect<AuditFinding[], ManifestParseError | ManifestValidationError> =>
  Effect.gen(function* () {
    const manifest = yield* loadManifest(root);
    const findings = [
      ...auditGeneratedFiles(root, manifest),
      ...auditLayers(root, manifest),
      ...auditAdrArchive(root),
      ...(yield* auditMembers(root, manifest)),
      ...(yield* auditLock(root, manifest)),
    ];
    const errors = findings.filter((finding) => finding.level === "error");
    const warnings = findings.filter((finding) => finding.level === "warn");
    return [...errors, ...warnings];
  });
