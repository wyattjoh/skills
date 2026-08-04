#!/usr/bin/env bun
/**
 * Reclaim disk space from regenerable build artifacts and tool caches.
 *
 * Safety model: discovery by directory name only produces candidates. Every
 * candidate is independently verified before it is eligible for deletion, and
 * re-verified immediately before the delete itself. A directory that cannot be
 * proven regenerable is reported and skipped, never removed.
 *
 *   cargo         must contain CACHEDIR.TAG, which cargo writes into target/
 *   xcode         must be ignored by its own repo, per git check-ignore
 *   node-modules  must sit beside a package.json
 *   swift         must sit beside a Package.swift
 *   cache         must be a known fixed cache path
 *
 * Usage:
 *   bun scan.ts                        scan the home directory, report only
 *   bun scan.ts --root ~/Code          scan specific roots (repeatable)
 *   bun scan.ts --min-size 100         hide candidates under 100 MB
 *   bun scan.ts --caches               add global caches to a root-scoped scan
 *   bun scan.ts --json                 machine-readable output
 *   bun scan.ts --apply                delete verified candidates
 */

import { readdir, rm, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Console, Data, Effect } from "effect";
import {
  bySizeDesc,
  type BuildCategory,
  type Candidate,
  categoryFor,
  type Discovered,
  dropNested,
  formatSize,
  isInstalledSoftware,
  isToolManagedCache,
  parseDuKb,
  plural,
  shouldPrune,
  summarizeByCategory,
  type ToolCache,
  totalKb,
  type Verdict,
} from "./classify.ts";

class UnsupportedPlatformError extends Data.TaggedError("UnsupportedPlatformError")<{
  readonly platform: string;
}> {}

class BuildsRunningError extends Data.TaggedError("BuildsRunningError")<{
  readonly processes: readonly string[];
}> {}

class DeleteFailedError extends Data.TaggedError("DeleteFailedError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

interface Options {
  readonly roots: readonly string[];
  readonly apply: boolean;
  readonly json: boolean;
  readonly minSizeKb: number;
  readonly maxDepth: number;
  /**
   * Global caches live outside any scanned root, so including them in a narrowly
   * scoped scan would delete far more than the user asked for. They are reported
   * only for a home-wide scan, or when --caches is passed explicitly.
   */
  readonly includeCaches: boolean;
}

const HOME = homedir();

/** Deleting a target directory mid-build corrupts the build and confuses the tool. */
const BUILD_PROCESS_PATTERN = "cargo|rustc|xcodebuild|swift-frontend|webpack|vite";

/** Fixed cache directories that are safe to remove outright, per platform. */
function knownCachePaths(): readonly string[] {
  const darwin = [
    join(HOME, "Library/Developer/Xcode/DerivedData"),
    join(HOME, "Library/Developer/Xcode/iOS DeviceSupport"),
    join(HOME, "Library/Developer/Xcode/watchOS DeviceSupport"),
    join(HOME, "Library/Developer/Xcode/tvOS DeviceSupport"),
    join(HOME, "Library/Developer/Xcode/visionOS DeviceSupport"),
    join(HOME, "Library/Caches/ms-playwright"),
    join(HOME, "Library/Caches/go-build"),
  ];
  const linux = [join(HOME, ".cache/go-build"), join(HOME, ".cache/ms-playwright")];
  return platform() === "darwin" ? darwin : linux;
}

/**
 * Caches owned by a package manager. Reclaimed with the vendor's own command
 * rather than by deleting the directory, which would desync the tool's index.
 */
function toolCacheSpecs(): readonly { tool: string; path: string; command: string }[] {
  const shared = [
    { tool: "pnpm", path: join(HOME, "Library/pnpm/store"), command: "pnpm store prune" },
    {
      tool: "cargo",
      path: join(HOME, ".cargo/registry/cache"),
      command: "cargo cache --autoclean",
    },
    { tool: "bun", path: join(HOME, ".bun/install/cache"), command: "bun pm cache rm" },
    { tool: "npm", path: join(HOME, ".npm/_cacache"), command: "npm cache clean --force" },
  ];
  if (platform() !== "darwin") return shared;
  return [
    { tool: "homebrew", path: join(HOME, "Library/Caches/Homebrew"), command: "brew cleanup -s" },
    ...shared,
  ];
}

const parseOptions = (argv: readonly string[]): Options => {
  const roots: string[] = [];
  let minSizeKb = 10 * 1024;
  let maxDepth = 8;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) roots.push(expandHome(argv[++i] ?? ""));
    else if (arg === "--min-size" && argv[i + 1]) minSizeKb = Number(argv[++i]) * 1024;
    else if (arg === "--max-depth" && argv[i + 1]) maxDepth = Number(argv[++i]);
  }
  const scopedToRoots = roots.length > 0;
  return {
    roots: scopedToRoots ? roots : [HOME],
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
    minSizeKb,
    maxDepth,
    includeCaches: argv.includes("--caches") || !scopedToRoots,
  };
};

