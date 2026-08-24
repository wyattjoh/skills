---
name: setup-pre-commit-hooks
description: "Sets up repository-owned pre-commit checks with Lefthook as the language-neutral orchestrator. Detects each runtime from its manifests, merges into any existing hook runner, and installs and verifies the hook. Per-language commands, flags, and gotchas live in references/rust.md and references/typescript.md. Takes an optional repository path."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(git:*)
  - Bash(bun:*)
  - Bash(bunx:*)
  - Bash(npx:*)
  - Bash(cargo:*)
  - Bash(rustup:*)
  - Bash(mise:*)
  - Bash(lefthook:*)
argument-hint: "[repository-path]"
disable-model-invocation: true
effort: high
memory: user
---

# Pre-commit Hooks

Set up repository-owned pre-commit checks that adapt to the languages and tools
already present. Prefer Lefthook as the language-neutral orchestrator. Keep the
configuration declarative, fast, and safe for partially staged changes.

This file covers orchestration only. The concrete commands, flags, and failure
modes for each runtime live in the language reference files, and they do not mix.

## Workflow

1. Resolve `$ARGUMENTS` as the repository path, defaulting to the current directory.
2. Read the repository instructions and inspect existing hook configuration before
   changing anything.
3. Detect runtimes and workspaces from manifests, not file extensions alone.
4. Read the reference file for each detected runtime, and only those.
5. Propose the detected checks and exact files to change. Get confirmation before
   installing dependencies or replacing an existing hook system.
6. Merge the checks into the existing hook setup, or install Lefthook when no runner
   exists.
7. Install the hook, run every configured command manually, then run
   `lefthook run pre-commit`.
8. Report prerequisites, changed files, verification results, and how to bypass or
   uninstall the hook.

## Detect the Repository

Inspect the root and any workspace members:

| Signal                                        | Runtime        | Reference                                              |
| --------------------------------------------- | -------------- | ------------------------------------------------------ |
| `Cargo.toml`                                  | Rust           | [`references/rust.md`](references/rust.md)             |
| `package.json` plus `bun.lock` or `bun.lockb` | TypeScript/Bun | [`references/typescript.md`](references/typescript.md) |

A polyglot repository composes the blocks from several references into one config.
It does not get a merged or shared command definition: each runtime keeps its own
glob, its own command, and its own flags.

Also inspect `lefthook.yml`, `.lefthook.yml`, `.pre-commit-config.yaml`, `.husky/`,
`.githooks/`, `package.json` scripts, `Cargo.toml` workspace metadata, and repository
CI. Preserve an existing runner unless the user explicitly approves migration.

Do not add a command solely because its executable happens to be installed globally.
Confirm the tool is a declared repository dependency, or add it under the
repository's chosen version policy.

## Select the Runner

Use this order:

1. Extend the repository's existing hook runner.
2. Otherwise use Lefthook. It is language-neutral, supports staged-file templates,
   parallel commands, and mixed-language monorepos without requiring Python.
3. Use native `core.hooksPath` only when the user rejects an additional hook runner.
   Explain that native hooks require a committed cross-platform wrapper and custom
   staged-file handling.

Do not introduce Husky into Rust-only or mixed repositories merely because Bun is
present. Do not introduce Python `pre-commit` unless the repository already depends
on Python or the user requests it.

## Configure Lefthook

Merge rather than overwrite. Use one supported Lefthook config filename. The shape
is one command entry per detected runtime, filled in from the language references:

```yaml
pre-commit:
  parallel: true
  commands:
    # one entry per detected runtime, copied from that runtime's reference file
```

### Shared semantics

- `glob` filters the staged file list, and the command is skipped when nothing is
  left. This works even when `run` contains no file template, so `glob` is the
  correct way to gate a whole-project command on a language being touched.
- Lefthook's `**` matches one **or more** directories deep, so `src/**/*.ts` does not
  match `src/index.ts`. Use extension-only patterns like `*.ts` unless you truly need
  a path constraint.
- Leave `{staged_files}` unquoted. Lefthook quotes only the paths that need it.
  Wrapping it in `"..."` forces quoting on every path, which breaks tools that do not
  strip quotes themselves.
- Prefer check-only commands over autofixers. Since Lefthook 2.1.7, `pre-commit` runs
  automatically hide unstaged/partially-staged hunks before the hook and restore them
  afterward, aborting the commit (rather than silently including unreviewed content)
  if a fixer's changes conflict with the restore; `stage_fixed: true` now stages only
  the fixer's edits to already-staged content. On an older Lefthook, or one run with
  `--no-stage-fixed`, that protection is absent and an autofixer can pull unstaged
  work into the commit — pin `min_version: 2.1.7` in `lefthook.yml` if a command in
  this config writes files or uses `stage_fixed`.
- Keep pre-commit fast. Move whole-project analysis that cannot be scoped to staged
  files, such as type checking and test suites, to `pre-push` or CI.
- Use `root:` only when a tool must run from a subdirectory. It changes the working
  directory and trims that prefix from the file paths passed to the command.

Adapt commands to repository scripts when equivalent scripts already exist. Prefer
project-local executables over globally resolved ones.

## Install and Bootstrap

Follow the repository's dependency policy. Per-runtime dependency lists are in the
language references.

If Lefthook is managed by mise, Homebrew, Cargo tooling, or another existing project
bootstrap mechanism, use that mechanism instead of adding a duplicate package.
Document installation in the repository's existing contributor setup location.

Never assume dependency installation also enables hooks. Run `lefthook install`
explicitly. Do not modify global Git configuration.

## Verification

Run each configured command directly before invoking the hook runner, then run the
hook itself:

```bash
lefthook run pre-commit
```

The exact per-runtime commands to run first are listed in each language reference.
Run only the ones for detected runtimes, with any adaptations made during setup.

Confirm the hook is installed without making a test commit: check that
`.git/hooks/pre-commit` exists, or that `core.hooksPath` points at Lefthook's
directory. If a command fails, report the concrete failure and leave the hook
configuration visible for review. Do not bypass checks or weaken lint rules to force
a passing result.

Tell the user that `git commit --no-verify` bypasses hooks for emergencies and that
`lefthook uninstall` removes installed hook shims while leaving configuration intact.

## References

- [`references/rust.md`](references/rust.md) — Cargo-based checks: why Clippy cannot
  take staged paths, `--all-targets` and `--all-features` tradeoffs, `[lints]` in
  `Cargo.toml` versus `-D warnings`, `rustfmt` edition handling, moving Clippy to
  pre-push.
- [`references/typescript.md`](references/typescript.md) — oxfmt and oxlint: the two
  distinct globs, check-only invocation, default severity and `--deny-warnings`, the
  absence of type-aware rules, config and ignore resolution, binary resolution.
