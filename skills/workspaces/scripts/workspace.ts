#!/usr/bin/env bun
import { Command } from "commander";
import { Data, Effect, Match } from "effect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AuditFinding, auditWorkspace } from "./lib/audit.ts";
import {
  currentBranch,
  type GitCommandError,
  headSha,
  isDirty,
  isGitRepo,
  listStacks,
  type StackInfo,
} from "./lib/git.ts";
import { type LockEntry, renderClaudeMd, renderLock } from "./lib/generate.ts";
import { appendEntry, parseCategory, UnknownCategoryError } from "./lib/journal.ts";
import {
  findWorkspaceRoot,
  loadManifest,
  LOCK_FILENAME,
  type ManifestParseError,
  type ManifestValidationError,
  resolveMemberPath,
  type WorkspaceManifest,
  type WorkspaceRootNotFoundError,
} from "./lib/manifest.ts";

/**
 * Raised by `manifest sync --check` when a generated file would change,
 * and by `context` when a manifest layer path is missing on disk.
 */
class DriftError extends Data.TaggedError("DriftError")<{
  message: string;
}> {}

type CliError =
  | WorkspaceRootNotFoundError
  | ManifestParseError
  | ManifestValidationError
  | GitCommandError
  | UnknownCategoryError
  | DriftError;

const formatError = (error: CliError): string =>
  Match.value(error).pipe(
    Match.tag(
      "WorkspaceRootNotFoundError",
      (e) => `no workspace.yaml found walking up from ${e.startDir}`,
    ),
    Match.tag("ManifestParseError", (e) => `failed to parse ${e.path}: ${e.message}`),
    Match.tag(
      "ManifestValidationError",
      (e) => `${e.path} is invalid:\n${e.issues.map((issue) => `  - ${issue}`).join("\n")}`,
    ),
    Match.tag(
      "GitCommandError",
      (e) => `git ${e.args.join(" ")} failed in ${e.repo} (exit ${e.exitCode}): ${e.stderr}`,
    ),
    Match.tag(
      "UnknownCategoryError",
      (e) =>
        `unknown journal category "${e.category}" (expected decision|deviation|scope|cross-repo)`,
    ),
    Match.tag("DriftError", (e) => e.message),
    Match.exhaustive,
  );

const run = (program: Effect.Effect<void, CliError>): Promise<void> =>
  Effect.runPromise(
    program.pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(`workspaces: ${formatError(error)}`);
          process.exitCode = 1;
        }),
      ),
    ),
  );

const loadWorkspace = (
  workspaceDir: string | undefined,
): Effect.Effect<
  { root: string; manifest: WorkspaceManifest },
  WorkspaceRootNotFoundError | ManifestParseError | ManifestValidationError
> =>
  Effect.gen(function* () {
    const root = yield* findWorkspaceRoot(workspaceDir ?? process.cwd());
    const manifest = yield* loadManifest(root);
    return { root, manifest };
  });

type MemberStatus = {
  member: string;
  path: string;
  present: boolean;
  branch: string | undefined;
  dirty: boolean | undefined;
  stacks: StackInfo[];
};

const collectStatus = (
  root: string,
  manifest: WorkspaceManifest,
): Effect.Effect<MemberStatus[], GitCommandError> =>
  Effect.forEach(manifest.members, (member) =>
    Effect.gen(function* () {
      const path = resolveMemberPath(root, member);
      if (!existsSync(path) || !isGitRepo(path)) {
        return {
          member: member.name,
          path,
          present: false,
          branch: undefined,
          dirty: undefined,
          stacks: [],
        };
      }
      const branch = yield* currentBranch(path);
      const dirty = yield* isDirty(path);
      const stacks = yield* listStacks(path);
      const bound = stacks.filter((stack) => stack.name.startsWith(manifest.stackPrefix));
      return { member: member.name, path, present: true, branch, dirty, stacks: bound };
    }),
  );

