# Retro

Read this when a `settled` event carries `retro="due"`, or when you end a delegate right after `verify --problem`.

## When one is due

A `settled` event with `retro="due"` says why in `reason`: `problem` (a problem verdict newer than the session's last retro), `resumes` (two or more), or `every-5th` (the domain's fifth, tenth, ... settled delegate session). It also names the `session`; a re-retro after a later problem verdict adds `since-turn`, the turn of the last retro, so the retro covers only the turns after it. The CLI decides and keeps the markers: each session gets one routine retro at most, and only a newer problem verdict fires again. The decision is made when the settled event is built, so a `--problem` verdict shows on that session's next settle; for a delegate you end right after `verify --problem`, launch the retro yourself with the same command.

## Launch

After you verify the delegate, launch the retro as a read-only delegate filed under the item:

```sh
coordinate delegate retro-<name> --task "retro <name>" --no-space --cwd "$(coordinate wiki path)" --skill retro --args "session <session> cwd <its cwd>[ since-turn <n>]" --brief <brief> --item <id>
```

It counts against the budget like any delegate. Its brief and REPORT.md sit under the wiki's ignored `.scratch/retro-<name>/`; it files each candidate with `coordinate finding add "<title>" --kind opportunity --source retro:<name> --detail-md "<detail>"` and never edits the wiki.

## When it settles

Verify it, write a `type: retro` page ([wiki.md](wiki.md)) carrying the report's substance, with `delegate:retro-<name>` and `session:<session>` in `sources` (the report stays in the ignored `.scratch/`, so never cite its path), `wiki commit`, and end it. The candidates wait for the user as findings.
