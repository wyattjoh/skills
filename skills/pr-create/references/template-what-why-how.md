# What/Why/How fallback template

Use this when no PR template is present in the repo.

```markdown
## What

- <concrete change 1>
- <concrete change 2>

## Why

<one-paragraph motivation grounded in commits / branch name / existing
context>

## How

<only include for non-trivial changes -- see rules below>
```

## Adaptive length rules

### What (always included)

- Bullet list, not prose.
- Each bullet describes a concrete change, not a commit. Collapse related
  commits into a single bullet (e.g., three `refactor(auth):` commits become
  one bullet: "extracted token validation into its own module").
- Target 3-7 bullets. More than that usually means the PR is too large.

### Why (always included)

- One paragraph. Two if the motivation has a before-state and an after-state
  worth contrasting.
- Pull from commit message bodies first. Fall back to the branch name when
  bodies are sparse (a branch named `fix/session-timeout-regression` tells
  you the why is a regression fix).
- Never fabricate. If you cannot ground the "why" in any available signal,
  write `TBD` and flag it to the user during plan review.

### How (conditional)

Include only when the change is non-obvious. Examples:

- Architectural shift (splitting a monolith module, introducing a new layer).
- Non-trivial refactor that restructures control flow.
- Performance-motivated change where the approach matters more than the
  outcome.
- Workaround for an external bug (link the upstream issue).

Skip when:

- Docs-only change.
- Dependency bump.
- Config / settings / env tweak.
- Small fix where the diff speaks for itself.
- Test additions with no source changes.

A good heuristic: if you cannot write two useful sentences for How, omit it.

## Examples

### Trivial (skip How)

```markdown
## What

- Bump `@types/node` from 20.12.7 to 20.14.0.

## Why

Aligns with the version used by the monorepo's shared tsconfig; fixes a
type-mismatch warning in `scripts/build.ts`.
```

### Non-trivial (include How)

```markdown
## What

- Replace the single `UserService.authenticate()` method with a two-phase
  flow: `prepareChallenge()` then `verifyResponse()`.
- Move challenge state from in-memory to Redis with a 5-minute TTL.
- Add `X-Auth-Request-Id` header plumbing through the middleware.

## Why

Single-phase authentication assumed the request handler lived in the same
process as the challenge issuer. Moving to a load-balanced deployment
requires passing the challenge out-of-band and letting any worker verify it.

## How

`prepareChallenge()` writes a signed nonce to Redis keyed by
`auth:challenge:<request-id>`, then returns the challenge payload to the
client. `verifyResponse()` reads the nonce back, verifies the signature, and
deletes the key. The two-phase split is intentional so clients can retry the
second call without re-issuing a challenge.

The middleware change ensures the request ID propagates through downstream
services so we can trace failures across the hop.
```

## Anti-patterns

- **Do not list file paths in What.** Reviewers see the file tree already.
- **Do not restate commit message bodies verbatim** -- synthesize.
- **Do not include metrics like "N commits, M files changed"** -- these go
  stale and the diff shows them.
- **Do not leave `TODO` in the body** after confirmation. If a section has
  nothing to say, either remove it (for How) or write a short honest note
  ("No behavior change", "No new dependencies") and move on.
- **Do not use em-dashes (`--`) in the rendered body** (per the user's global
  `CLAUDE.md`). Use commas, parentheses, or separate sentences.
