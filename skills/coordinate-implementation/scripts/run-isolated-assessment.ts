#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
  acceptanceDecisions,
  decideAcceptanceDisposition,
  decideStallDisposition,
  evaluateAcceptanceLive,
  evaluateStallLive,
  StallDecision,
  STALL_POLICY_VERSION,
  TYPESAFE_MODEL,
  type AcceptanceAssessment,
  type AcceptanceDisposition,
  type StallAssessment,
} from "./lib/assessment.ts";
import {
  ACCEPTANCE_SCENARIOS,
  STALL_SCENARIOS,
  type AcceptanceScenario,
  type StallScenario,
} from "./lib/assessment-scenarios.ts";
import { spawnGit } from "./lib/git.ts";

type Scenario =
  | { kind: "stall"; value: StallScenario }
  | { kind: "acceptance"; value: AcceptanceScenario };

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
};

const root = resolve(import.meta.dir, "../../..");
const scenarioId = process.argv[2];
const runRoot = resolve(
  root,
  ".scratch",
  "coordinate-typesafe-eval",
  "isolated",
  scenarioId ?? "missing-scenario",
  new Date().toISOString().replaceAll(":", "-"),
);
const repositoryPath = join(runRoot, "repo");
const artifactPath = join(runRoot, "artifacts");
const controllerPath = join(runRoot, "controller");
const sessionPath = join(runRoot, "pi-session");

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const findScenario = (id: string | undefined): Scenario => {
  const stall = STALL_SCENARIOS.find((scenario) => scenario.id === id);
  if (stall !== undefined) return { kind: "stall", value: stall };
  const acceptance = ACCEPTANCE_SCENARIOS.find((scenario) => scenario.id === id);
  if (acceptance !== undefined) return { kind: "acceptance", value: acceptance };
  throw new Error(`Unknown isolated scenario ${String(id)}`);
};

const initializeRepository = async (scenario: Scenario): Promise<void> => {
  await mkdir(repositoryPath, { recursive: true });
  const initialized = spawnGit(["init", "-q", "-b", "main"], { cwd: repositoryPath });
  if (initialized.exitCode !== 0) throw new Error(`git init failed: ${initialized.stderr}`);
  await writeJson(join(repositoryPath, "scenario-state.json"), scenario.value.state);
  await writeFile(
    join(repositoryPath, "README.md"),
    "# Disposable isolated Assessment fixture\n\nThe model receives scenario state directly.\n",
  );
  const added = spawnGit(["add", "README.md", "scenario-state.json"], { cwd: repositoryPath });
  if (added.exitCode !== 0) throw new Error(`git add failed: ${added.stderr}`);
  const committed = spawnGit(
    [
      "-c",
      "user.name=TypeSafe Experiment",
      "-c",
      "user.email=typesafe-experiment@example.invalid",
      "commit",
      "-q",
      "-m",
      `test: add ${scenario.value.id} fixture`,
    ],
    { cwd: repositoryPath },
  );
  if (committed.exitCode !== 0) throw new Error(`git commit failed: ${committed.stderr}`);
};

const serializedQuestions = (scenario: Scenario): Record<string, unknown> => {
  const decisions =
    scenario.kind === "stall" ? StallDecision.decisions : acceptanceDecisions(scenario.value.state);
  return Object.fromEntries(
    Object.entries(decisions).map(([key, decision]) => [
      key,
      {
        type: "noul",
        instructions: decision.instructions,
        criteria: decision.criteria,
      },
    ]),
  );
};

const normalizeAcceptance = (disposition: AcceptanceDisposition): "pass" | "fix" | "review" => {
  if (disposition.disposition === "fix") return "fix";
  if (disposition.disposition === "spec-review") return "review";
  return "pass";
};

