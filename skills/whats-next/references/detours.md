# Detours

For when the user is **blocked** rather than between stages. Each detour answers
one question and then returns to the route; none of them replaces a stage.

Match on what's blocking, emit the prompt, and name the stage it returns to.

## The question needs a runnable answer

"How should this look" or "how should it behave" — questions paper can't settle.
Wayfinder has a `prototype` ticket type for exactly this; outside a map, reach
for it any time a design question resists discussion.

A prototype lives in its own directory, so it's bridged by `/handoff` in both
directions:

```
/handoff

I'm going to answer <QUESTION> with a throwaway prototype in a separate
directory. Write the handoff file: what we've decided so far, what the
prototype needs to answer, and what to bring back.
```

Then, in a fresh session against that file:

```
/prototype

<paste or reference the handoff file>
```

And to return:

```
/handoff

Write up what the prototype settled about <QUESTION>, so I can fold it back
into <MAP-OR-TICKET-NAME>.
```

→ Returns to **Stage 1** (resolve the ticket with the answer). Throwaway is a
constraint on how it's written, not a promise to delete it — the prototype is
kept as a primary source on a `prototype/<name>` branch and pointed at from the
ticket.

## The question needs knowledge from outside the repo

Third-party API behaviour, documentation, anything not in the working directory.
This is the one ticket type that runs AFK and in parallel — several research
tickets can be in flight at once.

```
/research

<the question, stated precisely enough that a cited answer settles it>

Leave the findings as a markdown file with citations, on a research/<name>
branch, and I'll point at it from <TICKET-NAME>.
```

→ Returns to **Stage 1**. Keep working while it reads.

## The answer lives in someone else's head

Not in your head, not in the codebase — in a colleague's, a customer's, a
vendor's.

```
/to-questionnaire

I need <PERSON-OR-ROLE> to settle <QUESTION> before <TICKET-NAME> can resolve.
Write them a questionnaire.
```

→ Returns to **Stage 1** when the answers come back. What comes back is material
for `/to-spec` too, if it lands after the map has cleared.

## A human has to do something first

Provisioning access, signing up for a service so its API can be judged, clicking
through a dashboard, a one-off migration. This is a wayfinder `task` ticket: it
does rather than decides, and earns its place only by unblocking a decision.

```
/wizard

<the human-only step>, so that <DECISION> becomes answerable.
```

→ Returns to **Stage 1**. The resolution records what was done plus any facts
later tickets depend on: where credentials live, new URLs, row counts.

## Something is broken

A build that resists a first glance, an intermittent flake, a regression between
two known-good states.

```
/diagnosing-bugs

<what's broken, what you expected, and the last state you know was good>
```

→ Returns to **Stage 4** normally. If the post-mortem finds the real problem is
that there's no good seam to lock the bug down, it hands off to
`/improve-codebase-architecture` instead, which generates an idea you can take
back to the top of the route.

## The window is filling up mid-stage

Not a detour so much as a hazard. The **smart zone** is roughly 150k tokens; past
it the model reasons worse but doesn't announce it, and Stages 2–3 are meant to
share one window.

At a **phase boundary**, in order of preference: continue → `/clear` if nothing
here matters next → `/handoff` if the next step needs a new directory or harness
→ subagent for a tightly-scoped side task → `/compact` as the default fallback.

**Mid-phase**, you have two options only: continue, or split the remainder into
subagents. Don't compact mid-phase to buy room — reach the boundary first.
