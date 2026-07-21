# Hung Backup Watchdog

A standalone watchdog that kills hung `restic` / `resticprofile` backup runs so a
single stuck run cannot block the hourly schedule for hours or days.

## Why it exists

macOS FileProvider (the iCloud "Desktop & Documents Folders" sync) can deadlock
the kernel when restic calls `read()` on a cloud-materialized (online-only) file:
the FileProvider bridge holds a lock while issuing a synchronous read, then needs
to call back into the same process to materialize the file. The kernel returns
`EDEADLK` ("resource deadlock avoided", errno 35) and, in the worst case, the
`read()` blocks indefinitely.

Two consequences:

- The error shows up in `backup.log` as `failed to save <path>: ... resource deadlock avoided`, and the run exits with code 3 (logged as ERROR even though a snapshot may still be written).
- If the read blocks forever, the whole `restic backup` hangs. Because launchd will not start a new instance of a job while the previous one is still alive, **every subsequent hourly run is silently skipped** until the hung process dies. The hung run also holds the repository lock.

restic cannot rescue itself here: `--stuck-request-timeout` (default 5m, set to
`2m` in `profiles.yaml`) only covers stuck B2 backend/network requests. Go cannot
cancel a thread parked in a blocking local `read()` syscall, so an external
watchdog is the only reliable fix. Corollary: because B2 stalls already auto-retry
at the `stuck-request-timeout`, any multi-hour hang is almost certainly a blocked
local read, not the network.

## Files

- Script: `~/.config/resticprofile/watchdog.sh`
- launchd agent: `~/Library/LaunchAgents/local.resticprofile.watchdog.plist` (label `local.resticprofile.watchdog`)
- Kill log: `~/.config/resticprofile/logs/watchdog.log`
- Agent stderr: `~/.config/resticprofile/logs/watchdog.err.log`

## Behavior

- Runs every 20 minutes (`StartInterval` 1200) and once at load (`RunAtLoad`).
- Finds backup processes via `pgrep -x restic` and `pgrep -f 'resticprofile.*run-schedule'`.
- Reads each process's age with `ps -o etime=` (the macOS keyword is `etime`, NOT the Linux `etimes`), parses the `[[dd-]hh:]mm:ss` format to seconds, and `kill -9`s any process older than `THRESHOLD`.
- `THRESHOLD` defaults to 7200s (2h); override per-run with the `WATCHDOG_THRESHOLD` env var (used by tests).
- Logs each kill to `watchdog.log`. A no-op run writes nothing.

Self-healing: after a kill, the next hourly run clears the stale lock on its own
because `profiles.yaml` sets `restic-stale-lock-age: 2h` and `force-inactive-lock: true`.
No manual `unlock` is needed.

## Managing the agent

This agent is NOT created by `resticprofile schedule`, so `resticprofile unschedule --all`
will not touch it. Manage it directly with launchctl:

```bash
# Load (idempotent: bootout first if already loaded)
launchctl bootout    gui/$(id -u)/local.resticprofile.watchdog 2>/dev/null || true
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/local.resticprofile.watchdog.plist

# Verify it is loaded
launchctl list | grep resticprofile.watchdog

# Unload / remove
launchctl bootout    gui/$(id -u)/local.resticprofile.watchdog
```

Editing `watchdog.sh` needs no reload: launchd re-execs the script each interval,
so changes take effect on the next run. Only changes to the `.plist` itself
require a bootout + bootstrap cycle.

## Changing the threshold

Edit `THRESHOLD` in `watchdog.sh` (no reload needed). Reference points: hourly runs
normally finish in ~2 minutes; a multi-day catch-up run took ~18 minutes. 2h is
~6x the worst observed real run, so legitimate runs are never at risk.

## Testing

`pgrep -x restic` and `ps -o etime=` are the load-bearing primitives. The sandbox
may SIGKILL a copied binary renamed `restic` and hide backgrounded copies from
`pgrep`, so do not test by faking a process named `restic`. Instead verify the
two primitives plus the parse/kill/log path against a plain `/bin/sleep` with a
temporary copy of the script that matches `sleep` and a low `WATCHDOG_THRESHOLD`.

## Root-cause prevention (beyond the watchdog)

The watchdog is a safety net, not a cure. To stop the deadlock from happening:

- Turn off iCloud "Optimize Mac Storage" (System Settings → Apple ID → iCloud) so files under `~/Documents` stay materialized locally and restic never triggers a download-on-read. This is a System Settings toggle, not a resticprofile change.
- Or exclude the cloud-synced path from `default.backup.source` / add it to `exclude` (accepting that iCloud, not restic, then holds those files).

Also worth keeping healthy: the healthchecks.io check should have a period/grace
configured so a run that pings `/start` but never completes raises an alert. A
silent hang that never sends a fail ping will otherwise go unnoticed until the
next manual status check.
