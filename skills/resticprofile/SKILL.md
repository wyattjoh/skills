---
name: resticprofile
description: 'Operates the resticprofile CLI for restic backups: running profiles, inspecting status, managing schedules, editing config, and troubleshooting. Triggers on "run my backup", "backup status", "resticprofile", "restic profile", "schedule my backup", "check backups", "snapshot", "prune backups", or any mention of restic backup workflows. Use this whenever the user touches backup operations even if they do not name the tool, since resticprofile is the entry point to restic in these workflows.'
allowed-tools: Bash, Read, Edit, Glob, Grep
effort: low
---

# Resticprofile Workflows

`resticprofile` is a Go wrapper around `restic` that turns a YAML config into named profiles, schedules, and pre/post hooks. Never invoke `restic` directly through this skill: every backup, prune, and check goes through `resticprofile`.

Use this skill to operate the CLI, inspect schedules and logs, and edit the profile. If the user is asking about restic internals (snapshots, repository format, encryption), still go through `resticprofile` for the actual commands, since it injects credentials and lock handling.

## Setup

Discover the specifics at the start of a task rather than assuming them; the tool
already knows most of them.

- **Binary:** `resticprofile` on `PATH` (confirm with `resticprofile version`).
- **Config:** resticprofile auto-resolves its config from the default search path
  (`~/.config/resticprofile/`, `/etc/resticprofile/`, or the current directory).
  Every command prints the resolved path as its first line
  (`using configuration file: <path>`); trust that over any assumption. By default
  `status.json` and `logs/*.log` sit under that config dir.
- **Repository, profiles, hostname, retention, schedules, healthchecks:** all
  defined in the config. Read them with `resticprofile profiles` and
  `resticprofile show` (or `resticprofile <profile>.show`). Do not assume a
  repository backend, a hostname, or that a profile named `default` exists.
- **Scheduler:** resticprofile drives the OS scheduler — `launchd` on macOS (agents
  under `~/Library/LaunchAgents/local.resticprofile.*`), `systemd`/`crond` on Linux.
  Manage it through `resticprofile schedule`/`unschedule`/`status`, never by editing
  the scheduler directly.
- **Secrets:** credentials come from the profile's `password-command` / `run-before`
  hooks (for example the macOS keychain via `security find-generic-password`). Never
  echo a secret, and never write one into `profiles.yaml` or any plaintext file. To
  rotate, update the source the profile reads (e.g. `security add-generic-password`),
  not the YAML.
- **Watchdog (optional):** some setups add a watchdog that kills hung backups so they
  stop blocking the schedule. If a `watchdog.sh` sits beside the config with a matching
  scheduler agent, see `references/watchdog.md`; otherwise disregard the watchdog
  mentions below.

### Selecting a profile

