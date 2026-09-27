---
name: claude-skills
description: Provides comprehensive guidance on Claude Code skill authoring. Triggers on "create a skill", "build a skill", "make a new skill", "develop a skill", "write a skill", "enhance a skill", "improve this skill", "refine skill description", "add trigger phrases", "fix skill frontmatter", "update SKILL.md", or works with any files matching skills/*/SKILL.md. Fetches official documentation for up-to-date best practices. PROACTIVE.
argument-hint: "[skill-name]"
---

# Authoring Claude Code skills

Create skills that Claude can discover and use reliably without making the agent follow a larger procedure than the task requires. In this repository, a published skill lives in `skills/<name>/SKILL.md`; scripts belong in `scripts/` and supporting material in `references/`. Follow the target repository's own rules when working elsewhere.

## Approach

1. **Understand the job.** Read the existing skill, its callers and supporting files when editing; for a new skill, inspect nearby examples and the task it needs to enable. Preserve effective triggers and behavior unless the user wants them changed. Decide what belongs in the entry skill, a reference, or a narrow script.
2. **Check the current contract.** Consult [Claude Code's skill documentation](https://code.claude.com/docs/en/skills.md) and [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md) when creating a skill, changing frontmatter or discovery behavior, or when uncertain about a capability. Use the local references below for details, but verify version-sensitive claims against current documentation. Do not copy a documentation page into the skill.
3. **Make relevant design decisions.** A useful `description` states the purpose and natural trigger conditions in third person. Review frontmatter fields against the actual use case, especially invocation control, arguments, reasoning depth, context, and tool permissions. Suggest concrete settings and trade-offs for fields that would materially help; ask the user when a consequential choice cannot be inferred. Do not require a full-field questionnaire for an unrelated content edit. See [frontmatter fields](references/frontmatter-reference.md).
4. **Write for outcomes.** Put the goal, essential boundaries, and a short way of working in `SKILL.md`. Supply exact steps for fragile operations, but leave adaptable work adaptable. Put optional API details and extended examples in directly linked references; use scripts for mechanical work that prose and existing tools do not handle well. Avoid repeating instructions across the entry skill and references. See [best practices](references/best-practices.md).
5. **Verify the result.** Check that frontmatter parses, paths and links resolve, and the description matches likely requests without over-triggering. Walk through a successful use and a relevant failure or recovery path; run any script tests or project checks. If activation is uncertain, try representative prompts or `claude plugin eval` rather than adding speculative trigger phrases. Update affected callers and the repository's skill catalog when its entries change.

## Boundaries and useful distinctions

- Use a `SKILL.md` file with frontmatter starting on its first line. `name` and `description` are required by this repository's authoring convention, even though Claude Code permits defaults. Keep the name aligned with the directory and the description specific to the work it serves.
- For helper scripts in this repository, use Bun and TypeScript. Prefer Effect for meaningful I/O or failure handling, but not for tiny pure helpers; follow the `effect-ts` skill when using it.
- `allowed-tools` **pre-approves** listed tools for the invocation turn; it does not restrict the available tool pool. Add it only for intentional permission grants. Use `disallowed-tools` when a tool must actually be unavailable. See [visibility and permissions](references/visibility-and-discovery.md).
- Consider `disable-model-invocation: true` for user-controlled, side-effectful actions, and `user-invocable: false` for model-only background knowledge. Neither setting replaces the confirmation required by the task's own safety boundaries.
- Skill content stays in the conversation after invocation. Keep standing guidance in the entry skill and load detail only when needed. Hooks and injected commands have their own lifetimes and failure modes; check [advanced patterns](references/hooks-and-advanced.md) before adding them.
- If a skill does not activate, first check its frontmatter and whether its description expresses the user's intent. If it activates too broadly, narrow the description rather than adding more procedure to the body.

## Reference map

- [Frontmatter field reference](references/frontmatter-reference.md): field semantics and examples.
- [Authoring best practices](references/best-practices.md): structure, testing, scripts, and degrees of freedom.
- [Hooks and advanced patterns](references/hooks-and-advanced.md): hooks, dynamic context, arguments, and forked execution.
- [Visibility and discovery](references/visibility-and-discovery.md): permissions, skill lookup, invocation, and troubleshooting.
