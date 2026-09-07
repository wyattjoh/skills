# Skill Visibility, Permissions, and Discovery

## Controlling Skill Visibility

Skills can be invoked three ways:

1. **Manual**: User types `/skill-name` in the prompt
2. **Programmatic**: Claude calls it via the Skill tool
3. **Auto-discovery**: Claude reads the description and loads it when relevant

### Visibility Fields

| Setting                          | You can invoke | Claude can invoke | When loaded into context                                     |
| -------------------------------- | -------------- | ----------------- | ------------------------------------------------------------ |
| Default                          | Yes            | Yes               | Description always in context; full skill loads when invoked |
| `disable-model-invocation: true` | Yes            | No                | Description not in context; full skill loads when you invoke |
| `user-invocable: false`          | No             | Yes               | Description always in context; full skill loads when invoked |

**Note:** In a regular session, skill descriptions are loaded into context so
Claude knows what's available, but full skill content only loads when invoked.
Subagents with preloaded skills work differently: the full skill content is
injected at startup.

### Example: Model-Only Skill

Hide from slash menu but allow Claude to invoke programmatically:

```yaml
---
name: internal-review-standards
description: Apply internal code review standards when reviewing pull requests
user-invocable: false
---
```

### Example: User-Only Skill

Allow manual invocation but prevent Claude from calling via Skill tool:

```yaml
---
name: manual-deployment
description: Deploy to production with manual confirmation
disable-model-invocation: true
---
```

## Permission Rules for Skills

Control which skills Claude can invoke using permission rules in `/permissions`:

### Syntax

```text
# Allow specific skills
Skill(commit)
Skill(review-pr *)

# Deny specific skills
Skill(deploy *)

# Disable all skills
Skill
```

- `Skill(name)`: Exact match for a specific skill
- `Skill(name *)`: Prefix match with any arguments
- `Skill`: Matches all skills (useful in deny rules)

### Notes

- `allowed-tools` in skill frontmatter grants tool access without per-use
  approval when the skill is active, but your permission settings still govern
  baseline behavior for all other tools
- `user-invocable` only controls menu visibility, **not** Skill tool access.
  Use `disable-model-invocation: true` to block programmatic invocation
- A few built-in commands, including `/init` and `/security-review`, are also
  available through the Skill tool. Other built-in commands such as
  `/compact` are not.

## Skill Precedence & Discovery

### Scope Priority

When multiple skills exist across different scopes:

1. **Enterprise** skills take highest precedence
2. **Personal** skills (in `~/.claude/skills/`) override project skills
3. **Project** skills (in `.claude/skills/`) are the default scope

**Plugin skills** use a namespaced format (`plugin-name:skill-name`) and don't
conflict with personal or project skills.

If a skill and a built-in command share the same name, the **skill takes
precedence**. A skill at any level also overrides a **bundled** skill of the
same name, but never the bundled skill's aliases: a project `code-review` skill
replaces `/code-review`, while `/review` still runs the bundled one. Skills at
any local level, plus plugin skills and `.claude/commands/` files, all override
a skill synced from claude.ai.

Other discovery details worth knowing when placing a skill:

- The folder name `synced` is **reserved** in the enterprise, personal, and
  project skills locations, in any capitalization. Claude Code owns
  `~/.claude/skills/synced/` and skips a skill you author at that name.
- A `<skill-name>` entry can be a **symlink** to a directory elsewhere on disk.
  Claude Code follows it, and loads the skill once even if the same target is
  reachable from several locations.
- Adding a `.claude-plugin/plugin.json` to a skill folder makes it load as a
  plugin named `<name>@skills-dir`, so it can also bundle agents, hooks, and MCP
  servers. In a project's `.claude/skills/`, this requires accepting the
  workspace trust dialog first.

### Stacked Invocations

Typing several skills in one prompt (`/skill-a /skill-b do XYZ`) loads **all**
the leading skills, up to 5, not just the first.

### Reloading Skills Mid-Session

`/reload-skills` re-scans the skill directories without restarting the session.
A `SessionStart` hook that installs or updates skills can return
`{"hookSpecificOutput": {"hookEventName": "SessionStart", "reloadSkills": true}}`
to make them available in the same session, since skill discovery otherwise
runs before `SessionStart` hooks finish.

