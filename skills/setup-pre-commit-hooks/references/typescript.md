# TypeScript and Bun pre-commit checks

Oxfmt and Oxlint checks for repositories with a `package.json` and a Bun lockfile.
Both are JavaScript/TypeScript tools. Never point them at Rust, Go, or Python files.

## Detection

- `package.json` plus `bun.lock` (text, Bun 1.2 and later) or `bun.lockb` (binary,
  earlier versions) means a Bun-owned repository.
- A `workspaces` array in the root `package.json` means a monorepo. Configure one
  command at the repository root rather than one per package; both tools walk
  directories on their own.
- Confirm `oxfmt` and `oxlint` are declared dependencies. A globally installed binary
  is not a reason to add a hook command, because every other contributor and CI will
  fail on a command they do not have.
- Check for existing scripts first. `bun run lint` and `bun run format:check` are
  preferable to a hand-written invocation, because the hook, CI, and manual runs then
  cannot drift apart.

## Lefthook block

```yaml
pre-commit:
  parallel: true
  commands:
    oxfmt:
      glob: "*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,json,jsonc,yaml,yml,md,mdx,css,scss,html,vue,svelte,astro}"
      run: bun run format:check {staged_files}
    oxlint:
      glob: "*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,vue,astro,svelte}"
      run: bun run lint {staged_files}
```

The two globs differ deliberately. Oxfmt formats data and markup files that Oxlint
does not lint, so sharing one glob hands Oxlint `.md`, `.json`, and `.css` paths it
has no rules for. Keep them as separate entries with separate patterns.

Bun forwards extra arguments to the script, so `bun run format:check {staged_files}`
resolves to `oxfmt --check <paths>`. npm requires an explicit `--` separator before
forwarded arguments; Bun does not.

## Binary resolution

When no suitable script exists, call the project-local binary explicitly:

```yaml
pre-commit:
  parallel: true
  commands:
    oxfmt:
      glob: "*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,json,jsonc,yaml,yml,md,mdx,css,scss,html,vue,svelte,astro}"
      run: ./node_modules/.bin/oxfmt --check {staged_files}
    oxlint:
      glob: "*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,vue,astro,svelte}"
      run: ./node_modules/.bin/oxlint {staged_files}
```

Prefer this over `bunx` inside a hook. `bunx` resolves a locally installed binary
first, but silently downloads the package from npm when it is missing. In a checkout
where someone forgot `bun install`, that turns a lint check into a network round-trip
inside the commit path, and it resolves a version nobody pinned. Verified behavior:
running `bunx oxlint` in a repository with no `node_modules` resolves and downloads
the package rather than failing.

`bunx` is fine for the one-off bootstrap commands run during setup.

## Check, never write

Oxfmt defaults to `--write`, which formats files in place. In a pre-commit hook always
pass `--check`, which reports formatting problems and exits non-zero without touching
anything. `--list-different` prints only the offending paths if quieter output is
wanted.

Lefthook does not stash unstaged changes, so a writing formatter rewrites hunks that
were never staged, and the committed content stops matching what was reviewed. Adding
`stage_fixed: true` makes it worse: it re-stages the whole file, silently pulling
unstaged work into the commit. Keep both tools read-only and let the developer run
`bun run format` themselves.

The same rule rules out `oxlint --fix`, `--fix-suggestions`, and `--fix-dangerously`.

## Oxlint severity is looser than it looks

Only the `correctness` category is enabled by default. `suspicious`, `pedantic`,
`perf`, `style`, and `restriction` are opt-in, and most plugins (react, import, jest,
vitest, node, promise, jsx-a11y, nextjs) are off unless enabled. The typescript,
unicorn, and oxc plugins are on by default.

Enable what the repository needs in `.oxlintrc.json` rather than on the hook command
line, so the editor, CI, and the hook agree on one policy.

Oxlint exits 0 on warnings. If the repository's policy is that warnings block a
commit, add `--deny-warnings` or `--max-warnings 0`. Without one of those, a
warning-level violation passes the hook and then fails a stricter CI job.

## No type-aware rules

Oxlint analyses files individually and has no type information, so it does not replace
`tsc --noEmit`. Type checking cannot be scoped to staged files at all, because types
cross file boundaries: a staged change can break a file that was not staged.

Leave type checking (`bun run check` or `tsc --noEmit`) out of pre-commit and run it on
pre-push or in CI. The same applies to the test suite.

## Config and ignore resolution

- **Oxfmt** reads `.oxfmtrc.json`, and searches subdirectories for nested configs
  unless given `--disable-nested-config`. Ignores come from `.gitignore` and
  `.prettierignore` in the current directory, or from `--ignore-path`.
- **Oxlint** reads `.oxlintrc.json`, overridable with `-c`. Ignores come from
  `.eslintignore`, `--ignore-path`, and `--ignore-pattern`.

Exclude generated and vendored directories through those ignore files, not through the
Lefthook glob. A glob-only exclusion means a manual `bun run lint` and the hook check
different file sets, so the hook passes and CI fails.

In a monorepo, Lefthook runs from the repository root and `{staged_files}` are
root-relative, which both tools handle. Add `root:` to a command only when a tool
genuinely must run from a package directory.

## Dependencies

```bash
bun add --dev lefthook oxfmt oxlint
bunx lefthook install
```

Pin versions the way the repository already pins them. `bun add --dev` updates
`bun.lock`; commit it alongside the hook configuration.

If the repository already gets Lefthook from mise or Homebrew, use that instead of
adding a duplicate npm dependency.

## Verification

```bash
bun run format:check          # or ./node_modules/.bin/oxfmt --check .
bun run lint                  # or ./node_modules/.bin/oxlint .
bunx lefthook run pre-commit
```

Run the tool commands directly before the hook runner, so a failure is attributable to
the tool rather than to hook wiring.
