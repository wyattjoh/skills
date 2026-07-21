# Binary Release Artifacts

Projects that ship compiled binaries (Go, Rust, Deno compile, Bun compile) typically attach artifacts to the GitHub release and may update external package managers (Homebrew, Scoop, Chocolatey).

## Pipeline Overview

1. Release-please cuts the release and creates a GitHub release (empty artifacts).
2. A follow-up job builds binaries for each target.
3. Binaries are tar-gzipped and checksummed.
4. `gh release upload` attaches them to the release.
5. Optionally, a downstream job updates a package manager manifest.

## Multi-Target Build Matrix

```yaml
build-binaries:
  needs: release-please
  if: ${{ needs.release-please.outputs.releases_created == 'true' }}
  strategy:
    matrix:
      target:
        - { os: ubuntu-latest, triple: x86_64-unknown-linux-gnu, suffix: linux-x64 }
        - { os: ubuntu-latest, triple: aarch64-unknown-linux-gnu, suffix: linux-arm64 }
        - { os: macos-latest, triple: x86_64-apple-darwin, suffix: darwin-x64 }
        - { os: macos-latest, triple: aarch64-apple-darwin, suffix: darwin-arm64 }
        - { os: windows-latest, triple: x86_64-pc-windows-msvc, suffix: windows-x64 }
  runs-on: ${{ matrix.target.os }}
  permissions:
    contents: write # required to upload release assets
  steps:
    - uses: actions/checkout@v4
    # ... language-specific setup ...
    - name: Build
      run: <build command for matrix.target.triple>
    - name: Package
      shell: bash
      env:
        VERSION: ${{ needs.release-please.outputs.version }}
        SUFFIX: ${{ matrix.target.suffix }}
      run: |
        NAME="mytool-${VERSION}-${SUFFIX}"
        mkdir "$NAME"
        cp dist/binary "$NAME/"
        tar -czf "$NAME.tar.gz" "$NAME"
        shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
    - name: Upload to release
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        TAG: ${{ needs.release-please.outputs.tag_name }}
      run: |
        gh release upload "$TAG" *.tar.gz *.sha256 --clobber
```

Windows typically wants `.zip` instead of `.tar.gz`; adjust per OS.

## Language-Specific Build Commands

### Deno Compile

```bash
deno compile \
  --allow-read --allow-net \
  --target $TRIPLE \
  --output dist/binary \
  src/main.ts
```

Deno cross-compiles from any host, so a single runner can build all targets (the matrix becomes just a packaging fan-out).

### Rust

```bash
cargo build --release --target $TRIPLE
```

Cross-compiling from Linux to macOS/Windows is painful; the matrix approach with native runners is simpler.

### Go

```bash
GOOS=$OS GOARCH=$ARCH go build -ldflags="-X main.version=$VERSION" -o dist/binary ./cmd/mytool
```

Like Deno, Go cross-compiles cleanly from any host.

### Bun Compile

```bash
bun build --compile --target=bun-$OS-$ARCH --outfile=dist/binary src/main.ts
```

## Checksum Aggregation

Instead of per-file `.sha256`, produce a single `checksums.txt`:

```bash
shasum -a 256 *.tar.gz *.zip > checksums.txt
gh release upload "$TAG" checksums.txt --clobber
```

Consumers verify with `shasum -a 256 -c checksums.txt`.

## Downstream Package Manager Updates

Once binaries are attached, downstream package managers can be bumped. See [downstream-updates.md](downstream-updates.md) for the general pattern. The specifics differ per manager:

- **Homebrew tap**: Edit the `Formula/*.rb` file; update `url`, `sha256`, `version`.
- **Scoop bucket**: Edit the JSON manifest; update `version`, `url`, `hash`.
- **Chocolatey**: Update the `.nuspec` and push a new package to the chocolatey feed.

## Best Practices

1. **Checksum everything.** Users pinning to a checksum need a stable one; re-uploading to the same tag with `--clobber` changes hashes.
2. **Use `--clobber` on re-runs.** Failed jobs often need a retry; `gh release upload` without it fails on existing assets.
3. **Embed version in the binary.** `-ldflags` (Go), `env!("CARGO_PKG_VERSION")` (Rust), build-time import (Deno/Bun). Lets `mytool --version` work offline.
4. **Sign if possible.** Sigstore (cosign) for open-source; GPG for traditional flows. Not required but increasingly expected.
5. **Keep the build job's `contents: write` scoped narrowly.** Don't grant it broader permissions than needed to upload.
