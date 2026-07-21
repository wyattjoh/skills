# profiles.yaml schema cheat sheet

This is a hand-curated reference for the v1 YAML format used at `~/.config/resticprofile/profiles.yaml`. Full reference: https://creativeprojects.github.io/resticprofile/configuration/

The file is split into top-level blocks:

- `version` — pin to `"1"` (string) so resticprofile parses it as v1 config.
- `global:` — process-wide defaults that are not tied to a profile.
- `groups:` — optional named bundles of profiles, run with `resticprofile <group>.<command>`.
- One key per profile (e.g. `default:`). Each profile holds restic command sections.

## global

| Key                           | Purpose                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `prevent-sleep: true`         | Keep macOS awake while a profile runs.                                                     |
| `scheduler: launchd`          | On macOS use launchd (alternatives: `systemd`, `crond`, `taskscheduler`, `crontab:/path`). |
| `priority: low`               | Process priority (`low`, `background`, `normal`, `high`).                                  |
| `restic-stale-lock-age: 2h`   | Auto-clear repo locks older than this.                                                     |
| `restic-lock-retry-after: 1m` | Backoff before retrying a locked repo.                                                     |
| `default-command: snapshots`  | Command used when none is given.                                                           |
| `min-memory: 100`             | Refuse to start below MB of free RAM.                                                      |
| `ionice: true` / `nice: 10`   | Linux-only IO/CPU niceness.                                                                |
| `schedule-defaults:`          | Defaults merged into every profile's `schedule-*` settings.                                |

`schedule-defaults` fields mirror the `schedule-*` keys documented below (`permission`, `lock-wait`, `log`, `priority`, `capture-environment`, `ignore-on-battery`, ...).

## profile sections

A profile has restic-command sections plus a few resticprofile-only keys at the top.

```yaml
default:
  inherit: base # optional: pull from another profile
  description: "primary backup" # shown in `resticprofile profiles`
  repository: "b2:bucket:path" # or `repository-file:` / `repository-command:`
  password-file: /path # any one of password-file, password-command, key-hint
  password-command: "security find-generic-password -a resticprofile -s restic-password -w"
  status-file: /path/status.json
  force-inactive-lock: true
  initialize: false # auto `restic init` when missing

  env: # process env for restic (merged with `run-before` output)
    RESTIC_CACHE_DIR: /tmp/restic-cache

  run-before: ["<cmd>", ...]
  run-after: ["<cmd>", ...]
  run-after-fail: ["<cmd>", ...]
  run-finally: ["<cmd>", ...]

  backup: { ... }
  retention: { ... }
  forget: { ... }
  prune: { ... }
  check: { ... }
  snapshots: { ... }
  copy: { ... }
  restore: { ... }
```

`inherit` is the easiest way to add a second profile (e.g. a "monthly off-site copy") without duplicating credentials. Children override parents key-by-key.

`run-before` / `run-after` hooks can append to `{{ env }}` (a temp file path resticprofile passes through) to inject secrets without leaking them into the YAML — exactly the pattern used here for B2 keys.

## Command sections

Every restic command can have a same-named block. Flags use kebab-case and accept scalars or lists.

### backup

```yaml
backup:
  source: [/path1, /path2]
  source-base: /Users/<you> # prepended to each source if relative
  exclude: ["node_modules", ".cache"]
  exclude-file: /path/to/list
  exclude-caches: true
  exclude-if-present: [".nobackup"]
  iexclude: ["*.tmp"] # case-insensitive
  host: workstation.local
  tag: [daily]
  one-file-system: true
  extended-status: true # populates status.json with counts
  schedule: "*:00" # see schedule grammar below
```

`source` is the only required field. Anything you would normally pass to `restic backup` works as a kebab-case key.

### retention vs forget

- `retention:` is resticprofile sugar that runs `restic forget` with the configured keep-\* rules, scoped to this host and tags. It supports `after-backup: true` to chain after a successful backup.
- `forget:` is the raw `restic forget` flags. Use it when you want a one-off, broader sweep.

Keep keys:

```yaml
retention:
  after-backup: true
  keep-last: 5
  keep-hourly: 24
  keep-daily: 7
  keep-weekly: 4
  keep-monthly: 12
  keep-yearly: 3
  keep-tag: [keep]
  keep-within: "2y"
  prune: false # set true to compact immediately
  host: true # restrict to this host
  tag: [...]
```

### prune / check

