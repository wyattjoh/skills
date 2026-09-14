import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findWorkspaceRoot,
  loadManifest,
  ManifestValidationError,
  resolveMemberPath,
  validateManifest,
  type WorkspaceMember,
  WorkspaceRootNotFoundError,
} from "./manifest.ts";
import { spawnGit } from "./git-env.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_MANIFEST = {
  version: 1,
  name: "Checkout Redesign",
  slug: "checkout-redesign",
  description: "Redesign the checkout flow across services.",
  members: [
    { name: "storefront", path: "../storefront", url: "https://github.com/acme/storefront" },
    { name: "payments", path: "../payments", ref: "develop" },
  ],
  context: {
    layers: [
      { name: "constitution", path: "docs/constitution.md", description: "Invariant principles" },
    ],
  },
  skills: ["checkout-redesign-context"],
};

describe("validateManifest", () => {
  it("parses a valid manifest with defaults applied", () => {
    const manifest = Effect.runSync(validateManifest(VALID_MANIFEST, "workspace.yaml"));
    expect(manifest).toEqual({
      version: 1,
      name: "Checkout Redesign",
      slug: "checkout-redesign",
      description: "Redesign the checkout flow across services.",
      members: [
        {
          name: "storefront",
          path: "../storefront",
          url: "https://github.com/acme/storefront",
          ref: "main",
        },
        { name: "payments", path: "../payments", url: undefined, ref: "develop" },
      ],
      layers: [
        {
          name: "constitution",
          path: "docs/constitution.md",
          description: "Invariant principles",
        },
      ],
      skills: ["checkout-redesign-context"],
      sections: [],
      stackPrefix: "checkout-redesign/",
      branchPrefix: "checkout-redesign/",
    });
  });

  it("parses declared sections", () => {
    const manifest = Effect.runSync(
      validateManifest(
        {
          ...VALID_MANIFEST,
          sections: [{ title: "Review site", body: "An Astro site in `src/`." }],
        },
        "workspace.yaml",
      ),
    );
    expect(manifest.sections).toEqual([{ title: "Review site", body: "An Astro site in `src/`." }]);
  });

  it("honours explicit convention prefixes", () => {
    const manifest = Effect.runSync(
      validateManifest(
        {
          ...VALID_MANIFEST,
          conventions: {
            "stack-prefix": "cw/",
            "branch-prefix": "wyattjoh/cw/",
          },
        },
        "workspace.yaml",
      ),
    );
    expect(manifest.stackPrefix).toBe("cw/");
    expect(manifest.branchPrefix).toBe("wyattjoh/cw/");
  });
});

describe("validateManifest failures", () => {
  it("reports exact issues for an invalid manifest", () => {
    const result = Effect.runSync(
      Effect.flip(
        validateManifest(
          {
            version: 2,
            name: "X",
            slug: "Bad Slug",
            description: "d",
            members: [],
            context: { layers: [] },
            conventions: { "stack-prefix": "a.b/" },
          },
          "workspace.yaml",
        ),
      ),
    );
    expect(result).toBeInstanceOf(ManifestValidationError);
    expect(result.issues).toEqual([
      'manifest "version" must be 1',
      'manifest "slug" must be kebab-case (got "Bad Slug")',
      'manifest must include a non-empty "members" list',
      'manifest must include a non-empty "context.layers" list',
      'stack-prefix "a.b/" must not contain dots (stack names are git-config subsections)',
    ]);
  });

  it("reports malformed and duplicate sections", () => {
    const result = Effect.runSync(
      Effect.flip(
        validateManifest(
          {
            ...VALID_MANIFEST,
            sections: [
              { title: "Review site", body: "An Astro site." },
              { title: "Review site", body: "" },
              "not a mapping",
            ],
          },
          "workspace.yaml",
        ),
      ),
    );
    expect(result).toBeInstanceOf(ManifestValidationError);
    expect(result.issues).toEqual([
      'sections[1] must include a non-empty string "body"',
      "sections[2] must be a mapping",
      'duplicate section title "Review site"',
    ]);
  });

  it("rejects a non-list sections key", () => {
    const result = Effect.runSync(
      Effect.flip(
        validateManifest({ ...VALID_MANIFEST, sections: "Review site" }, "workspace.yaml"),
      ),
    );
    expect(result.issues).toEqual(['manifest "sections" must be a list when present']);
  });
});

