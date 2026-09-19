# Template: `<run>/briefs/common.md`

Copy this template to the run folder when absent. Before launching a worker,
replace every angle-bracket placeholder and delete inapplicable bullets. Derive
the values from repository instructions and CI configuration, using task runners
or package manifests only when those authoritative sources name them. Do not
guess a command or safety rule from the detected toolchain. Ask the user when
authoritative sources conflict or leave a required choice unresolved. Persist
the same sources, exact gate argv arrays, and resolved safety constraints with
`review.policy.prepare` before launching a worker.

```markdown
# Implementation brief (shared)

You are implementing one ticket from the "<spec name>" spec in the
<repository> repository. You are working inside a dedicated git worktree on a
feature branch. The integration checkout is <base checkout path>; do not edit
it directly.

Repository context:

- Read <repository instruction files> before changing code.
- Read <architecture, domain, ADR, or API contract documents relevant to this
  run>.
- Follow the existing code, naming, import, and test patterns near the files
  you change.

Implementation rules:

- Read the run spec and your ticket before editing.
- Use test-first development when required by repository instructions or when a
  useful test seam exists.
- Keep the change within the ticket's acceptance criteria. Report scope that
  belongs to another ticket instead of silently expanding the change.
- Update <documentation or generated artifacts that repository instructions
  require to stay synchronized>.

Verification:

- Gate sources: <repository instruction and CI paths that authorize the commands>.
- During implementation, run: <targeted or incremental verification commands>.
- Before committing, run these required final gates exactly:
  1. `<final gate argv 1 rendered for humans>`
  2. `<final gate argv 2 rendered for humans>`
- If the repository defines no executable gate, replace this list with:
  > No executable repository gate is defined by the listed instructions or CI;
  > verify the ticket manually against its acceptance criteria.
- A Claude implementor completes Matt's `implement` self-review before handing
  off. A Pi implementor completes `## Standards` and `## Spec` in this same
  session; do not require a subagent extension.

Project-specific safety constraints:

- <commands, services, credentials, data directories, generated files, or
  environments that workers must not touch>
- If there are no additional constraints, replace this list with:
  `No constraints beyond the repository instructions and this brief.`

Git and completion:

- Follow the resolved repository commit policy: <commit shape and fix-round
  behavior from the persisted Repository policy record>. When repository
  instructions are silent, multiple commits are allowed and fix rounds append
  commits.
- Commit on the current branch, not the integration branch. Never push or
  perform remote writes unless the repository policy and persisted tracker
  writeback mode explicitly authorize that exact action. Stage only intended
  files.
- When completely finished and the required commits exist, print a final line
  exactly: `TICKET DONE <ticket-number>`, followed by a short summary and any
  acceptance checkbox you could not satisfy with the reason.
- If genuinely blocked on a decision only the human can make, print
  `TICKET BLOCKED <ticket-number>: <question>` and stop.
- A reviewer may send one consolidated follow-up request containing every
  actionable Standards and Spec finding. Apply the recorded fix-commit policy,
  rerun all required gates and this harness's self-review, then print
  `FIXES DONE <ticket-number>`.
```