const printStatus = (statuses: MemberStatus[]): void => {
  for (const status of statuses) {
    if (!status.present) {
      console.log(`✗ ${status.member}: missing at ${status.path}`);
      continue;
    }
    const dirtyLabel = status.dirty ? "dirty" : "clean";
    const stackLabel =
      status.stacks.length > 0
        ? status.stacks.map((stack) => stack.name).join(", ")
        : "(no bound stacks)";
    console.log(`✓ ${status.member}: ${status.branch} [${dirtyLabel}] stacks: ${stackLabel}`);
  }
};

const printFindings = (findings: AuditFinding[]): void => {
  if (findings.length === 0) {
    console.log("✓ workspace audit passed with no findings");
    return;
  }
  for (const finding of findings) {
    const symbol = finding.level === "error" ? "✗" : "⚠";
    console.log(`${symbol} [${finding.id}] ${finding.message}`);
  }
};

const cli = new Command()
  .name("workspace")
  .description("Operate a multi-repo workspace hub (see the workspaces skill)");

const withWorkspaceOption = (command: Command): Command =>
  command.option("--workspace <dir>", "workspace directory (defaults to walking up from cwd)");

const manifestCommand = cli.command("manifest").description("manifest-derived file management");

withWorkspaceOption(
  manifestCommand
    .command("sync")
    .description("regenerate CLAUDE.md from workspace.yaml")
    .option("--check", "exit 1 if generated files are stale instead of writing"),
).action((options: { workspace?: string; check?: boolean }) =>
  run(
    Effect.gen(function* () {
      const { root, manifest } = yield* loadWorkspace(options.workspace);
      const target = join(root, "CLAUDE.md");
      const rendered = renderClaudeMd(manifest);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (options.check) {
        if (existing !== rendered) {
          return yield* Effect.fail(
            new DriftError({ message: "CLAUDE.md is stale; run `just sync` to regenerate it" }),
          );
        }
        console.log("✓ generated files match workspace.yaml");
        return;
      }
      if (existing === rendered) {
        console.log("✓ CLAUDE.md already up to date");
        return;
      }
      writeFileSync(target, rendered);
      console.log(`✓ wrote ${target}`);
    }),
  ),
);

withWorkspaceOption(
  manifestCommand.command("freeze").description("capture member HEAD SHAs into workspace.lock"),
).action((options: { workspace?: string }) =>
  run(
    Effect.gen(function* () {
      const { root, manifest } = yield* loadWorkspace(options.workspace);
      const entries: LockEntry[] = [];
      for (const member of manifest.members) {
        const path = resolveMemberPath(root, member);
        if (!existsSync(path) || !isGitRepo(path)) {
          return yield* Effect.fail(
            new DriftError({
              message: `cannot freeze: member "${member.name}" missing at ${path}`,
            }),
          );
        }
        entries.push({ name: member.name, ref: member.ref, sha: yield* headSha(path) });
      }
      const target = join(root, LOCK_FILENAME);
      writeFileSync(target, renderLock(entries));
      console.log(`✓ froze ${entries.length} member(s) into ${target}`);
    }),
  ),
);

withWorkspaceOption(
  cli
    .command("status")
    .description("cross-repo status: branch, dirtiness, bound stacks per member")
    .option("--json", "emit JSON"),
).action((options: { workspace?: string; json?: boolean }) =>
  run(
    Effect.gen(function* () {
      const { root, manifest } = yield* loadWorkspace(options.workspace);
      const statuses = yield* collectStatus(root, manifest);
      if (options.json) {
        console.log(JSON.stringify(statuses, null, 2));
        return;
      }
      printStatus(statuses);
    }),
  ),
);

