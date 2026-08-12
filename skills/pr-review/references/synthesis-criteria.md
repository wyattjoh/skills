# Synthesis Criteria

Guidelines for the synthesis sub-agent that merges findings from parallel
Opus and Codex reviews.

## Input

You receive:

1. **Opus findings**: JSON array of findings from deep-reasoning review
2. **Codex findings**: JSON array of findings from systematic checklist review
3. **Original diff**: The code changes being reviewed
4. **Repo health data**: High-churn files, bug hotspots, bus factor info

## Process

### 1. Deduplication

Two findings are duplicates if they reference the same file and line range
(within 5 lines) AND describe the same underlying issue (even if worded
differently). When merging duplicates:

- Keep the more detailed description
- Set `sources: ["opus", "codex"]`
- Use the higher severity if they disagree on severity
- Combine evidence from both

### 2. Corroboration Marking

Findings flagged independently by both reviewers (after deduplication) are
marked as corroborated. These carry higher confidence because two independent
analysis approaches converged on the same issue.

### 3. Disagreement Adjudication

When only one reviewer flags an issue:

**Low/Medium severity:**

- Read the relevant code in the diff
- Assess whether the finding is valid
- Either confirm (keep the finding) or dismiss (remove it)
- Add a `synthesisNote` explaining your reasoning
- Set `contested: false` (you made the call)

**High/Critical severity:**

- Read the relevant code in the diff
- Form your own assessment
- Keep the finding with `contested: true`
- Add a `synthesisNote` with your assessment and recommendation
- The user will see both the original finding and your note

### 4. Severity Calibration

After merging, re-evaluate severities in context:

- A medium issue in a high-churn file (from repo health data) may warrant
  elevation to high
- A medium issue in a file with known bug hotspot history should be elevated
- A low issue that appears in a file owned by a single contributor (bus factor
  risk) may warrant a note but not necessarily elevation
- Multiple low issues in the same file may collectively warrant a medium
  architectural finding

### 5. Output Schema

Produce a JSON array where each finding includes the full schema:

```json
{
  "id": "string",
  "file": "string",
  "line": "number",
  "severity": "critical | high | medium | low",
  "category": "string",
  "title": "string",
  "description": "string",
  "evidence": "string",
  "sources": ["opus"] | ["codex"] | ["opus", "codex"],
  "contested": "boolean",
  "synthesisNote": "string (required when contested or when dismissing/adjudicating)"
}
```

Return ONLY the JSON array.
