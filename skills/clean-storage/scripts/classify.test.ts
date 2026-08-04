import { describe, expect, it } from "bun:test";
import {
  bySizeDesc,
  type Candidate,
  categoryFor,
  dropNested,
  formatSize,
  isInstalledSoftware,
  isToolManagedCache,
  isUnderPrefix,
  parseDuKb,
  plural,
  shouldPrune,
  summarizeByCategory,
  totalKb,
} from "./classify.ts";

const candidate = (path: string, category: Candidate["category"], sizeKb: number): Candidate => ({
  path,
  category,
  sizeKb,
  verified: true,
});

describe("categoryFor", () => {
  it("maps target to cargo", () => {
    expect(categoryFor("target")).toBe("cargo");
  });

  it("maps DerivedData and build to xcode", () => {
    expect(categoryFor("DerivedData")).toBe("xcode");
    expect(categoryFor("build")).toBe("xcode");
  });

  it("maps node_modules and .build", () => {
    expect(categoryFor("node_modules")).toBe("node-modules");
    expect(categoryFor(".build")).toBe("swift");
  });

  it("returns null for an unrelated directory name", () => {
    expect(categoryFor("src")).toBe(null);
  });

  it("returns null for directory names that collide with Object.prototype keys", () => {
    expect(categoryFor("constructor")).toBe(null);
    expect(categoryFor("toString")).toBe(null);
    expect(categoryFor("valueOf")).toBe(null);
    expect(categoryFor("hasOwnProperty")).toBe(null);
    expect(categoryFor("__proto__")).toBe(null);
  });
});

describe("shouldPrune", () => {
  it("prunes version control metadata", () => {
    expect(shouldPrune(".git")).toBe(true);
  });

  it("prunes macOS app bundles so package contents are not walked", () => {
    expect(shouldPrune("Xcode.app")).toBe(true);
  });

  it("walks ordinary source directories", () => {
    expect(shouldPrune("src")).toBe(false);
  });
});

describe("formatSize", () => {
  it("reports kilobytes below one megabyte", () => {
    expect(formatSize(512)).toBe("512K");
  });

  it("reports whole megabytes below one gigabyte", () => {
    expect(formatSize(2048)).toBe("2M");
  });

  it("reports one decimal of gigabytes at and above one gigabyte", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0G");
    expect(formatSize(54_657_843)).toBe("52.1G");
  });
});

describe("parseDuKb", () => {
  it("reads the leading size field from du -sk output", () => {
    expect(parseDuKb("54657843\t/Users/x/target\n")).toBe(54_657_843);
  });

  it("returns 0 when du produced no parseable size", () => {
    expect(parseDuKb("du: no such file\n")).toBe(0);
  });
});

describe("bySizeDesc and totalKb", () => {
  const items = [
    candidate("/a", "cargo", 100),
    candidate("/b", "xcode", 900),
    candidate("/c", "cargo", 500),
  ];

  it("orders largest first", () => {
    expect(bySizeDesc(items).map((item) => item.path)).toEqual(["/b", "/c", "/a"]);
  });

  it("leaves the input array untouched", () => {
    bySizeDesc(items);
    expect(items.map((item) => item.path)).toEqual(["/a", "/b", "/c"]);
  });

  it("sums sizes", () => {
    expect(totalKb(items)).toBe(1500);
  });
});

describe("summarizeByCategory", () => {
  it("groups counts and sizes per category, largest first", () => {
    const summary = summarizeByCategory([
      candidate("/a", "cargo", 100),
      candidate("/b", "xcode", 900),
      candidate("/c", "cargo", 500),
    ]);
    expect(summary).toEqual([
      { category: "xcode", count: 1, sizeKb: 900 },
      { category: "cargo", count: 2, sizeKb: 600 },
    ]);
  });

  it("returns an empty list for no candidates", () => {
    expect(summarizeByCategory([])).toEqual([]);
  });
});

describe("isUnderPrefix", () => {
  it("matches the prefix itself and paths beneath it", () => {
    expect(isUnderPrefix("/a/b", "/a/b")).toBe(true);
    expect(isUnderPrefix("/a/b/c", "/a/b")).toBe(true);
  });

  it("respects segment boundaries so a name prefix does not match", () => {
    expect(isUnderPrefix("/a/bc", "/a/b")).toBe(false);
  });
});

