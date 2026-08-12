import { test, expect } from "bun:test";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFooter } from "./submit-pr-review.ts";
import { buildPayload } from "./submit-pr-review.ts";
import { collectCriticalDrops } from "./submit-pr-review.ts";
import { detectMethodologyLeaks } from "./submit-pr-review.ts";
import { formatDroppedNotice } from "./submit-pr-review.ts";
import { formatHeadMismatchAbort } from "./submit-pr-review.ts";
import { loadReview } from "./submit-pr-review.ts";
import { parseHunks } from "./submit-pr-review.ts";
import { partitionFindings } from "./submit-pr-review.ts";
import { renderFinding } from "./submit-pr-review.ts";
import type { Finding } from "./submit-pr-review.ts";

async function makeTempJsonFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-test-"));
  return join(dir, "review.json");
}

test("parseHunks: multi-hunk multi-file diff with new and deleted files", async () => {
  const patch = await Bun.file(new URL("./testdata/pr-diff.patch", import.meta.url)).text();
  const hunks = parseHunks(patch);

  expect(hunks.size).toBe(2);
  expect([...(hunks.get("src/auth.ts") ?? [])].toSorted((a, b) => a - b)).toEqual([
    10, 11, 12, 13, 14, 15, 16, 17,
  ]);
  expect([...(hunks.get("src/new-file.ts") ?? [])].toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
  expect(hunks.get("src/deleted.ts")).toBeUndefined();
});

test("parseHunks: hunk header without count defaults to 1", () => {
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -5 +5 @@
-old
+new
`;
  const hunks = parseHunks(patch);
  expect([...(hunks.get("x.ts") ?? [])]).toEqual([5]);
});

test("parseHunks: deletion-only hunk does not advance new-side counter", () => {
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,3 +10,1 @@
 keep
-drop
-drop
`;
  const hunks = parseHunks(patch);
  expect([...(hunks.get("x.ts") ?? [])]).toEqual([10]);
});

test("parseHunks: blank context line stripped of its leading space still advances", () => {
  // Line 11 is a blank context line written as "" rather than " ". Whitespace
  // stripping anywhere in the pipeline produces that, and every line after it
  // has to keep its real number.
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,4 +10,4 @@
 first

 third
+fourth
`;
  const hunks = parseHunks(patch);
  expect([...(hunks.get("x.ts") ?? [])].toSorted((a, b) => a - b)).toEqual([10, 11, 12, 13]);
});

test("parseHunks: trailing empty string after the final hunk adds no phantom line", () => {
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
 first
+second
`;
  const hunks = parseHunks(patch);
  expect([...(hunks.get("x.ts") ?? [])].toSorted((a, b) => a - b)).toEqual([1, 2]);
});

test("parseHunks: content past the declared new-side count is not consumed", () => {
  // The format-patch signature trails the final hunk. Its version line would
  // read as a context line if the hunk were not bounded by its header count.
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,1 @@
+only
--
2.51.0
`;
  const hunks = parseHunks(patch);
  expect([...(hunks.get("x.ts") ?? [])]).toEqual([1]);
});

test("loadReview: valid document parses into typed shape", async () => {
  const path = new URL("./testdata/review.json", import.meta.url);
  const doc = await loadReview(path.pathname);
  expect(doc.findings.length).toBe(3);
  expect(doc.findings[0].id).toBe("SEC-001");
  expect(doc.findings[0].line).toBe(14);
  expect(doc.summary.startsWith("Reviewed")).toBe(true);
});

test("loadReview: rejects missing summary", async () => {
  const path = await makeTempJsonFile();
  await Bun.write(path, JSON.stringify({ findings: [] }));
  try {
    await loadReview(path);
    throw new Error("expected loadReview to throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg.includes("summary")).toBe(true);
  } finally {
    await unlink(path);
  }
});

test("loadReview: rejects finding with invalid severity", async () => {
  const path = await makeTempJsonFile();
  await Bun.write(
    path,
    JSON.stringify({
      summary: "x",
      findings: [
        {
          id: "X",
          file: "a.ts",
          line: 1,
          severity: "extreme",
          category: "security",
          title: "t",
          description: "d",
          evidence: "e",
        },
      ],
    }),
  );
  try {
    await loadReview(path);
    throw new Error("expected loadReview to throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg.includes("severity")).toBe(true);
  } finally {
    await unlink(path);
  }
});

test("partitionFindings: keeps in-hunk, drops out-of-hunk", async () => {
  const patch = await Bun.file(new URL("./testdata/pr-diff.patch", import.meta.url)).text();
  const hunks = parseHunks(patch);
  const review = await loadReview(new URL("./testdata/review.json", import.meta.url).pathname);

  const { anchorable, dropped } = partitionFindings(review.findings, hunks);

  expect(anchorable.map((f) => f.id)).toEqual(["SEC-001", "STY-001"]);
  expect(dropped.map((f) => f.id)).toEqual(["ARCH-001"]);
});

test("appendFooter: formats the required attribution footer", () => {
  expect(appendFooter("Summary.", { agentName: "Codex", humanName: "Wyatt Johnson" })).toBe(
    "Summary.\n\n###### Sent from Codex\n\n- [ ] reviewed by Wyatt Johnson",
  );
});

test("renderFinding: emits description and attribution footer", () => {
  const body = renderFinding(
    {
      id: "SEC-001",
      file: "src/auth.ts",
      line: 14,
      severity: "high",
      category: "security",
      title: "Token logged before validation",
      description: "Raw token exposure in logs.",
      evidence: 'console.log("validating", trimmed);',
    },
    { agentName: "Codex", humanName: "Wyatt Johnson" },
  );

  expect(body).toBe(
    "Raw token exposure in logs.\n\n###### Sent from Codex\n\n- [ ] reviewed by Wyatt Johnson",
  );
});

test("buildPayload: matches golden fixture for auth-diff scenario", async () => {
  const patch = await Bun.file(new URL("./testdata/pr-diff.patch", import.meta.url)).text();
  const hunks = parseHunks(patch);
  const review = await loadReview(new URL("./testdata/review.json", import.meta.url).pathname);
  const { anchorable } = partitionFindings(review.findings, hunks);

  const payload = buildPayload(review.summary, anchorable, {
    agentName: "Codex",
    humanName: "Wyatt Johnson",
  });

  const expected = JSON.parse(
    await Bun.file(new URL("./testdata/expected-payload.json", import.meta.url)).text(),
  );
  expect(payload).toEqual(expected);
});

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "SEC-001",
    file: "src/auth.ts",
    line: 14,
    severity: "high",
    category: "security",
    title: "Title",
    description: "Description.",
    evidence: "code;",
    ...over,
  };
}

test("collectCriticalDrops: returns only findings with severity critical", () => {
  const dropped: Finding[] = [
    mkFinding({ id: "A", severity: "critical" }),
    mkFinding({ id: "B", severity: "high" }),
    mkFinding({ id: "C", severity: "critical" }),
    mkFinding({ id: "D", severity: "low" }),
  ];
  const criticals = collectCriticalDrops(dropped);
  expect(criticals.map((f) => f.id)).toEqual(["A", "C"]);
});

test("collectCriticalDrops: empty when no criticals", () => {
  const dropped: Finding[] = [
    mkFinding({ id: "A", severity: "high" }),
    mkFinding({ id: "B", severity: "medium" }),
  ];
  expect(collectCriticalDrops(dropped)).toEqual([]);
});

test("detectMethodologyLeaks: catches 'Reviewed with Opus + Codex' in summary", () => {
  const leaks = detectMethodologyLeaks("Reviewed with Opus + Codex second-opinion validation.", []);
  const fields = leaks.map((l) => l.field);
  expect(fields.includes("summary")).toBe(true);
  const tokensLower = leaks.map((l) => l.token.toLowerCase());
  expect(tokensLower.some((t) => t.includes("opus"))).toBe(true);
  expect(tokensLower.some((t) => t.includes("codex"))).toBe(true);
});

test("detectMethodologyLeaks: catches '(codex confirmed)' in finding description", () => {
  const leaks = detectMethodologyLeaks("Clean summary.", [
    mkFinding({ description: "(codex confirmed) Issue details." }),
  ]);
  expect(leaks.length > 0).toBe(true);
  expect(leaks[0].field).toBe("SEC-001.description");
});

test("detectMethodologyLeaks: clean review passes without leaks", () => {
  const leaks = detectMethodologyLeaks(
    "Overall the change looks solid. Focus review on the token path.",
    [
      mkFinding({
        description: "Token is logged before validation.",
        evidence: "console.log(token)",
      }),
    ],
  );
  expect(leaks).toEqual([]);
});

test("detectMethodologyLeaks: catches corroboration/synthesis terminology", () => {
  const leaks = detectMethodologyLeaks(
    "Two reviewers corroborated this finding after synthesis.",
    [],
  );
  const tokensLower = leaks.map((l) => l.token.toLowerCase());
  expect(tokensLower.some((t) => t.startsWith("corroborat"))).toBe(true);
  expect(tokensLower.some((t) => t.startsWith("synthesis"))).toBe(true);
});

test("detectMethodologyLeaks: catches 'the synth agent' without full 'synthesis'", () => {
  const leaks = detectMethodologyLeaks("The synth agent flagged this.", []);
  expect(leaks.length > 0).toBe(true);
  expect(leaks.some((l) => l.token.toLowerCase() === "synth")).toBe(true);
});

test("detectMethodologyLeaks: catches 'two reviewers agreed'", () => {
  const leaks = detectMethodologyLeaks("Two reviewers agreed that this path is suspect.", []);
  expect(leaks.some((l) => l.token.toLowerCase().startsWith("two reviewers"))).toBe(true);
});

test("detectMethodologyLeaks: catches 'both models' / 'both reviewers' / 'both agents'", () => {
  for (const phrase of ["both models", "both reviewers", "both agents"]) {
    const leaks = detectMethodologyLeaks(`${phrase} flagged this.`, []);
    expect(leaks.length > 0).toBe(true);
  }
});

test("detectMethodologyLeaks: catches 'o3 said' model attribution", () => {
  const leaks = detectMethodologyLeaks("o3 said this is risky.", []);
  expect(leaks.some((l) => l.token.toLowerCase() === "o3")).toBe(true);
});

test("detectMethodologyLeaks: catches 'the secondary pass' / 'dual review'", () => {
  for (const phrase of [
    "the secondary pass found this",
    "a dual review flagged this",
    "the primary reviewer agreed",
  ]) {
    const leaks = detectMethodologyLeaks(phrase, []);
    expect(leaks.length > 0).toBe(true);
  }
});

test("loadReview: accepts a finding that omits the optional evidence field", async () => {
  const path = await makeTempJsonFile();
  await Bun.write(
    path,
    JSON.stringify({
      summary: "x",
      findings: [
        {
          id: "SEC-001",
          file: "a.ts",
          line: 1,
          severity: "high",
          category: "security",
          title: "t",
          description: "d",
        },
      ],
    }),
  );
  try {
    const doc = await loadReview(path);
    expect(doc.findings[0].evidence).toBe(undefined);
  } finally {
    await unlink(path);
  }
});

test("loadReview: rejects a non-string evidence field", async () => {
  const path = await makeTempJsonFile();
  await Bun.write(
    path,
    JSON.stringify({
      summary: "x",
      findings: [
        {
          id: "SEC-001",
          file: "a.ts",
          line: 1,
          severity: "high",
          category: "security",
          title: "t",
          description: "d",
          evidence: 42,
        },
      ],
    }),
  );
  try {
    await loadReview(path);
    throw new Error("expected loadReview to throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg.includes("evidence")).toBe(true);
  } finally {
    await unlink(path);
  }
});

test("detectMethodologyLeaks: scans evidence when the field is present", () => {
  const leaks = detectMethodologyLeaks("Clean summary.", [
    mkFinding({ description: "Clean description.", evidence: "flagged during synthesis" }),
  ]);
  expect(leaks.map((l) => l.field)).toEqual(["SEC-001.evidence"]);
});

test("formatDroppedNotice: names every dropped finding", () => {
  const notice = formatDroppedNotice([
    mkFinding({ id: "SEC-001", file: "src/auth.ts", line: 14, title: "Token logged" }),
    mkFinding({ id: "STY-002", file: "src/ui.tsx", line: 8, title: "Naming" }),
  ]);
  expect(notice.includes("2 findings do not anchor")).toBe(true);
  expect(notice.includes("SEC-001  src/auth.ts:14  Token logged")).toBe(true);
  expect(notice.includes("STY-002  src/ui.tsx:8  Naming")).toBe(true);
});

test("formatDroppedNotice: uses singular wording for one finding", () => {
  const notice = formatDroppedNotice([mkFinding({ id: "SEC-001" })]);
  expect(notice.includes("1 finding does not anchor")).toBe(true);
});

test("formatHeadMismatchAbort: reports both revisions", () => {
  const message = formatHeadMismatchAbort("aaaa111", "bbbb222");
  expect(message.includes("reviewed at head: aaaa111")).toBe(true);
  expect(message.includes("current head:     bbbb222")).toBe(true);
});
