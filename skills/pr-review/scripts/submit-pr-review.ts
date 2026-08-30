export type HunkMap = Map<string, Set<number>>;

export function parseHunks(diff: string): HunkMap {
  const map: HunkMap = new Map();
  let currentFile: string | null = null;
  let currentLine = 0;
  let remaining = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const match = line.match(/^\+\+\+ b\/(.+)$/);
      currentFile = match ? match[1] : null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match && currentFile) {
        currentLine = parseInt(match[1], 10);
        // The header declares how many lines the hunk covers on the new side.
        // Consuming exactly that many bounds the hunk, so trailing content
        // (the "\ No newline" marker, the format-patch signature, the empty
        // string split() leaves after the final newline) cannot leak in.
        remaining = match[2] === undefined ? 1 : parseInt(match[2], 10);
        inHunk = remaining > 0;
      } else {
        inHunk = false;
      }
      continue;
    }
    if (!inHunk || !currentFile) continue;

    const first = line[0];
    // A context line is " ". A blank context line that lost its trailing space
    // to whitespace stripping arrives as "". Both occupy a line on the new
    // side, so both advance the counter; skipping "" without advancing would
    // shift every subsequent anchor in the hunk by one.
    if (first === "+" || first === " " || first === undefined) {
      let fileLines = map.get(currentFile);
      if (!fileLines) {
        fileLines = new Set();
        map.set(currentFile, fileLines);
      }
      fileLines.add(currentLine);
      currentLine++;
      remaining--;
      if (remaining === 0) {
        inHunk = false;
      }
    }
    // "-" lines exist only on the LEFT side; skip without advancing.
    // "\" lines ("\ No newline at end of file") are informational; skip.
  }

  return map;
}

export type Severity = "critical" | "high" | "medium" | "low";

/**
 * The concrete change being proposed, rendered into a collapsed <details> block
 * so the diff never competes with the finding itself for the author's
 * attention. Optional: plenty of findings ("this needs a decision", "this needs
 * a test we cannot write for you") have no mechanical fix, and inventing a
 * plausible-looking diff for one is worse than omitting the block.
 */
export interface FindingFix {
  /** One or two sentences. The reader has already read `description`. */
  summary: string;
  /**
   * Diff body only — no ```diff fence, the renderer adds it. Unified-diff
   * markers (`-`/`+`/context) are what make the block skimmable; a plain
   * after-the-change snippet forces the reader to diff it by eye.
   */
  diff?: string;
}

export interface Finding {
  id: string;
  file: string;
  line: number;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  /**
   * Reviewer bookkeeping. Never posted to GitHub, so it is optional: a review
   * that has nothing to record here omits it rather than inventing filler.
   */
  evidence?: string;
  fix?: FindingFix;
}

export interface ReviewDocument {
  summary: string;
  findings: Finding[];
}

export interface ReviewAttribution {
  agentName: string;
  humanName: string;
}

function normalizeAttributionName(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (/[\r\n]/.test(normalized)) {
    throw new Error(`${label} must be a single line`);
  }
  return normalized;
}

export function formatFooter(attribution: ReviewAttribution): string {
  const agentName = normalizeAttributionName("Agent name", attribution.agentName);
  const humanName = normalizeAttributionName("Human name", attribution.humanName);
  return `###### Sent from ${agentName}\n\n- [ ] reviewed by @${humanName}`;
}