```yaml
prune:
  max-repack-size: "2G"
  max-unused: "5%"
  schedule: "Sun 02:30"
  schedule-lock-wait: 30m
  schedule-ignore-on-battery: true

check:
  read-data: false
  read-data-subset: "2.5%" # accepts %, count, or "size:1G"
  with-cache: true
  schedule: "Sun *-*-* 02:00"
```

### snapshots / forget / restore / copy / mount / unlock

These mirror their restic flags. Only `restore` requires positional context — pass `--target` here; the snapshot id is given on the command line.

## Schedule grammar

`schedule:` accepts a single expression or a list. Format is systemd-calendar style; resticprofile translates to launchd/crontab/taskscheduler equivalents.

| Expression          | Meaning                                    |
| ------------------- | ------------------------------------------ |
| `"*:00"`            | Top of every hour                          |
| `"*:0,30"`          | Every 30 minutes                           |
| `"Sun 02:30"`       | Sundays at 02:30                           |
| `"Sun *-*-* 02:00"` | Sundays at 02:00 (explicit date wildcards) |
| `"daily"`           | Once a day at 00:00 (shortcut)             |
| `"*-*-01 03:00"`    | First day of every month at 03:00          |

Schedule modifiers (per command section):

| Key                                        | Effect                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `schedule-permission: user_logged_on`      | Run as user, only when logged in. Alternatives: `user`, `system`. |
| `schedule-lock-wait: 30m`                  | Wait up to this long for the repo lock.                           |
| `schedule-lock-mode: default`              | `default`, `fail`, `ignore`.                                      |
| `schedule-log: /path/log`                  | Redirect command output.                                          |
| `schedule-priority: standard`              | `background`, `standard`.                                         |
| `schedule-ignore-on-battery: true`         | Skip entirely on battery.                                         |
| `schedule-ignore-on-battery-less-than: 20` | Skip when charge is <= N%.                                        |
| `schedule-environment: [ FOO=bar ]`        | Extra env for scheduled run only.                                 |
| `schedule-capture-environment: HOME`       | Carry-over env names from the user session.                       |
| `schedule-after-network-online: true`      | macOS/systemd: wait for network.                                  |

After changing any `schedule*` key, run `resticprofile schedule --all` so launchd picks up the new plist.

## Notifications (send-\*)

resticprofile can ping any HTTP endpoint before/after a command. Used here for healthchecks.io:

```yaml
send-before:
  - url: "https://hc-ping.com/<uuid>/start"
send-after:
  - url: "https://hc-ping.com/<uuid>"
send-after-fail:
  - url: "https://hc-ping.com/<uuid>/fail"
    method: POST
    body: "${ERROR}\n\nCommand: ${ERROR_COMMANDLINE}\nExit Code: ${ERROR_EXIT_CODE}\nStderr: ${ERROR_STDERR}"
    headers:
      - name: X-Source
        value: resticprofile
    body-template: /path/to/tmpl
    skip-tls-verification: false
```

Available variables inside `body` / `body-template`: `${ERROR}`, `${ERROR_COMMANDLINE}`, `${ERROR_EXIT_CODE}`, `${ERROR_STDERR}`, `${PROFILE_NAME}`, `${PROFILE_COMMAND}`, `${HOSTNAME}`.

## Templating and includes

- `{{ env }}` — path to a temp env file that `run-before` can append to. Anything written there is exported to restic and the rest of the run.
- `{{ .Profile.Name }}` / `{{ .Hostname }}` / `{{ .CurrentDir }}` / `{{ .Now }}` — Go template helpers usable anywhere in the file.
- `includes:` at the top level pulls in additional YAML files (glob supported). Useful when secrets-adjacent fragments live elsewhere.

## Editor support

```bash
resticprofile generate --json-schema v2 > ~/.config/resticprofile/schema.json
```

Point VS Code's YAML extension at it via `yaml.schemas` so the file gets autocomplete + validation.

## Things that bite

- YAML booleans: `permission: user_logged_on` not `user logged on`; quote any value containing spaces.
- A `schedule` of `daily` runs at midnight — usually not what you want; prefer an explicit time.
- `retention.host: true` means "this host only". Leaving it off keeps snapshots from other hosts as well.
- `exclude:` is glob-matched against path components, so `node_modules` matches anywhere; `/Users/.../node_modules` would not.
- After renaming or removing a profile, `unschedule` the old name _before_ deleting it, otherwise the launchd plist is orphaned.