const runTypeSafe = async (scenario: Scenario) => {
  const started = performance.now();
  try {
    if (scenario.kind === "stall") {
      const assessment = await Effect.runPromise(evaluateStallLive(scenario.value.state));
      const disposition = decideStallDisposition(
        scenario.value.state.worker.status,
        assessment.answers,
      );
      return {
        status: "succeeded" as const,
        assessment,
        disposition,
        normalized_disposition: disposition.disposition,
        correct:
          disposition.disposition === scenario.value.oracle.disposition &&
          disposition.reason === scenario.value.oracle.reason,
        latency_ms: Math.round((performance.now() - started) * 100) / 100,
        error: null,
      };
    }
    const assessment = await Effect.runPromise(evaluateAcceptanceLive(scenario.value.state));
    const preflight = decideAcceptanceDisposition("preflight-only", assessment);
    const replacement = decideAcceptanceDisposition("replace-spec-reviewer", assessment);
    const normalized = normalizeAcceptance(replacement);
    return {
      status: "succeeded" as const,
      assessment,
      dispositions: { preflight, replacement },
      normalized_disposition: normalized,
      correct: normalized === scenario.value.oracle,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      error: null,
    };
  } catch (error) {
    return {
      status: "failed" as const,
      assessment: null,
      normalized_disposition: "pause",
      correct: false,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const baselinePrompt = (scenario: Scenario): string => {
  const request = {
    state: scenario.value.state,
    questions: serializedQuestions(scenario),
  };
  if (scenario.kind === "stall") {
    return [
      "Estimate the five requested probabilities from only the supplied state.",
      "Return one JSON object and no markdown or explanation.",
      "Every value must be a number from 0 through 1.",
      'Shape: {"probabilities":{"meaningful_progress":0,"mechanical_input_wait":0,"human_decision_required":0,"transient_service_failure":0,"crash_or_loop":0}}',
      JSON.stringify(request),
    ].join("\n\n");
  }
  return [
    "Estimate satisfaction and evidence sufficiency for every acceptance criterion from only the supplied state.",
    "Return one JSON object and no markdown or explanation.",
    "Every value must be a number from 0 through 1 and every criterion id must appear exactly once.",
    'Shape: {"criteria":[{"id":"AC1","satisfaction":0,"evidence_sufficiency":0}]}',
    JSON.stringify(request),
  ].join("\n\n");
};

const parseJsonText = (text: string): unknown => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(trimmed) as unknown;
};

const finalAssistantText = (events: string): string => {
  const parsed = events
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const messages = parsed.filter(
    (event) =>
      event.type === "message_end" &&
      typeof event.message === "object" &&
      event.message !== null &&
      (event.message as Record<string, unknown>).role === "assistant",
  );
  const message = messages.at(-1)?.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("");
};

const onlySessionFile = async (): Promise<string> => {
  const files = (await readdir(sessionPath)).filter((file) => file.endsWith(".jsonl"));
  if (files.length !== 1) throw new Error(`Expected one Pi session file, found ${files.length}`);
  return join(sessionPath, files[0]!);
};

const piMetrics = async (path: string) => {
  const entries = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  let turns = 0;
  let toolCalls = 0;
  let providerCost = 0;
  let listPrice = 0;
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
  for (const entry of entries) {
    let usage: Usage | undefined;
    if (entry.type === "message") {
      const message = entry.message as Record<string, unknown>;
      if (message.role !== "assistant") continue;
      turns += 1;
      const content = Array.isArray(message.content) ? message.content : [];
      toolCalls += content.filter(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "toolCall",
      ).length;
      usage = message.usage as Usage;
    } else if (entry.type === "usage") {
      usage = entry.usage as Usage;
    }
    if (usage === undefined) continue;
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cache_read += usage.cacheRead;
    tokens.cache_write += usage.cacheWrite;
    tokens.total += usage.totalTokens;
    providerCost += usage.cost.total;
    const tiered = usage.input > 272_000;
    listPrice +=
      (usage.input * (tiered ? 10 : 5) +
        usage.output * (tiered ? 45 : 30) +
        usage.cacheRead * (tiered ? 1 : 0.5) +
        usage.cacheWrite * (tiered ? 12.5 : 6.25)) /
      1_000_000;
  }
  return {
    turns,
    tool_calls: toolCalls,
    tokens,
    provider_reported_cost_usd: providerCost,
    public_list_price_equivalent_usd: listPrice,
  };
};

const finiteProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const runPiBaseline = async (scenario: Scenario) => {
  const started = performance.now();
  await mkdir(sessionPath, { recursive: true });
  const child = Bun.spawn(
    [
      "pi",
      "--mode",
      "json",
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "low",
      "--session-dir",
      sessionPath,
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      baselinePrompt(scenario),
    ],
    { cwd: repositoryPath, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [events, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await writeFile(join(artifactPath, "pi-events.jsonl"), events);
  if (exitCode !== 0) {
    return {
      status: "failed" as const,
      correct: false,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      error: stderr.trim() || `Pi exited ${exitCode}`,
      metrics: null,
    };
  }

  try {
    const value = parseJsonText(finalAssistantText(events)) as Record<string, unknown>;
    let assessment: StallAssessment | AcceptanceAssessment;
    let normalized: string;
    let correct: boolean;
    if (scenario.kind === "stall") {
      const probabilities = value.probabilities as Record<string, unknown>;
      const keys = [
        "meaningful_progress",
        "mechanical_input_wait",
        "human_decision_required",
        "transient_service_failure",
        "crash_or_loop",
      ] as const;
      if (
        probabilities === undefined ||
        !keys.every((key) => finiteProbability(probabilities[key]))
      ) {
        throw new Error("Pi returned malformed stall probabilities");
      }
      assessment = {
        answers: Object.fromEntries(
          keys.map((key) => [key, probabilities[key]]),
        ) as StallAssessment["answers"],
        usage: { input_tokens: null, output_tokens: null },
      };
      const disposition = decideStallDisposition(
        scenario.value.state.worker.status,
        assessment.answers,
      );
      normalized = disposition.disposition;
      correct =
        disposition.disposition === scenario.value.oracle.disposition &&
        disposition.reason === scenario.value.oracle.reason;
    } else {
      const answers = value.criteria;
      if (!Array.isArray(answers)) throw new Error("Pi returned no acceptance criteria");
      const criteria = scenario.value.state.ticket.acceptance_criteria.map((criterion) => {
        const answer = answers.find(
          (candidate: unknown) =>
            typeof candidate === "object" &&
            candidate !== null &&
            (candidate as Record<string, unknown>).id === criterion.id,
        ) as Record<string, unknown> | undefined;
        if (
          answer === undefined ||
          !finiteProbability(answer.satisfaction) ||
          !finiteProbability(answer.evidence_sufficiency)
        ) {
          throw new Error(`Pi returned malformed probabilities for ${criterion.id}`);
        }
        return {
          ...criterion,
          satisfaction: answer.satisfaction,
          evidence_sufficiency: answer.evidence_sufficiency,
        };
      });
      assessment = { criteria, usage: { input_tokens: null, output_tokens: null } };
      normalized = normalizeAcceptance(
        decideAcceptanceDisposition("replace-spec-reviewer", assessment),
      );
      correct = normalized === scenario.value.oracle;
    }
    const sessionFile = await onlySessionFile();
    return {
      status: "succeeded" as const,
      assessment,
      normalized_disposition: normalized,
      correct,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      error: null,
      metrics: await piMetrics(sessionFile),
      session_file: sessionFile,
    };
  } catch (error) {
    return {
      status: "failed" as const,
      correct: false,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      error: error instanceof Error ? error.message : String(error),
      metrics: null,
    };
  }
};

const main = async (): Promise<void> => {
  if (process.env.HERDR_ENV !== "1") throw new Error("Run isolated harnesses inside Herdr");
  const scenario = findScenario(scenarioId);
  const startedAt = new Date();
  await Promise.all([
    mkdir(artifactPath, { recursive: true }),
    mkdir(controllerPath, { recursive: true }),
  ]);
  await initializeRepository(scenario);
  await writeJson(join(controllerPath, "oracle.json"), {
    scenario: scenario.value.id,
    expected: scenario.value.oracle,
  });
  const request = {
    schema_version: 1,
    kind: "assessment-request",
    assessment_kind: scenario.kind,
    assessment_id: scenario.value.id,
    model_requested: TYPESAFE_MODEL,
    authority_policy_version: scenario.kind === "stall" ? STALL_POLICY_VERSION : "acceptance-v1",
    state_sha256: sha256(JSON.stringify(scenario.value.state)),
    state: scenario.value.state,
    questions: serializedQuestions(scenario),
  };
  await writeJson(join(artifactPath, "request.json"), request);

  const typeSafe = await runTypeSafe(scenario);
  await writeJson(join(artifactPath, "typesafe-evidence.json"), typeSafe);
  const pi = await runPiBaseline(scenario);
  await writeJson(join(artifactPath, "pi-evidence.json"), pi);
  const completedAt = new Date();
  const typeSafeInput = typeSafe.assessment?.usage.input_tokens ?? 0;
  const result = {
    schema_version: 1,
    scenario: scenario.value.id,
    assessment_kind: scenario.kind,
    completed: true,
    oracle: scenario.value.oracle,
    typesafe: typeSafe,
    pi_baseline: pi,
    wall_time_ms: completedAt.getTime() - startedAt.getTime(),
    economics: {
      typesafe_actual_cost_usd: (typeSafeInput * 0.042) / 1_000_000,
      pi_provider_reported_cost_usd: pi.metrics?.provider_reported_cost_usd ?? null,
      pi_public_list_price_equivalent_usd: pi.metrics?.public_list_price_equivalent_usd ?? null,
    },
    run_root: runRoot,
  };
  await writeJson(join(runRoot, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
};

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        completed: false,
        scenario: scenarioId,
        run_root: runRoot,
        error: (error as Error).message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