export function appendFooter(body: string, attribution: ReviewAttribution): string {
  const content = body.trim();
  const footer = formatFooter(attribution);
  return content.length > 0 ? `${content}\n\n${footer}` : footer;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recognises our own footer with the review checkbox in either state.
 *
 * The footer is not inert text: it ends in a checkbox the human reviewer is
 * expected to tick. Matching `formatFooter` verbatim therefore stops matching
 * the moment the review is actually acted on, which is exactly when an amend is
 * most likely — so identification deliberately ignores the box.
 */
export function footerPattern(attribution: ReviewAttribution): RegExp {
  const agentName = escapeRegExp(normalizeAttributionName("Agent name", attribution.agentName));
  const humanName = escapeRegExp(normalizeAttributionName("Human name", attribution.humanName));
  return new RegExp(
    `###### Sent from ${agentName}\\s*\\n\\s*\\n- \\[[ xX]\\] reviewed by @${humanName}`,
  );
}

/**
 * Carries the reviewer's checkbox state across an amend. Rewriting the body
 * would otherwise reset a ticked box to unticked, quietly discarding the
 * reviewer's signal that they had already looked at the comment.
 */
export function preserveReviewCheckbox(rendered: string, existingBody: string): string {
  const alreadyChecked = /- \[[xX]\] reviewed by @/.test(existingBody);
  if (!alreadyChecked) {
    return rendered;
  }
  return rendered.replace(/- \[ \] (reviewed by @)/, "- [x] $1");
}

const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

const REQUIRED_STRING_FIELDS = [
  "id",
  "file",
  "severity",
  "category",
  "title",
  "description",
] as const;

export async function loadReview(path: string): Promise<ReviewDocument> {
  const text = await Bun.file(path).text();
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Review document must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string") {
    throw new Error("Review document: missing 'summary' field (empty string is allowed)");
  }
  if (!Array.isArray(obj.findings)) {
    throw new Error("Review document: 'findings' must be an array");
  }

  const findings: Finding[] = [];
  for (const [i, entry] of obj.findings.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Finding ${i}: not an object`);
    }
    const f = entry as Record<string, unknown>;
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof f[field] !== "string" || (f[field] as string).length === 0) {
        throw new Error(`Finding ${i}: missing or empty string field '${field}'`);
      }
    }
    if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1) {
      throw new Error(`Finding ${i}: invalid line number`);
    }
    if (!SEVERITIES.includes(f.severity as Severity)) {
      throw new Error(`Finding ${i}: invalid severity '${String(f.severity)}'`);
    }
    if (f.evidence !== undefined && typeof f.evidence !== "string") {
      throw new Error(`Finding ${i}: 'evidence' must be a string when present`);
    }
    findings.push({
      id: f.id as string,
      file: f.file as string,
      line: f.line,
      severity: f.severity as Severity,
      category: f.category as string,
      title: f.title as string,
      description: f.description as string,
      evidence: f.evidence as string | undefined,
      fix: parseFix(i, f.fix),
    });
  }

  return { summary: obj.summary, findings };
}

/**
 * Rejects a `fix` that is present but unusable rather than rendering an empty
 * "Recommended fix" block. A collapsed section the author expands to find
 * nothing is worse than no section at all.
 */
function parseFix(index: number, raw: unknown): FindingFix | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Finding ${index}: 'fix' must be an object when present`);
  }
  const fix = raw as Record<string, unknown>;
  if (typeof fix.summary !== "string" || fix.summary.trim().length === 0) {
    throw new Error(`Finding ${index}: 'fix.summary' must be a non-empty string`);
  }
  if (fix.diff !== undefined) {
    if (typeof fix.diff !== "string" || fix.diff.trim().length === 0) {
      throw new Error(`Finding ${index}: 'fix.diff' must be a non-empty string when present`);
    }
    if (/^\s*```/.test(fix.diff)) {
      throw new Error(
        `Finding ${index}: 'fix.diff' must be the diff body only — the renderer adds the ` +
          "```diff fence, so a pre-fenced value nests and renders as literal backticks",
      );
    }
  }
  return {
    summary: fix.summary,
    diff: fix.diff as string | undefined,
  };
}

export interface Partition {
  anchorable: Finding[];
  dropped: Finding[];
}

export function partitionFindings(findings: Finding[], hunks: HunkMap): Partition {
  const anchorable: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    const fileLines = hunks.get(f.file);
    if (fileLines && fileLines.has(f.line)) {
      anchorable.push(f);
    } else {
      dropped.push(f);
    }
  }
  return { anchorable, dropped };
}

export function collectCriticalDrops(dropped: Finding[]): Finding[] {
  return dropped.filter((f) => f.severity === "critical");
}

/**
 * Non-critical drops are skipped rather than fatal, but skipping them silently
 * reads as "everything posted". Name each one so the caller can re-anchor it or
 * fold it into the review body deliberately.
 */
export function formatDroppedNotice(dropped: Finding[]): string {
  const noun = dropped.length === 1 ? "finding does" : "findings do";
  const lines = dropped.map((f) => `  - ${f.id}  ${f.file}:${f.line}  ${f.title}`);
  return [
    `${dropped.length} ${noun} not anchor to the PR diff and will not be posted:`,
    "",
    ...lines,
    "",
    "GitHub review comments attach only to lines present in the PR's right-hand",
    "hunks. Re-anchor each one to a changed line, or move it into the summary.",
  ].join("\n");
}

