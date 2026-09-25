import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerEscalation, listOpenEscalations } from "./lib/escalations.ts";
import { acceptSnapshot } from "./lib/snapshot.ts";
import { runEngine } from "./lib/engine.ts";
import { readEventsSince } from "./lib/event-log.ts";
import { spawnGit } from "./lib/git.ts";
import type { HerdrActuator, OwnedTab } from "./lib/herdr-actuator.ts";
import { readTicketStatus } from "./lib/run-config.ts";
import { createFakeHerdrEnv } from "./test-herdr.ts";
import { startFakeHerdr, type FakeHerdrServer } from "./test-herdr-server.ts";
import { standardTicket, workflow } from "./workflow.ts";

const FAKE_ENV = createFakeHerdrEnv();
const originalPath = process.env.PATH;
const originalLive = process.env.HERDR_TEST_LIVE_PANES;

beforeAll(() => {
  process.env.PATH = FAKE_ENV.PATH;
  process.env.HERDR_TEST_LIVE_PANES = "[]";
});

afterAll(() => {
  process.env.PATH = originalPath;
  if (originalLive === undefined) delete process.env.HERDR_TEST_LIVE_PANES;
  else process.env.HERDR_TEST_LIVE_PANES = originalLive;
});

const servers: FakeHerdrServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const git = (cwd: string, args: string[]) => {
  const result = spawnGit(args, { cwd });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
};

const commitFile = (cwd: string, name: string, body: string, message: string) => {
  writeFileSync(join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
};

type Fixture = { root: string; repository: string; runPath: string; statePath: string };

const TICKETS = [
  { number: "01", slug: "outbox", blocked_by: [] as string[] },
  { number: "02", slug: "client", blocked_by: [] as string[] },
  { number: "03", slug: "worker", blocked_by: ["01"] },
];

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-builtins-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Test User"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  commitFile(repository, "CLAUDE.md", "# rules\n", "base");
  const runPath = join(root, "run");
  mkdirSync(join(runPath, "issues"), { recursive: true });
  mkdirSync(join(runPath, "briefs"), { recursive: true });
  writeFileSync(join(runPath, "spec.md"), "# Offline sync\n");
  writeFileSync(join(runPath, "briefs", "common.md"), "Implement one ticket.\n");
  writeFileSync(
    join(runPath, "snapshot.json"),
    JSON.stringify({
      schema_version: 1,
      source: {
        kind: "local",
        tracker: "local-files",
        reference: "file:run",
        tracker_workflow: null,
      },
      specification: { path: "spec.md", source_reference: "file:spec.md", agreed: true },
      tickets: TICKETS.map((ticket) => ({
        number: ticket.number,
        path: `issues/${ticket.number}-${ticket.slug}.md`,
        source_reference: `file:issues/${ticket.number}`,
        blocked_by: ticket.blocked_by,
      })),
    }),
  );
  for (const ticket of TICKETS) {
    writeFileSync(
      join(runPath, "issues", `${ticket.number}-${ticket.slug}.md`),
      `# ${ticket.number}: ${ticket.slug}\n\n**Blocked by:** ${ticket.blocked_by.length === 0 ? "none" : ticket.blocked_by.map((blocker) => `${blocker}: ${TICKETS.find((candidate) => candidate.number === blocker)!.slug}`).join(", ")}\n\n**Status:** ready-for-agent\n\n- [ ] works\n`,
    );
  }
  const skill = join(root, "implement-SKILL.md");
  writeFileSync(skill, "# implement\n");
  const statePath = join(runPath, "RESUME.md");
  writeFileSync(
    statePath,
    `# builtins run

Schema version: 2

Prefix:          ex
Base:            main
Base sha:        ${git(repository, ["rev-parse", "main"])}
Mode:            parallel
Parallel cap:    2
Stall interval:  10m
Branch template: wyattjoh/ex-NN-<slug>

Coordinator:
  harness:    claude
  model:      fable
  effort:     low
  handoff:    disabled
  threshold:  unavailable
  unattended: block

Implementor:
  harness: pi
  model:   openai/test
  effort:  high

Reviewer:
  harness: claude
  model:   sonnet
  effort:  medium

## Repository policy

\`\`\`json
${JSON.stringify(
  {
    instruction_files: ["CLAUDE.md"],
    worktree: { kind: "native", tool: "git", root: join(root, "worktrees"), create_argv: null },
    branch_naming: "wyattjoh/ex-NN-<slug>",
    setup_argvs: [],
    cleanup: "native-safe",
    remote: "local-only",
    remote_sync_argv: null,
    commit: { commits: "multiple", fixes: "append" },
  },
  null,
  2,
)}
\`\`\`

## Review policy

\`\`\`json
${JSON.stringify(
  {
    instruction_files: ["CLAUDE.md"],
    ci_files: [],
    gates: [{ name: "test", argv: [process.execPath, "-e", "process.exit(0)"] }],
    no_executable_gates: false,
    safety_constraints: ["Do not push."],
    no_additional_safety_constraints: false,
    gate_execution: { claude: "background-allowed", pi: "synchronous" },
    self_review: "standards-spec-single-session",
    max_infrastructure_attempts: 4,
    retry_delays_seconds: [1, 2, 4],
  },
  null,
  2,
)}
\`\`\`

## Tickets

| NN | harness | model | effort | rounds | esc | status | sha |
| -- | ------- | ----- | ------ | ------ | --- | ------ | --- |
${TICKETS.map((ticket) => `| ${ticket.number} | - | - | - | 0 | - | queued | - |`).join("\n")}

## Active tickets

## Review evidence

## Decisions

- setup

## Retained landed branches
`,
  );
  return { root, repository, runPath, statePath };
};