const expandHome = (path: string): string =>
  path.startsWith("~") ? join(HOME, path.slice(1)) : path;

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  );

const isDirectory = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map((stats) => stats.isDirectory()),
    Effect.orElseSucceed(() => false),
  );

/** Size in kilobytes via du, which is far faster than walking a large tree. */
const sizeKb = (path: string): Effect.Effect<number> =>
  Effect.tryPromise(() => $`du -sk ${path}`.nothrow().text()).pipe(
    Effect.map(parseDuKb),
    Effect.orElseSucceed(() => 0),
  );

/**
 * Walk a root, collecting candidate directories. A matched directory is never
 * descended into, so nested artifacts inside an artifact are not reported twice.
 */
const walk = (root: string, maxDepth: number): Effect.Effect<readonly Discovered[]> =>
  Effect.gen(function* () {
    const found: Discovered[] = [];
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > maxDepth) continue;

      const entries = yield* Effect.tryPromise(() =>
        readdir(current.path, { withFileTypes: true }),
      ).pipe(Effect.orElseSucceed(() => []));

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const childPath = join(current.path, entry.name);
        const category = categoryFor(entry.name);
        if (category !== null) {
          found.push({ path: childPath, category });
          continue; // matched, so do not descend
        }
        if (shouldPrune(entry.name)) continue;
        queue.push({ path: childPath, depth: current.depth + 1 });
      }
    }
    return found;
  });

/** A real cargo target directory always contains the CACHEDIR.TAG cargo writes. */
const verifyCargo = (path: string): Effect.Effect<boolean> => exists(join(path, "CACHEDIR.TAG"));

/** Gitignored means the repo treats it as regenerable, which is the property we need. */
const verifyGitIgnored = (path: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const parent = path.slice(0, path.lastIndexOf("/"));
    const root = yield* Effect.tryPromise(() =>
      $`git rev-parse --show-toplevel`.cwd(parent).nothrow().text(),
    ).pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (root === "") return false;
    const exitCode = yield* Effect.tryPromise(() =>
      $`git check-ignore -q ${path}`.cwd(root).nothrow(),
    ).pipe(
      Effect.map((result) => result.exitCode),
      Effect.orElseSucceed(() => 1),
    );
    return exitCode === 0;
  });

/** A sibling manifest proves the directory is installed output, not source. */
const verifySibling = (path: string, manifest: string): Effect.Effect<boolean> =>
  exists(join(path.slice(0, path.lastIndexOf("/")), manifest));

/** The per-category proof, before the installed-software exclusion is applied. */
const proveRegenerable = (item: Discovered): Effect.Effect<boolean> => {
  switch (item.category) {
    case "cargo":
      return verifyCargo(item.path);
    case "xcode":
      return verifyGitIgnored(item.path);
    case "node-modules":
      return verifySibling(item.path, "package.json");
    case "swift":
      return verifySibling(item.path, "Package.swift");
    case "cache":
      return Effect.succeed(true);
  }
};

const FAILURE_REASON: Readonly<Record<BuildCategory, string>> = {
  cargo: "no CACHEDIR.TAG, not a cargo target",
  xcode: "not gitignored, may be tracked output",
  "node-modules": "no sibling package.json",
  swift: "no sibling Package.swift",
  cache: "path missing",
};

/**
 * Prove a candidate is safe to delete.
 *
 * The installed-software exclusion runs first and overrides the per-category
 * proof. A globally installed CLI has a node_modules beside a package.json, so
 * that proof alone would happily green-light uninstalling every global package.
 */
