import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "./audit.ts";
import { renderClaudeMd } from "./generate.ts";
import { loadManifest } from "./manifest.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const makeMemberRepo = (parent: string, name: string): string => {
  const dir = join(parent, name);
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
  expect(init.exitCode).toBe(0);
  const commit = Bun.spawnSync([
    "git",
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "init",
  ]);
  expect(commit.exitCode).toBe(0);
  return dir;
};

/**
 * Scaffolds a fully healthy workspace hub with one real member repo and
 * returns the hub root.
 */
const makeWorkspace = (): string => {
  const parent = mkdtempSync(join(tmpdir(), "workspaces-audit-"));
  created.push(parent);
  makeMemberRepo(parent, "app");

  const root = join(parent, "demo-workspace");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "workspace.yaml"),
    [
      "version: 1",
      "name: Demo",
      "slug: demo",
      "description: Demo workspace.",
      "members:",
      "  - name: app",
      "    path: ../app",
      "context:",
      "  layers:",
      "    - name: constitution",
      "      path: docs/constitution.md",
      "      description: Invariant principles",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "docs", "constitution.md"), "# Constitution\n");
  writeFileSync(join(root, "docs", "index.md"), "- [Constitution](constitution.md)\n");
  writeFileSync(join(root, "JOURNAL.md"), "# Journal\n");
  const manifest = Effect.runSync(loadManifest(root));
  writeFileSync(join(root, "CLAUDE.md"), renderClaudeMd(manifest));
  symlinkSync("CLAUDE.md", join(root, "AGENTS.md"));
  return root;
};

describe("auditWorkspace", () => {
  it("returns no findings for a healthy workspace", () => {
    const root = makeWorkspace();
    expect(Effect.runSync(auditWorkspace(root))).toEqual([]);
  });

  it("flags a stale CLAUDE.md", () => {
    const root = makeWorkspace();
    writeFileSync(join(root, "CLAUDE.md"), "# Hand edited\n");
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual(["claude-md-stale"]);
    expect(findings[0]?.level).toBe("error");
  });

  it("flags a missing layer", () => {
    const root = makeWorkspace();
    rmSync(join(root, "docs", "constitution.md"));
    writeFileSync(join(root, "docs", "index.md"), "(empty index)\n");
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual(["layer-missing"]);
  });

  it("flags an existing layer that has no link in the index", () => {
    const root = makeWorkspace();
    // Index contains no Markdown link to constitution.md
    writeFileSync(join(root, "docs", "index.md"), "# Index\n\nNo links here.\n");
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual(["layer-unindexed"]);
    expect(findings[0]?.level).toBe("warn");
  });

  it("resolves a directory link for a directory layer", () => {
    const root = makeWorkspace();
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "0001-init.md"), "# ADR 0001\n");
    writeFileSync(
      join(root, "workspace.yaml"),
      [
        "version: 1",
        "name: Demo",
        "slug: demo",
        "description: Demo workspace.",
        "members:",
        "  - name: app",
        "    path: ../app",
        "context:",
        "  layers:",
        "    - name: constitution",
        "      path: docs/constitution.md",
        "      description: Invariant principles",
        "    - name: adr",
        "      path: docs/adr/",
        "      description: Architecture decisions",
        "",
      ].join("\n"),
    );
    // Both layers linked using destination-relative paths from docs/index.md
    writeFileSync(
      join(root, "docs", "index.md"),
      "- [Constitution](constitution.md)\n- [ADR directory](adr/)\n",
    );
    const manifest = Effect.runSync(loadManifest(root));
    writeFileSync(join(root, "CLAUDE.md"), renderClaudeMd(manifest));
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual([]);
  });

  it("does not treat anchors or external URLs as layer references", () => {
    const root = makeWorkspace();
    // Index has anchors and external URLs that mention constitution.md but no
    // local relative link to it; the layer must still be flagged as unindexed
    writeFileSync(
      join(root, "docs", "index.md"),
      [
        "- [Anchor only](#constitution.md)",
        "- [External](https://example.com/docs/constitution.md)",
        "- plain text mention of docs/constitution.md",
        "",
      ].join("\n"),
    );
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual(["layer-unindexed"]);
  });

  it("flags a missing member repo", () => {
    const root = makeWorkspace();
    rmSync(join(root, "..", "app"), { recursive: true, force: true });
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual(["member-missing"]);
  });

  it("flags an ADR archive that has no mapping manifest", () => {
    const root = makeWorkspace();
    mkdirSync(join(root, "docs", "adr", "archive"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "archive", "0001-old.md"), "# Old decision\n");
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual(["adr-archive-unmanifested"]);
    expect(findings[0]?.level).toBe("warn");
  });

  it("accepts an ADR archive that carries a README mapping manifest", () => {
    const root = makeWorkspace();
    mkdirSync(join(root, "docs", "adr", "archive"), { recursive: true });
    writeFileSync(join(root, "docs", "adr", "archive", "0001-old.md"), "# Old decision\n");
    writeFileSync(
      join(root, "docs", "adr", "archive", "README.md"),
      "# Archive\n\n0001 → dropped\n",
    );
    expect(Effect.runSync(auditWorkspace(root))).toEqual([]);
  });

  it("flags missing journal and broken AGENTS.md link as errors", () => {
    const root = makeWorkspace();
    rmSync(join(root, "JOURNAL.md"));
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "AGENTS.md"), "not a symlink\n");
    const findings = Effect.runSync(auditWorkspace(root));
    expect(findings.map((finding) => finding.id)).toEqual([
      "agents-md-not-link",
      "journal-missing",
    ]);
  });
});
