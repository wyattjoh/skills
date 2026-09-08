# Template: `<run>/briefs/common.md`

Copy to the run folder when absent, replacing `<spec name>`, `<repository>`,
and `<main checkout path>`.

```markdown
# Implementation brief (shared)

You are implementing one ticket from the "<spec name>" spec in the
<repository> repository. You are working inside a dedicated git worktree on a
feature branch. The main checkout is <main checkout path> — do not edit it.

Rules:

- Read CLAUDE.md, DESIGN.md, CONTEXT.md, and `.claude/rules/*.md` in this
  worktree before changing code. Read the spec and the ticket (attached).
- Respect the ADRs in docs/adr/ named by the spec.
- Work test-first where a seam exists: write or move the tests at the new
  interface, watch them fail, then implement. Replace tests, don't layer them.
- Before any `cargo build|check|test`, run `just crsqlite` once in this worktree.
  Run `cargo check --workspace` and single test files regularly; run
  `just test` (full workspace) once at the end. Also run
  `bun scripts/check-agent-architecture.ts` if you touched core/app/plugins.
- Before committing, run exactly what CI runs and fix everything it raises;
  there are no pre-commit hooks, so this is the only gate before review:
  `cargo fmt --all -- --check` and
  `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
  A commit with any clippy warning or unformatted file is rejected at review.
- Update CLAUDE.md / DESIGN.md / rules / CLI contract docs in the same commit
  when the ticket calls for it.
- Commit exactly ONE conventional commit on the current branch (not main).
  Never push. Never touch remotes. Stage only intended files.
- When completely finished and the commit exists, print a final line exactly:
  `TICKET DONE <ticket-number>` followed by a short summary of what changed and
  any acceptance checkbox you could not satisfy and why.
- If genuinely blocked on a decision only the human can make, print
  `TICKET BLOCKED <ticket-number>: <question>` and stop.
- A reviewer will later send you follow-up fix requests in this same session.
  For fixes, amend the single commit (`git commit --amend`) so the branch still
  holds exactly one commit, then print `FIXES DONE <ticket-number>`.

Installed app data is off limits:

- Never run the built binaries (`cargo run`, `just start`, `just install*`,
  `target/*/atk`, `target/*/agent-toolkit`, the `watch_cost` example) or any
  `atk ...` command. The real app is running and its data lives in
  `~/.local/share/agent-toolkit`; only tests with tempdir/in-memory fixtures
  are allowed. Never call `Paths::detect()` from a test.
```