const verify = (item: Discovered): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    if (isInstalledSoftware(item.path, HOME)) {
      return { ok: false, reason: "installed software, needs a reinstall not a rebuild" };
    }
    if (isToolManagedCache(item.path, HOME)) {
      return { ok: false, reason: "inside a tool-managed cache, use the vendor command" };
    }
    const proved = yield* proveRegenerable(item);
    return proved ? { ok: true } : { ok: false, reason: FAILURE_REASON[item.category] };
  });

const inspect = (item: Discovered): Effect.Effect<Candidate> =>
  Effect.gen(function* () {
    const verdict = yield* verify(item);
    const size = yield* sizeKb(item.path);
    return verdict.ok
      ? { ...item, sizeKb: size, verified: true }
      : { ...item, sizeKb: size, verified: false, reason: verdict.reason };
  });

const detectRunningBuilds: Effect.Effect<readonly string[]> = Effect.tryPromise(() =>
  $`pgrep -l -f ${BUILD_PROCESS_PATTERN}`.nothrow().text(),
).pipe(
  Effect.map((out) => (out.trim() === "" ? [] : out.trim().split("\n"))),
  Effect.orElseSucceed(() => []),
);

const freeSpace: Effect.Effect<string> = Effect.tryPromise(() =>
  $`df -h ${HOME}`.nothrow().text(),
).pipe(
  Effect.map((out) => out.trim().split("\n")[1]?.split(/\s+/)[3] ?? "unknown"),
  Effect.orElseSucceed(() => "unknown"),
);

const collectCaches: Effect.Effect<readonly Candidate[]> = Effect.forEach(
  knownCachePaths(),
  (path): Effect.Effect<Candidate | null> =>
    Effect.gen(function* () {
      if (!(yield* isDirectory(path))) return null;
      return { path, category: "cache", sizeKb: yield* sizeKb(path), verified: true };
    }),
  { concurrency: 4 },
).pipe(Effect.map((results) => results.filter((item): item is Candidate => item !== null)));

const collectToolCaches: Effect.Effect<readonly ToolCache[]> = Effect.forEach(
  toolCacheSpecs(),
  (spec) =>
    Effect.gen(function* () {
      if (!(yield* isDirectory(spec.path))) return null;
      return { ...spec, sizeKb: yield* sizeKb(spec.path) };
    }),
  { concurrency: 4 },
).pipe(Effect.map((results) => results.filter((item): item is ToolCache => item !== null)));

const removeDirectory = (item: Candidate): Effect.Effect<Candidate, DeleteFailedError> =>
  Effect.gen(function* () {
    // Re-verify at the last moment, so a stale scan can never widen the blast radius.
    const verdict = yield* verify(item);
    if (!verdict.ok) {
      return yield* new DeleteFailedError({
        path: item.path,
        cause: `failed re-verification at delete time: ${verdict.reason}`,
      });
    }
    yield* Effect.tryPromise({
      try: () => rm(item.path, { recursive: true, force: true }),
      catch: (cause) => new DeleteFailedError({ path: item.path, cause }),
    });
    return item;
  });

/**
 * Print every path that would be deleted, one per line.
 *
 * The full list is the point: the user is authorizing specific directories, not a
 * total. Anything the size filter removed is disclosed by count and size, so the
 * printed list is never a silent subset of what runs.
 */
const reportText = (
  deletable: readonly Candidate[],
  skipped: readonly Candidate[],
  toolCaches: readonly ToolCache[],
  hidden: { readonly count: number; readonly sizeKb: number; readonly minSizeKb: number },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.log(
      `Will delete ${plural(deletable.length, "dir")}, ${formatSize(totalKb(deletable))} total:`,
    );
    for (const item of deletable) {
      yield* Console.log(
        `  ${formatSize(item.sizeKb).padStart(7)}  ${item.category.padEnd(13)} ${item.path}`,
      );
    }

    if (hidden.count > 0) {
      yield* Console.log(
        `\nNot listed and not deleted: ${plural(hidden.count, "dir")} below the ` +
          `${formatSize(hidden.minSizeKb)} threshold, ${formatSize(hidden.sizeKb)} total. ` +
          `Lower --min-size to include them.`,
      );
    }

    if (skipped.length > 0) {
      yield* Console.log("\nSkipped, could not prove regenerable:");
      for (const item of skipped) {
        yield* Console.log(
          `  ${formatSize(item.sizeKb).padStart(7)}  ${item.path}  (${item.reason})`,
        );
      }
    }

    // Summary comes after the full list, so it reads as a recap rather than a
    // substitute for the paths above.
    yield* Console.log("\nBy category:");
    for (const row of summarizeByCategory(deletable)) {
      yield* Console.log(
        `  ${formatSize(row.sizeKb).padStart(7)}  ${row.category.padEnd(13)} ${plural(row.count, "dir")}`,
      );
    }
    yield* Console.log(
      `\n${plural(deletable.length, "dir")}, ${formatSize(totalKb(deletable))} reclaimable`,
    );

    if (toolCaches.length > 0) {
      yield* Console.log("\nTool-managed caches, reclaim with the vendor command:");
      for (const cache of toolCaches) {
        yield* Console.log(`  ${formatSize(cache.sizeKb).padStart(7)}  ${cache.command}`);
      }
    }
  });

