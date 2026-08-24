# Rust pre-commit checks

Cargo-based checks for repositories with a `Cargo.toml`. Applies to the Rust portion
of a polyglot repository only. Never apply these tools to non-Rust files.

## Detection

- `Cargo.toml` at the repository root means Rust. A `[workspace]` table means multiple
  crates, which changes the package selection flags below.
- `Cargo.toml` files nested under a workspace root are members, not separate projects.
  Do not add a command per member.
- `rust-toolchain.toml` or `rust-toolchain` pins the toolchain. The hook inherits it
  automatically through the rustup shims, so do not hardcode `cargo +nightly`.
- Confirm the components exist before configuring anything:

  ```bash
  rustup component list --installed | grep -E 'clippy|rustfmt'
  rustup component add clippy rustfmt
  ```

  A missing component surfaces as `no such command: clippy`, which reads like a
  broken hook rather than a missing prerequisite.

## Lefthook block

```yaml
pre-commit:
  parallel: true
  commands:
    fmt:
      glob: "*.rs"
      run: cargo fmt --all -- --check
    clippy:
      glob: "*.rs"
      run: cargo clippy --workspace --all-targets --no-deps -- -D warnings
```

Drop `--workspace` for a single-crate repository. Drop `-- -D warnings` if the
repository uses the `[lints]` table (see below).

## Cargo operates on packages, not files

Clippy compiles a crate graph. It cannot lint an arbitrary list of staged `.rs` files,
so never pass `{staged_files}` to it. `glob: "*.rs"` is the correct mechanism: Lefthook
filters the staged set, skips the command entirely when no Rust file is staged, and
otherwise runs the whole-package command. The glob is a gate, not an argument list.

The one Rust tool that does accept paths is `rustfmt` invoked directly:

```yaml
pre-commit:
  commands:
    fmt:
      glob: "*.rs"
      run: rustfmt --check --edition 2021 {staged_files}
```

Bare `rustfmt` defaults to edition 2015 and misparses modern code, so `--edition` is
mandatory and must match the package. It also has no view of workspace metadata.
Prefer `cargo fmt --all -- --check` unless formatting time on a large workspace is a
measured problem.

## Flag selection

| Flag                    | When to use it                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--workspace`           | Multi-crate workspaces. Without it only the current package is checked, so a change in another member passes the hook and fails CI.                 |
| `--all-targets`         | Includes tests, benches, and examples. Catches more, costs noticeably more compile time. Drop it first when the hook gets slow and let CI carry it. |
| `--all-features`        | Only when features are additive. Mutually exclusive features make this fail to compile. Use an explicit `--features <list>` or the defaults.        |
| `--no-deps`             | Limits linting to the selected packages instead of also linting local path dependencies.                                                            |
| `--locked` / `--frozen` | When the repository requires lockfile fidelity. `--locked` fails if `Cargo.lock` would change; `--frozen` also forbids network access.              |

Preserve whatever feature flags the repository's CI already uses. A hook that lints a
different feature set than CI produces failures that cannot be reproduced locally.

## Prefer `[lints]` in Cargo.toml over `-D warnings`

Rust 1.74 and later support a `[lints]` table. Lint policy in the manifest applies to
every invocation, including the editor and CI, instead of only the ones that remember
the flag:

```toml
[workspace.lints.clippy]
all = { level = "deny", priority = -1 }

[lints]
workspace = true
```

With that in place the hook becomes `cargo clippy --workspace --all-targets --no-deps`.
Keep `-- -D warnings` only for repositories that have not adopted the table.

## Prefer check-only over autofix

`cargo clippy --fix` and `cargo fmt` without `--check` rewrite files in place.
`--fix` refuses to run against a dirty working tree unless given `--allow-dirty`,
which is exactly the state a pre-commit hook runs in — either it fails constantly or
it is forced past the one safety check it has. Keep both check-only.

Since Lefthook 2.1.7, `pre-commit` runs hide unstaged/partially-staged hunks before
the hook and restore them afterward, so a rewriting command on an up-to-date Lefthook
no longer silently pulls unstaged work into the commit (a conflicting restore aborts
the commit instead). That safety net does not help with `--fix`'s own `--allow-dirty`
requirement, so check-only remains the simpler, faster choice regardless of Lefthook
version.

## Speed

Clippy is almost always the slowest check in a mixed repository, because a cold
`target/` means building the full dependency graph.

- Keep `target/` warm. Do not add a clean step anywhere near the hook.
- Consider `sccache` when builds are shared across worktrees or CI.
- If the hook is still too slow, split it: keep formatting on pre-commit and move
  Clippy to pre-push.

```yaml
pre-commit:
  commands:
    fmt:
      glob: "*.rs"
      run: cargo fmt --all -- --check

pre-push:
  commands:
    clippy:
      glob: "*.rs"
      run: cargo clippy --workspace --all-targets --no-deps -- -D warnings
```

For `pre-push` hooks Lefthook filters against `{push_files}`, the committed but
unpushed files, rather than the staged set.

## Verification

```bash
rustup component list --installed | grep -E 'clippy|rustfmt'
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --no-deps -- -D warnings
```

Run these directly before invoking `lefthook run pre-commit`, with whatever flag
adaptations were made during setup. A first run on a cold `target/` is expected to be
slow, and that duration is what the developer will pay on their next commit.
