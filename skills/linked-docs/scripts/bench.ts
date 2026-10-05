#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Console, Effect, Either } from "effect";
import { EVALS, PROFILES, grade, type EvalCase, type Grade } from "./evals.ts";
import { createServices, RetrievalError, retrieve, type Policy } from "./retrieve.ts";

/**
 * Request counts measured at the HTTP boundary, including failed attempts.
 * Token totals cover only responses that actually supplied valid usage fields.
 */
export type Measurements = {
  calls: number;
  choiceCalls: number;
  verifyCalls: number;
  inputTokens: number;
  outputTokens: number;
  usageResponses: number;
  requestBytes: number;
  documentRequests: number;
};

/**
 * Shared spend limit across all cases, profiles, and repetitions.
 */
export type RequestBudget = { used: number; limit: number };

/**
 * Meter requests without storing headers, credentials, states, or response bodies.
 * A synchronous pre-dispatch guard prevents parallel calls exceeding the cap.
 */
export function meteredFetch(
  budget: RequestBudget,
  implementation: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const metrics: Measurements = {
    calls: 0,
    choiceCalls: 0,
    verifyCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageResponses: 0,
    requestBytes: 0,
    documentRequests: 0,
  };
  const pending = new Set<Promise<Response>>();
  const measure = async (url: string, init: RequestInit): Promise<Response> => {
    const modelRequest = url === "https://api.typesafe.ai/v1/systemone";
    if (!modelRequest) {
      metrics.documentRequests++;
      return implementation(url, init);
    }
    if (budget.used >= budget.limit)
      throw new Error("Benchmark total API request budget exhausted");
    budget.used++;
    metrics.calls++;
    const body = String(init.body);
    metrics.requestBytes += Buffer.byteLength(body);
    const types = Object.values(JSON.parse(body).questions as Record<string, { type: string }>).map(
      (q) => q.type,
    );
    if (types.includes("choice")) metrics.choiceCalls++;
    if (types.includes("noul")) metrics.verifyCalls++;
    const response = await implementation(url, init);
    try {
      const usage = (await response.clone().json()).usage;
      if (
        Number.isFinite(usage?.input_tokens) &&
        usage.input_tokens >= 0 &&
        Number.isFinite(usage?.output_tokens) &&
        usage.output_tokens >= 0
      ) {
        metrics.inputTokens += usage.input_tokens;
        metrics.outputTokens += usage.output_tokens;
        metrics.usageResponses++;
      }
    } catch {
      /* The retriever reports invalid responses; missing usage is not zero-cost proof. */
    }
    return response;
  };
  const fetcher = (url: string, init: RequestInit) => {
    const job = measure(url, init);
    pending.add(job);
    void job.then(
      () => pending.delete(job),
      () => pending.delete(job),
    );
    return job;
  };
  return { fetcher, metrics, drain: () => Promise.allSettled(pending) };
}

/**
 * Explicit run selection and deadlines. No live inference happens in plan mode.
 */
export type BenchOptions = {
  cases: EvalCase[];
  profiles: { name: string; policy: Policy }[];
  repeat: number;
  maxCalls: number;
  caseTimeoutMs: number;
  suiteTimeoutMs: number;
  cache: string;
  model: string;
  apiKey: string;
};

/**
 * Per-attempt result. API/schema/timeouts remain errors, never correct abstentions.
 */
export type BenchRow = {
  case: string;
  profile: string;
  repetition: number;
  expected: "evidence" | "abstain";
  status: string;
  grade: Grade | undefined;
  error: string | undefined;
  elapsedMs: number;
  metrics: Measurements;
  evidence: {
    url: string;
    heading: string;
    start: number;
    end: number;
    text: string;
    verified: boolean;
    relevance: number;
  }[];
};

/**
 * Summarize quality alongside cost, keeping operational failures in denominators.
 * Report positive hits and negative abstentions separately to expose tradeoffs.
 */
export function summarize(rows: BenchRow[]) {
  return [...new Set(rows.map((row) => row.profile))].map((profile) => {
    const attempted = rows.filter((row) => row.profile === profile);
    const positives = attempted.filter((row) => row.expected === "evidence");
    const negatives = attempted.filter((row) => row.expected === "abstain");
    const successful = attempted.filter((row) => row.error === undefined);
    const accepted = successful.reduce((sum, row) => sum + (row.grade?.accepted ?? 0), 0);
    const matched = successful.reduce((sum, row) => sum + (row.grade?.matched ?? 0), 0);
    const mean = (get: (row: BenchRow) => number) =>
      attempted.reduce((sum, row) => sum + get(row), 0) / attempted.length;
    return {
      profile,
      attempted: attempted.length,
      errors: attempted.length - successful.length,
      passed: attempted.filter((row) => row.grade?.pass).length,
      positiveHits: positives.filter((row) => row.grade?.pass).length,
      positiveCases: positives.length,
      correctAbstentions: negatives.filter((row) => row.grade?.pass).length,
      negativeCases: negatives.length,
      acceptedSpanPrecision: accepted ? matched / accepted : null,
      meanCalls: mean((row) => row.metrics.calls),
      meanElapsedMs: mean((row) => row.elapsedMs),
      inputTokens: attempted.reduce((sum, row) => sum + row.metrics.inputTokens, 0),
      outputTokens: attempted.reduce((sum, row) => sum + row.metrics.outputTokens, 0),
    };
  });
}

