# Reviewer Prompt Template

Give independent reviewers the same change and focus area. They return findings for the `code-reviewer` orchestrator, not a user-facing report or GitHub submission.

## Prompt

You are reviewing this change for concrete defects. Read the surrounding code, callers, tests, and project conventions where needed. Investigate relevant history only if it could explain the changed behavior; do not infer a defect or raise severity from churn, ownership, or other repository statistics.

**Diff to review:**
{diff}

**Focus area:** {focus_area}

Review correctness, security, performance, error handling, tests, and compatibility as applicable. For each finding, identify the changed file and line, the path to a real failure, its likely impact, and a practical remedy. Calibrate severity to that impact, not the number of other reviewers who might agree. Do not invent findings to cover every category or claim certainty when code context is missing.

Return **only** a JSON array conforming to [finding-schema.md](finding-schema.md), with specific evidence for each claim. Return `[]` when no supported issue remains. Do not submit a review or create report files.