const program = Effect.gen(function* () {
  const options = parseOptions(process.argv.slice(2));

  if (platform() === "win32") {
    return yield* new UnsupportedPlatformError({ platform: platform() });
  }

  // Scanning is read-only and always safe. Only deletion has to wait for builds
  // to finish, since removing a target directory mid-build corrupts it.
  if (options.apply) {
    const running = yield* detectRunningBuilds;
    if (running.length > 0) {
      return yield* new BuildsRunningError({ processes: running });
    }
  }

  const discovered = yield* Effect.forEach(options.roots, (root) => walk(root, options.maxDepth), {
    concurrency: 2,
  }).pipe(Effect.map((batches) => dropNested(batches.flat())));

  const inspected = yield* Effect.forEach(discovered, inspect, { concurrency: 8 });
  const caches = options.includeCaches ? yield* collectCaches : [];
  const toolCaches = options.includeCaches ? yield* collectToolCaches : [];

  const all = [...inspected, ...caches];
  const verified = all.filter((c) => c.verified);
  const deletable = bySizeDesc(verified.filter((c) => c.sizeKb >= options.minSizeKb));
  const skipped = bySizeDesc(all.filter((c) => !c.verified && c.sizeKb >= options.minSizeKb));

  // Disclosed in the report so the printed list is never a silent subset.
  const hidden = {
    count: verified.length - deletable.length,
    sizeKb: totalKb(verified) - totalKb(deletable),
    minSizeKb: options.minSizeKb,
  };

  if (options.json) {
    yield* Console.log(JSON.stringify({ deletable, skipped, toolCaches, hidden }, null, 2));
    if (!options.apply) return;
  } else {
    yield* Console.log(`Free before: ${yield* freeSpace}`);
    yield* Console.log(options.apply ? "Mode: APPLY\n" : "Mode: report only\n");
    yield* reportText(deletable, skipped, toolCaches, hidden);
  }

  if (!options.apply) {
    yield* Console.log("\nNothing deleted. Re-run with --apply to remove the listed directories.");
    return;
  }

  yield* Console.log("");
  const [failures, removed] = yield* Effect.partition(deletable, removeDirectory, {
    concurrency: 4,
  });
  for (const item of removed) {
    yield* Console.log(`removed  ${formatSize(item.sizeKb).padStart(7)}  ${item.path}`);
  }
  for (const failure of failures) {
    yield* Console.error(`FAILED   ${failure.path}: ${String(failure.cause)}`);
  }
  yield* Console.log(
    `\nRemoved ${removed.length} of ${plural(deletable.length, "dir")}. Free after: ${yield* freeSpace}`,
  );
});

const handled = program.pipe(
  Effect.catchTags({
    UnsupportedPlatformError: (error) =>
      Console.error(`clean-storage supports macOS and Linux, not ${error.platform}.`).pipe(
        Effect.flatMap(() => Effect.sync(() => process.exit(1))),
      ),
    BuildsRunningError: (error) =>
      Effect.gen(function* () {
        yield* Console.error("Refusing to run, these look like active builds:");
        for (const proc of error.processes) yield* Console.error(`  ${proc}`);
        yield* Console.error("Stop them and re-run.");
        yield* Effect.sync(() => process.exit(1));
      }),
  }),
);

await Effect.runPromise(handled);
