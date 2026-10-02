# Writing style

The levers that make a skill predictable: the agent takes the same _process_ on every run, even when the output differs. Most of these ideas follow Matt Pocock's [`writing-for-agents`](https://github.com/mattpocock/skills) skill; this file restates them for this collection and adds the workflow and script guidance.

Contents:

- [Two budgets](#two-budgets)
- [Pointers and descriptions](#pointers-and-descriptions)
- [Steps and reference](#steps-and-reference)
- [Completion criteria](#completion-criteria)
- [Degrees of freedom](#degrees-of-freedom)
- [Leading words](#leading-words)
- [Positive phrasing](#positive-phrasing)
- [Pruning](#pruning)
- [Workflow patterns for low-freedom work](#workflow-patterns-for-low-freedom-work)
- [Scripts](#scripts)
- [Evaluating a skill](#evaluating-a-skill)
- [Example: procedure to goal](#example-procedure-to-goal)

## Two budgets

- **Context load** is what always-loaded text costs the agent: every model-invoked description sits in context on every turn, used or not. Once a skill is invoked, its body also stays in the conversation for later turns and is reattached after compaction, so body text is a recurring cost too.
- **Cognitive load** is what the human pays to remember which skills exist and when to run them. Spend it where human judgement matters (user-invoked, side-effectful skills) and remove it elsewhere.

Material reached only through a pointer avoids context load at the cost of the pointer's own line.

## Pointers and descriptions

A **pointer** names material outside the agent's context and states when to reach it. A skill description is one; a line in `AGENTS.md` naming a doc is another. The pointer's wording, not its target, decides how reliably the agent reaches the material. When must-have material is missed, sharpen the pointer first, and inline the material only if that fails.

- **Lead with what it does.** Harnesses truncate descriptions under budget pressure, so the first clause carries the match.
- **One trigger per branch.** A branch is a distinct case the skill handles. Synonyms that rename one branch are one trigger written twice; collapse them.
- **Third person, specific nouns.** "Extracts tables from PDFs" beats "Helps with documents".
- **Cut what the body already says.** The description routes; the body instructs.

## Steps and reference

A skill mixes two kinds of content: **steps** (ordered actions) and **reference** (rules and facts consulted on demand). Place each piece on a ladder by how soon the agent needs it:

1. **In-file steps**: what the agent does, in order.
2. **In-file reference**: consulted while working. A flat peer set (every rule of a review on one level) is fine.
3. **Disclosed reference**: a separate file behind a pointer, loaded only when the pointer fires.

**Progressive disclosure** moves material down the ladder so the top stays legible. Test it by branch: inline what every branch needs, and disclose what only some branches reach. Reference that buries the steps makes attending to them a coin flip.

**Co-location**: keep a concept's definition, rules, and caveats under one heading so reading one part brings its neighbours along.

**Sprawl** is a document too long even when every line is live. Attention thins across the excess. Cure it with the ladder: disclose by branch, or split by sequence.

Structure rules that keep disclosure working:

- Keep references one link from `SKILL.md`. An agent following a chain of links reads partially.
- Give a reference longer than about 100 lines a table of contents.
- Organize multi-domain references by domain (`references/finance.md`, `references/sales.md`) so one branch loads one file.

## Completion criteria

Every step, and every body of reference that must be applied in full, ends on a **completion criterion**: the condition that tells the agent the work is done.

- **Clarity.** A vague bound ("once you understand the code") invites premature completion: the agent's attention slides to the visible steps ahead. Sharpen the bound first. Only if it stays fuzzy and you observe the rush, split the later steps out across a real context boundary (a subagent or a separate invocation); an inline call clears nothing.
- **Demand.** "Every modified model accounted for" forces thorough work where "produce a change list" does not. Demand drives the legwork without listing it as steps.

The strongest criteria are both checkable and exhaustive: "`--help` exits 0 and the test suite passes", "every captured value lands where the plan said".

## Degrees of freedom

Match specificity to fragility:

- **High freedom** (goals and criteria): several approaches are valid and the right one depends on context. Most skills live here.
- **Medium freedom** (a template or a parameterized script): a preferred pattern exists and variation is acceptable.
- **Low freedom** (exact commands, few parameters): the operation is fragile, consistency is critical, or the order is load-bearing, as with credentials and migrations.

A narrow bridge needs rails; an open field needs a direction. Write the rails only on the bridge.

## Leading words

A **leading word** is a compact concept the model already knows that anchors a region of behaviour in one token: _tracer bullet_, _red_, _idempotent_, _tight_ loop. Repeated as a token, it accumulates meaning and recruits priors without definition text. Prefer an existing word to a coined one; a coined word must be defined and recruits nothing.

Hunt restatements that collapse into one word. "Fast, deterministic, low-overhead" becomes _tight_. "A check you trust to fail on the bug" becomes _red_, which turns a fuzzy gate into an observable state. Keep one term per concept throughout the skill; mixing "endpoint", "route", and "URL" for one thing splits its meaning.

## Positive phrasing

Steering by prohibition names the unwanted behaviour and makes it more available, so state the target behaviour instead: "write one-line comments", not a ban on long ones. Keep a prohibition only as a hard guardrail that has no positive form, and pair it with the positive target so attention lands on what to do.

## Pruning

- **Single source of truth.** Each meaning lives in one place, so changing behaviour is a one-place edit. Duplication costs tokens and inflates a meaning's prominence.
- **The environment is a source.** `package.json` scripts, config files, directory layout, and `--help` output already hold facts. A skill that restates them is a cache that goes stale. Record what the agent cannot find by looking: the unwritten convention, the reason behind a choice, the gotcha no config admits.
- **No-ops.** A sentence the model already obeys by default pays load to say nothing. Test each sentence against the default and delete whole sentences that fail. A leading word too weak to beat the default ("be thorough") needs a stronger word ("relentless"), not more sentences.
- **Sediment.** Adding feels safe and removing feels risky, so stale layers settle. Prune on every edit.
- **Time-sensitive facts.** Write "current method" and keep deprecated approaches in a clearly labelled "old patterns" section, not dated conditionals.
- **One default.** Offer one recommended tool or approach with an escape hatch, not a menu of five.

## Workflow patterns for low-freedom work

These patterns make progress observable and errors correctable where exact steps are justified. They compose; a simple skill may need only the first.

- **Checklist.** For long multi-step work, give a checklist the agent copies into its response and ticks off. It keeps validation steps from being skipped and shows the user progress.
- **Feedback loop.** Run a validator, fix, repeat, and proceed only when it passes. Without a script, the validator can be a reference the output is compared against.
- **Plan, validate, execute.** For batch, destructive, or high-stakes changes, have the agent write a plan file, validate it with a script, then apply it. Iterating on a plan is cheap; undoing a bad execution is not.

## Scripts

- **Solve, don't punt.** Handle expected error conditions in the script. If the author cannot say what to do on an error, the agent cannot work it out from a stack trace either.
- **Explain constants.** Every timeout, limit, and magic number carries the reason for its value.
- **Specific errors.** Say what went wrong and what the valid options are ("Field 'signature_date' not found. Available: customer_name, order_total"), so the agent can fix it without another round trip.
- **Fully qualified tool names.** Reference MCP tools with their server prefix (`GitHub:create_issue`) so they resolve when several servers are connected.
- **Forward slashes** in every path.

## Evaluating a skill

A skill that triggers was found, which is different from a skill that worked. Measure both: whether the agent **invokes** it on the prompts it should, and whether the **output** meets the bar when it does.

1. Run representative tasks without the skill and note the failures or repeated context you supply. Those gaps are what the skill is for.
2. Write the minimum content that closes the gaps.
3. Run each prompt in a **fresh session** with the skill available and again with it disabled, then compare. Leftover context from authoring masks gaps in the written instructions.
4. Watch how the agent navigates: reading files in an unexpected order means the structure is unclear; a reference read on every run belongs in `SKILL.md`; a bundled file never opened is unneeded or poorly pointed to.
5. Check with smaller and larger models. A smaller model shows missing guidance; a larger one shows over-explanation.

In Claude Code, the `skill-creator` plugin and `claude plugin eval` automate the with-and-without comparison, grading, and description tuning.

## Example: procedure to goal

A procedure that overrides judgement:

```markdown
## Steps

1. Run `git remote -v`.
2. If the remote contains github.com, run `gh auth status`.
3. Open `.github/workflows/deploy.yml`.
4. Find every line containing `secrets.`.
5. For each one, run `gh secret list` and check the name is present.
6. Tell the user which secrets are missing.
```

The same skill, goal-first:

```markdown
Report which secrets the deploy workflow reads that the repository does not yet have.

Done when every `secrets.*` reference in every workflow is classified as installed or missing, and the user has the missing names. Read secret names only; values never leave the forge.
```

The second is shorter, works on Forgejo as well as GitHub, covers every workflow file instead of one, and leaves the agent free to choose the commands.