export function formatHeadMismatchAbort(expected: string, actual: string): string {
  return [
    "Aborting: the pull request moved since this review was written.",
    "",
    `  reviewed at head: ${expected}`,
    `  current head:     ${actual}`,
    "",
    "Line anchors were computed against the old diff, so they may attach to",
    "unrelated code or fail to attach at all. Re-fetch the diff, re-verify each",
    "finding's file and line against it, then resubmit with the new",
    "--expect-head value.",
  ].join("\n");
}

export function formatCriticalAbort(criticals: Finding[]): string {
  const lines = criticals.map((f) => `  - ${f.file}:${f.line}  ${f.title}`);
  return [
    "Aborting: critical findings do not anchor to the PR diff.",
    "",
    "GitHub review comments can only attach to lines present in the PR's",
    "right-hand hunks. These critical findings point at lines outside the",
    "diff, so they would be silently dropped:",
    "",
    ...lines,
    "",
    "Resolution options:",
    "  1. Re-anchor each finding to a line that IS in the diff (the nearest",
    "     changed line that preserves context is usually fine).",
    "  2. Downgrade to high/medium if the severity was set for reviewer",
    "     emphasis rather than production-critical impact.",
    "  3. Post the review manually (not through this script) if the finding",
    "     genuinely needs to call out unchanged code.",
  ].join("\n");
}

const METHODOLOGY_TOKENS: readonly RegExp[] = [
  /\bopus\b/i,
  /\bcodex\b/i,
  /\bgpt-?5\b/i,
  /\bo3\b/i,
  /\bcorroborat(ed|ion)\b/i,
  /\bcontested\b/i,
  /\bsecond[-\s]opinion\b/i,
  /\bsynth(esis)?\b/i,
  /\breviewed with\b/i,
  /\bsources:\s*\[/i,
  /\btwo reviewers\b/i,
  /\bboth (reviewers|models|agents)\b/i,
  /\b(primary|secondary|dual)[-\s](pass|reviewer|review)\b/i,
];

export interface MethodologyLeak {
  field: string;
  token: string;
  excerpt: string;
}

function scanForMethodologyTokens(field: string, text: string): MethodologyLeak[] {
  const leaks: MethodologyLeak[] = [];
  for (const pattern of METHODOLOGY_TOKENS) {
    const match = text.match(pattern);
    if (!match) continue;
    const start = Math.max(0, (match.index ?? 0) - 20);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 20);
    leaks.push({
      field,
      token: match[0],
      excerpt: text.slice(start, end).replace(/\s+/g, " ").trim(),
    });
  }
  return leaks;
}

export function detectMethodologyLeaks(summary: string, findings: Finding[]): MethodologyLeak[] {
  const leaks: MethodologyLeak[] = [];
  leaks.push(...scanForMethodologyTokens("summary", summary));
  for (const f of findings) {
    leaks.push(...scanForMethodologyTokens(`${f.id}.title`, f.title));
    leaks.push(...scanForMethodologyTokens(`${f.id}.description`, f.description));
    if (f.evidence !== undefined) {
      leaks.push(...scanForMethodologyTokens(`${f.id}.evidence`, f.evidence));
    }
  }
  return leaks;
}

export function formatMethodologyAbort(leaks: MethodologyLeak[]): string {
  const lines = leaks.map((l) => `  - ${l.field}: matched "${l.token}" in "...${l.excerpt}..."`);
  return [
    "Aborting: review text contains methodology chrome.",
    "",
    "A PR review must read as if a human wrote it. Internal reviewer bookkeeping",
    "(parallel reviewer names, synthesis terminology, confidence tags) does not",
    "belong in the body the PR author reads. Offending matches:",
    "",
    ...lines,
    "",
    "Rewrite the summary/findings without mentioning the review methodology and",
    "resubmit.",
  ].join("\n");
}

/**
 * Renders the severity badge that opens every inline comment. The author reads
 * comments one at a time, out of order, with no access to the findings file, so
 * the badge is the only thing telling them whether a comment blocks the merge
 * or is a nit they can wave through.
 */
