---
name: clean-storage
description: 'Reclaims disk space by finding and removing regenerable build artifacts and tool caches (cargo target/, Xcode DerivedData, node_modules, Swift .build, Homebrew/pnpm/bun/npm caches). Triggers on "clean storage", "free up disk space", "what is taking up space", "disk is full", "reclaim disk", "clean build artifacts", "clear caches", or invokes /clean-storage.'
disable-model-invocation: true
effort: high
---

# Clean storage

Finds regenerable build artifacts and caches, verifies each one is genuinely
disposable, reports them, and deletes only after the user agrees.

Do not add `context: fork`. This workflow depends on `AskUserQuestion` for the
deletion checkpoint and on the user reading the full path list, and a forked
subagent cannot prompt the user. It must run inline.

## Workflow

### 1. Scan (read-only, run without asking)

```bash
bun $SKILL_DIR/scripts/scan.ts --root ~/Code --root ~/Projects
```

Default root is the home directory. Scanning a whole home directory takes a while,
so prefer explicit `--root` flags when the user named a location.

Useful flags:

| Flag              | Effect                                      |
| ----------------- | ------------------------------------------- |
| `--root <path>`   | Root to walk, repeatable. Default `~`       |
| `--min-size <MB>` | Hide candidates below this size. Default 10 |
| `--max-depth <n>` | Walk depth. Default 8                       |
| `--caches`        | Add global caches to a root-scoped scan     |
| `--json`          | Machine-readable output                     |
| `--apply`         | Delete the verified candidates              |

Global caches (Xcode DerivedData, DeviceSupport, go-build, Playwright, and the
package manager stores) live outside any scanned root. They are included only in a
home-wide scan, or when `--caches` is passed. This keeps a scoped request like
"clean up my Rust project" from proposing deletions across the whole machine.

### 2. Report every path

**Print the complete list of directories that would be deleted, one per line, before
asking for anything.** The user is authorizing specific paths, not a number. A
category summary alone is not enough to consent to a deletion, and neither is "the
largest few entries".

The script already prints the full list under "Will delete". Relay it verbatim. Do
not truncate it, do not replace it with the category totals, and do not collapse it
to the top N. If the list is long, that is information the user needs: a 153-entry
list is itself a signal about how wide the deletion is.

Then also surface:

- Anything under "Skipped", with its reason. These are candidates the scanner could
  not prove regenerable, and they are worth a human glance.
- The category totals and grand total, after the full list, as a summary.
- The tool-managed cache commands, which the script never runs itself.

### 3. Confirm before deleting

Deletion is destructive. Use `AskUserQuestion` to confirm, only after the full path
list is on screen. Include the total and the category breakdown in the question so
the user is deciding on real numbers.

Never run `--apply` without an explicit yes in the conversation. A general request
like "clean up my disk" authorizes the scan, not the deletion.

### 4. Apply

```bash
bun $SKILL_DIR/scripts/scan.ts --root ~/Code --apply
```

Pass the same roots and filters used for the scan, so the user approves the same set
that gets deleted.

The script refuses to run `--apply` while a build process is detected, since removing
a target directory mid-build corrupts it. If it refuses, report which process blocked
it rather than working around the check.

### 5. Report the outcome

Give the before and after free space and the count actually removed. If any path
failed, say which and why.

## Safety model

Discovery is by directory name, which proves nothing on its own. Every candidate must
pass an independent check before it is eligible, and it is re-verified immediately
before deletion so a stale scan cannot widen the blast radius.

| Category       | Proof                     |
| -------------- | ------------------------- |
| `cargo`        | contains `CACHEDIR.TAG`   |
| `xcode`        | `git check-ignore` passes |
| `node-modules` | sibling `package.json`    |
| `swift`        | sibling `Package.swift`   |
| `cache`        | known fixed cache path    |

Two exclusions run first and override the proof above:

- **Installed software** (`~/.bun/install/global`, `~/.local/share/mise`, `/usr/local/lib/node_modules`,
  and similar). A globally installed CLI has a `node_modules` beside a `package.json`,
  so the proof alone would green-light uninstalling every global package.
- **Tool-managed caches** (`~/.bun/install/cache`, `~/Library/pnpm/store`, and similar).
  These are reported with the vendor command instead, so they are not also deleted piecemeal.

Anything that fails is reported and skipped, never deleted. The scanner is built to
under-report rather than over-delete.

User data is out of scope. Messages attachments, `~/Downloads`, Photos libraries, and
Simulator devices are never touched, even when large.

See [references/categories.md](references/categories.md) for the full category list,
the reasoning behind each proof, and walk behavior.

## Notes

- The user's environment may block `rm -rf` from the agent. The script deletes through
  Bun's filesystem API rather than shelling out, but if a permission prompt appears,
  let the user answer it instead of finding another route.
- Deleting these directories costs a cold rebuild on next build. Mention this when the
  reclaimed set is dominated by projects the user is actively working in.
