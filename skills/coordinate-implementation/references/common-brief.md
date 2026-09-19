# Template: `<run>/briefs/common.md`

Copy this template to the run folder when absent. Before launching a worker,
replace every angle-bracket placeholder and delete inapplicable bullets. Derive
the values from repository instructions, CI configuration, task runners,
package manifests, and the spec. Do not guess a command or safety rule. Ask the
user when authoritative sources conflict or leave a required choice unresolved.

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

- During implementation, run: <targeted or incremental verification commands>.
- Before committing, run these required final gates exactly:
  1. `<final gate command 1>`
  2. `<final gate command 2>`
- If the repository defines no executable gate, replace this list with:
  > No repository gate was found; verify the ticket manually against its
  > acceptance criteria.

Project-specific safety constraints:

- <commands, services, credentials, data directories, generated files, or
  environments that workers must not touch>
- If there are no additional constraints, replace this list with:
  `No constraints beyond the repository instructions and this brief.`

Git and completion:

- Commit exactly one conventional commit on the current branch, not the
  integration branch. Never push or perform remote writes. Stage only intended
  files.
- When completely finished and the commit exists, print a final line exactly:
  `TICKET DONE <ticket-number>`, followed by a short summary and any acceptance
  checkbox you could not satisfy with the reason.
- If genuinely blocked on a decision only the human can make, print
  `TICKET BLOCKED <ticket-number>: <question>` and stop.
- A reviewer may send follow-up fixes in this session. Amend the single commit,
  rerun the required gates, then print `FIXES DONE <ticket-number>`.
```
