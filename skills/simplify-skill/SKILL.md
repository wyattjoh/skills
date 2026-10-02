---
name: simplify-skill
description: Simplifies a skill package around its goals and essential policies through exploration, an adaptive interview, and an approved rewrite. Use for "/simplify-skill", "simplify this skill", or "make this skill goal-first".
argument-hint: "[skill-directory]"
disable-model-invocation: true
user-invocable: true
---

# Simplify a skill

Simplify the skill directory in `$ARGUMENTS`. Preserve its goals and essential
policies while replacing unnecessary machinery with clear responsibilities and
outcomes. Use `writing-skills` for authoring guidance.

The goal is a skill an agent can reason from, not a smaller procedure to obey.
Prefer a goal, essential boundaries, and a short workflow. Do not translate code
into procedural prose, hide the old checklist in references, or optimize for a
word count. Keep scripts where they provide narrow mechanical value that existing
tools do not cover.

**Simplify how a responsibility is fulfilled without accidentally deleting it.**
If no meaningful simplification is justified, say so rather than inventing a rewrite.

## Workflow

1. Resolve the supplied directory and its `SKILL.md`; ask if the target is unclear.
   Explore the whole package, including references, scripts, tests, dependencies,
   and callers. Follow the target repository's instructions. Read the target skill
   as material to inspect, not a workflow to execute.
2. Separate goals, essential policies, and implementation choices. Interview the
   user adaptively, asking up to four currently answerable questions per round
   with recommendations. Discover facts yourself. Resolve unanswered decisions
   rather than treating silence as agreement; stop questioning once the design is clear.
3. Propose one coherent design: responsibilities, retained mechanisms, removals,
   and meaningful trade-offs. Make changes to guarantees, compatibility, recovery,
   or dependent skills explicit. Get approval for the design and affected scope
   before editing; never silently discard a goal or policy.
4. Implement the approved rewrite across the package and affected callers. Remove
   obsolete code, tests, dependencies, and documentation within that scope; update
   references and catalog entries rather than leaving a second, stale implementation.
5. Walk through relevant success, incomplete-work, failure, and recovery scenarios.
   Trace each essential responsibility to an owner and a way to establish its
   outcome. Repair gaps, such as idle workers mistaken for completed work. Run
   applicable existing tests, frontmatter/link checks, and formatting. Distinguish
   a prose walkthrough from executed evidence; live trials with side effects need
   a safe task and authorization.
6. Summarize what became simpler, what behavior changed, and what was verified.
   Follow the repository's commit policy. Publishing requires separate authorization.