### Override Skill Visibility From Settings

The `skillOverrides` setting controls a skill's visibility from `settings.json`
instead of its own frontmatter — useful for skills checked into a shared repo
you don't want to edit. The `/skills` menu writes it for you (highlight a
skill, press `Space` to cycle states, `Enter` to save to
`.claude/settings.local.json`). Each key is a skill name; each value is one of:

| Value                   | Listed to Claude     | In `/` menu |
| ----------------------- | -------------------- | ----------- |
| `"on"`                  | Name and description | Yes         |
| `"name-only"`           | Name only            | Yes         |
| `"user-invocable-only"` | Hidden               | Yes         |
| `"off"`                 | Hidden               | Hidden      |

A skill absent from `skillOverrides` is treated as `"on"`. As of v2.1.199,
`"off"` also hides the skill from Remote Control and Agent SDK command
listings, not just the terminal `/` menu. Plugin skills aren't affected;
manage those through `/plugin` instead.

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "off"
  }
}
```

### Nested & Monorepo Discovery

Claude Code automatically discovers skills from nested `.claude/skills/`
directories when working with files in subdirectories. For example, editing a
file in `packages/frontend/` also loads skills from
`packages/frontend/.claude/skills/`.

If a nested skill shares a name with a project-root skill, both stay
available: the nested one gets a directory-qualified name (e.g.
`apps/web:deploy`), and invoking the unqualified name still runs the
project-root skill, which gets a list of the directory-qualified variants
appended with an instruction to also invoke any variant whose directory holds
the files Claude is working on (requires Claude Code v2.1.203+). Skills in a
nested directory aren't available at session start — they load the first time
Claude touches a file in that subdirectory, and stay available for the rest of
the session.

### Additional Directories

Skills in `.claude/skills/` within directories added via `--add-dir` are loaded
automatically and picked up by live change detection.

### Live Change Detection

Claude Code watches `~/.claude/skills/`, the project `.claude/skills/`, and
`.claude/skills/` inside `--add-dir` directories, so adding, editing, or
removing a skill takes effect in the current session. Two limits: detection
covers `SKILL.md` **text only** (for a skill folder that's also a plugin,
changes to `hooks/`, `.mcp.json`, `agents/`, and `output-styles/` need
`/reload-plugins`), and a top-level skills directory that didn't exist when the
session started isn't watched until you restart.

### Cowork, Cloud Sessions, and Synced Skills

Cowork sessions and cloud sessions (including routines) **don't read
`~/.claude/skills/` on your machine**. They load the skills enabled for your
claude.ai account, synced at session start; cloud sessions additionally load
project skills committed to the cloned repository's `.claude/skills/`. A
personal-only skill therefore reports as not found when a routine invokes it.
Desktop scheduled tasks are different: they run locally and load skills the same
way any local session does.

Authoring implications:

- To make a skill available in these sessions, either enable it for your
  claude.ai account, or (cloud only) commit it to the repo's `.claude/skills/`
  or ship it in a plugin declared in the repo's `.claude/settings.json`.
- Uploading a personal skill to claude.ai puts it on the Agent Skills spec path,
  so only the six spec fields are allowed. See the frontmatter reference.
- Locally, a skill synced **from** claude.ai is degraded on purpose: its body
  doesn't run `!` commands, doesn't attach `@` file references, and doesn't
  substitute `${CLAUDE_PROJECT_DIR}` or `${CLAUDE_SESSION_ID}`. All of those
  reach Claude as literal text. In a cloud session the body behaves normally.
- Claude Code skips a synced skill whose name collides with any other command,
  comparing names case-, spacing-, and Unicode-insensitively.
- To pull synced skills onto your own machine, run once with
  `CLAUDE_CODE_SYNC_SKILLS=1 claude -p "..."`; they download to
  `~/.claude/skills/synced/` and load in later interactive sessions.

## Description Character Budget

Skill descriptions share a character budget (1% of the context window,
adjustable via `skillListingBudgetFraction`). Each entry — the combined
`description` + `when_to_use` text — is truncated at **1,536 characters** in
the skill listing (configurable via `skillListingMaxDescChars`), so
front-load the key use case. The listing always contains every skill **name**;
when it overflows, Claude Code drops **descriptions**, starting with the skills
you invoke least, so the ones you use most keep their full text. To diagnose:

1. Run `/doctor` for an estimate of the listing's context cost and its biggest
   contributors. `--debug` also logs a warning when the listing overflows.
2. Check the Skills row in `/context`, which reports the listing size **after**
   the budget is applied, so it matches what the model receives.
3. Keep the combined `description`/`when_to_use` text concise, and set
   low-priority skills to `"name-only"` in `skillOverrides` to free budget.
4. Raise the budget with `skillListingBudgetFraction` (e.g. `0.02` = 2%) or set
   `SLASH_COMMAND_TOOL_CHAR_BUDGET` to a fixed character count.

## Commands Migration

Custom commands (`.claude/commands/`) have been **merged into skills**. A file at
`.claude/commands/review.md` and a skill at `.claude/skills/review/SKILL.md` both
create `/review` and work the same way. Existing `.claude/commands/` files
continue to work and support the same frontmatter, **except `name` and `paths`,
which Claude Code ignores in a command file** (a command is always invoked by
its file name). Skills are recommended since they support additional features
like supporting files, `context: fork`, and hooks.

If a skill and a command share the same name, the **skill takes precedence**.

## Bundled Skills

Claude Code ships with built-in skills available in every session, including
`/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, `/claude-api`,
`/dataviz`, `/simplify`, `/run`, `/verify`, and `/run-skill-generator`. A few
are feature-gated: `/workflow-authoring` is available only when dynamic
workflows are enabled. To turn them off, use the `disableBundledSkills` setting
or the `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` environment variable, either of
which disables every bundled skill except `/doctor`.

