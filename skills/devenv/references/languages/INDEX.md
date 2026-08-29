# Languages Reference Index

Per-language `languages.<name>.*` option references for devenv.sh, grouped by ecosystem.

## Systems

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| C | [c](c.md) | `debugger`, `lsp.enable`, `lsp.package` |
| C++ | [cplusplus](cplusplus.md) | `lsp.enable`, `lsp.package` only |
| Crystal | [crystal](crystal.md) | `package`, `shards.enable`, `shards.package` |
| Fortran | [fortran](fortran.md) | `package` |
| Go | [go](go.md) | `version`, `package`, `enableHardeningWorkaround`, `delve.enable`, `delve.package` |
| Hare | [hare](hare.md) | enable only (no `package`) |
| Nim | [nim](nim.md) | `package` |
| Odin | [odin](odin.md) | `debugger`, `package` |
| Pascal | [pascal](pascal.md) | `lazarus.enable` |
| Rust | [rust](rust.md) | `channel`, `version`, `components`, `targets`, `toolchainFile`, `mold.enable` |
| Swift | [swift](swift.md) | `package` |
| V | [v](v.md) | enable, package only |
| Vala | [vala](vala.md) | `package` |
| Zig | [zig](zig.md) | `version`, `package` |

## JVM & CLR

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| Clojure | [clojure](clojure.md) | `lsp.enable`, `lsp.package` only |
| .NET | [dotnet](dotnet.md) | `package` |
| Java | [java](java.md) | `jdk.package`, `gradle.enable`, `maven.enable` |
| Kotlin | [kotlin](kotlin.md) | `lsp.enable`, `lsp.package` only |
| Scala | [scala](scala.md) | `sbt.enable`, `mill.enable`, `java.jdk.package` |

## Web/JS

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| Deno | [deno](deno.md) | enable, package only |
| Elm | [elm](elm.md) | `lsp.enable`, `lsp.package` only |
| Gleam | [gleam](gleam.md) | enable, package only |
| JavaScript | [javascript](javascript.md) | `directory`, `npm.install.enable`, `pnpm.install.enable`, `yarn.install.enable`, `bun.install.enable`, `corepack.enable` |
| PureScript | [purescript](purescript.md) | `spago.enable`, `spago.package` |
| TypeScript | [typescript](typescript.md) | `lsp.enable`, `lsp.package` only |

## Scripting

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| AWK (gawk) | [gawk](gawk.md) | enable only (no `package`) |
| Lua | [lua](lua.md) | `package` |
| Perl | [perl](perl.md) | `packages` |
| PHP | [php](php.md) | `version`, `extensions`, `ini`, `packages.composer`, `fpm.pools` |
| Python | [python](python.md) | `version`, `directory`, `venv.enable`, `poetry.enable`, `uv.enable`, `libraries` |
| Raku | [raku](raku.md) | enable only (no `package`) |
| Robot Framework | [robotframework](robotframework.md) | `python` |
| Ruby | [ruby](ruby.md) | `version`, `versionFile`, `bundler.enable`, `documentation.enable` |
| Shell | [shell](shell.md) | `lsp.enable`, `lsp.package` only |

## Functional

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| Elixir | [elixir](elixir.md) | `package` |
| Erlang | [erlang](erlang.md) | `package` |
| Haskell | [haskell](haskell.md) | `package`, `cabal.enable`, `stack.enable`, `stack.args` |
| Idris | [idris](idris.md) | `package` |
| Lean 4 | [lean4](lean4.md) | enable, package only |
| OCaml | [ocaml](ocaml.md) | `packages` |
| Racket | [racket](racket.md) | enable, package only |
| Standard ML | [standardml](standardml.md) | `package` |
| Unison | [unison](unison.md) | enable, package only |

## Data/Scientific & Publishing

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| Julia | [julia](julia.md) | enable, package only |
| R | [r](r.md) | `radian.enable` |
| TeX Live | [texlive](texlive.md) | `base`, `packages` |
| Typst | [typst](typst.md) | `fontPaths` |

## Infra/Config

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| Ansible | [ansible](ansible.md) | `package`, `lsp.package` (no distinguishing options beyond that) |
| CUE | [cue](cue.md) | `package` |
| Helm | [helm](helm.md) | `package`, `plugins` |
| Jsonnet | [jsonnet](jsonnet.md) | `lsp.enable`, `lsp.package` only |
| Nix | [nix](nix.md) | `lsp.enable`, `lsp.package` only |
| OpenTofu | [opentofu](opentofu.md) | `package` |
| Pkl | [pkl](pkl.md) | `package` |
| Terraform | [terraform](terraform.md) | `version`, `package` |

## Niche

| Language | File | Key options beyond `enable` |
| --- | --- | --- |
| Dart | [dart](dart.md) | enable, package only |
| Lobster | [lobster](lobster.md) | enable, package only |
| Solidity | [solidity](solidity.md) | `foundry.enable`, `foundry.package` |

## Notably deep

- **[python](python.md)** (1013 lines): the deepest language doc — `venv.*` for stdlib venvs, `poetry.*` with granular `install.*` (extras, groups, root package), and `uv.*` with matching `sync.*` knobs; plus `manylinux.enable` and `patches.buildEnv.enable` for native-extension quirks.
- **[rust](rust.md)** (582 lines): channel/version selection backed by fenix, a full `toolchain.*` component map (cargo/clippy/rust-analyzer/rustc/rustfmt), `toolchainFile` import, cross-compile `targets`, and alternate linkers/backends (`mold`, `lld`, `wild`, `cranelift`, `clangLinker`).
- **[php](php.md)** (425 lines): per-project `version`, `extensions`/`disableExtensions`, raw `ini`, Composer `packages.composer`, and a full FPM subsystem (`fpm.pools`, `fpm.settings`, `fpm.phpOptions`, `fpm.extraConfig`) for running pool-based FPM servers.
- **[javascript](javascript.md)** (386 lines): one enable gate over four competing package managers (`npm`, `pnpm`, `yarn`, `bun`), each with its own `<pm>.enable`/`<pm>.install.enable`/`<pm>.package`, plus `corepack.enable` and monorepo `directory` targeting.
- **[haskell](haskell.md)** (172 lines): dual build-tool support via `cabal.enable`/`cabal.package` and `stack.enable`/`stack.package`/`stack.args`.
- **[java](java.md)** (162 lines) and **[scala](scala.md)** (166 lines): both layer optional build tools on top of a shared JDK — Java via `gradle.enable`/`maven.enable`, Scala via `sbt.enable`/`mill.enable` (and both reference `languages.java.jdk.package`).
- **[go](go.md)** (156 lines): dedicated `delve.enable`/`delve.package` debugger integration alongside `enableHardeningWorkaround` for CGO edge cases.
