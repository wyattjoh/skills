# Generated skill: output structure

The generated skill is **pure documentation** — a `SKILL.md` plus `references/`,
no `package.json`, no scripts. Follow this layout exactly during synthesis.

```
skills/<cli-name>/
├── SKILL.md                       # navigational + the common-operations path
└── references/
    ├── commands/<group>.md        # ALWAYS one file per top-level command group
    └── <config-format>.md         # one file per associated config format
```

## `SKILL.md` contents

Keep it navigational and lean (well under 500 lines). It carries the common
path; the exhaustive per-command detail lives in `references/`.

### Frontmatter

```yaml
---
name: <cli-name>
description: '<Purpose sentence>. Triggers on "<cli>", "<cli> <key-subcommand>", "<config-file-name>", ...'
allowed-tools: Bash, Read
effort: low
---
```

- The `description` must include concrete trigger phrases: the CLI name, its key
  subcommands, and every associated config-file name (e.g. for `just`: `"just"`,
  `"Justfile"`, `"just recipe"`, `"run a just task"`). This is what makes the
  skill auto-activate later — get it right.
- `allowed-tools: Bash, Read` — a usage skill runs the CLI and reads config.
- `effort: low` — the generated skill is a lookup/kickstart, not a reasoner.

### Body sections (in order)

1. **Title + one-paragraph overview** — what the CLI is for.
2. **Local setup** — binary path and the **pinned version explored**. Note the
   config-file name(s) the CLI reads.
3. **Global flags** — a table of global flags / env vars.
4. **Anatomy** — a one-line invocation shape,
   e.g. `` `<cli> [global flags] <command> [command flags]` ``.
5. **Commands** — a **top-level command table**: one row per top-level command
   with a one-line purpose and a link to its `references/commands/<group>.md`.
6. **Common workflows** — the star of the skill. A handful of real, **source-
   cited** workflows for the common operations. Each example ends with a
   `Source:` note; inferred ones are marked `(inferred)`.
7. **References** — an index linking every file in `references/`.

If docs-only (no local binary), add near the top:
`> Unverified against a local binary (docs-only generation).`

## `references/commands/<group>.md`

**Always one file per top-level command group**, regardless of how small the CLI
is. Each file holds that group's depth-2 detail:

- A subcommand table (subcommand, purpose, key flags).
- Per-subcommand flag tables where the flag set is non-trivial.
- Any verbatim `EXAMPLES:` block captured from `--help`.
- Discrepancy notes where `--help` and docs disagreed, with the pinned version.

## `references/<config-format>.md`

One file per associated config format (always produced when the CLI reads one).
Document syntax, structure, and features, with small worked examples. Cite the
docs sections the format description came from.

## Synthesis reminders

- **Binary wins on existence/spelling; docs win on explanation.** Note conflicts
  inline with the version.
- Lead with the common path. Flag tables support the workflows; they are not the
  point.
- Do not manufacture examples. Every workflow traces to a source or is marked
  `(inferred)`.
- Mirror the house style of existing CLI skills in this repo (`resticprofile`,
  `varlock`): table-heavy, terse, example-forward.
