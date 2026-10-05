#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Console, Effect, Either } from "effect";
import { EVALS, PROFILES, grade, type EvalCase, type Grade } from "./evals.ts";
import { createCachedServices, modelUsage } from "./model-cache.ts";
import { RetrievalError, retrieve, type Policy } from "./retrieve.ts";

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
 * Synchronous guards enforce both total and optional per-profile spend caps.
 */
export function meteredFetch(
  budget: RequestBudget,
  implementation: (url: string, init: RequestInit) => Promise<Response> = fetch,
  profileBudget: RequestBudget | undefined = undefined,
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
    if (profileBudget && profileBudget.used >= profileBudget.limit)
      throw new Error("Benchmark per-profile API request budget exhausted");
    budget.used++;
    if (profileBudget) profileBudget.used++;
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
      const usage = modelUsage((await response.clone().json()).usage);
      if (usage) {
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
  maxCallsPerProfile: number;
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
  metrics: Measurements & {
    modelCacheHits: number;
    logicalCalls: number;
    logicalChoiceCalls: number;
    logicalVerifyCalls: number;
    logicalInputTokens: number;
    logicalOutputTokens: number;
    logicalUsageResponses: number;
  };
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
      meanLogicalCalls: mean((row) => row.metrics.logicalCalls),
      modelCacheHits: attempted.reduce((sum, row) => sum + row.metrics.modelCacheHits, 0),
      logicalInputTokens: attempted.reduce((sum, row) => sum + row.metrics.logicalInputTokens, 0),
      logicalOutputTokens: attempted.reduce((sum, row) => sum + row.metrics.logicalOutputTokens, 0),
      meanElapsedMs: mean((row) => row.elapsedMs),
      inputTokens: attempted.reduce((sum, row) => sum + row.metrics.inputTokens, 0),
      outputTokens: attempted.reduce((sum, row) => sum + row.metrics.outputTokens, 0),
    };
  });
}

/**
 * Run the unchanged production retriever against every selected case/profile.
 * Keep document bodies fixed in memory across comparisons and fingerprint them.
 * Reuse identical model inputs across profiles and replay repetitions.
 * Logical workload and fresh API spend are reported separately.
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
    const profileBudgets = new Map(
      options.profiles.map((profile) => [
        profile.name,
        { used: 0, limit: options.maxCallsPerProfile },
      ]),
    );
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
          if (Date.now() >= deadline) {
            stopReason = "suite deadline exceeded";
            break run;
          }
          // Exhausted spend budgets still allow entirely cached evaluations to finish.
          const meter = meteredFetch(budget, fetcher, profileBudgets.get(profile.name));
          const { services, modelCache } = createCachedServices(
            {
              indexUrl: test.index,
              cache: options.cache,
              refresh: false,
              apiKey: options.apiKey,
              model: options.model,
              // Also bound logical work per attempt, including cached evaluations.
              maxCalls: options.maxCallsPerProfile,
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
          yield* Effect.promise(() => modelCache.drain());
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
            metrics: {
              ...meter.metrics,
              modelCacheHits: modelCache.metrics.hits,
              logicalCalls: modelCache.metrics.requests,
              logicalChoiceCalls: modelCache.metrics.choiceRequests,
              logicalVerifyCalls: modelCache.metrics.verifyRequests,
              logicalInputTokens: meter.metrics.inputTokens + modelCache.metrics.inputTokens,
              logicalOutputTokens: meter.metrics.outputTokens + modelCache.metrics.outputTokens,
              logicalUsageResponses:
                meter.metrics.usageResponses + modelCache.metrics.usageResponses,
            },
            evidence: result?.passages ?? [],
          };
          rows.push(row);
          progress(row);
        }
    }
    return {
      version: 2,
      startedAt: new Date(started).toISOString(),
      model: options.model,
      retrieverSha256,
      planned,
      completed: rows.length,
      complete: rows.length === planned,
      stopReason,
      totalCalls: budget.used,
      maxCalls: budget.limit,
      maxCallsPerProfile: options.maxCallsPerProfile,
      profileCalls: Object.fromEntries(
        [...profileBudgets].map(([name, value]) => [name, value.used]),
      ),
      modelCache: join(options.cache, "jev"),
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
--repeat <1-5>        Replays cached judgments; profile order rotates (default: 1)
--max-calls <1-2000>  HARD total fresh TypeSafe HTTP-attempt cap (default: 200)
--max-calls-per-profile <1-2000>  Fresh cap across cases/repeats (default: 64)
                      Also bounds logical evaluations per individual attempt
--case-timeout <ms>   Per-case deadline (default: 180000)
--cache <dir>        Documents and persistent Jev cache (default: .scratch/linked-docs-cache)
--output <file>      JSON report under .scratch/ (default: .scratch/linked-docs-bench.json)
--model <id>         Default: jev-1.13.0
--help               Show help
Spend caps block uncached work as error rows; cached work remains available.
The suite deadline is 10 minutes and may leave the matrix incomplete.
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
      "max-calls-per-profile": { type: "string" },
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
    maxCallsPerProfile: integer(values["max-calls-per-profile"], 64, 2000),
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
          maxCallsPerProfile: args.maxCallsPerProfile,
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
      `${row.case}\t${row.profile}\t${row.grade?.pass ? "PASS" : "FAIL"}\t${row.metrics.logicalCalls} logical (${row.metrics.logicalChoiceCalls} Choice/${row.metrics.logicalVerifyCalls} Noul), ${row.metrics.calls} fresh, ${row.metrics.modelCacheHits} reused\t${row.metrics.inputTokens} in/${row.metrics.outputTokens} out\t${row.elapsedMs}ms${row.error ? `\t${row.error}` : ""}`,
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
        profileCalls: report.profileCalls,
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
