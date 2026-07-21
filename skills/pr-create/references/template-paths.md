# PR template lookup locations

GitHub searches several locations for a pull request template. This skill
mirrors GitHub's behavior plus a `docs/` fallback.

## Lookup order

Check every path below in order. Collect matches rather than stopping at the
first hit, because the `PULL_REQUEST_TEMPLATE/` directory can contain
multiple templates.

1. `.github/pull_request_template.md` (lowercase)
2. `.github/PULL_REQUEST_TEMPLATE.md` (uppercase)
3. `docs/pull_request_template.md`
4. `docs/PULL_REQUEST_TEMPLATE.md`
5. All files matching `.github/PULL_REQUEST_TEMPLATE/*.md`
6. All files matching `docs/PULL_REQUEST_TEMPLATE/*.md`

GitHub also accepts the repo root (e.g., `./pull_request_template.md`). Most
repos put it under `.github/`, so the root path is supported but deprioritized
in the lookup.

## Case sensitivity

On macOS (and Linux) filesystems are case-sensitive. Check both the all-lower
and all-upper variants. Do not guess at mixed-case variants; they are
non-canonical.

## Multiple-template selection

When the user has a `PULL_REQUEST_TEMPLATE/` directory, GitHub lets the author
pick by query parameter (`?template=<name>`). In this skill, prompt the user
via `AskUserQuestion`:

- One option per discovered file, labeled by filename minus `.md` extension.
- One "none -- use What/Why/How instead" option at the end.

## Template variables

Some templates contain placeholders like `<!-- describe your change -->` or
bracketed instructions. Treat these as authoring hints, not literal content:

- Replace them with the generated content from commits and diff.
- Preserve any unchecked checkboxes (`- [ ]`) so the user can mark them after
  creation. Never tick a checkbox on the user's behalf.

## Non-template files to ignore

- `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` are documentation, not
  templates.
- `ISSUE_TEMPLATE/` and similar are for issues, not PRs.
- `CODEOWNERS` is unrelated to templates.