Do not assume a profile named `default` exists. Before running any profile-scoped command when the target profile is not already clear from context, enumerate the configured profiles with `resticprofile profiles` (it prints each profile's name and description).

- **Exactly one profile:** use it directly, no need to ask.
- **Multiple profiles:** pick the first one listed as the convenient default, but always show the user the full list (name + description) so they can redirect to another instead of a silent guess. Never fire a mutating or destructive command (`backup`, `forget`, `prune`, `restore`, `unschedule`) at a guessed profile when several exist and the user did not name one. Surface the list and let them pick, or confirm the first is right, before proceeding. Read-only commands (`status`, `snapshots`, `show`) can default to the first profile without friction, since nothing is at stake.
- Once a profile is chosen (by either path), remember it for the rest of the turn rather than re-discovering it before every command.

## Command Anatomy

```
resticprofile [resticprofile flags] [profile.]<command> [command flags]
```

- `profile.` selects a named profile (equivalently `-n <name>`); omit it only when there is a single profile or resticprofile's own configured default applies. Prefer targeting the profile you selected (see "Selecting a profile" above) explicitly.
- `<command>` is either a resticprofile own-command (`status`, `schedule`, `show`, `profiles`, `generate`, `run-schedule`) or a restic command (`backup`, `snapshots`, `forget`, `prune`, `check`, `restore`, `mount`, `unlock`, `stats`, `ls`, `find`, `diff`, etc.).
- Restic commands inherit their flags from the matching section of the profile (e.g., the `backup:` block populates `restic backup` flags).

resticprofile resolves its own config from the default search path (see [Setup](#setup)), so you can run commands from anywhere:

```bash
resticprofile <command>
```

Pass `-c <path>` only to target a config outside the default search path.

## Quick Reference

| Goal                               | Command                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| List profiles                      | `resticprofile profiles`                                                |
| Show effective config of a profile | `resticprofile show` (single profile) or `resticprofile <profile>.show` |
| Dry-run any command                | `resticprofile --dry-run <command>`                                     |
| Run the configured backup          | `resticprofile backup`                                                  |
| Run backup verbosely               | `resticprofile -v backup`                                               |
| Show last run status               | `resticprofile status`                                                  |
| List snapshots                     | `resticprofile snapshots`                                               |
| List snapshots for one host only   | `resticprofile snapshots --host <hostname>`                             |
| Prune now (respecting retention)   | `resticprofile forget --prune` or `resticprofile prune`                 |
| Verify repository                  | `resticprofile check`                                                   |
| Check with data read               | `resticprofile check --read-data-subset 5%`                             |
| Install schedules                  | `resticprofile schedule --all`                                          |
| Remove schedules                   | `resticprofile unschedule --all`                                        |
| Schedule a single command          | `resticprofile schedule backup`                                         |
| Unlock a stale repo lock           | `resticprofile unlock`                                                  |
| Mount the repo for browsing        | `resticprofile mount /tmp/restic`                                       |
| Restore latest for one host        | `resticprofile restore latest --host <hostname> --target /tmp/restore`  |
| Repo stats                         | `resticprofile stats`                                                   |
| Shell completion                   | `resticprofile generate --zsh-completion`                               |
| JSON schema for editor validation  | `resticprofile generate --json-schema v2`                               |

`<hostname>` is profile-specific: it comes from the selected profile's `backup.host` config, discoverable via the `.show` command above. There is no universal hostname to hardcode.

Pass `--dry-run` first whenever the action mutates state (`backup`, `forget`, `prune`, `restore`, `unschedule`). It prints the underlying restic command without executing.

## Common Workflows

### Run a backup on demand

```bash
resticprofile -v backup
```

Don't assume the host, sources, excludes, hooks, or schedule, since those are profile-specific. Inspect the selected profile's actual effective config with `resticprofile <profile>.show` (or `resticprofile show` when there is only one profile) to see its `backup.host`, source paths, excludes, run hooks, and `schedule:` before describing what a run will do.

If the user just wants to know "did it run?", prefer `resticprofile status` plus a peek at `status.json` over re-running the backup.

### Inspect status and history

- `resticprofile status` — shows the schedule registration in launchd plus the next/last run window.
- `cat ~/.config/resticprofile/status.json | jq` — last-run summary (success, duration, files added, bytes added).
- `tail -n 200 ~/.config/resticprofile/logs/backup.log` — actual stdout/stderr from scheduled runs.
- `tail -n 100 ~/.config/resticprofile/logs/check.log` — weekly repo verification log.
- `resticprofile snapshots --compact` — repo-side history.

### Manage the launchd schedule

```bash
resticprofile schedule --all     # write/refresh all jobs from profiles.yaml
resticprofile unschedule --all   # remove every job this profile registered
resticprofile schedule backup    # only the backup schedule
resticprofile status --all       # see every scheduled job
```

After editing `schedule:` entries in `profiles.yaml`, rerun `resticprofile schedule --all` so launchd sees the change. The plist files land in `~/Library/LaunchAgents/local.resticprofile.<profile>.<command>.plist`.

If launchd disagrees with `resticprofile status` (e.g., a stale job after renaming a profile), inspect with `launchctl list | grep resticprofile` and clean up by running `unschedule` first, then `schedule`.

### Edit the profile

Open `~/.config/resticprofile/profiles.yaml`. After any edit:

1. Validate by running `resticprofile show` — it parses, expands templates, and renders the effective config. Errors surface here before the next scheduled run.
2. If schedules changed, run `resticprofile schedule --all`.
3. If sources/excludes changed, follow up with `resticprofile -v --dry-run backup` to confirm the file list looks right before the next real run.

See `references/profiles-yaml.md` for the schema cheat sheet (global, profile sections, retention, schedule fields, run hooks, healthchecks).

### Restore files

```bash
# Browse snapshots first (<hostname> is the selected profile's backup.host)
resticprofile snapshots --host <hostname>

# Restore everything from the latest snapshot for that host
resticprofile restore latest \
  --host <hostname> \
  --target /tmp/restore

# Restore a specific path from a specific snapshot
resticprofile restore <snapshot-id> \
  --include "/Users/<you>/Documents/foo" \
  --target /tmp/restore
```

For a one-off browse without copying anything, use `resticprofile mount /tmp/restic` and Cmd+Q the process (or Ctrl+C the terminal) to unmount.

### Forget and prune

The profile keeps hourly/daily/weekly/monthly/yearly tiers via `retention:` and prunes weekly on Sunday 02:30. To force a clean-up now:

```bash
resticprofile --dry-run forget --prune   # preview
resticprofile forget --prune             # apply
```

`forget` only removes snapshots; `prune` reclaims pack space. The scheduled `prune` job is the right thing to leave alone unless the repo is bloated.

## Troubleshooting Playbook

Work through these in order.

1. **"Unable to lock repository" / stale lock.** Another run crashed or is in flight. Confirm nothing is actively backing up (`ps aux | grep restic`), then `resticprofile unlock`. The profile sets `restic-stale-lock-age: 2h` so locks older than that auto-clear.
2. **Backup never ran.** Check `resticprofile status` — if the job is missing, run `resticprofile schedule --all`. If it is registered but did not fire, check `~/.config/resticprofile/logs/backup.log` and `log show --predicate 'process == "resticprofile"' --last 1h`. The schedule honors `schedule-ignore-on-battery-less-than: 20`, so a low battery skip is expected.
   - **Backups silently stopped for hours/days.** A backup that hangs holds the launchd slot, so launchd skips every later hourly run. Check for a long-lived process: `ps -o pid,etime,command -ax | grep '[r]estic'`. A common culprit on macOS is the FileProvider deadlock (`EDEADLK` / "resource deadlock avoided" in the backup log) on iCloud-synced files under `~/Documents`. If a watchdog is installed (see [Setup](#setup)), it kills runs older than 2h automatically; otherwise kill the `restic` + `resticprofile … run-schedule` PIDs yourself, then `resticprofile unlock`. See `references/watchdog.md` for the watchdog.
3. **Credentials missing / "Fatal: unable to open config file".** Repository credentials come from the profile's `run-before` / `password-command` hooks. Inspect `resticprofile show` to see which source they read (e.g. a keychain entry, verified with `security find-generic-password -a <account> -s <service> -w` on macOS, without logging the output). If the source is empty, restore it before any run can succeed.
4. **Healthchecks.io shows no pings.** Either the run is failing before the post hook or the URL changed. The current UUIDs live in `profiles.yaml` under `send-before` / `send-after` / `send-after-fail`. Curl one manually with `-I` to confirm reachability.
5. **Slow or huge backup.** Compare `status.json` to the previous run; a large `files_new` count usually points to a new directory that should be excluded. Add it under the profile's `backup.exclude:` (e.g. `<profile>.backup.exclude:`) and rerun `resticprofile show` to confirm.
6. **Profile won't parse.** Run `resticprofile show` to get the YAML/template error with line numbers. Round-trip the file through `python -c "import yaml,sys;yaml.safe_load(open('profiles.yaml'))"` for a YAML-only sanity check.
7. **Restic version mismatch.** `resticprofile version --verbose` prints both the resticprofile and restic versions. Upgrade with `brew upgrade resticprofile restic` if either is stale.

## Editing Etiquette

- Never write a secret into `profiles.yaml`. Keep using `password-command` and `run-before` keychain pulls.
- Prefer adding excludes over removing sources — fewer surprises when a path comes back later.
- After any change that affects scheduling, leave the user with the two follow-up commands they will care about: `resticprofile show` (sanity check) and `resticprofile schedule --all` (apply).
- Conventional commit messages for changes to this directory still apply, e.g. `chore(resticprofile): exclude .turbo from backup`.

## When to Reach for the Reference File

Read `references/profiles-yaml.md` before editing `profiles.yaml` if the change involves:

- New `schedule:` expressions or `schedule-*` modifiers
- Retention policy tuning
- Adding/removing profiles, groups, or inheritance
- New `run-before` / `run-after` / `send-*` hooks
- Switching repository backends or password sources