const acceptFixture = (fixture: Fixture) =>
  Effect.runPromise(
    acceptSnapshot({
      runPath: fixture.runPath,
      statePath: fixture.statePath,
      writeback: undefined,
      projectRemoteWrites: "forbidden",
      acceptedAt: "2026-09-25T12:00:00Z",
    }),
  );

type Agent = { session: string; pane: string; cwd: string; reviewer: boolean };

/**
 * Scripted agents: implementors commit a ticket file, answer rebase, fix, and
 * self-review prompts; reviewers write a PASS or FAIL report to the named path.
 */
const fakeWorld = async (options: {
  failFirstReview: string | undefined;
  ask: string | undefined;
}) => {
  const server = await startFakeHerdr([]);
  servers.push(server);
  const panes = new Map<string, string>();
  const agents = new Map<string, Agent>();
  const prompts: Array<{ session: string; text: string }> = [];
  const starts: string[] = [];
  let nextPane = 1;
  let reviewFailed = false;
  let asked = false;

  const respond = async (agent: Agent, text: string) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (agent.reviewer) {
      const path = /write your complete report to (\S+?)\. That file/u.exec(text)![1]!;
      const ticket = /-review-(\d+)-/u.exec(agent.session)![1]!;
      const fail =
        options.failFirstReview === ticket && !reviewFailed && text.includes("Spec review");
      if (fail) reviewFailed = true;
      writeFileSync(
        path,
        fail
          ? "## Finding\nSeverity: high\nLocation: ticket.txt:1\nRationale: missing detail\nSuggested fix: add detail\n\nFAIL\n"
          : "No actionable findings.\n\nPASS\n",
      );
    } else if (text.startsWith("REBASE REQUIRED")) {
      git(agent.cwd, ["rebase", "-q", "main"]);
    } else if (text.includes("## Standards")) {
      const path = /to (\S+\.draft\.md)/u.exec(text)![1]!;
      writeFileSync(path, "## Standards\nNo findings.\n\n## Spec\nNo findings.\n");
    } else if (text.startsWith("Apply every finding")) {
      commitFile(agent.cwd, `fix-${agent.session}.txt`, "fixed\n", "fix");
    } else if (text.startsWith("Answer to your TICKET BLOCKED")) {
      commitFile(agent.cwd, `${agent.session}.txt`, "answered\n", "ticket work");
    } else if (options.ask === agent.session && !asked) {
      asked = true;
      mkdirSync(join(text.split("write the complete question to ")[1]!.split(",")[0]!, ".."), {
        recursive: true,
      });
      writeFileSync(
        text.split("write the complete question to ")[1]!.split(",")[0]!,
        "Should retries be capped?\n",
      );
      server.setStatus(agent.session, "blocked", true);
      return;
    } else {
      commitFile(agent.cwd, `${agent.session}.txt`, `${agent.session}\n`, "ticket work");
    }
    server.setStatus(agent.session, "idle", true);
  };

  const actuator: HerdrActuator = {
    ensureTab: (input) =>
      Effect.sync((): OwnedTab => {
        const pane = `w1:p${nextPane++}`;
        panes.set(pane, input.cwd);
        return { tab_id: `w1:t${pane.slice(4)}`, pane_id: pane, adopted: false };
      }),
    run: (command) =>
      Effect.sync(() => {
        const session = command.args[2]!;
        const pane = command.args[command.args.indexOf("--pane") + 1]!;
        const agent: Agent = {
          session,
          pane,
          cwd: panes.get(pane)!,
          reviewer: session.includes("-review-"),
        };
        agents.set(session, agent);
        starts.push(session);
        server.agents.push({ session, pane, status: "idle" });
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }),
    deliverPrompt: (session, text) =>
      Effect.sync(() => {
        prompts.push({ session, text });
        server.setStatus(session, "working", true);
        void respond(agents.get(session)!, text);
      }),
    readPane: () => Effect.succeed(""),
    closePane: (pane) =>
      Effect.sync(() => {
        server.exitPane(pane);
        return "closed" as const;
      }),
    runInPane: () => Effect.void,
  };
  return { server, actuator, prompts, starts };
};

