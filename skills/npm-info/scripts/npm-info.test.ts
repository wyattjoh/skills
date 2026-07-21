import { describe, expect, it as test } from "bun:test";
import {
  extractLicense,
  extractMaintainers,
  extractRepository,
  parseRegistryResponse,
} from "./npm-info.ts";

// ═══════════════════════════════════════════════════════════════
// extractRepository Tests
// ═══════════════════════════════════════════════════════════════

describe("extractRepository", () => {
  test("returns null for undefined", () => {
    expect(extractRepository(undefined)).toBe(null);
  });

  test("returns string directly", () => {
    expect(extractRepository("https://github.com/foo/bar")).toBe("https://github.com/foo/bar");
  });

  test("extracts url from object", () => {
    expect(extractRepository({ type: "git", url: "https://github.com/foo/bar" })).toBe(
      "https://github.com/foo/bar",
    );
  });

  test("normalizes git+ prefix", () => {
    expect(
      extractRepository({
        type: "git",
        url: "git+https://github.com/foo/bar.git",
      }),
    ).toBe("https://github.com/foo/bar");
  });

  test("strips .git suffix", () => {
    expect(extractRepository({ type: "git", url: "https://github.com/foo/bar.git" })).toBe(
      "https://github.com/foo/bar",
    );
  });

  test("returns null for object without url", () => {
    expect(extractRepository({ type: "git" })).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════
// extractLicense Tests
// ═══════════════════════════════════════════════════════════════

describe("extractLicense", () => {
  test("returns null for undefined", () => {
    expect(extractLicense(undefined)).toBe(null);
  });

  test("returns string directly", () => {
    expect(extractLicense("MIT")).toBe("MIT");
  });

  test("extracts type from object", () => {
    expect(extractLicense({ type: "ISC" })).toBe("ISC");
  });

  test("returns null for object without type", () => {
    expect(extractLicense({})).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════
// extractMaintainers Tests
// ═══════════════════════════════════════════════════════════════

describe("extractMaintainers", () => {
  test("returns empty array for undefined", () => {
    expect(extractMaintainers(undefined)).toEqual([]);
  });

  test("returns empty array for empty array", () => {
    expect(extractMaintainers([])).toEqual([]);
  });

  test("extracts names from maintainer objects", () => {
    expect(
      extractMaintainers([{ name: "alice", email: "alice@example.com" }, { name: "bob" }]),
    ).toEqual(["alice", "bob"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseRegistryResponse Tests
// ═══════════════════════════════════════════════════════════════

describe("parseRegistryResponse", () => {
  test("parses minimal response", () => {
    const result = parseRegistryResponse({ name: "test-pkg" });

    expect(result.name).toBe("test-pkg");
    expect(result.description).toBe("");
    expect(result.version).toBe("unknown");
    expect(result.license).toBe(null);
    expect(result.homepage).toBe(null);
    expect(result.repository).toBe(null);
    expect(result.maintainers).toEqual([]);
    expect(result.keywords).toEqual([]);
    expect(result.readme).toBe(null);
    expect(result.deprecated).toBe(false);
    expect(result.engines).toEqual({});
    expect(result.dependencies).toEqual({});
    expect(result.distTags).toEqual({});
  });

  test("parses full response", () => {
    const result = parseRegistryResponse({
      name: "express",
      description: "Fast web framework",
      "dist-tags": { latest: "4.21.2", next: "5.0.1" },
      license: "MIT",
      homepage: "http://expressjs.com/",
      repository: {
        type: "git",
        url: "git+https://github.com/expressjs/express.git",
      },
      maintainers: [{ name: "dougwilson" }],
      keywords: ["framework", "web"],
      readme: "# Express",
      versions: {
        "4.21.2": {
          engines: { node: ">= 0.10.0" },
          dependencies: { accepts: "~1.3.8" },
        },
      },
    });

    expect(result.name).toBe("express");
    expect(result.description).toBe("Fast web framework");
    expect(result.version).toBe("4.21.2");
    expect(result.license).toBe("MIT");
    expect(result.homepage).toBe("http://expressjs.com/");
    expect(result.repository).toBe("https://github.com/expressjs/express");
    expect(result.maintainers).toEqual(["dougwilson"]);
    expect(result.keywords).toEqual(["framework", "web"]);
    expect(result.readme).toBe("# Express");
    expect(result.deprecated).toBe(false);
    expect(result.engines).toEqual({ node: ">= 0.10.0" });
    expect(result.dependencies).toEqual({ accepts: "~1.3.8" });
    expect(result.distTags).toEqual({ latest: "4.21.2", next: "5.0.1" });
  });

  test("detects deprecated packages", () => {
    const result = parseRegistryResponse({
      name: "old-pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": { deprecated: "Use new-pkg instead" },
      },
    });

    expect(result.deprecated).toBe("Use new-pkg instead");
  });
});
