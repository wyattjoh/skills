#!/usr/bin/env bun
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Console, Data, Effect } from "effect";
import { spawnGit } from "./git-env.ts";
import { type Reference, updateReferences } from "./table.ts";

class AddError extends Data.TaggedError("AddError")<{ message: string }> {}

const attempt = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new AddError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new AddError({ message }));
const git = (cwd: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const result = yield* attempt(() => spawnGit(args, cwd));
    yield* check(result.exitCode === 0, `git ${args[0]} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  });
const stat = (path: string) =>
  attempt(async () => {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });

const help = `Usage: bun add.ts <repo-url> (--tag <tag> | --default-branch) [options]

Add a shallow reference submodule and update the root CLAUDE.md table.
Run from the host repository, or select it with --repo. Resolve the desired
version yourself; this script does not infer dependencies or choose latest tags.

  --tag <tag>          Exact tag, including v or package prefixes
  --default-branch     Pin the remote default branch HEAD instead of a tag
  --name <directory>   Reference directory name (defaults to repository basename)
  --dependency <name>  Table label (defaults to directory name)
  --version <version>  Table version (defaults to normalized tag or branch@sha)
  --expected-commit <sha>  Require the commit previously confirmed in --dry-run
  --repo <directory>   Host repository (defaults to current directory)
  --dry-run           Validate and show the plan without writing
  --yes               Apply without prompting, after prior confirmation
  --help              Show this help

.gitmodules, the gitlink, and CLAUDE.md (or its in-repo symlink target) are staged.
Unrelated changes are left alone. No commits, pushes, or destructive cleanup.
If Git fails after starting the add, partial state is retained for inspection.
`;

const program = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () =>
      parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        strict: true,
        options: {
          tag: { type: "string" },
          "default-branch": { type: "boolean" },
          name: { type: "string" },
          dependency: { type: "string" },
          version: { type: "string" },
          "expected-commit": { type: "string" },
          repo: { type: "string" },
          "dry-run": { type: "boolean" },
          yes: { type: "boolean" },
          help: { type: "boolean" },
        },
      }),
    catch: (cause) => new AddError({ message: `${String(cause)}\nRun with --help for usage.` }),
  });
  const options = args.values;
  if (options.help) {
    yield* Console.log(help);
    return;
  }
  yield* check(
    args.positionals.length === 1,
    "Provide one repository URL. Run with --help for usage.",
  );
  yield* check(
    Boolean(options.tag) !== Boolean(options["default-branch"]),
    "Choose exactly one of --tag <tag> or --default-branch.",
  );
  const inputUrl = args.positionals[0]!;
  yield* check(
    Boolean(inputUrl) && !inputUrl.startsWith("-") && !/[\r\n]/.test(inputUrl),
    "Invalid repository URL.",
  );
  // Git interprets relative submodule URLs against the host's remote, not its cwd.
  const url = !inputUrl.includes(":") ? resolve(inputUrl) : inputUrl;
  const name =
    options.name ??
    inputUrl
      .replace(/\/$/, "")
      .split(/[/:]/)
      .at(-1)!
      .replace(/\.git$/, "");
  yield* check(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name),
    "Use --name with a single directory name containing letters, digits, dots, underscores, or hyphens.",
  );
  const path = `.claude/references/${name}`;
  const root = yield* git(resolve(options.repo ?? process.cwd()), ["rev-parse", "--show-toplevel"]);
  yield* git(root, ["rev-parse", "--verify", "HEAD"]).pipe(
    Effect.mapError(
      () =>
        new AddError({
          message: "The host repository needs at least one commit before adding a submodule.",
        }),
    ),
  );
  for (const parent of [".claude", ".claude/references"]) {
    const info = yield* stat(join(root, parent));
    yield* check(
      !info || info.isDirectory(),
      `${parent} must be a directory, not a symlink or file.`,
    );
  }
  const modules = yield* stat(join(root, ".gitmodules"));
  yield* check(!modules || modules.isFile(), ".gitmodules must be a regular file.");
  if (modules) {
    const entries = yield* attempt(() =>
      spawnGit(
        ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
        root,
      ),
    );
    yield* check(
      entries.exitCode === 0 || entries.exitCode === 1,
      `Cannot read .gitmodules: ${entries.stderr}`,
    );
    const registered = entries.stdout
      .split("\n")
      .some((line) => line.slice(line.indexOf(" ") + 1).trim() === path);
    yield* check(
      !registered,
      `${path} is already registered. Use the skill's upgrade flow instead.`,
    );
  }
  yield* check(
    !(yield* stat(join(root, path))),
    `${path} already exists. Inspect it before retrying an add.`,
  );
  yield* check(
    (yield* git(root, ["ls-files", "--stage", "--", path])) === "",
    `${path} already has index entries. Inspect them before adding.`,
  );
  const moduleDir = yield* git(root, ["rev-parse", "--git-path", `modules/${path}`]);
  yield* check(
    !(yield* stat(resolve(root, moduleDir))),
    `Stored module ${moduleDir} already exists. Inspect partial state before retrying.`,
  );
  const local = yield* attempt(() =>
    spawnGit(["config", "--local", "--get", `submodule.${path}.url`], root),
  );
  yield* check(
    local.exitCode === 1,
    `Local configuration for ${path} already exists or could not be read. Inspect it before retrying.`,
  );

  const doc = join(root, "CLAUDE.md");
  const docInfo = yield* stat(doc);
  const docTarget = docInfo ? yield* attempt(() => realpath(doc)) : doc;
  const docPath = relative(root, docTarget);
  yield* check(
    docPath !== ".." &&
      !docPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(docPath),
    "CLAUDE.md points outside the repository; update its table manually instead.",
  );
  for (const stagedPath of [".gitmodules", path, docPath]) {
    const ignored = yield* attempt(() => spawnGit(["check-ignore", "-q", "--", stagedPath], root));
    yield* check(
      ignored.exitCode === 1,
      `${stagedPath} is ignored or could not be checked. Adjust ignore rules before adding.`,
    );
  }
  const original = docInfo ? yield* attempt(() => readFile(docTarget, "utf8")) : "";
  const changed = yield* git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".gitmodules",
    "CLAUDE.md",
    docPath,
  ]);
  yield* check(
    changed === "",
    "Commit or stash existing changes to .gitmodules and CLAUDE.md (including its symlink target) before adding.",
  );

  let ref: string;
  let commit: string;
  if (options.tag) {
    yield* git(root, ["check-ref-format", `refs/tags/${options.tag}`]);
    const tags = yield* git(root, [
      "ls-remote",
      "--tags",
      "--",
      url,
      `refs/tags/${options.tag}`,
      `refs/tags/${options.tag}^{}`,
    ]);
    const entries = new Map(
      tags.split("\n").map((line) => {
        const [sha, tag] = line.split(/\s+/);
        return [tag, sha] as const;
      }),
    );
    ref = options.tag;
    commit = entries.get(`refs/tags/${ref}^{}`) ?? entries.get(`refs/tags/${ref}`) ?? "";
    yield* check(Boolean(commit), `Tag ${ref} does not exist in ${url}. Nothing was added.`);
  } else {
    const head = yield* git(root, ["ls-remote", "--symref", "--", url, "HEAD"]);
    ref = head.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1] ?? "";
    commit = head.match(/^([a-f0-9]+)\s+HEAD$/m)?.[1] ?? "";
    yield* check(
      Boolean(ref) && Boolean(commit),
      "Remote has no resolvable default branch HEAD. Choose an explicit tag instead.",
    );
  }
  yield* check(
    !options["expected-commit"] || options["expected-commit"] === commit,
    `Resolved pin ${commit} differs from --expected-commit. Review a new --dry-run before adding.`,
  );
  const tagVersion = ref.slice(ref.lastIndexOf("@") + 1).replace(/^v(?=\d)/, "");
  const reference: Reference = {
    dependency: options.dependency ?? name,
    version: options.version ?? (options.tag ? tagVersion : `${ref}@${commit.slice(0, 7)}`),
    path,
    url,
    commit,
  };
  // Parse and render before any mutation, so unsupported Markdown cannot leave a partial add.
  const updated = yield* Effect.try({
    try: () => updateReferences(original, reference),
    catch: (cause) => new AddError({ message: String(cause) }),
  });
  yield* Console.log(
    `Host: ${root}\nDependency: ${reference.dependency}\nPath: ${path}\nRepository: ${url}\nRef: ${ref}\nPin: ${commit}\nVersion: ${reference.version}\nUpdate and stage: .gitmodules, ${path}, ${docPath}`,
  );
  if (options["dry-run"]) {
    yield* Console.log("Dry run: nothing changed.");
    return;
  }
  if (!options.yes) {
    yield* check(
      Boolean(process.stdin.isTTY),
      "Confirmation requires a terminal. Review --dry-run, then use --yes to apply.",
    );
    const answer = yield* attempt(async () => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        // Bound unattended prompts as well as Git commands.
        return await readline.question("Add this reference? [y/N] ", {
          signal: AbortSignal.timeout(60_000),
        });
      } finally {
        readline.close();
      }
    });
    if (!/^(y|yes)$/i.test(answer.trim())) {
      yield* Console.log("Cancelled: nothing changed.");
      return;
    }
  }
  // Recheck inputs after confirmation before staging whole files.
  yield* check(
    (yield* git(root, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".gitmodules",
      "CLAUDE.md",
      docPath,
    ])) === "",
    "Host metadata changed during confirmation. Re-run the command.",
  );
  const addition = Effect.gen(function* () {
    yield* git(root, ["submodule", "add", "--depth", "1", "--", url, path]);
    const checkout = join(root, path);
    // Fetch exact refs, then check peeled commits. Co-located monorepo tags make describe unreliable.
    yield* git(checkout, [
      "fetch",
      "--depth",
      "1",
      "origin",
      options.tag ? `refs/tags/${ref}` : `refs/heads/${ref}`,
    ]);
    yield* check(
      (yield* git(checkout, ["rev-parse", "FETCH_HEAD^{commit}"])) === commit,
      "Remote ref moved after confirmation. Inspect the partial add and resolve the new pin before retrying.",
    );
    yield* git(checkout, ["checkout", "--detach", commit]);
    yield* check(
      (yield* git(checkout, ["rev-parse", "HEAD"])) === commit,
      "Submodule HEAD does not match the confirmed pin.",
    );
    yield* git(root, ["add", "--", ".gitmodules", path]);
    const entries = yield* git(root, ["ls-files", "--stage", "--", path]);
    yield* check(
      entries === `160000 ${commit} 0\t${path}`,
      "Expected exactly one pinned 160000 gitlink. Inspect the index before continuing.",
    );
    const current = (yield* stat(doc)) ? yield* attempt(() => readFile(docTarget, "utf8")) : "";
    yield* check(
      current === original,
      "CLAUDE.md changed while Git was running. Inspect the partial add before updating documentation.",
    );
    yield* attempt(() => writeFile(docTarget, updated));
    yield* git(root, ["add", "--", docPath]);
    yield* Console.log(
      `Added ${path} at ${commit}. Changes are staged; review and commit when ready.`,
    );
  });
  yield* addition.pipe(
    Effect.mapError(
      (error) =>
        new AddError({
          message: `${error.message}\nThe add may have left partial state. Inspect git status and ${path}; no destructive cleanup was attempted.`,
        }),
    ),
  );
});

if (import.meta.main) {
  await Effect.runPromise(
    program.pipe(
      Effect.catchTag("AddError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(error.message);
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