/**
 * Run the unchanged production retriever against every selected case/profile.
 * Keep document bodies fixed in memory across comparisons and fingerprint them.
 * Rotate profile order across repetitions to reduce warm-cache/order bias.
 */
export function runBench(
  options: BenchOptions,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  progress: (row: BenchRow) => void = () => {},
) {
  return Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          ["retrieve.ts", "documents.ts"].map((file) =>
            Bun.file(new URL(file, import.meta.url)).text(),
          ),
        ),
      catch: () => new RetrievalError({ message: "Cannot fingerprint retrieval implementation" }),
    });
    const retrieverSha256 = createHash("sha256").update(source.join("\n")).digest("hex");
    const budget: RequestBudget = { used: 0, limit: options.maxCalls };
    const corpus = new Map<string, { url: string; text: string }>();
    const rows: BenchRow[] = [];
    const started = Date.now();
    const deadline = started + options.suiteTimeoutMs;
    const planned = options.cases.length * options.profiles.length * options.repeat;
    let stopReason: string | undefined;
    run: for (let repetition = 0; repetition < options.repeat; repetition++) {
      const order = options.profiles
        .slice(repetition % options.profiles.length)
        .concat(options.profiles.slice(0, repetition % options.profiles.length));
      for (const test of options.cases)
        for (const profile of order) {
          if (budget.used >= budget.limit || Date.now() >= deadline) {
            stopReason =
              budget.used >= budget.limit
                ? "total request budget exhausted"
                : "suite deadline exceeded";
            break run;
          }
          const meter = meteredFetch(budget, fetcher);
          const { services } = createServices(
            {
              indexUrl: test.index,
              cache: options.cache,
              refresh: false,
              apiKey: options.apiKey,
              model: options.model,
              maxCalls: 64,
            },
            meter.fetcher,
          );
          const document = services.document;
          services.document = (url) =>
            Effect.suspend(() => {
              const cached = corpus.get(url);
              if (cached) return Effect.succeed(cached);
              return document(url).pipe(
                Effect.tap((body) =>
                  Effect.sync(() => {
                    corpus.set(url, body);
                  }),
                ),
              );
            });
          const before = performance.now();
          const outcome = yield* Effect.either(
            retrieve(test.index, test.question, services, profile.policy).pipe(
              Effect.timeout(Math.min(options.caseTimeoutMs, Math.max(1, deadline - Date.now()))),
            ),
          );
          // Include in-flight response usage even if a sibling request or validator failed.
          yield* Effect.promise(() => meter.drain());
          const result = Either.isRight(outcome) ? outcome.right : undefined;
          const row: BenchRow = {
            case: test.id,
            profile: profile.name,
            repetition: repetition + 1,
            expected: test.expected.kind,
            status: result?.status ?? "error",
            grade: result ? grade(result, test.expected) : undefined,
            error: Either.isLeft(outcome) ? outcome.left.message : undefined,
            elapsedMs: Math.round(performance.now() - before),
            metrics: { ...meter.metrics },
            evidence: result?.passages ?? [],
          };
          rows.push(row);
          progress(row);
        }
    }
    return {
      version: 1,
      startedAt: new Date(started).toISOString(),
      model: options.model,
      retrieverSha256,
      planned,
      completed: rows.length,
      complete: rows.length === planned,
      stopReason,
      totalCalls: budget.used,
      maxCalls: budget.limit,
      caseTimeoutMs: options.caseTimeoutMs,
      suiteTimeoutMs: options.suiteTimeoutMs,
      cases: options.cases,
      profiles: options.profiles,
      documents: [...corpus]
        .map(([requestedUrl, body]) => ({
          requestedUrl,
          url: body.url,
          sha256: createHash("sha256").update(body.text).digest("hex"),
        }))
        .toSorted((a, b) => a.requestedUrl.localeCompare(b.requestedUrl)),
      rows,
      summaries: summarize(rows),
    };
  });
}

