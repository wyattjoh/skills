# Triage Examples

Worked examples of how to classify review comments and draft replies. Each
example shows the reviewer's comment, the verification work, the bucket, and (if
the bucket is not `FIX` or `SKIP`) the draft reply.

## Example 1: FIX

**Reviewer on `src/parser.ts:42`:**

> `parseInt` without a radix is bug-prone. Pass `10`.

**Verification:**

- Read `src/parser.ts:42`, confirmed `parseInt(raw)` with no radix.
- Grepped for `parseInt(`, found 3 other call sites, all with radix. This one is
  the outlier.
- No eslint rule enforces it currently.

**Bucket:** `FIX`. No reply (action > words). Edit adds `, 10`.

## Example 2: FIX-MODIFIED

**Reviewer on `api/users.ts:88`:**

> Wrap this in a try/catch and return 500 on failure.

**Verification:**

- The handler is mounted behind a project-wide error middleware
  (`middleware/errors.ts:14`) that already converts thrown errors to 500s with
  structured logging.
- A local try/catch would either duplicate that logic or swallow the error
  before the middleware runs.

**Bucket:** `FIX-MODIFIED`. Fix: add an explicit `throw new HttpError(500, ...)`
at the failure branch so the existing middleware formats it.

**Draft reply:**

> Our `middleware/errors.ts` already maps thrown errors to 500 with structured
> logging, so a local try/catch would bypass it. Instead, I made the failure
> branch throw `HttpError(500, "user lookup failed")` so the middleware handles
> it consistently. Let me know if you want the inline catch anyway.

## Example 3: PUSHBACK (YAGNI)

**Reviewer on `metrics/export.ts`:**

> This endpoint should support date filtering, pagination, and CSV export.

**Verification:**

- Grepped the repo for `/metrics/export` and the function name. Exactly one
  caller: an internal ops script that dumps everything once a week.
- No issue or roadmap doc mentions additional consumers.

**Bucket:** `PUSHBACK`.

**Draft reply:**

> The only caller is `scripts/weekly-ops-dump.ts`, which reads the full payload
> and does its own filtering downstream. Adding date filters, pagination, and
> CSV export would be dead code under current usage (YAGNI). Happy to add them
> if there is a consumer I missed, is there one you have in mind?

## Example 4: PUSHBACK (breaks existing behavior)

**Reviewer on `auth/session.ts:120`:**

> Remove the legacy token fallback, it's been deprecated for months.

**Verification:**

- Checked `CHANGELOG.md`: deprecation announced 2026-02, removal targeted for
  next major.
- Grepped production logs via the observability dashboard: legacy tokens still
  account for 4% of requests in the last 7 days.
- Current branch is a patch release, not the next major.

**Bucket:** `PUSHBACK`.

**Draft reply:**

> Legacy tokens still account for ~4% of requests in the last 7 days (per the
> auth dashboard), and removal is scheduled for the next major per CHANGELOG.md.
> This branch is a patch release. Keeping the fallback here and proposing
> removal in the major bump, does that work?

## Example 5: CLARIFY

**Reviewer on `db/schema.sql:55`:**

> This should probably be indexed.

**Verification:**

- The column is `user_id`, already covered by a composite index
  `(user_id, created_at)` at line 72.
- The comment could mean "needs a dedicated index on `user_id` alone" or "I
  didn't see the composite index, sorry".

**Bucket:** `CLARIFY`.

**Draft reply:**

> There's a composite index on `(user_id, created_at)` at line 72 which should
> cover `user_id` lookups. Were you asking for a standalone index on `user_id`,
> or did the composite one not show up on your side?

## Example 6: SKIP

**Reviewer:**

> LGTM, nice work!

**Bucket:** `SKIP`. No action, no reply.

## Patterns

| Signal                                                           | Likely bucket      |
| ---------------------------------------------------------------- | ------------------ |
| Reviewer's claim contradicts a grep result                       | `PUSHBACK`         |
| Reviewer asks for a feature with zero callers                    | `PUSHBACK` (YAGNI) |
| Reviewer correct but fix is wrong for local patterns             | `FIX-MODIFIED`     |
| Reviewer's meaning is one of two plausible reads                 | `CLARIFY`          |
| Thread is on a line deleted in a later commit on the same branch | `SKIP`             |
| LGTM / thanks / emoji-only                                       | `SKIP`             |

## CI Examples

CI failures use a separate bucket vocabulary (`CI-FIX`, `CI-FLAKE`, `CI-INFRA`,
`CI-SKIP`). They never produce a GitHub reply because there is no thread; the
fix speaks through the diff and the next push re-runs CI. See
`references/ci-checks.md` for fetch and bucketing details.

### Example 7: CI-FIX (compile error from this branch)

**Failed check:** `build / typecheck` (workflow: `CI`), conclusion `failure`.

**Log slice (last lines of `gh run view <runId> --log-failed`):**

```
api/users.ts(88,15): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
  Type 'undefined' is not assignable to type 'string'.
```

**Verification:**

- Read `api/users.ts:88`. The new `findById(req.query.id)` call was added on
  this branch in commit `a1b2c3d`.
- `req.query.id` is typed `string | undefined` because the route allows it to be
  omitted.
- No earlier commit on this branch referenced this line.

**Bucket:** `CI-FIX`. Plan:
`api/users.ts:88 - guard with !id check, return 400 before calling findById`.

### Example 8: CI-FLAKE (network blip in unrelated test)

**Failed check:** `e2e / payments-suite`, conclusion `failure`.

**Log slice:**

```
✖ checkout flow › applies coupon code (12.4s)
  Error: connect ETIMEDOUT 10.0.0.42:443
    at TLSSocket._handleConnectError (...)
  Attempt 1 of 3 failed, retrying...
  Attempt 2 of 3 failed, retrying...
  Attempt 3 of 3 failed.
```

**Verification:**

- The diff on this branch touches `auth/session.ts` only; no payments code.
- The error is a TLS connect timeout to an internal staging service, retried by
  the test harness three times.
- A different `runId` for the same `headSha` is green for this same job (visible
  via `gh run list --branch <head>`).

**Bucket:** `CI-FLAKE`. Plan: no code change; will pass on re-run after the
user's next push.

### Example 9: CI-INFRA (missing secret)

**Failed check:** `deploy-preview / vercel`, conclusion `action_required`.

**Description (no Actions log to fetch, third-party check):**

> Deployment requires VERCEL_TOKEN. Add it under Settings → Secrets.

**Verification:**

- The `link` URL points at vercel.com, not `github.com/.../actions/runs/...`, so
  there is no run ID to pull a `--log-failed` slice for.
- The description is the source of truth; missing repo secret is an environment
  issue.

**Bucket:** `CI-INFRA`. Plan: no code change; surface to user with the action
required (add `VERCEL_TOKEN`).

### Example 10: CI-SKIP (already addressed in a later commit)

**Failed check:** `lint / eslint`, conclusion `failure`, completed 12 minutes
ago.

**Log slice:**

```
src/utils/format.ts:14:1  error  Missing return type on function  @typescript-eslint/explicit-function-return-type
```

**Verification:**

- Read `src/utils/format.ts:14` in `HEAD`. Function now has an explicit return
  type.
- `git log --oneline <baseRef>..HEAD` shows
  `e4f5g6h fix(format): add return type` after the failing run.

**Bucket:** `CI-SKIP`. Plan: already addressed in `e4f5g6h`; the next push will
turn this check green.
