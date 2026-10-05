import { afterEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meteredFetch, parseBenchArgs, runBench, summarize, type BenchOptions } from "./bench.ts";
import { EVALS, PROFILES, grade, type EvalCase, type EvidenceResult } from "./evals.ts";

const source = "https://docs.example.com/settings.md";
const expected: EvalCase["expected"] = {
  kind: "evidence",
  url: source,
  includes: ["binary", "arguments"],
};
const result = (text = "binary arguments", url = source, verified = true): EvidenceResult => ({
  status: "evidence",
  warnings: [],
  passages: [{ url, text, verified }],
});

describe("gold labels", () => {
  test("requires a verified gold source and all strings in one excerpt", () => {
    expect(grade(result(), expected)).toEqual({
      pass: true,
      accepted: 1,
      matched: 1,
      reason: "gold source and span found",
    });
    expect(grade(result("binary only"), expected).pass).toBe(false);
    expect(grade(result("binary arguments", "https://wrong.example.com/doc"), expected).pass).toBe(
      false,
    );
    expect(grade(result("binary arguments", source, false), expected).pass).toBe(false);
    expect(
      grade(
        {
          status: "evidence",
          warnings: [],
          passages: [
            { url: source, text: "binary", verified: true },
            { url: source, text: "arguments", verified: true },
          ],
        },
        expected,
      ).pass,
    ).toBe(false);
  });
  test("abstention cannot hide accepted evidence or missing source coverage", () => {
    const negative: EvidenceResult = {
      status: "insufficient_evidence",
      warnings: [],
      passages: [{ url: source, text: "generic advice", verified: false }],
    };
    expect(grade(negative, { kind: "abstain" }).pass).toBe(true);
    expect(grade(result(), { kind: "abstain" }).pass).toBe(false);
    expect(grade({ ...negative, warnings: ["HTTP 404"] }, { kind: "abstain" }).pass).toBe(false);
  });
  test("suite includes both answerable and indexed-corpus negative cases", () => {
    expect(EVALS.map((item) => item.expected.kind)).toEqual([
      "evidence",
      "evidence",
      "evidence",
      "evidence",
      "abstain",
      "abstain",
    ]);
    expect(new Set(EVALS.map((item) => item.id)).size).toBe(6);
    expect(PROFILES.baseline).toEqual({ beam: 3, pages: 6, threshold: 0.6 });
  });
});

