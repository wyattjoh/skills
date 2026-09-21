#!/usr/bin/env bun
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TYPESAFE_SECRET } from "./lib/assessment.ts";
import { spawnGit } from "./lib/git.ts";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type AgentInfo = {
  agent_status: string;
  pane_id: string;
};

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
};

type SessionMetrics = {
  turns: number;
  tool_calls: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  provider_reported_cost_usd: number;
  list_price_equivalent_usd: number;
};

const root = resolve(import.meta.dir, "../../..");
const skillRoot = resolve(import.meta.dir, "..");
const assessmentCli = resolve(import.meta.dir, "assessment-experiment.ts");
const runRoot = resolve(
  root,
  ".scratch",
  "coordinate-typesafe-eval",
  "runs",
  `first-stall-${new Date().toISOString().replaceAll(":", "-")}`,
);
const repositoryPath = join(runRoot, "repo");
const controllerPath = join(runRoot, "controller");
const artifactPath = join(runRoot, "artifacts");
const sessionPath = join(runRoot, "sessions");
const suffix = crypto.randomUUID().slice(0, 6);
const workerName = `ts-stall-w-${suffix}`;
const coordinatorName = `ts-stall-c-${suffix}`;

const run = async (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> => {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => child.kill(), options.timeoutMs).unref();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, stdout, stderr };
};

const requireSuccess = (label: string, result: CommandResult): string => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
};

const herdrJson = async (args: string[]): Promise<Record<string, unknown>> => {
  const result = await run("herdr", args, { timeoutMs: 900_000 });
  const stdout = requireSuccess(`herdr ${args.join(" ")}`, result);
  return JSON.parse(stdout) as Record<string, unknown>;
};

const agentInfo = async (target: string): Promise<AgentInfo> => {
  const response = await herdrJson(["agent", "get", target]);
  const result = response.result as { agent?: AgentInfo } | undefined;
  if (result?.agent === undefined) throw new Error(`Herdr returned no agent for ${target}`);
  return result.agent;
};

const paneFromSplit = (response: Record<string, unknown>): string => {
  const result = response.result as { pane?: { pane_id?: unknown } } | undefined;
  const pane = result?.pane?.pane_id;
  if (typeof pane !== "string") throw new Error("Herdr pane split returned no pane_id");
  return pane;
};

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const onlySessionFile = async (role: "coordinator" | "worker"): Promise<string> => {
  const directory = join(sessionPath, role);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
  if (files.length !== 1) {
    throw new Error(`Expected one ${role} session file in ${directory}, found ${files.length}`);
  }
  return join(directory, files[0]!);
};