const moduleFor = (fixture: Fixture, world: Awaited<ReturnType<typeof fakeWorld>>) =>
  workflow(
    async (run) => {
      await run.frontier((ticket) => standardTicket(ticket));
    },
    {
      repository: fixture.repository,
      implementSkill: join(fixture.root, "implement-SKILL.md"),
      workspace: "w1",
      socketPath: world.server.path,
      actuator: world.actuator,
      answerPollMs: 20,
    },
  );

const engineFor = (
  fixture: Fixture,
  world: Awaited<ReturnType<typeof fakeWorld>>,
  expected: number,
) =>
  runEngine({
    statePath: fixture.statePath,
    expectedGeneration: expected,
    scriptSha256: "sha",
    pid: process.pid,
    host: "host-a",
    pane: null,
    heartbeatMs: 1_000,
    now: () => new Date(),
    workflow: moduleFor(fixture, world).run,
  });

const runFixture = async (
  fixture: Fixture,
  world: Awaited<ReturnType<typeof fakeWorld>>,
  onTick: (() => Promise<void>) | undefined = undefined,
) => {
  const module = workflow(
    async (run) => {
      await run.frontier((ticket) => standardTicket(ticket));
    },
    {
      repository: fixture.repository,
      implementSkill: join(fixture.root, "implement-SKILL.md"),
      workspace: "w1",
      socketPath: world.server.path,
      actuator: world.actuator,
      answerPollMs: 20,
    },
  );
  const engine = Effect.runPromise(
    runEngine({
      statePath: fixture.statePath,
      expectedGeneration: 0,
      scriptSha256: "sha",
      pid: process.pid,
      host: "host-a",
      pane: null,
      heartbeatMs: 1_000,
      now: () => new Date(),
      workflow: module.run,
    }),
  );
  if (onTick !== undefined) await onTick();
  return engine;
};

