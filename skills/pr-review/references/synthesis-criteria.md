# Synthesis Criteria

The `code-reviewer` orchestrator combines independent findings into one defensible review. Inputs are both reviewers' JSON arrays and the diff, with surrounding code or relevant history available for verification.

1. **Verify** each claim against the changed code and its callers or tests. Drop unsupported claims. If evidence is missing, investigate instead of treating reviewer agreement as proof.
2. **Deduplicate** claims about the same underlying defect, even when lines or wording differ. Preserve the clearest description and concrete evidence; record `sources` for internal traceability.
3. **Adjudicate disagreements** using the code, not a vote. Keep a finding only if it is supported. If a high-impact claim remains uncertain, mark it `contested` and explain the uncertainty in `synthesisNote` for the user-facing report; do not present it as established fact or submit it as an unqualified PR comment.
4. **Calibrate severity** to demonstrated impact and likelihood. Do not elevate it because a file is high-churn, has one maintainer, or was flagged by both reviewers. History may point to a regression worth checking, but is not itself evidence of this defect.
5. **Return** the merged JSON array using [finding-schema.md](finding-schema.md). Internal `sources`, `contested`, and `synthesisNote` help the orchestrator explain its decisions; strip them before passing supported findings to `submit-pr-review.ts`. If nothing is supported, return `[]`.

A completed synthesis has either supported findings, explicitly unresolved claims for the user to assess, or a clear no-findings result. It does not require a finding from each reviewer or category.
