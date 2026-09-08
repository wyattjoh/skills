# Standing loop

Schedule with `CronCreate`, recurring, on an off-minute ten-minute cadence
(for example `4-59/10 * * * *`), prompt below with `<folder>`, the run
prefixes, session names, and RESUME paths filled in from your RESUME.md.
Session-only: recreate on every start, resume, and handoff; delete it when
switching to the wind-down loop in [pause.md](pause.md).

> Core coordinator progress and health check. 1) `herdr pane list`; for each
> run coordinator pane (labels `coordinator <prefix>`; trust labels over ids)
> run `herdr pane read <pane> --lines 40 --source recent` and judge health:
> stalled if agent_status is `working` but the tail and 🧠 figure are
> unchanged since the previous tick, or the tail shows API/network errors, a
> permission prompt, or a question waiting on input; unhealthy if the pane is
> gone or its RESUME.md has not moved while its worker landed. A network error
> visible on every coordinator at once is an outage, not a stall: wait one
> tick. For a stalled coordinator send one
> `herdr agent prompt <pane> "Continue your coordinate-implementation loop from RESUME.md."`;
> if it is gone, tell the user rather than relaunching. 2) Read every run's
> RESUME.md and your own, and act on any cross-session messages. 3) Duties:
> hold the merge order recorded in RESUME.md; when a run reaches `main` tell
> the others to merge `main` into their base and collect the shas; keep the
> recorded owner as the only editor of each shared file; fix drift in
> `.scratch/coordinators.md`; compare each active ticket's
> `git diff --stat <base>..HEAD` against the other runs and warn affected
> coordinators before they land; relay any blocked user-run steps to the user.
> Never push, touch remotes, write GitHub issues, delete branches, remove
> worktrees, run built binaries, implement, or review tickets. 4) Read your
> own 🧠 figure from `herdr pane read $HERDR_PANE_ID --lines 6`; above
> 200,000 tokens follow the handoff section of the core-coordinator skill.
> Report in three lines or fewer when nothing changed.

Per tick, one shell call is enough: pane list, coordinator tails, own context
figure, `git worktree list` filtered to ticket prefixes, base heads, and a
`git status --short` plus `git log --oneline <base>..HEAD` in each ticket
worktree. Append a dated one-line status to RESUME.md only when something
changed.
