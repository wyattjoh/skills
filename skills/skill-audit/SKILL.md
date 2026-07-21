---
name: skill-audit
description: |
  Audits skill execution in the current session by analyzing conversation history for permission denials, tool errors, user corrections, and unexpected behavior. Provides categorized recommendations and offers to fix the skill via plan mode. Triggers on "audit skill", "audit this skill", "debug skill execution", "why did the skill fail", "review skill behavior", "skill problems", "skill had errors", "skill not working right", or mentions "skill-audit", "skill permissions issue".
argument-hint: "[skill-name]"
disable-model-invocation: true
effort: high
---

# Skill Audit

Post-execution forensics for Claude Code skills. Analyzes the current session's conversation history to find permission denials, tool errors, user corrections, and unexpected behavior during a skill invocation — then offers to fix the skill.

## Phase 1: Validate Arguments

**Skill name**: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask the user which skill they want to audit using `AskUserQuestion`.

Resolve the skill definition by searching for the SKILL.md file:

1. Use `Glob` to search `skills/*/SKILL.md` in the current working directory
2. Also search `~/.claude/skills/*/SKILL.md` for installed skills
3. Match the skill name against the directory name (e.g., `$ARGUMENTS` = `just` matches `skills/just/SKILL.md`)

If no matching skill is found, report the error and list available skills so the user can pick one.

## Phase 2: Read Target Skill Definition

Read the matched `SKILL.md` file and extract:

- **`allowed-tools`** — What tools the skill is permitted to use (if unrestricted, note that)
- **`description`** — Trigger phrases and purpose
- **`context`** — Whether it runs forked or inline
- **`disable-model-invocation`** — Whether it's manual-only
- **Body content** — The workflow steps, phases, and instructions the skill defines

Summarize what the skill is _supposed_ to do in 2-3 sentences. This becomes the baseline for detecting deviations.

## Phase 3: Delegate Session Analysis

Spawn a `conversation-historian` agent via the `Agent` tool with the following prompt. Include ALL of these details in the agent prompt:

> Analyze the current session for skill execution issues.
>
> **Session file**: `~/.claude/projects/!`pwd | sed 's|/|-|g'`/${CLAUDE_SESSION_ID}.jsonl`
>
> **Target skill**: `$ARGUMENTS`
>
> **What to do:**
>
> 1. Run `parse-conversation.ts --format=stats` on the session file to get a tool call overview
> 2. Run `parse-conversation.ts --include-tools --format=readable --search="$ARGUMENTS"` to find the skill invocation point and surrounding context
> 3. Search for these signals in messages AFTER the skill invocation:
>    - **Permission denials**: `tool_result` entries with `is_error: true` — search for "permission", "denied", "not allowed"
>    - **Tool errors**: Any `tool_result` with `is_error: true` (failed Bash commands, Read errors, etc.)
>    - **User corrections**: User messages containing "no", "wrong", "instead", "don't", "that's not", "actually", "stop", "I said", "not what I"
>    - **Retries**: The same tool being called multiple times with similar arguments (indicates struggling)
> 4. Compare actual tool usage against the skill's allowed-tools list: `ALLOWED_TOOLS_PLACEHOLDER`
>    - Flag any tools used that aren't in the allowed list
>    - Flag any tools in the allowed list that were denied
> 5. Return a structured summary with these sections:
>    - **Permission Denials**: List each denial with the tool name and what was attempted
>    - **Tool Errors**: List each error with the tool, arguments summary, and error message
>    - **User Corrections**: List each correction with the user's words and what Claude was doing wrong
>    - **Unexpected Tool Usage**: Tools used outside the allowed-tools list
>    - **Retries/Struggles**: Tools called 3+ times with similar arguments
>    - **Overall Assessment**: 1-2 sentence summary of how well the skill executed

Replace `ALLOWED_TOOLS_PLACEHOLDER` with the actual `allowed-tools` value from Phase 2 (or "unrestricted" if none).

## Phase 4: Present Findings

Once the conversation-historian returns its analysis, present the findings in a structured format:

### Report Structure

```
## Skill Audit: <skill-name>

### Summary
<Overall assessment from the historian>

### Findings

#### Permission Denials
| Tool | Attempted Action | Recommendation |
|------|-----------------|----------------|
| ...  | ...             | Add to allowed-tools / Adjust skill workflow |

#### Tool Errors
| Tool | Error | Recommendation |
|------|-------|----------------|
| ...  | ...   | Fix path/args in skill body |

#### User Corrections
| What User Said | What Claude Was Doing | Recommendation |
|----------------|----------------------|----------------|
| ...            | ...                  | Revise workflow step |

#### Unexpected Tool Usage
| Tool | Context | Recommendation |
|------|---------|----------------|
| ...  | ...     | Add to allowed-tools or remove from workflow |

### Recommendation Summary
<Numbered list of specific changes to make to the SKILL.md>
```

If no issues are found in a category, omit that section entirely rather than showing an empty table.

If NO issues are found at all, report that the skill executed cleanly and no changes are needed.

## Phase 5: Offer Repair

After presenting findings, if there are actionable recommendations:

1. Ask the user if they want to fix the skill now using `AskUserQuestion`
2. If yes, invoke `EnterPlanMode` to plan the fixes
3. In the plan, reference `/claude-skills` for current skill authoring best practices
4. The plan should address each recommendation from Phase 4

If the user declines, suggest they can run `/skill-audit $ARGUMENTS` again after making manual changes to verify the fixes.