export function formatSeverityBadge(severity: Severity): string {
  return `**[${severity.toUpperCase()}]**`;
}

/**
 * The fix goes in a collapsed <details> so the comment still reads as a review
 * at a glance. An author scanning ten comments wants the finding; an author who
 * has accepted one wants the patch. Blank lines around the block are required —
 * GitHub stops parsing markdown inside <details> without them, and the diff
 * would render as one run-on line.
 */
export function renderFix(fix: FindingFix): string {
  const parts = ["<details>", "<summary>Recommended fix</summary>", "", fix.summary.trim()];
  if (fix.diff !== undefined) {
    parts.push("", "```diff", fix.diff.replace(/\n+$/, ""), "```");
  }
  parts.push("", "</details>");
  return parts.join("\n");
}

export function renderFinding(f: Finding, attribution: ReviewAttribution): string {
  const sections = [formatSeverityBadge(f.severity), f.description];
  if (f.fix !== undefined) {
    sections.push(renderFix(f.fix));
  }
  return appendFooter(sections.join("\n\n"), attribution);
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface ReviewPayload {
  body: string;
  /**
   * Omitted entirely for a pending (draft) review. GitHub's reviews endpoint
   * treats a missing `event` as "leave this review in PENDING state", which is
   * the only way to create a draft the author can keep adding to in the UI
   * before submitting. Sending `event: "COMMENT"` publishes immediately.
   */
  event?: "COMMENT";
  comments: ReviewComment[];
}

export function buildPayload(
  summary: string,
  anchorable: Finding[],
  attribution: ReviewAttribution,
  pending = false,
): ReviewPayload {
  return {
    body: appendFooter(summary, attribution),
    ...(pending ? {} : { event: "COMMENT" as const }),
    comments: anchorable.map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT",
      body: renderFinding(f, attribution),
    })),
  };
}

import { parseArgs } from "node:util";

interface CliFlags {
  pr: string;
  owner: string;
  repo: string;
  findings: string;
  agentName: string;
  humanName: string;
  dryRun: boolean;
  pending: boolean;
  expectHead: string | null;
  updateExisting: boolean;
}

function parseCli(args: string[]): CliFlags {
  const { values } = parseArgs({
    args,
    options: {
      pr: { type: "string" },
      owner: { type: "string" },
      repo: { type: "string" },
      findings: { type: "string" },
      "agent-name": { type: "string" },
      "human-name": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      pending: { type: "boolean", default: false },
      "expect-head": { type: "string" },
      "update-existing": { type: "boolean", default: false },
    },
  });
  for (const required of ["pr", "owner", "repo", "findings", "agent-name", "human-name"] as const) {
    if (typeof values[required] !== "string" || values[required] === "") {
      throw new Error(`Missing required flag --${required}`);
    }
  }
  return {
    pr: values.pr as string,
    owner: values.owner as string,
    repo: values.repo as string,
    findings: values.findings as string,
    agentName: values["agent-name"] as string,
    humanName: values["human-name"] as string,
    dryRun: values["dry-run"] === true,
    pending: values.pending === true,
    expectHead: typeof values["expect-head"] === "string" ? values["expect-head"] : null,
    updateExisting: values["update-existing"] === true,
  };
}

/**
 * Every gh call names the repository explicitly. Without --repo, gh infers it
 * from the working directory, so the script would resolve a different PR (or
 * fail outright) depending on where it happened to be invoked from, even though
 * --owner and --repo were supplied.
 */
async function fetchPrDiff(pr: string, repo: string): Promise<string> {
  const gh = process.env.GH_PATH ?? "gh";
  // Plain `gh pr diff`, never `--patch`. `--patch` emits format-patch output:
  // one diff per commit, each numbered against that commit's parent. On a
  // multi-commit PR a line touched by an early commit and re-touched later
  // resolves to an intermediate line number, so anchors computed from it miss
  // the PR's final right-hand side and GitHub silently drops the comment.
  const proc = Bun.spawn([gh, "pr", "diff", pr, "--repo", repo], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh pr diff ${pr} failed (exit ${code}): ${stderr}`);
  }
  return stdout;
}

/**
 * The script fetches its own diff, so the revision it anchors against can drift
 * from the one the review was written against. Reporting the head makes that
 * drift visible, and --expect-head turns it into a hard stop.
 */
async function fetchPrHeadSha(pr: string, repo: string): Promise<string> {
  const gh = process.env.GH_PATH ?? "gh";
  const args = [
    gh,
    "pr",
    "view",
    pr,
    "--repo",
    repo,
    "--json",
    "headRefOid",
    "--jq",
    ".headRefOid",
  ];
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh pr view ${pr} failed (exit ${code}): ${stderr}`);
  }
  return stdout.trim();
}

