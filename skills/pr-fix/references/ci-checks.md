# CI Checks Reference for pr-fix

Exact commands and rules for fetching failing CI checks, pulling failure logs,
and bucketing each `conclusion` value.

## Fetch Checks for the PR

```bash
gh pr checks <n> --json name,status,conclusion,workflow,link,description,startedAt,completedAt
```

Field meanings:

| Field                       | Use                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`                      | Job name (sometimes `workflow / job` for workflows with multiple jobs)                                     |
| `status`                    | `queued`, `in_progress`, `completed`                                                                       |
| `conclusion`                | `success`, `failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure`, `neutral`, `skipped` |
| `workflow`                  | Workflow file name (e.g. `CI`, `Deploy`)                                                                   |
| `link`                      | Browser URL for the check; for GitHub Actions checks this is also where the run ID can be parsed           |
| `description`               | Short status summary; often contains the proximate reason for non-Actions checks (Vercel, etc.)            |
| `startedAt` / `completedAt` | Timestamps; useful for cross-referencing whether the failure predates a later commit on the branch         |

## Filter for Triage

Keep checks that match **all** of these:

- `status == "completed"`
- `conclusion` is one of: `failure`, `cancelled`, `timed_out`,
  `action_required`, `startup_failure`

`success`, `neutral`, and `skipped` are not failures. Anything still `queued` or
`in_progress` is not actionable yet, but its count is reported in the Phase 9
terminal summary so the user knows triage was incomplete.

## Parse the Workflow Run ID

GitHub Actions check links follow this shape:

```
https://github.com/<owner>/<repo>/actions/runs/<runId>/job/<jobId>
```

Extract `<runId>` (the segment after `/runs/`) for log fetching. If the URL does
not match this shape (third-party check like Vercel, Netlify, Codecov), there is
no run ID; skip the log fetch and rely on `description` to bucket.

## Pull the Failure Log

```bash
gh run view <runId> --log-failed | tail -n 200
```

Why `tail -n 200`: the failed-log slice for a long workflow can be tens of
thousands of lines, but the actionable signal is almost always near the end (the
failing assertion or error). 200 lines is enough to capture context and short
enough to keep in working memory. If the first scan lands on noise (e.g. a
verbose teardown), increase the slice (`tail -n 500`) before giving up.

If `gh run view` returns 404 (run was deleted or restarted), classify the check
as `CI-INFRA` with reason "log unavailable" and surface it in the terminal
summary.

## Bucketing Heuristics

The user's choice was "everything not green is in scope," so all of the
conclusions below enter triage. The bucket is decided by the log + code
investigation in Phase 2b, not the `conclusion` value alone, but each conclusion
has a default leaning:

| Conclusion        | Default leaning                                                               | Rationale                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failure`         | `CI-FIX`                                                                      | Code is broken; the log usually points at the failing line. Override to `CI-FLAKE` only if there is concrete evidence of flakiness (random network, retried test, timing-dependent assertion). |
| `timed_out`       | `CI-FIX` if a slow-loop / infinite-await is in the diff, otherwise `CI-FLAKE` | Distinguish "we made it slow" from "the runner was overloaded" by checking whether the timeout scope crosses code added on this branch.                                                        |
| `cancelled`       | `CI-SKIP`                                                                     | Most often auto-cancelled by a subsequent push or by the user. Only escalate to `CI-INFRA` if the cancellation came from a runner crash (visible in the log preamble).                         |
| `action_required` | `CI-INFRA`                                                                    | Manual approval gate (deploy environment, third-party permission). Not a code fix; surface for user to handle.                                                                                 |
| `startup_failure` | `CI-INFRA`                                                                    | Runner crashed before workflow steps ran. No code change available.                                                                                                                            |

Override the default leaning when the log evidence is unambiguous.

### Flake signals worth recognizing

The following patterns argue for `CI-FLAKE` even on a `failure` conclusion:

- A test that retried and only the final attempt failed (look for
  `Attempt 2 failed`, `Retry 1/3`, etc.)
- Network errors hitting external services (`ECONNRESET`, `ETIMEDOUT`, `503`
  from a third-party API)
- Single-test failure in a suite that passes deterministically locally and on
  adjacent runs
- The same job is green on a different `runId` for the same `headSha`

If the evidence is one log line with no corroboration, prefer `CI-FIX` (assume
real until shown flaky). Misclassifying a flake as a fix wastes investigation
time but doesn't ship bad code; misclassifying a real failure as a flake ships
bad code.

### Already-addressed signal

`git log --oneline <baseRef>..HEAD` and grep the failing line. If a later commit
on the branch removes the offending code, classify as `CI-SKIP` with reason
`"already addressed in <sha>"`. The next push to PR re-runs CI and the check
turns green.