const HELP = `Usage: bun scripts/bench.ts [--run] [options]
Without --run: print the eval plan, no network or credentials required.
Live runs use TYPESAFE_API_KEY injected by varlock, like search.ts.
--case <ids>          Comma-separated cases (default: all six)
--profiles <names>    baseline,balanced,narrow (default: all three)
--repeat <1-5>        Repetitions; profile order rotates (default: 1)
--max-calls <1-2000>  HARD total TypeSafe HTTP-attempt cap (default: 200)
--case-timeout <ms>   Per-case deadline (default: 180000)
--cache <dir>        Document cache (default: .scratch/linked-docs-cache)
--output <file>      JSON report under .scratch/ (default: .scratch/linked-docs-bench.json)
--model <id>         Default: jev-1.13.0
--help               Show help
The suite deadline is 10 minutes. A cap/deadline may leave the matrix incomplete.
Exit 0: all selected evals pass; 2: misses/errors/incomplete; 1: invalid setup.
`;

const select = (raw: string | undefined, names: string[]) => {
  const selected = raw === undefined ? names : raw.split(",");
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !names.includes(name))
  )
    throw new Error(`Choose distinct IDs from: ${names.join(", ")}`);
  return selected;
};
const integer = (raw: string | undefined, fallback: number, max: number) => {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`Expected an integer from 1 through ${max}`);
  return value;
};

/**
 * Validate CLI selections before any network request, returning a no-spend plan.
 */
export function parseBenchArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean" },
      run: { type: "boolean" },
      case: { type: "string" },
      profiles: { type: "string" },
      repeat: { type: "string" },
      "max-calls": { type: "string" },
      "case-timeout": { type: "string" },
      cache: { type: "string" },
      output: { type: "string" },
      model: { type: "string" },
    },
  });
  const ids = select(
    values.case,
    EVALS.map((item) => item.id),
  );
  const names = select(values.profiles, Object.keys(PROFILES));
  const output = resolve(values.output ?? ".scratch/linked-docs-bench.json");
  const outputRelative = relative(resolve(".scratch"), output);
  if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative))
    throw new Error("Write benchmark reports under the current repository's .scratch/ directory");
  return {
    help: values.help ?? false,
    run: values.run ?? false,
    output,
    cases: ids.map((id) => EVALS.find((item) => item.id === id)!),
    profiles: names.map((name) => ({ name, policy: PROFILES[name] })),
    repeat: integer(values.repeat, 1, 5),
    maxCalls: integer(values["max-calls"], 200, 2000),
    caseTimeoutMs: integer(values["case-timeout"], 180_000, 180_000),
    suiteTimeoutMs: 600_000,
    cache: resolve(values.cache ?? ".scratch/linked-docs-cache"),
    model: values.model ?? "jev-1.13.0",
  };
}

const main = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseBenchArgs(Bun.argv.slice(2)),
    catch: (error) =>
      new RetrievalError({ message: error instanceof Error ? error.message : "Invalid arguments" }),
  });
  if (args.help) {
    yield* Console.log(HELP);
    return;
  }
  if (!args.run) {
    yield* Console.log(
      JSON.stringify(
        {
          cases: args.cases,
          profiles: args.profiles,
          repeat: args.repeat,
          planned: args.cases.length * args.profiles.length * args.repeat,
          maxCalls: args.maxCalls,
          message:
            "Plan only. Add --run through varlock to spend API requests. Partial matrices are explicitly reported.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey)
    return yield* Effect.fail(
      new RetrievalError({
        message: "TYPESAFE_API_KEY is required; run this benchmark through varlock",
      }),
    );
  const report = yield* runBench({ ...args, apiKey }, fetch, (row) => {
    console.log(
      `${row.case}\t${row.profile}\t${row.grade?.pass ? "PASS" : "FAIL"}\t${row.metrics.calls} calls (${row.metrics.choiceCalls} Choice/${row.metrics.verifyCalls} Noul)\t${row.metrics.inputTokens} in/${row.metrics.outputTokens} out\t${row.elapsedMs}ms${row.error ? `\t${row.error}` : ""}`,
    );
  });
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(args.output), { recursive: true });
      await writeFile(args.output, JSON.stringify(report, null, 2));
    },
    catch: () => new RetrievalError({ message: `Cannot write report: ${args.output}` }),
  });
  yield* Console.log(
    JSON.stringify(
      {
        complete: report.complete,
        totalCalls: report.totalCalls,
        stopReason: report.stopReason,
        summaries: report.summaries,
        report: args.output,
      },
      null,
      2,
    ),
  );
  if (!report.complete || report.rows.some((row) => !row.grade?.pass)) process.exitCode = 2;
});

if (import.meta.main)
  await Effect.runPromise(
    main.pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Console.error(error.message);
          process.exitCode = 1;
        }),
      ),
    ),
  );
