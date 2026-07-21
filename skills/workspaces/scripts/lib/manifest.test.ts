import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findWorkspaceRoot,
  loadManifest,
  ManifestValidationError,
  validateManifest,
  WorkspaceRootNotFoundError,
} from "./manifest.ts";

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
      stackPrefix: "checkout-redesign/",
      branchPrefix: "checkout-redesign/",
    });
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