withWorkspaceOption(
  cli
    .command("stacks")
    .description("list stacks across members bound to this workspace's stack prefix")
    .option("--json", "emit JSON"),
).action((options: { workspace?: string; json?: boolean }) =>
  run(
    Effect.gen(function* () {
      const { root, manifest } = yield* loadWorkspace(options.workspace);
      const rows: Array<{ member: string; stack: StackInfo }> = [];
      for (const member of manifest.members) {
        const path = resolveMemberPath(root, member);
        if (!existsSync(path) || !isGitRepo(path)) continue;
        const stacks = yield* listStacks(path);
        for (const stack of stacks) {
          if (stack.name.startsWith(manifest.stackPrefix)) {
            rows.push({ member: member.name, stack });
          }
        }
      }
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(`no stacks bound to prefix "${manifest.stackPrefix}"`);
        return;
      }
      for (const row of rows) {
        const branches =
          row.stack.branches.length > 0 ? row.stack.branches.join(" → ") : "(no branches)";
        console.log(
          `${row.member} :: ${row.stack.name} [${row.stack.mergeStrategy ?? "squash"}] ${branches}`,
        );
      }
    }),
  ),
);

withWorkspaceOption(
  cli
    .command("context")
    .description("print the ordered context layer files for the enter flow")
    .option("--json", "emit JSON"),
).action((options: { workspace?: string; json?: boolean }) =>
  run(
    Effect.gen(function* () {
      const { root, manifest } = yield* loadWorkspace(options.workspace);
      const layers = manifest.layers.map((layer) => ({
        ...layer,
        absolutePath: join(root, layer.path),
        exists: existsSync(join(root, layer.path)),
      }));
      if (options.json) {
        console.log(JSON.stringify(layers, null, 2));
      } else {
        for (const [index, layer] of layers.entries()) {
          const symbol = layer.exists ? "✓" : "✗";
          console.log(
            `${symbol} ${index + 1}. ${layer.name}: ${layer.absolutePath} — ${layer.description}`,
          );
        }
      }
      const missing = layers.filter((layer) => !layer.exists);
      if (missing.length > 0) {
        return yield* Effect.fail(
          new DriftError({
            message: `${missing.length} context layer path(s) missing: ${missing.map((layer) => layer.path).join(", ")}`,
          }),
        );
      }
    }),
  ),
);

withWorkspaceOption(
  cli
    .command("audit")
    .description("run all workspace integrity checks; exits 1 on errors")
    .option("--json", "emit JSON"),
).action((options: { workspace?: string; json?: boolean }) =>
  run(
    Effect.gen(function* () {
      const { root } = yield* loadWorkspace(options.workspace);
      const findings = yield* auditWorkspace(root);
      if (options.json) {
        console.log(JSON.stringify(findings, null, 2));
      } else {
        printFindings(findings);
      }
      if (findings.some((finding) => finding.level === "error")) {
        process.exitCode = 1;
      }
    }),
  ),
);

const journalCommand = cli.command("journal").description("deviation journal management");

withWorkspaceOption(
  journalCommand
    .command("add")
    .description("append a structured entry to JOURNAL.md")
    .requiredOption("--category <category>", "decision | deviation | scope | cross-repo")
    .requiredOption("--title <title>", "one-line entry title")
    .option("--links <links>", "comma-separated cross-links (adr/NNNN, phase N, org/repo#PR)")
    .option("--body <body>", "entry body text"),
).action(
  (options: {
    workspace?: string;
    category: string;
    title: string;
    links?: string;
    body?: string;
  }) =>
    run(
      Effect.gen(function* () {
        const { root } = yield* loadWorkspace(options.workspace);
        const category = parseCategory(options.category);
        if (category === undefined) {
          return yield* new UnknownCategoryError({ category: options.category });
        }
        const journalPath = join(root, "JOURNAL.md");
        if (!existsSync(journalPath)) {
          return yield* Effect.fail(
            new DriftError({
              message: "JOURNAL.md is missing; seed it from the skill template first",
            }),
          );
        }
        const links = (options.links ?? "")
          .split(",")
          .map((link) => link.trim())
          .filter((link) => link !== "");
        const date = new Date().toISOString().slice(0, 10);
        const updated = appendEntry(
          readFileSync(journalPath, "utf8"),
          { category, title: options.title, links, body: options.body },
          date,
        );
        writeFileSync(journalPath, updated);
        console.log(`✓ journaled ${category}: ${options.title}`);
      }),
    ),
);

await cli.parseAsync(process.argv);
