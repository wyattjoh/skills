---
name: writing-skills
description: Writes and edits agent skills (SKILL.md plus its references and scripts) in a goal-first style that works across Claude Code, Codex, and other harnesses. Use when creating or editing a skill, tightening a skill's description or triggers, choosing frontmatter or invocation settings, or pruning a skill that has grown into a procedure.
argument-hint: "[skill-name]"
---

# Writing skills

A skill is a document an agent runs. The goal: it is reached exactly when it should be, and it carries the agent to an outcome with the fewest words that change what the agent does. Follow the target repository's own skill rules; in this repository they live in `.claude/rules/skills.md`.

## The style: goals over procedures

Most skills describe an **outcome** and leave the route to the agent. A goal-first skill states:

- **Goal**: what is true when the work is done, in a sentence or two.
- **Completion criteria**: checkable conditions that tell done from not done, demanding enough to drive the digging. "Every `secrets.*` reference in CI has an installed secret" drives more legwork than "set up secrets".
- **Boundaries**: the hard lines (confirmations, irreversible actions, what stays untouched), each stated as the behaviour you want.
- **Pointers**: where detail lives (a reference, a script, another skill), each worded with the condition for reaching it.

Write ordered steps only where order or exact form matters: credentials, migrations, destructive or one-shot operations, a fixed output format. Those steps still end on completion criteria. Everything adaptable stays a goal, because the agent already plans well and a procedure overrides judgement it would otherwise use.

Setup and interactive skills default to **explore, present, confirm, write**: read the environment before asking, lead each question with the recommended answer, and write once the user confirms.

The levers behind this style (pointers, the steps and reference ladder, completion criteria, leading words, positive phrasing, pruning) are in [writing style](references/writing-style.md). Read it before writing a new skill or restructuring one.

## Way of working

1. **Understand the job.** For an edit, read the skill, its references, and its callers, and keep triggers that already work. For a new skill, read neighbouring skills and the task it serves. Done when you can state the skill's goal and completion criteria in two sentences.
2. **Choose invocation.** A model-invoked skill keeps a model-facing description, so the agent and other skills can reach it; it costs context on every turn. A user-invoked skill is reachable only by the human typing its name and costs no context. Make side-effectful, one-shot work user-invoked. Apply the choice in every harness the skill ships to (see the harness references).
3. **Write the pointer.** For a model-invoked skill, the description leads with what the skill does, then names one trigger per distinct case, in third person. For a user-invoked skill, it is a one-line summary for a human browsing commands.
4. **Write the body.** Goal, completion criteria, boundaries, then pointers. Inline what every branch needs; move what only some branches need into a reference one link from `SKILL.md`. Use a script for mechanical work that prose does badly, and test it.
5. **Prune.** Delete each sentence that does not change behaviour against the default, restates what a file or `--help` already says, or repeats a meaning held elsewhere. Rewrite each prohibition as the positive target, keeping a ban only as a guardrail that has no positive form.
6. **Verify.** Frontmatter opens on line 1 and parses, links and paths resolve, scripts pass their tests, and the repository's checks pass. Walk one successful use and one failure or recovery path through the skill. Update callers and the repository's skill catalog when entries change. If activation is uncertain, run representative prompts in a fresh session (or `claude plugin eval`) instead of adding speculative triggers.

## Portability

- **Portable core.** The [Agent Skills](https://agentskills.io) format: a directory named after the skill holding `SKILL.md`, plus optional `scripts/`, `references/`, and `assets/`. Frontmatter fields every harness accepts are `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`.
- **Calling another skill.** Write an explicit instruction to call the Skill tool with the skill's name (`Call the Skill tool with "alchemy"`), one call per skill. A user-invoked skill cannot be called this way; tell the user to run it instead. Reach shared material through the skill that owns it, not through a path into another skill's folder.
- **Paths.** Write `$SKILL_DIR` for the skill's own directory, meaning the base directory the harness reports when the skill loads. Use `${CLAUDE_SKILL_DIR}` only in Claude Code-specific features such as hooks and `allowed-tools` rules.
- **Harness features are additive.** Hooks, dynamic context injection, forked context, and `agents/openai.yaml` belong to one harness each. Keep the skill correct when a harness ignores them, or declare the requirement in `compatibility`.

## Reference map

- [Writing style](references/writing-style.md): the levers in depth, workflow patterns for low-freedom work, script guidelines, and evaluation.
- [Codex](references/harnesses/codex.md): skill locations, `agents/openai.yaml`, and implicit invocation policy.
- [Claude Code frontmatter](references/harnesses/claude-code-frontmatter.md): every field's semantics and examples.
- [Claude Code discovery and permissions](references/harnesses/claude-code-discovery.md): visibility, precedence, live reload, and the description budget.
- [Claude Code advanced patterns](references/harnesses/claude-code-advanced.md): hooks, dynamic context injection, forked context, and string substitutions.

Harness facts change between releases. Verify version-sensitive claims against [Claude Code's skill docs](https://code.claude.com/docs/en/skills.md) or [Codex's skill docs](https://developers.openai.com/codex/skills) before relying on them.