const request = (type = "choice"): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ questions: { result: { type } } }),
});
const endpoint = "https://api.typesafe.ai/v1/systemone";
describe("HTTP metering", () => {
  test("measures real requests and token usage, excluding public-document calls", async () => {
    const fake = mock(async () =>
      Response.json({ usage: { input_tokens: 123, output_tokens: 7 } }),
    );
    const budget = { used: 0, limit: 2 };
    const meter = meteredFetch(budget, fake);
    await meter.fetcher(source, {});
    await meter.fetcher(endpoint, request());
    await meter.fetcher(endpoint, request("noul"));
    await meter.drain();
    expect(budget.used).toBe(2);
    expect(meter.metrics).toEqual({
      calls: 2,
      choiceCalls: 1,
      verifyCalls: 1,
      inputTokens: 246,
      outputTokens: 14,
      usageResponses: 2,
      requestBytes:
        Buffer.byteLength(String(request().body)) + Buffer.byteLength(String(request("noul").body)),
      documentRequests: 1,
    });
  });
  test("parallel attempts cannot exceed the total HTTP cap", async () => {
    const fake = mock(async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const meter = meteredFetch({ used: 0, limit: 1 }, fake);
    const outcomes = await Promise.allSettled([
      meter.fetcher(endpoint, request()),
      meter.fetcher(endpoint, request()),
    ]);
    await meter.drain();
    expect(outcomes.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(meter.metrics.calls).toBe(1);
  });
  test("HTTP failures consume attempts but unavailable usage stays identifiable", async () => {
    const fake = mock(async () => new Response("denied", { status: 401 }));
    const meter = meteredFetch({ used: 0, limit: 2 }, fake);
    expect((await meter.fetcher(endpoint, request())).status).toBe(401);
    expect(meter.metrics.calls).toBe(1);
    expect(meter.metrics.usageResponses).toBe(0);
  });
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const testCase: EvalCase = {
  id: "test",
  index: "https://docs.example.com/llms.txt",
  question: "Binary arguments?",
  rationale: "Fixture",
  expected,
};
const options = async (): Promise<BenchOptions> => {
  const cache = await mkdtemp(join(tmpdir(), "linked-docs-bench-"));
  dirs.push(cache);
  return {
    cases: [testCase],
    profiles: Object.entries(PROFILES).map(([name, policy]) => ({ name, policy })),
    repeat: 1,
    maxCalls: 30,
    caseTimeoutMs: 5000,
    suiteTimeoutMs: 10000,
    cache,
    model: "test",
    apiKey: "test-key",
  };
};
const fakeFetch = mock(async (url: string, init: RequestInit): Promise<Response> => {
  if (url !== endpoint)
    return new Response(
      url.endsWith("llms.txt")
        ? "# Docs\n- [Settings](./settings.md)"
        : "Opening\n\n# Settings\nbinary arguments\n",
    );
  const body = JSON.parse(String(init.body));
  const question = body.questions.result;
  const keys = Object.keys(question.criteria ?? {});
  const answer =
    question.type === "choice"
      ? {
          type: "choice",
          probabilities: Object.fromEntries(keys.map((id) => [id, 1 / keys.length])),
        }
      : { type: "noul", noul: 0.9 };
  return Response.json({
    answers: { result: answer },
    usage: { input_tokens: 10, output_tokens: 2 },
  });
});

const failingFetch = async (url: string, init: RequestInit) =>
  url === endpoint ? new Response("denied", { status: 401 }) : fakeFetch(url, init);

describe("comparison runner", () => {
  test("compares the real retriever, retaining fixed corpus hashes and complete evidence", async () => {
    fakeFetch.mockClear();
    const report = await Effect.runPromise(runBench(await options(), fakeFetch));
    expect(report.complete).toBe(true);
    expect(report.rows.map((row) => row.grade?.pass)).toEqual([true, true, true]);
    expect(report.totalCalls).toBe(9);
    expect(report.rows.map((row) => row.metrics.documentRequests)).toEqual([2, 0, 0]);
    expect(report.documents).toHaveLength(2);
    expect(report.documents.every((doc) => /^[a-f0-9]{64}$/.test(doc.sha256))).toBe(true);
    expect(report.rows[0].evidence.some((span) => span.text.includes("binary arguments"))).toBe(
      true,
    );
    expect(summarize(report.rows).map((summary) => summary.positiveHits)).toEqual([1, 1, 1]);
  });
  test("budget exhaustion is partial, never a complete or successful smaller sample", async () => {
    const config = await options();
    config.maxCalls = 3;
    const report = await Effect.runPromise(runBench(config, fakeFetch));
    expect(report.complete).toBe(false);
    expect(report.totalCalls).toBe(3);
    expect(report.planned).toBe(3);
    expect(report.completed).toBe(1);
    expect(report.stopReason).toBe("total request budget exhausted");
  });
  test("mid-case cap stops at actual dispatched requests and retains an error row", async () => {
    const config = await options();
    config.maxCalls = 2;
    const report = await Effect.runPromise(runBench(config, fakeFetch));
    expect(report.complete).toBe(false);
    expect(report.totalCalls).toBe(2);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].metrics.calls).toBe(2);
    expect(report.rows[0].status).toBe("error");
    expect(report.rows[0].grade).toBeUndefined();
    expect(report.rows[0].error).toContain("budget exhausted");
  });
  test("expired suite deadlines return an explicit empty partial report", async () => {
    const config = await options();
    config.suiteTimeoutMs = 0;
    const report = await Effect.runPromise(runBench(config, fakeFetch));
    expect(report.complete).toBe(false);
    expect(report.rows).toEqual([]);
    expect(report.totalCalls).toBe(0);
    expect(report.stopReason).toBe("suite deadline exceeded");
  });
  test("service failures cannot pass the abstention control", async () => {
    const config = await options();
    config.cases = [{ ...testCase, expected: { kind: "abstain" } }];
    config.profiles = config.profiles.slice(0, 1);
    const report = await Effect.runPromise(runBench(config, failingFetch));
    expect(report.rows[0].status).toBe("error");
    expect(report.rows[0].grade).toBeUndefined();
    expect(report.summaries[0].correctAbstentions).toBe(0);
    expect(report.summaries[0].errors).toBe(1);
  });
  test("repetitions rotate profile order rather than always measuring baseline cold", async () => {
    const config = await options();
    config.repeat = 2;
    const report = await Effect.runPromise(runBench(config, fakeFetch));
    expect(report.rows.map((row) => row.profile)).toEqual([
      "baseline",
      "balanced",
      "narrow",
      "balanced",
      "narrow",
      "baseline",
    ]);
  });
});

describe("CLI safety", () => {
  test("defaults to a no-spend plan and can select the bounded smoke case", () => {
    expect(parseBenchArgs([]).run).toBe(false);
    const args = parseBenchArgs(["--run", "--case", "lsp-binary", "--max-calls", "100"]);
    expect(args.cases.map((item) => item.id)).toEqual(["lsp-binary"]);
    expect(args.maxCalls).toBe(100);
  });
  test("rejects ambiguous IDs, invalid budgets, and report paths outside scratch", () => {
    expect(() => parseBenchArgs(["--profiles", "missing"])).toThrow("Choose distinct IDs");
    expect(() => parseBenchArgs(["--case", "lsp-binary,lsp-binary"])).toThrow(
      "Choose distinct IDs",
    );
    expect(() => parseBenchArgs(["--max-calls", "0"])).toThrow("Expected an integer");
    expect(() => parseBenchArgs(["--repeat", "6"])).toThrow("Expected an integer");
    expect(() => parseBenchArgs(["--output", "bench.json"])).toThrow(".scratch/");
  });
});
