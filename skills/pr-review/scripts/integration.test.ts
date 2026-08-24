import { test, expect } from "bun:test";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "submit-pr-review.ts");
const FAKE_GH = join(HERE, "testdata/fake-gh");
const DIFF = join(HERE, "testdata/pr-diff.patch");
const REVIEW = join(HERE, "testdata/review.json");
const EXPECTED = join(HERE, "testdata/expected-payload.json");
const ATTRIBUTION_ARGS = ["--agent-name", "Codex", "--human-name", "wyattjoh"];

async function makeTempFile(suffix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-integration-"));
  return join(dir, `tmp${suffix}`);
}

async function runScript(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args, ...ATTRIBUTION_ARGS], {
    env: {
      ...process.env,
      GH_PATH: FAKE_GH,
      FAKE_GH_DIFF_FILE: DIFF,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("integration: --dry-run prints payload and counters, does not call gh api", async () => {
  const result = await runScript([
    "--pr",
    "123",
    "--owner",
    "acme",
    "--repo",
    "widgets",
    "--findings",
    REVIEW,
    "--dry-run",
  ]);

  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  const expected = JSON.parse(await Bun.file(EXPECTED).text());
  expect(parsed.payload).toEqual(expected);
  expect(parsed.counters).toEqual({ inline: 2, dropped: 1, critical_dropped: 0 });
  expect(parsed.critical_dropped).toEqual([]);
  expect(parsed.head_sha).toBe("1111111111111111111111111111111111111111");
  expect(parsed.dropped.map((f: { id: string }) => f.id)).toEqual(["ARCH-001"]);
  expect(result.stderr.includes("ARCH-001  src/unrelated.ts:99")).toBe(true);
});

test("integration: submit mode names dropped findings on stderr", async () => {
  const capture = await makeTempFile(".json");
  const stdoutFile = await makeTempFile(".json");
  await Bun.write(stdoutFile, JSON.stringify({ html_url: "https://example.test/r/1" }));

  try {
    const result = await runScript(
      ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", REVIEW],
      { FAKE_GH_CAPTURE_FILE: capture, FAKE_GH_API_STDOUT_FILE: stdoutFile },
    );

    expect(result.code).toBe(0);
    expect(result.stderr.includes("1 finding does not anchor")).toBe(true);
    expect(result.stderr.includes("ARCH-001  src/unrelated.ts:99")).toBe(true);
  } finally {
    await unlink(capture);
    await unlink(stdoutFile);
  }
});

test("integration: --expect-head mismatch aborts before fetching the diff or posting", async () => {
  const invocationLog = await makeTempFile(".log");
  try {
    const result = await runScript(
      [
        "--pr",
        "123",
        "--owner",
        "acme",
        "--repo",
        "widgets",
        "--findings",
        REVIEW,
        "--expect-head",
        "0000000000000000000000000000000000000000",
      ],
      { FAKE_GH_INVOCATION_LOG: invocationLog },
    );

    expect(result.code).toBe(1);
    expect(result.stderr.includes("moved since this review was written")).toBe(true);
    const invocations = await readInvocations(invocationLog);
    expect(invocations).toEqual(["pr view"]);
  } finally {
    await unlink(invocationLog).catch(() => {});
  }
});

test("integration: --expect-head matching the current head submits normally", async () => {
  const capture = await makeTempFile(".json");
  const stdoutFile = await makeTempFile(".json");
  await Bun.write(stdoutFile, JSON.stringify({ html_url: "https://example.test/r/2" }));

  try {
    const result = await runScript(
      [
        "--pr",
        "123",
        "--owner",
        "acme",
        "--repo",
        "widgets",
        "--findings",
        REVIEW,
        "--expect-head",
        "1111111111111111111111111111111111111111",
      ],
      { FAKE_GH_CAPTURE_FILE: capture, FAKE_GH_API_STDOUT_FILE: stdoutFile },
    );

    expect(result.code).toBe(0);
    const captured = JSON.parse(await Bun.file(capture).text());
    const expected = JSON.parse(await Bun.file(EXPECTED).text());
    expect(captured).toEqual(expected);
  } finally {
    await unlink(capture);
    await unlink(stdoutFile);
  }
});

test("integration: submit mode POSTs payload via gh api", async () => {
  const capture = await makeTempFile(".json");
  const stdoutFile = await makeTempFile(".json");
  await Bun.write(
    stdoutFile,
    JSON.stringify({
      html_url: "https://github.com/acme/widgets/pull/123#pullrequestreview-1",
    }),
  );

  try {
    const result = await runScript(
      ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", REVIEW],
      {
        FAKE_GH_CAPTURE_FILE: capture,
        FAKE_GH_API_STDOUT_FILE: stdoutFile,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout.includes("pullrequestreview-1")).toBe(true);

    const captured = JSON.parse(await Bun.file(capture).text());
    const expected = JSON.parse(await Bun.file(EXPECTED).text());
    expect(captured).toEqual(expected);
  } finally {
    await unlink(capture);
    await unlink(stdoutFile);
  }
});

test("integration: submit fails closed when gh api exits non-zero", async () => {
  const result = await runScript(
    ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", REVIEW],
    { FAKE_GH_API_EXIT: "1" },
  );
  expect(result.code).toBe(1);
  expect(result.stderr.toLowerCase().includes("failed")).toBe(true);
});

test("integration: empty-anchorable short-circuit", async () => {
  const reviewOnlyDropped = await makeTempFile(".json");
  await Bun.write(
    reviewOnlyDropped,
    JSON.stringify({
      summary: "summary",
      findings: [
        {
          id: "ARCH-001",
          file: "src/unrelated.ts",
          line: 99,
          severity: "medium",
          category: "architecture",
          title: "t",
          description: "d",
          evidence: "e",
        },
      ],
    }),
  );
  try {
    const result = await runScript([
      "--pr",
      "123",
      "--owner",
      "acme",
      "--repo",
      "widgets",
      "--findings",
      reviewOnlyDropped,
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counters).toEqual({ inline: 0, dropped: 1, critical_dropped: 0 });
  } finally {
    await unlink(reviewOnlyDropped);
  }
});

async function readInvocations(path: string): Promise<string[]> {
  try {
    const text = await Bun.file(path).text();
    return text.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

test("integration: critical finding outside diff aborts dry-run with exit 2 and does not POST", async () => {
  const review = await makeTempFile(".json");
  const invocationLog = await makeTempFile(".log");
  await Bun.write(
    review,
    JSON.stringify({
      summary: "Overview of the change for the PR author.",
      findings: [
        {
          id: "SEC-001",
          file: "src/unrelated.ts",
          line: 99,
          severity: "critical",
          category: "security",
          title: "Unsanitized input reaches shell",
          description: "This line is not in the diff.",
          evidence: "exec(req.body.cmd);",
        },
      ],
    }),
  );
  try {
    const result = await runScript(
      ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", review, "--dry-run"],
      { FAKE_GH_INVOCATION_LOG: invocationLog },
    );
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counters.critical_dropped).toBe(1);
    expect(parsed.critical_dropped.length).toBe(1);
    expect(result.stderr.toLowerCase().includes("critical")).toBe(true);
    const invocations = await readInvocations(invocationLog);
    expect(invocations.some((line) => line.startsWith("api"))).toBe(false);
  } finally {
    await unlink(review);
    await unlink(invocationLog).catch(() => {});
  }
});

test("integration: critical finding outside diff aborts real submit and does not POST", async () => {
  const review = await makeTempFile(".json");
  const invocationLog = await makeTempFile(".log");
  await Bun.write(
    review,
    JSON.stringify({
      summary: "Overview of the change for the PR author.",
      findings: [
        {
          id: "SEC-001",
          file: "src/unrelated.ts",
          line: 99,
          severity: "critical",
          category: "security",
          title: "Unsanitized input reaches shell",
          description: "This line is not in the diff.",
          evidence: "exec(req.body.cmd);",
        },
      ],
    }),
  );
  try {
    const result = await runScript(
      ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", review],
      { FAKE_GH_INVOCATION_LOG: invocationLog },
    );
    expect(result.code).toBe(1);
    expect(result.stderr.toLowerCase().includes("critical")).toBe(true);
    const invocations = await readInvocations(invocationLog);
    expect(invocations.some((line) => line.startsWith("api"))).toBe(false);
  } finally {
    await unlink(review);
    await unlink(invocationLog).catch(() => {});
  }
});

test("integration: methodology chrome in summary aborts before diff fetch", async () => {
  const review = await makeTempFile(".json");
  const invocationLog = await makeTempFile(".log");
  await Bun.write(
    review,
    JSON.stringify({
      summary: "Reviewed with Opus + Codex second-opinion validation.",
      findings: [
        {
          id: "SEC-001",
          file: "src/auth.ts",
          line: 14,
          severity: "high",
          category: "security",
          title: "Token logged before validation",
          description: "Raw token exposure in logs.",
          evidence: "console.log(token);",
        },
      ],
    }),
  );
  try {
    const result = await runScript(
      ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", review, "--dry-run"],
      { FAKE_GH_INVOCATION_LOG: invocationLog },
    );
    expect(result.code).toBe(1);
    expect(result.stderr.toLowerCase().includes("methodology")).toBe(true);
    const invocations = await readInvocations(invocationLog);
    expect(invocations.length).toBe(0);
  } finally {
    await unlink(review);
    await unlink(invocationLog).catch(() => {});
  }
});

test("integration: methodology chrome in finding description aborts", async () => {
  const review = await makeTempFile(".json");
  const invocationLog = await makeTempFile(".log");
  await Bun.write(
    review,
    JSON.stringify({
      summary: "Clean summary for the PR author.",
      findings: [
        {
          id: "SEC-001",
          file: "src/auth.ts",
          line: 14,
          severity: "high",
          category: "security",
          title: "Token logged before validation",
          description: "(codex confirmed) Raw token exposure in logs.",
          evidence: "console.log(token);",
        },
      ],
    }),
  );
  try {
    const result = await runScript(
      ["--pr", "123", "--owner", "acme", "--repo", "widgets", "--findings", review, "--dry-run"],
      { FAKE_GH_INVOCATION_LOG: invocationLog },
    );
    expect(result.code).toBe(1);
    expect(result.stderr.toLowerCase().includes("methodology")).toBe(true);
    const invocations = await readInvocations(invocationLog);
    expect(invocations.length).toBe(0);
  } finally {
    await unlink(review);
    await unlink(invocationLog).catch(() => {});
  }
});
