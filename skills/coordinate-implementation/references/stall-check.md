# Stall check

Schedule with `CronCreate`, cron `5-59/10 * * * *`, recurring, prompt below
with `<slug>` filled in. Re-create it on every start, resume, and handoff;
delete it at handoff and when the run finishes.

`<slug>` is the only substitution. No preference value is ever written into
this prompt: the cron fires for hours and the record can change under it, so
everything else is read from RESUME.md at fire time.

> Stall check for the <slug> implementation run. For every active worker pane
> in the ticket table at .scratch/<slug>/RESUME.md: read
> `herdr pane read <pane> --lines 25 --source recent` and compare the visible
> activity line and the 🧠 token figure with what you saw at the previous stall
> check. A worker is stalled if its agent_status is `working` but the token
> figure and last activity line have not changed across two consecutive stall
> checks, or if the tail shows an API/network error, a permission prompt, or a
> question waiting on input. For a stalled worker: if it is waiting on a prompt
> or hit a transient error, re-prompt the same session with
> `herdr agent prompt <pane> "..."` to continue; if it is genuinely crashed or
> looping, apply the crash-restart rule from the coordinate-implementation
> skill, relaunching with the record bound in that ticket's own table row and
> never with a substituted model or effort. Confirm the background monitor is
> still armed on the current pane id and re-arm with
> `herdr agent wait <pane> --until idle --until done --until blocked` if not.
> Report in one line if nothing is stalled.