- **`/simplify [focus]`**: Reviews recently changed files for code reuse,
  quality, and efficiency, then fixes issues. Spawns three parallel review
  agents. Pass text to focus: `/simplify focus on memory efficiency`
- **`/batch <instruction>`**: Orchestrates large-scale changes across a
  codebase. Decomposes work into 5-30 independent units, spawns one agent per
  unit in isolated git worktrees, each opening a PR.
- **`/debug [description]`**: Troubleshoots the current Claude Code session by
  reading the session debug log.
- **`/claude-api`**: Loads Claude API reference material for your project's
  language. Also activates automatically when code imports the Anthropic SDK.
- **`/loop [interval] <prompt>`**: Runs a prompt repeatedly on an interval.
  Useful for polling deployments or periodic checks.
- **`/run [description]`**: Launches and drives your app to see a change
  working, inferring the launch from your project type.
- **`/verify [description]`**: Builds and runs your app to confirm a code
  change works, without falling back to tests or type checks. When it has to
  work out the build without a recorded recipe, it writes what worked to
  `.claude/skills/verify/SKILL.md` (repo root, or the touched package directory
  in a monorepo), where the recorded skill replaces the bundled one. Requires
  v2.1.200+. It rewrites the file only when a run went wrong, so the file is
  safe to commit.
- **`/dataviz`**: Chart, palette, and dashboard design guidance with a runnable
  color-palette validator.
- **`/run-skill-generator`**: Records a per-project launch/build recipe at
  `.claude/skills/run-<name>/` so `/run`, `/verify`, and other agents stop
  rediscovering it each session.
- **`/doctor`**: Setup checkup; stays available even when
  `disableBundledSkills` is on (Claude Code v2.1.205+; before that it was a
  plain built-in command, not a bundled skill). Can still be hidden via
  `DISABLE_DOCTOR_COMMAND` or a `skillOverrides` entry of `"doctor": "off"`.

**As of v2.1.215**, `/code-review` and `/verify` only run when you invoke
them directly — Claude used to be able to trigger them automatically.

## Types of Skill Content

Skills generally contain one of two types:

- **Reference content**: Knowledge that Claude applies to current work (coding
  conventions, architectural patterns, API reference). Runs inline, augments
  understanding.
- **Task content**: Step-by-step instructions for specific actions (deployment
  workflows, commit procedures). Often paired with
  `disable-model-invocation: true`.

Many skills combine both types. Reference material works best as background
context, while task instructions benefit from explicit invocation.
