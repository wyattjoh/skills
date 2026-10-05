import { Effect, Schema } from "effect";

import { ProtocolError } from "./model.ts";

/**
 * A finding's severity is structural validation, not a semantic correctness judgment.
 */
export const Finding = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  description: Schema.NonEmptyString,
});

/**
 * Parsed review data must identify the exact assignment and reviewed Git snapshot.
 */
export const ReviewReport = Schema.Struct({
  ticketId: Schema.NonEmptyString,
  reviewerId: Schema.NonEmptyString,
  assignmentId: Schema.NonEmptyString,
  base: Schema.NonEmptyString,
  head: Schema.NonEmptyString,
  verdict: Schema.Literals(["approved", "changes_requested"]),
  findings: Schema.Array(Finding),
});

/**
 * Expected evidence comes from the live model and Git, not the reviewer-supplied document.
 */
export const ReviewBinding = Schema.Struct({
  ticketId: Schema.NonEmptyString,
  reviewerId: Schema.NonEmptyString,
  assignmentId: Schema.NonEmptyString,
  base: Schema.NonEmptyString,
  head: Schema.NonEmptyString,
  currentBase: Schema.NonEmptyString,
  currentHead: Schema.NonEmptyString,
  filename: Schema.NonEmptyString,
});

/**
 * Build an assignment-bound template for real workers and the browser editor.
 */
export const reviewTemplate = (
  binding: typeof ReviewBinding.Type,
  verdict: "approved" | "changes_requested",
): string =>
  `# Review\n\nticket: ${binding.ticketId}\nreviewer: ${binding.reviewerId}\nassignment: ${binding.assignmentId}\nbase: ${binding.base}\nhead: ${binding.head}\nverdict: ${verdict}\n\n## Findings\n${verdict === "approved" ? "None." : "- [medium] Describe an actionable issue and its source location."}\n`;

const fail = (message: string) => new ProtocolError({ message });

/**
 * Parse and validate the same Markdown contract in production and the simulator.
 * Reading a real file and checking its canonical location belongs to the platform adapter.
 */
export const validateReview = Effect.fn("fleet.validateReview")(function* (
  filename: string,
  markdown: string,
  binding: typeof ReviewBinding.Type,
) {
  if (filename !== binding.filename)
    return yield* fail("Review filename does not match the assigned scratch file");
  if (
    !filename.startsWith(".scratch/") ||
    filename.split("/").some((part) => part === ".." || part === ".") ||
    !filename.endsWith(".md")
  ) {
    return yield* fail("Review filename must be a .scratch/ Markdown path without traversal");
  }
  if (!/^# Review\s*$/m.test(markdown)) return yield* fail("Missing # Review title");
  const fields: Record<string, string> = {};
  for (const key of ["ticket", "reviewer", "assignment", "base", "head", "verdict"]) {
    const matches = [...markdown.matchAll(new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, "gm"))];
    if (matches.length !== 1) return yield* fail(`Require exactly one ${key} field`);
    fields[key] = matches[0][1]!;
  }
  const sections = [...markdown.matchAll(/^## Findings[ \t]*\r?\n([\s\S]*)$/gm)];
  if (sections.length !== 1) return yield* fail("Require one Findings section");
  const lines = sections[0][1]!
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return yield* fail("Findings must be structured entries or None.");
  const rawFindings: { severity: string; description: string }[] = [];
  if (!(lines.length === 1 && lines[0] === "None.")) {
    for (const line of lines) {
      const match = line.match(/^- \[(low|medium|high|critical)\] (\S.*)$/);
      if (match === null) return yield* fail("Each finding must use - [severity] description");
      rawFindings.push({ severity: match[1]!, description: match[2]! });
    }
  }
  const report = yield* Schema.decodeUnknownEffect(ReviewReport)({
    ticketId: fields.ticket,
    reviewerId: fields.reviewer,
    assignmentId: fields.assignment,
    base: fields.base,
    head: fields.head,
    verdict: fields.verdict,
    findings: rawFindings,
  }).pipe(Effect.mapError(() => fail("Invalid review fields or verdict")));
  for (const key of ["ticketId", "reviewerId", "assignmentId", "base", "head"] as const) {
    if (report[key] !== binding[key])
      return yield* fail(`${key} does not match the live review assignment`);
  }
  if (binding.base !== binding.currentBase || binding.head !== binding.currentHead) {
    return yield* fail("Review snapshot is stale relative to the current ticket head/base");
  }
  const blocking = report.findings.some((finding) => finding.severity !== "low");
  if (report.verdict === "approved" && blocking)
    return yield* fail("Approval cannot contain medium-or-higher findings");
  if (report.verdict === "changes_requested" && !blocking)
    return yield* fail(
      "Changes requested requires a medium-or-higher finding; low suggestions do not block approval",
    );
  return report;
});