const commit = (message: string): void => {
  const result = spawnGit(
    [
      "-c",
      "user.name=TypeSafe Experiment",
      "-c",
      "user.email=typesafe-experiment@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: repositoryPath },
  );
  if (result.exitCode !== 0) throw new Error(`git commit failed: ${result.stderr}`);
};

const initializeRepository = async (): Promise<void> => {
  await mkdir(repositoryPath, { recursive: true });
  const initialized = spawnGit(["init", "-q", "-b", "main"], { cwd: repositoryPath });
  if (initialized.exitCode !== 0) throw new Error(`git init failed: ${initialized.stderr}`);
  await writeFile(
    join(repositoryPath, "README.md"),
    "# TypeSafe stall experiment\n\nThis disposable repository contains one fabricated ticket.\n",
  );
  await writeFile(
    join(repositoryPath, "TICKET.md"),
    [
      "# Ticket 1: Create the accepted greeting file",
      "",
      "Create `greeting.txt` in the repository root containing exactly `hello` and a trailing newline.",
      "",
      "## Process fixture",
      "",
      "Before changing files, ask whether you should follow the accepted `greeting.txt` filename and wait for a reply. Ask in plain text, not through a structured question tool.",
      "After the coordinator tells you to continue from accepted instructions, implement the ticket, verify the exact file contents, and commit the change.",
      "",
      "## Acceptance criteria",
      "",
      "- `greeting.txt` exists in the repository root.",
      "- Its complete contents are `hello` followed by one newline.",
      "- The implementation is committed on the current branch.",
      "",
    ].join("\n"),
  );
  const added = spawnGit(["add", "README.md", "TICKET.md"], { cwd: repositoryPath });
  if (added.exitCode !== 0) throw new Error(`git add failed: ${added.stderr}`);
  commit("test: add fabricated stall ticket");
};

const modelRates = {
  "openai-codex/gpt-5.6-sol": {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    tier: { inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
  },
  "openai-codex/gpt-5.6-luna": {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    tier: { inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
  },
} as const;

const sessionMetrics = async (
  path: string,
  model: keyof typeof modelRates,
): Promise<SessionMetrics> => {
  const entries = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const usages: Usage[] = [];
  let turns = 0;
  let toolCalls = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message as Record<string, unknown>;
      if (message.role === "assistant") {
        turns += 1;
        const content = Array.isArray(message.content) ? message.content : [];
        toolCalls += content.filter(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>).type === "toolCall",
        ).length;
        usages.push(message.usage as Usage);
      }
      continue;
    }
    if (entry.type === "usage") usages.push(entry.usage as Usage);
  }

  const rates = modelRates[model];
  const totals = usages.reduce(
    (accumulator, usage) => {
      const selected = usage.input > rates.tier.inputTokensAbove ? rates.tier : rates;
      accumulator.input += usage.input;
      accumulator.output += usage.output;
      accumulator.cache_read += usage.cacheRead;
      accumulator.cache_write += usage.cacheWrite;
      accumulator.total += usage.totalTokens;
      accumulator.reported += usage.cost.total;
      accumulator.list +=
        (usage.input * selected.input +
          usage.output * selected.output +
          usage.cacheRead * selected.cacheRead +
          usage.cacheWrite * selected.cacheWrite) /
        1_000_000;
      return accumulator;
    },
    { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, reported: 0, list: 0 },
  );
  return {
    turns,
    tool_calls: toolCalls,
    tokens: {
      input: totals.input,
      output: totals.output,
      cache_read: totals.cache_read,
      cache_write: totals.cache_write,
      total: totals.total,
    },
    provider_reported_cost_usd: totals.reported,
    list_price_equivalent_usd: totals.list,
  };
};