describe("findWorkspaceRoot and loadManifest", () => {
  it("finds the manifest by walking up and loads it", () => {
    const root = mkdtempSync(join(tmpdir(), "workspaces-manifest-"));
    try {
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
          "    - name: spec",
          "      path: docs/spec.md",
          "      description: The spec",
          "",
        ].join("\n"),
      );
      const nested = join(root, "docs", "deep");
      mkdirSync(nested, { recursive: true });

      const found = Effect.runSync(findWorkspaceRoot(nested));
      expect(found).toBe(root);

      const manifest = Effect.runSync(loadManifest(found));
      expect(manifest.slug).toBe("demo");
      expect(manifest.members).toEqual([
        { name: "app", path: "../app", url: undefined, ref: "main" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails with WorkspaceRootNotFoundError outside any workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspaces-nowhere-"));
    try {
      const error = Effect.runSync(Effect.flip(findWorkspaceRoot(dir)));
      expect(error).toBeInstanceOf(WorkspaceRootNotFoundError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const MANIFEST_YAML = [
  "version: 1",
  "name: Demo",
  "slug: demo",
  "description: Demo workspace.",
  "members:",
  "  - name: app",
  "    path: ../app",
  "context:",
  "  layers:",
  "    - name: spec",
  "      path: docs/spec.md",
  "      description: The spec",
  "",
].join("\n");

const APP_MEMBER: WorkspaceMember = {
  name: "app",
  path: "../app",
  url: undefined,
  ref: "main",
};

const gitInRepo = (repo: string, args: string[]): void => {
  const result = spawnGit([
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    ...args,
  ]);
  expect(result.exitCode).toBe(0);
};

/**
 * Builds the real-world shape: a member checkout beside a hub repository that
 * carries a committed manifest, plus a linked worktree of that hub under
 * `.claude/worktrees/`. Temp dirs are realpath'd because git reports resolved
 * paths and macOS puts `$TMPDIR` behind a symlink.
 */
const makeHub = (): { parent: string; hub: string; worktree: string } => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "workspaces-hub-")));
  created.push(parent);
  mkdirSync(join(parent, "app"), { recursive: true });

  const hub = join(parent, "hub");
  mkdirSync(hub, { recursive: true });
  expect(spawnGit(["init", "-q", "-b", "main", hub]).exitCode).toBe(0);
  writeFileSync(join(hub, "workspace.yaml"), MANIFEST_YAML);
  gitInRepo(hub, ["add", "workspace.yaml"]);
  gitInRepo(hub, ["commit", "-q", "-m", "seed manifest"]);

  const worktree = join(hub, ".claude", "worktrees", "feature");
  gitInRepo(hub, ["worktree", "add", "-q", "-b", "feature", worktree]);

  return { parent, hub, worktree };
};

describe("resolveMemberPath", () => {
  it("resolves a member against the hub checkout", () => {
    const { parent, hub } = makeHub();
    expect(resolveMemberPath(hub, APP_MEMBER)).toBe(join(parent, "app"));
  });

  it("anchors a member on the hub checkout when the workspace is a hub worktree", () => {
    const { parent, worktree } = makeHub();
    expect(resolveMemberPath(worktree, APP_MEMBER)).toBe(join(parent, "app"));
  });

  it("resolves against the given root outside a git repository", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "workspaces-plain-hub-")));
    created.push(parent);
    const hub = join(parent, "hub");
    mkdirSync(hub, { recursive: true });
    writeFileSync(join(hub, "workspace.yaml"), MANIFEST_YAML);

    expect(resolveMemberPath(hub, APP_MEMBER)).toBe(join(parent, "app"));
  });

  it("resolves against the given root when the main working tree holds no manifest", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "workspaces-nested-hub-")));
    created.push(repo);
    expect(spawnGit(["init", "-q", "-b", "main", repo]).exitCode).toBe(0);
    const hub = join(repo, "hub");
    mkdirSync(hub, { recursive: true });
    writeFileSync(join(hub, "workspace.yaml"), MANIFEST_YAML);

    expect(resolveMemberPath(hub, APP_MEMBER)).toBe(join(repo, "app"));
  });
});
