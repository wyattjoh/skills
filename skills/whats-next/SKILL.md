---
name: whats-next
description: Reads the state of a wayfinder map and emits the copy-ready prompt for the next agent session on the route from foggy idea to shipped code. Triggers on "what's next", "what prompt do I give the next agent", "next step on the map", "I've cleared the map, now what", "which ticket now".
argument-hint: "[map-path-or-url]"
disable-model-invocation: true
---

# What's Next

Works out where you are on the **wayfinder → ship** route, then emits the exact
prompt to paste into the next agent session. The route spans several sessions by
design, so the hard part isn't the work, it's knowing which prompt starts the
next window and whether that window should be fresh.

**You emit a prompt. You do not run it.** Every stage transition here assumes a
context boundary; running the prompt yourself in this window destroys the thing
the route is protecting. Finish by printing the prompt and stop.

## Process

### 1. Locate the map

In order, stop at the first that hits:

1. `$ARGUMENTS`, if the user passed a path, URL, or effort slug.
2. `docs/agents/issue-tracker.md` — read the **Wayfinding operations** section to
   learn how _this_ repo expresses maps, tickets, blocking, and the frontier.
   Everything below assumes you have done this. If it's missing, tell the user to
   run `/setup-matt-pocock-skills` and default to the local-markdown tracker.
3. The tracker itself: `.scratch/*/map.md` locally, or
   `gh issue list --label wayfinder:map --state open` on GitHub.

If more than one map is live, list them by **name** (their titles, never bare
ids) and ask which. If none exists, that's Stage 0 — skip to the picker.

### 2. Read the state

Read the map body once: **Destination**, **Notes**, **Decisions so far**,
**Not yet specified**, **Out of scope**. Then get the ticket counts and the
frontier — open, unblocked, unclaimed — using the tracker's own query.

Read the map's low-res view, not every ticket body. You are deciding a stage,
not resolving anything.

**Distinguishing ticket kinds on a local tracker:** both wayfinder decision
tickets and `/to-tickets` implementation slices live under
`.scratch/<effort>/issues/`. A wayfinder ticket carries a `Type:` line
(`research`/`prototype`/`grilling`/`task`); an implementation slice doesn't.
Confirm by reading rather than trusting the count.

### 3. Confirm the stage

Derive the stage from the signals below, then present it with `AskUserQuestion`
with the derived stage first and marked `(detected)`. The state can lie — a map
can read as cleared while the user knows a decision is still soft — so the pick
is always theirs.

| Signal                                | Stage                      |
| ------------------------------------- | -------------------------- |
| No map, loose idea                    | **0 — Chart or skip**      |
| Map open, decision tickets remain     | **1 — Work the map**       |
| All decision tickets closed, no spec  | **2 — Collapse to a spec** |
| Spec exists, no implementation slices | **3 — Slice the spec**     |
| Slices exist, some open               | **4 — Build a slice**      |
| All slices closed                     | **5 — Close out**          |

When only _part_ of the map has cleared, that's Stage 2 scoped to a region —
offer it alongside Stage 1 rather than instead of it. You don't have to clear
the whole map before building.

If the user is blocked rather than between stages, read
[references/detours.md](references/detours.md) and emit a detour prompt instead.

### 4. Emit the prompt

Print the matching template as a fenced block with every placeholder replaced by
real values read from the map. Under it, one line of context hygiene: whether
the next session is **fresh**, **the same window**, or **this window**. Nothing
else — no summary of the map, no offer to run it.

## Stage prompts

### Stage 0 — Chart or skip

First settle whether a map is warranted at all. Wayfinder is for an effort too
big for one session and wrapped in fog; a well-scoped feature should go straight
to `/grill-with-docs`. If the idea is clearly the latter, say so and emit that
instead.

```
/wayfinder

<the loose idea, 2-4 sentences: what you want, why now, and what you
already know is uncertain about it>
```

→ **Fresh session.** Charting is one session's work and resolves nothing; expect
it to stop after the map and its first tickets exist.

### Stage 1 — Work the map

```
/wayfinder <MAP>
```

Name a ticket only when the user wants that one rather than the frontier's first:

```
/wayfinder <MAP>

Work the ticket "<TICKET-NAME>".
```

→ **Fresh session per ticket.** One ticket per session, research tickets
excepted. The session claims it before doing any work, so don't run two against
the same ticket.

### Stage 2 — Collapse to a spec

The load-bearing step. `/to-spec` doesn't interview — it synthesizes from
context — so a blank window specs from nothing. The preamble is what loads the
map's decisions as primary source.

```
Read the wayfinder map <MAP>. Then read the full body and resolution comment
of every ticket linked from its "Decisions so far" section — the map only
holds one-line gists, the tickets hold the actual decisions. Also follow any
linked assets (prototype branches, research files). Check "Out of scope" so
you know what not to spec.

Then run /to-spec for <DESTINATION>.
```

Scoped to a region, replace the last line with:

```
Then run /to-spec for just <REGION>: the decisions covering <A, B, C>.
Everything else on the map is out of scope for this spec — we'll spec the
rest separately.
```

Name the region by the **decisions it rests on**, not by a feature label. That's
what keeps the collapse honest while the rest of the map is still foggy.

→ **Fresh session**, and keep it open — Stage 3 runs in the same window. Expect
`/to-spec` to stop and check the test seams with you before it writes.

### Stage 3 — Slice the spec

```
/to-tickets
```

→ **Same window as Stage 2.** No clear, no compact. The slices need the spec's
thinking alive; that's the whole reason these two steps share a context.

Only if that window is already gone:

```
Read the spec at <SPEC>. Then run /to-tickets for it.
```

Flag this as the worse path — it recovers the spec but not the reasoning behind
it, so the slices come out coarser.

### Stage 4 — Build a slice

```
/implement <TICKET>
```

When blockers matter, add a line so the session doesn't wander:

```
/implement <TICKET>

Its blockers (<BLOCKERS>) are closed. Build only this slice; leave the other
tickets alone.
```

→ **Fresh session per slice**, blockers-first. Each slice is self-contained, so
the previous one's context is disposable. `/implement` drives `/tdd` internally
and runs `/code-review` before committing, so don't bolt those on.

### Stage 5 — Close out

Check the map before declaring done — fog in **Not yet specified** means the
effort continues:

- Fog remains → back to **Stage 1** against the same map.
- Map genuinely clear, work landed → offer `/code-review` against the merge-base
  for a whole-branch pass, or `/improve-codebase-architecture` if the build
  surfaced seams worth deepening.

## Rules

- **Refer to maps and tickets by name**, never by bare id or number. A wall of
  `#42, #43, #44` is illegible. The id rides inside the name as its link.
- **Never mutate the tracker.** No claiming, no closing, no editing the map.
  Claiming here would steal a ticket from a session that's actually going to
  work it.
- **Interpolate, don't stub.** If a value is genuinely unknown, ask for it rather
  than emitting `<PLACEHOLDER>` and calling it done.
- **Don't invent stages.** If the state matches nothing here, say so plainly and
  ask what they're trying to do next.