const main = async (): Promise<void> => {
  if (process.env.HERDR_ENV !== "1" || process.env.HERDR_PANE_ID === undefined) {
    throw new Error("This experiment must run inside the current Herdr pane.");
  }
  const apiKey = await Bun.secrets.get(TYPESAFE_SECRET);
  if (apiKey === null) {
    throw new Error(
      `Missing Bun.secrets credential ${TYPESAFE_SECRET.service}/${TYPESAFE_SECRET.name}.`,
    );
  }

  const startedAt = new Date();
  await Promise.all([
    mkdir(controllerPath, { recursive: true }),
    mkdir(artifactPath, { recursive: true }),
    mkdir(join(sessionPath, "worker"), { recursive: true }),
    mkdir(join(sessionPath, "coordinator"), { recursive: true }),
  ]);
  await initializeRepository();
  await writeJson(join(controllerPath, "oracle.json"), {
    scenario: "stall-mechanical-input-001",
    expected_disposition: "reprompt",
    expected_reason: "mechanical_input",
    expected_repository: { path: "greeting.txt", contents: "hello\n", commits_after_initial: 1 },
  });

  const coordinatorPane = paneFromSplit(
    await herdrJson([
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      repositoryPath,
      "--no-focus",
    ]),
  );
  const workerPane = paneFromSplit(
    await herdrJson([
      "pane",
      "split",
      "--pane",
      coordinatorPane,
      "--direction",
      "down",
      "--ratio",
      "0.5",
      "--cwd",
      repositoryPath,
      "--no-focus",
    ]),
  );

  await herdrJson([
    "agent",
    "start",
    workerName,
    "--kind",
    "pi",
    "--pane",
    workerPane,
    "--timeout",
    "60000",
    "--",
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "max",
    "--session-dir",
    join(sessionPath, "worker"),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ]);

  await herdrJson([
    "agent",
    "prompt",
    workerName,
    "Read TICKET.md and begin the ticket exactly as written. Stop when the process fixture tells you to ask for input.",
    "--wait",
    "--timeout",
    "600000",
  ]);

  const worker = await agentInfo(workerName);
  const status = worker.agent_status === "done" ? "idle" : worker.agent_status;
  if (status !== "working" && status !== "idle" && status !== "blocked") {
    throw new Error(`Worker reached unsupported Herdr state ${worker.agent_status}`);
  }
  const tail = requireSuccess(
    "read worker tail",
    await run(
      "herdr",
      ["agent", "read", workerName, "--source", "recent-unwrapped", "--lines", "25"],
      { timeoutMs: 30_000 },
    ),
  )
    .trimEnd()
    .split("\n")
    .slice(-25);
  const head = spawnGit(["rev-parse", "HEAD"], { cwd: repositoryPath });
  const gitStatus = spawnGit(["status", "--short"], { cwd: repositoryPath });
  const gitLog = spawnGit(["log", "-5", "--format=%H %s"], { cwd: repositoryPath });
  for (const [label, result] of [
    ["git rev-parse", head],
    ["git status", gitStatus],
    ["git log", gitLog],
  ] as const) {
    if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr}`);
  }

  const statePath = join(artifactPath, "stall-state.json");
  const requestPath = join(artifactPath, "stall-request.json");
  const evidencePath = join(artifactPath, "stall-evidence.json");
  const applyOutputPath = join(artifactPath, "stall-apply.json");
  await writeJson(statePath, {
    schema_version: 1,
    assessment_id: "stall-mechanical-input-001",
    ticket: {
      number: "1",
      title: "Create the accepted greeting file",
      acceptance_criteria: [
        "Create greeting.txt in the repository root.",
        "Its complete contents are hello followed by one newline.",
        "Commit the implementation on the current branch.",
      ],
    },
    worker: {
      session: workerName,
      harness: "pi",
      model: "openai-codex/gpt-5.6-luna",
      effort: "max",
      status,
      phase: "implementation",
    },
    previous_observation: null,
    current_observation: {
      observed_at: new Date().toISOString(),
      pane_tail: tail,
      head: head.stdout.trim(),
      git_status: gitStatus.stdout,
      recent_commits: gitLog.stdout.trimEnd().split("\n"),
    },
  });

  await writeJson(join(controllerPath, "prepare.json"), {
    schema_version: 1,
    operation: "stall.prepare",
    input: { state_path: statePath, request_path: requestPath },
  });
  await writeJson(join(controllerPath, "evaluate.json"), {
    schema_version: 1,
    operation: "stall.evaluate",
    input: { request_path: requestPath, evidence_path: evidencePath },
  });
  await writeJson(join(controllerPath, "apply.json"), {
    schema_version: 1,
    operation: "stall.apply",
    input: { request_path: requestPath, evidence_path: evidencePath },
  });

  await herdrJson([
    "agent",
    "start",
    coordinatorName,
    "--kind",
    "pi",
    "--pane",
    coordinatorPane,
    "--timeout",
    "60000",
    "--",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "low",
    "--session-dir",
    join(sessionPath, "coordinator"),
    "--no-extensions",
    "--no-skills",
    "--skill",
    join(skillRoot, "SKILL.md"),
    "--no-prompt-templates",
    "--no-context-files",
  ]);

  const coordinatorPrompt = [
    "Run one experimental stall assessment. Do not make your own semantic classification and do not inspect parent directories or any oracle file.",
    "Use the helper outputs as authoritative for this disposable fixture.",
    "Execute this exact shell workflow in one bash tool call:",
    "",
    "```bash",
    "set -euo pipefail",
    `bun ${JSON.stringify(assessmentCli)} < ${JSON.stringify(join(controllerPath, "prepare.json"))}`,
    `bun ${JSON.stringify(assessmentCli)} < ${JSON.stringify(join(controllerPath, "evaluate.json"))}`,
    `bun ${JSON.stringify(assessmentCli)} < ${JSON.stringify(join(controllerPath, "apply.json"))} > ${JSON.stringify(applyOutputPath)}`,
    `DISPOSITION="$(jq -r '.result.disposition.disposition' ${JSON.stringify(applyOutputPath)})"`,
    `PROMPT="$(jq -r '.result.disposition.prompt // empty' ${JSON.stringify(applyOutputPath)})"`,
    'test "$DISPOSITION" = "reprompt"',
    'test -n "$PROMPT"',
    `herdr agent prompt ${JSON.stringify(workerName)} "$PROMPT" --wait --timeout 600000`,
    'test "$(cat greeting.txt)" = hello',
    'test -z "$(git status --short)"',
    "```",
    "",
    "After it succeeds, report the applied disposition and the worker outcome concisely.",
  ].join("\n");
  await writeFile(join(controllerPath, "coordinator-prompt.md"), coordinatorPrompt);
  await herdrJson([
    "agent",
    "prompt",
    coordinatorName,
    coordinatorPrompt,
    "--wait",
    "--timeout",
    "900000",
  ]);

  const greeting = await readFile(join(repositoryPath, "greeting.txt"), "utf8");
  const finalStatus = spawnGit(["status", "--short"], { cwd: repositoryPath });
  const commitCount = spawnGit(["rev-list", "--count", "HEAD"], { cwd: repositoryPath });
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
    status: string;
    response: { usage: { input_tokens: number | null; output_tokens: number | null } } | null;
    disposition: { disposition: string; reason: string };
    latency_ms: number;
  };
  const oracle = JSON.parse(await readFile(join(controllerPath, "oracle.json"), "utf8")) as {
    expected_disposition: string;
    expected_reason: string;
  };
  const [coordinatorSession, workerSession] = await Promise.all([
    onlySessionFile("coordinator"),
    onlySessionFile("worker"),
  ]);
  const [coordinatorMetrics, workerMetrics] = await Promise.all([
    sessionMetrics(coordinatorSession, "openai-codex/gpt-5.6-sol"),
    sessionMetrics(workerSession, "openai-codex/gpt-5.6-luna"),
  ]);
  const passed =
    evidence.status === "succeeded" &&
    evidence.disposition.disposition === oracle.expected_disposition &&
    evidence.disposition.reason === oracle.expected_reason &&
    greeting === "hello\n" &&
    finalStatus.exitCode === 0 &&
    finalStatus.stdout === "" &&
    commitCount.exitCode === 0 &&
    commitCount.stdout.trim() === "2";
  const completedAt = new Date();
  const typeSafeInput = evidence.response?.usage.input_tokens ?? 0;
  const report = {
    schema_version: 1,
    scenario: "stall-mechanical-input-001",
    arm: "typesafe-assisted-coordinator",
    passed,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    wall_time_ms: completedAt.getTime() - startedAt.getTime(),
    panes: { coordinator: coordinatorPane, worker: workerPane },
    agents: { coordinator: coordinatorName, worker: workerName },
    artifacts: {
      run_root: runRoot,
      request: requestPath,
      evidence: evidencePath,
      coordinator_session: coordinatorSession,
      worker_session: workerSession,
    },
    oracle_result: {
      expected_disposition: oracle.expected_disposition,
      actual_disposition: evidence.disposition.disposition,
      expected_reason: oracle.expected_reason,
      actual_reason: evidence.disposition.reason,
    },
    workflow_result: {
      greeting_contents_exact: greeting === "hello\n",
      clean_worktree: finalStatus.exitCode === 0 && finalStatus.stdout === "",
      commit_count: commitCount.exitCode === 0 ? Number(commitCount.stdout.trim()) : null,
    },
    metrics: {
      coordinator: coordinatorMetrics,
      worker: workerMetrics,
      typesafe: {
        model: "jev-1.13.0",
        input_tokens: evidence.response?.usage.input_tokens ?? null,
        output_tokens: evidence.response?.usage.output_tokens ?? null,
        latency_ms: evidence.latency_ms,
        actual_cost_usd: (typeSafeInput * 0.042) / 1_000_000,
      },
      net: {
        provider_reported_cost_usd:
          coordinatorMetrics.provider_reported_cost_usd +
          workerMetrics.provider_reported_cost_usd +
          (typeSafeInput * 0.042) / 1_000_000,
        list_price_equivalent_usd:
          coordinatorMetrics.list_price_equivalent_usd +
          workerMetrics.list_price_equivalent_usd +
          (typeSafeInput * 0.042) / 1_000_000,
      },
    },
    price_snapshot: {
      captured_at: startedAt.toISOString(),
      source: "Pi openai-codex model catalog and https://docs.typesafe.ai/docs/pricing",
      rates_per_million_tokens_usd: {
        ...modelRates,
        "typesafe/jev-1.13.0": { input: 0.042, output: 0 },
      },
    },
  };
  await writeJson(join(runRoot, "result.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
};

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        run_root: runRoot,
        error: (error as Error).message,
        coordinator: coordinatorName,
        worker: workerName,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