export interface DryRunOutput {
  payload: ReviewPayload;
  head_sha: string;
  counters: {
    inline: number;
    dropped: number;
    critical_dropped: number;
  };
  dropped: Finding[];
  critical_dropped: Finding[];
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const review = await loadReview(cli.findings);

  const methodologyLeaks = detectMethodologyLeaks(review.summary, review.findings);
  if (methodologyLeaks.length > 0) {
    throw new Error(formatMethodologyAbort(methodologyLeaks));
  }

  const repo = `${cli.owner}/${cli.repo}`;
  const headSha = await fetchPrHeadSha(cli.pr, repo);
  if (cli.expectHead !== null && cli.expectHead !== headSha) {
    throw new Error(formatHeadMismatchAbort(cli.expectHead, headSha));
  }

  const diff = await fetchPrDiff(cli.pr, repo);
  const hunks = parseHunks(diff);
  const { anchorable, dropped } = partitionFindings(review.findings, hunks);
  const criticalDropped = collectCriticalDrops(dropped);
  const payload = buildPayload(
    review.summary,
    anchorable,
    { agentName: cli.agentName, humanName: cli.humanName },
    cli.pending,
  );

  if (cli.dryRun) {
    const out: DryRunOutput = {
      payload,
      head_sha: headSha,
      counters: {
        inline: anchorable.length,
        dropped: dropped.length,
        critical_dropped: criticalDropped.length,
      },
      dropped,
      critical_dropped: criticalDropped,
    };
    console.log(JSON.stringify(out, null, 2));
    if (dropped.length > 0) {
      console.error(formatDroppedNotice(dropped));
    }
    if (criticalDropped.length > 0) {
      console.error(formatCriticalAbort(criticalDropped));
      process.exit(2);
    }
    return;
  }

  if (criticalDropped.length > 0) {
    throw new Error(formatCriticalAbort(criticalDropped));
  }

  if (dropped.length > 0) {
    console.error(formatDroppedNotice(dropped));
  }

  if (anchorable.length === 0) {
    console.error("No findings anchor to the PR diff; nothing to submit.");
    return;
  }

  if (cli.updateExisting) {
    const existing = await fetchExistingComments(cli.owner, cli.repo, cli.pr);
    const { matched, unmatched } = matchExistingComments(payload.comments, existing, {
      agentName: cli.agentName,
      humanName: cli.humanName,
    });
    if (matched.length === 0) {
      throw new Error(
        "--update-existing matched no comments on this PR. Nothing was changed. Either the " +
          "review was never posted, its anchors have moved, or it was posted under a " +
          "different --agent-name/--human-name than the footer it carries.",
      );
    }
    await updateExistingComments(cli.owner, cli.repo, matched);
    if (unmatched.length > 0) {
      console.error(
        `\n${unmatched.length} finding(s) had no existing comment to update and were NOT ` +
          "posted. Re-run without --update-existing to add them as a new review:\n" +
          unmatched.map((c) => `  ${c.path}:${c.line}`).join("\n"),
      );
    }
    console.log(`updated ${matched.length} comment(s) on PR #${cli.pr}`);
    return;
  }

  const url = await submitReview(cli.owner, cli.repo, cli.pr, payload);
  if (cli.pending) {
    console.error(
      "Left as a PENDING review — visible only to you until you submit it from the " +
        "PR's Files changed tab. GitHub allows one pending review per user per PR.",
    );
  }
  console.log(url);
}

export interface ExistingComment {
  id: number;
  path: string;
  line: number;
  body: string;
}

export interface CommentMatch {
  comment: ReviewComment;
  existingId: number;
}

export interface MatchResult {
  matched: CommentMatch[];
  unmatched: ReviewComment[];
}