describe("built-in ticket operations", () => {
  it("implements, gates, reviews, rebases, and lands a dependent graph through fake agents", async () => {
    const fixture = makeFixture();
    await acceptFixture(fixture);
    const world = await fakeWorld({ failFirstReview: "02", ask: undefined });

    const exit = await runFixture(fixture, world);
    const state = readFileSync(fixture.statePath, "utf8");
    const events = await Effect.runPromise(readEventsSince(fixture.runPath, 0));
    const types = events.events.map((event) => event.type);

    expect(exit).toEqual({ reason: "completed", generation: 1 });
    expect(TICKETS.map((ticket) => readTicketStatus(state, ticket.number))).toEqual([
      "landed",
      "landed",
      "landed",
    ]);
    expect(git(fixture.repository, ["log", "--format=%s", "main"]).split("\n").toSorted()).toEqual([
      "base",
      "fix",
      "ticket work",
      "ticket work",
      "ticket work",
    ]);
    expect(types.filter((type) => type === "ticket.landed").length).toBe(3);
    expect(types.filter((type) => type === "ticket.fix_requested").length).toBe(1);
    expect(events.events.find((event) => event.type === "run.finalized")?.data.status).toBe(
      "completed",
    );
    expect(readFileSync(join(fixture.runPath, "SUMMARY.md"), "utf8").length > 0).toBe(true);
  }, 60_000);

  it("resumes after the engine dies mid-run without relaunching live implementors", async () => {
    const fixture = makeFixture();
    await acceptFixture(fixture);
    const world = await fakeWorld({ failFirstReview: undefined, ask: undefined });

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(engineFor(fixture, world, 0));
        while (world.prompts.filter((prompt) => prompt.text.includes("Ticket 0")).length < 2) {
          yield* Effect.sleep(5);
        }
        yield* Fiber.interrupt(first);
        return yield* engineFor(fixture, world, 1);
      }),
    );
    const state = readFileSync(fixture.statePath, "utf8");
    const events = await Effect.runPromise(readEventsSince(fixture.runPath, 0));
    const implementorStarts = world.starts.filter((session) => !session.includes("-review-"));

    expect(exit).toEqual({ reason: "completed", generation: 2 });
    expect(TICKETS.map((ticket) => readTicketStatus(state, ticket.number))).toEqual([
      "landed",
      "landed",
      "landed",
    ]);
    expect(implementorStarts.toSorted()).toEqual(["ex-01", "ex-02", "ex-03"]);
    expect(events.events.filter((event) => event.type === "engine.started").length).toBe(2);
  }, 60_000);

  it("holds new launches while the accepted snapshot is stale", async () => {
    const fixture = makeFixture();
    await acceptFixture(fixture);
    writeFileSync(join(fixture.runPath, "spec.md"), "# Offline sync, revised\n");
    const world = await fakeWorld({ failFirstReview: undefined, ask: undefined });

    const exit = await runFixture(fixture, world, async () => {
      for (let tries = 0; tries < 200; tries++) {
        const open = await Effect.runPromise(listOpenEscalations(fixture.runPath));
        if (open.length > 0) {
          await Effect.runPromise(
            acceptSnapshot({
              runPath: fixture.runPath,
              statePath: fixture.statePath,
              writeback: undefined,
              projectRemoteWrites: "forbidden",
              acceptedAt: "2026-09-25T12:05:00Z",
            }),
          );
          await Effect.runPromise(
            answerEscalation(fixture.runPath, {
              id: open[0]!.id,
              answer: "Accepted the revised spec.",
              answered_by: "user",
              answered_at: "2026-09-25T12:05:00Z",
            }),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    const types = (await Effect.runPromise(readEventsSince(fixture.runPath, 0))).events.map(
      (event) => event.type,
    );

    expect(exit.reason).toBe("completed");
    expect(types.indexOf("attention.snapshot_changed")).toBe(2);
    expect(types.indexOf("escalation.answered")).toBeLessThan(
      types.indexOf("implementor.launched"),
    );
  }, 60_000);

  it("parks only the asking ticket until its escalation is answered", async () => {
    const fixture = makeFixture();
    await acceptFixture(fixture);
    const world = await fakeWorld({ failFirstReview: undefined, ask: "ex-02" });

    const exit = await runFixture(fixture, world, async () => {
      for (let tries = 0; tries < 200; tries++) {
        const open = await Effect.runPromise(listOpenEscalations(fixture.runPath));
        if (open.length > 0) {
          await Effect.runPromise(
            answerEscalation(fixture.runPath, {
              id: open[0]!.id,
              answer: "Yes, cap at three.",
              answered_by: "coordinator",
              answered_at: "2026-09-25T12:00:00Z",
            }),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    const answered = world.prompts.filter((prompt) =>
      prompt.text.startsWith("Answer to your TICKET BLOCKED 02"),
    );

    expect(exit.reason).toBe("completed");
    expect(answered.length).toBe(1);
    expect(answered[0]!.text).toContain("Yes, cap at three.");
  }, 60_000);
});