## Bot CI Commenters

Some CI services post comments on the PR (Vercel, Codecov, Netlify previews) in
addition to writing check runs. Phase 1 of pr-fix already filters those comments
via `user.type == "Bot"`, so they do not enter the comment triage. Their
corresponding **check runs** still come through this file's fetch path and are
bucketed normally.

## Why No GitHub Reply for CI

CI failures do not have a thread, a commenter, or a resolution endpoint. The fix
speaks through the diff, and the next push re-runs the check. There is no
`resolveReviewThread` analog for status checks: the green check IS the
resolution.

## Local Verification (Phase 5)

Phase 5 of the skill verifies every applied `CI-FIX` edit locally before any
GitHub state changes. The strategy is **lightweight first, `act` as fallback**:
native commands reproduce most failures in seconds, and `act` catches the
remaining environment-sensitive ones at the cost of a Docker spin-up.

### Native command mapping

For each failing job name, infer the verification command:

| Failing job pattern                    | Likely native command                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `*typecheck*`, `*tsc*`, `*type-check*` | `tsc --noEmit`, `bun run check`, or the project's `typecheck` script                                                                  |
| `*lint*`, `*eslint*`, `*format*`       | The project's `lint` script (`npm run lint`, `bun run lint`, `pnpm run lint`)                                                         |
| `*test*`, `*spec*`, `*unit*`           | The project's test runner, scoped to the failing test if known (`bun test path/to/file`, `bun test -t '<name>'`, `vitest run <path>`) |
| `*build*`, `*compile*`                 | The project's `build` script                                                                                                          |
| `*e2e*`, `*integration*`               | Often unmappable to a quick native command; consider `act` or skip if the job needs external services                                 |

Inspect `package.json` `scripts`, `deno.json` `tasks`, and `Makefile` targets to
find the actual invocation. If multiple candidates fit, prefer the one whose
name matches the failing job most closely.

### `act` fallback

When no native command maps cleanly (e.g., a custom workflow step that runs a
shell pipeline directly):

```bash
act -W .github/workflows/<workflow>.yml -j <job-name> --reuse \
  --container-architecture linux/amd64 \
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest
```

Notes:

- `--reuse` keeps the container alive across multiple `CI-FIX` items in the same
  pr-fix run, dropping per-item startup cost from ~30s to ~2s.
- `--container-architecture linux/amd64` is required on Apple Silicon hosts to
  match GitHub-hosted runner behavior; without it, some toolchains emit
  arch-specific errors that don't reproduce in CI.
- `ghcr.io/catthehacker/ubuntu:act-latest` is the recommended image: it ships
  enough of the GitHub Actions runner to handle most workflows. The full
  `act-full` image is closer to GitHub's environment but is ~17 GB.
- First-time runs pull the image (~500 MB for `act-latest`); subsequent runs
  reuse it.

### Secrets

If a workflow needs secrets (`${{ secrets.* }}`), inject them with `op run` so
they don't land on disk:

```bash
op run --env-file=.env.tpl -- act -W .github/workflows/<workflow>.yml \
  -j <job-name> --reuse --secret-file <(env | grep '^GITHUB_\|^NPM_')
```

The `--secret-file` flag accepts a `KEY=VALUE` file (or process substitution
that produces one). Most CI failures don't need secrets; bother with this only
if the failing step explicitly references a secret.

### Unrunnable checks

Some checks have no local equivalent. Skip with a recorded reason:

| Check type                                   | Reason                                                              |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Vercel / Netlify deploy previews             | Cloud build, no replayable workflow file                            |
| `action_required` approval gates             | Requires human-on-GitHub action; no code fix applicable             |
| Self-hosted runner jobs                      | Runner labels (`self-hosted`, `gpu`, etc.) won't match local Docker |
| Third-party check runs (Codecov, SonarCloud) | Run on the third party's infrastructure                             |

These should already be classified `CI-INFRA` or `CI-SKIP` in Phase 2b, so they
don't reach Phase 5 as `CI-FIX`. If one does, the verification step records a
skip with reason `not act-compatible` and proceeds.

### Tool availability

Phase 5 distinguishes **failed** (ran the check, fix didn't hold) from
**unverified** (couldn't run the check):

- **`act` not installed**: record `unverified (act not installed)`, suggest
  `brew install act` in the Phase 9 summary, do not block.
- **Docker daemon not running**: record `unverified (docker unavailable)`,
  suggest starting Docker Desktop, do not block.
- **Native script missing**: record `unverified (no native command)`, do not
  block.

Failed verifications block Phase 6/7/8 (no replies, no resolves, no commit).
Unverified verifications proceed but flag the gap in the summary so the user
knows what wasn't proven locally.