/**
 * Pairs freshly rendered comments with the ones already on the PR, keyed by
 * (path, line).
 *
 * Only comments carrying the attribution footer are candidates. Without that
 * filter an amend would silently overwrite a human reviewer's comment that
 * happened to sit on the same line — the one failure mode here that cannot be
 * undone from the API, since PATCH keeps no history the author can recover.
 *
 * A line matched twice is left alone rather than guessed at: two agent comments
 * on one line means the review changed shape, and picking one arbitrarily would
 * rewrite the wrong finding.
 */
export function matchExistingComments(
  rendered: ReviewComment[],
  existing: ExistingComment[],
  attribution: ReviewAttribution,
): MatchResult {
  const footer = footerPattern(attribution);
  const byAnchor = new Map<string, ExistingComment[]>();
  for (const c of existing) {
    if (!footer.test(c.body)) {
      continue;
    }
    const key = `${c.path}:${c.line}`;
    byAnchor.set(key, [...(byAnchor.get(key) ?? []), c]);
  }

  const matched: CommentMatch[] = [];
  const unmatched: ReviewComment[] = [];
  for (const comment of rendered) {
    const candidates = byAnchor.get(`${comment.path}:${comment.line}`) ?? [];
    if (candidates.length === 1) {
      matched.push({
        comment: {
          ...comment,
          body: preserveReviewCheckbox(comment.body, candidates[0].body),
        },
        existingId: candidates[0].id,
      });
    } else {
      unmatched.push(comment);
    }
  }
  return { matched, unmatched };
}

async function fetchExistingComments(
  owner: string,
  repo: string,
  pr: string,
): Promise<ExistingComment[]> {
  const stdout = await runGh([
    "api",
    "--paginate",
    `/repos/${owner}/${repo}/pulls/${pr}/comments`,
    "-H",
    "Accept: application/vnd.github+json",
  ]);
  // --paginate concatenates JSON arrays across pages; gh emits them as separate
  // top-level arrays, so parse per-array rather than assuming a single value.
  const chunks = stdout.replace(/\]\s*\[/g, "],[");
  const parsed: unknown = JSON.parse(`[${chunks}]`);
  const flat = (Array.isArray(parsed) ? parsed : []).flat();
  const comments: ExistingComment[] = [];
  for (const entry of flat) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const c = entry as Record<string, unknown>;
    const line = typeof c.line === "number" ? c.line : c.original_line;
    if (typeof c.id !== "number" || typeof c.path !== "string" || typeof line !== "number") {
      continue;
    }
    comments.push({
      id: c.id,
      path: c.path,
      line,
      body: typeof c.body === "string" ? c.body : "",
    });
  }
  return comments;
}

async function updateExistingComments(
  owner: string,
  repo: string,
  matched: CommentMatch[],
): Promise<void> {
  for (const { comment, existingId } of matched) {
    await runGh(
      [
        "api",
        "-X",
        "PATCH",
        `/repos/${owner}/${repo}/pulls/comments/${existingId}`,
        "-H",
        "Accept: application/vnd.github+json",
        "--input",
        "-",
      ],
      JSON.stringify({ body: comment.body }),
    );
    console.error(`updated ${comment.path}:${comment.line} (comment ${existingId})`);
  }
}

async function runGh(args: string[], stdin?: string): Promise<string> {
  const gh = process.env.GH_PATH ?? "gh";
  const proc = Bun.spawn([gh, ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`);
  }
  return stdout;
}

async function submitReview(
  owner: string,
  repo: string,
  pr: string,
  payload: ReviewPayload,
): Promise<string> {
  const gh = process.env.GH_PATH ?? "gh";
  const proc = Bun.spawn(
    [
      gh,
      "api",
      "-X",
      "POST",
      `/repos/${owner}/${repo}/pulls/${pr}/reviews`,
      "-H",
      "Accept: application/vnd.github+json",
      "--input",
      "-",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const body = stderr + stdout;
    const hint = payload.comments.map((c) => `${c.path}:${c.line}`).join(", ");
    throw new Error(
      `gh api POST review failed (exit ${code}). Response: ${body}\n` +
        `Attempted inline anchors: ${hint}`,
    );
  }
  try {
    const response: unknown = JSON.parse(stdout);
    if (
      typeof response === "object" &&
      response !== null &&
      typeof (response as Record<string, unknown>).html_url === "string"
    ) {
      return (response as { html_url: string }).html_url;
    }
  } catch {
    // fall through
  }
  return "(review submitted; no html_url in response)";
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