describe("isInstalledSoftware", () => {
  const home = "/Users/example";

  // These are the exact paths a scan proposed for deletion. Each has a sibling
  // package.json, so the node-modules proof alone accepted them.
  it("excludes globally installed bun packages", () => {
    expect(isInstalledSoftware(`${home}/.bun/install/global/node_modules`, home)).toBe(true);
  });

  it("excludes the runtime dependencies of an installed app", () => {
    expect(isInstalledSoftware(`${home}/.ami/code/code-0.0.0-macos-arm64/node_modules`, home)).toBe(
      true,
    );
    expect(
      isInstalledSoftware(
        `${home}/.ami/code/code-0.0.0-macos-arm64/lib/vscode/extensions/node_modules`,
        home,
      ),
    ).toBe(true);
  });

  it("excludes mise-managed installs, which the sibling check missed only by accident", () => {
    expect(
      isInstalledSoftware(`${home}/.local/share/mise/installs/node/22/lib/node_modules`, home),
    ).toBe(true);
  });

  it("excludes agent tooling that ships its own dependencies", () => {
    // Deleting these breaks the MCP server or agent runtime until it refetches.
    expect(
      isInstalledSoftware(
        `${home}/.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/1.6.0/node_modules`,
        home,
      ),
    ).toBe(true);
    expect(isInstalledSoftware(`${home}/.pi/agent/npm/node_modules`, home)).toBe(true);
    expect(
      isInstalledSoftware(
        `${home}/.plannotator/vendor/agent-terminal/webtui-0.1.0/node_modules`,
        home,
      ),
    ).toBe(true);
    expect(
      isInstalledSoftware(`${home}/.local/share/opencode/worktree/abc/proj/node_modules`, home),
    ).toBe(true);
    expect(
      isInstalledSoftware(
        `${home}/.cache/opencode/packages/ollama-ai-provider-v2/node_modules`,
        home,
      ),
    ).toBe(true);
  });

  it("still allows conductor workspaces, which are real project checkouts", () => {
    expect(
      isInstalledSoftware(`${home}/.conductor/workspaces/frat-house/vilnius/node_modules`, home),
    ).toBe(false);
  });

  it("excludes system and homebrew install roots", () => {
    expect(isInstalledSoftware("/usr/local/lib/node_modules", home)).toBe(true);
    expect(isInstalledSoftware("/opt/homebrew/lib/node_modules/npm", home)).toBe(true);
    expect(isInstalledSoftware("/Applications/Foo.app/node_modules", home)).toBe(true);
  });

  it("allows ordinary project directories", () => {
    expect(isInstalledSoftware(`${home}/Code/myproject/node_modules`, home)).toBe(false);
    expect(isInstalledSoftware(`${home}/Projects/exo/target`, home)).toBe(false);
  });

  it("allows a project whose name merely starts like an install prefix", () => {
    expect(isInstalledSoftware(`${home}/.deno-playground/node_modules`, home)).toBe(false);
  });
});

describe("isToolManagedCache", () => {
  const home = "/Users/example";

  it("excludes node_modules inside the bun package cache", () => {
    // Reported under `bun pm cache rm`, so deleting it piecemeal double-counts.
    expect(
      isToolManagedCache(`${home}/.bun/install/cache/npm@11.15.0@@@1/node_modules`, home),
    ).toBe(true);
  });

  it("excludes the other package manager caches", () => {
    expect(isToolManagedCache(`${home}/Library/pnpm/store/v3`, home)).toBe(true);
    expect(isToolManagedCache(`${home}/.cargo/registry/cache`, home)).toBe(true);
    expect(isToolManagedCache(`${home}/.npm/_cacache/index-v5`, home)).toBe(true);
  });

  it("allows ordinary project directories", () => {
    expect(isToolManagedCache(`${home}/Code/myproject/node_modules`, home)).toBe(false);
  });
});

describe("plural", () => {
  it("keeps the noun singular for exactly one", () => {
    expect(plural(1, "dir")).toBe("1 dir");
  });

  it("pluralizes for zero and for many", () => {
    expect(plural(0, "dir")).toBe("0 dirs");
    expect(plural(16, "dir")).toBe("16 dirs");
  });
});

describe("dropNested", () => {
  it("keeps the ancestor and drops the directory nested inside it", () => {
    const kept = dropNested([
      { path: "/repo/target" },
      { path: "/repo/target/debug/build/target" },
      { path: "/other/target" },
    ]);
    expect(kept.map((item) => item.path)).toEqual(["/repo/target", "/other/target"]);
  });

  it("keeps sibling paths that share a name prefix but are not nested", () => {
    const kept = dropNested([{ path: "/repo/build" }, { path: "/repo/build-tools" }]);
    expect(kept.map((item) => item.path).toSorted()).toEqual(["/repo/build", "/repo/build-tools"]);
  });
});
