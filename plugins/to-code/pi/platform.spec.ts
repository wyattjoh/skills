import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { createTicket, createWorker } from "../fleet/model.ts";
import type { Runner } from "../hooks/core/herdr.ts";
import { gitEnvironment, nodeFleetPlatform } from "./platform.ts";
import type { FleetRun, WorkerRecord } from "./storage.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const spawnGit = (
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    cwd,
    env: {
      ...gitEnvironment(environment),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    timeout: 10_000,
  });
  expect(result.exitCode).toBe(0);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const rejected = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected failure");
};

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "to-code-platform-")));
  directories.push(root);
  const repository = join(root, "repository");
  const ticket = join(root, "ticket");
  const decoy = join(root, "decoy");
  await mkdir(repository);
  await mkdir(decoy);
  spawnGit(decoy, ["init", "-q", "-b", "main"]);
  spawnGit(decoy, ["commit", "--allow-empty", "-qm", "Decoy"]);
  const contaminated = {
    ...process.env,
    GIT_DIR: join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_COMMON_DIR: join(decoy, ".git"),
  };
  spawnGit(repository, ["init", "-q", "-b", "main"], contaminated);
  await writeFile(join(repository, ".gitignore"), ".scratch/\n");
  await writeFile(join(repository, "source.txt"), "initial\n");
  spawnGit(repository, ["add", "."]);
  spawnGit(repository, ["commit", "-qm", "Initial"]);
  spawnGit(repository, ["worktree", "add", "-qb", "ticket", ticket]);
  await writeFile(join(ticket, "source.txt"), "implemented\n");
  spawnGit(ticket, ["add", "."]);
  spawnGit(ticket, ["commit", "-qm", "Implementation"]);
  const commands: readonly string[][] = [];
  const mutableCommands = [...commands];
  const bindings: string[] = [];
  let removed = false;
  let probeFails = false;
  let occupant = "fleet_impl";
  let status = "idle";
  let space = "w1";
  let waitReason = "status";
  const terminal = () => ({
    address: "t2",
    name: occupant,
    cwd: ticket,
    state: "live",
    status: { app: "pi", state: status },
    turn: 3,
    labels: { "herdr.space": space, "to-code.run": "async-test", "to-code.worker": "impl" },
  });
  const runner: Runner = async (argv) => {
    mutableCommands.push([...argv]);
    let result: unknown = {};
    if (argv[0] === "herdr-app")
      result = {
        spaces: [
          { id: "w1", machine: null },
          { id: "remote", machine: "vps" },
        ],
      };
    if (argv[1] === "run") result = { address: "t2" };
    if (argv[0] === "hc" && argv[1] === "ls") result = { terminals: removed ? [] : [terminal()] };
    if (argv[1] === "get") {
      if (removed)
        return {
          exitCode: probeFails ? 1 : 3,
          stdout: "",
          stderr: JSON.stringify({
            error: { kind: probeFails ? "transport" : "not_found", message: "probe" },
          }),
        };
      result = terminal();
    }
    if (argv[1] === "rm") removed = true;
    if (argv[1] === "wait") result = { terminal: "t2", ended: true, reason: waitReason };
    return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
  };
  const directory = join(repository, ".scratch", "to-code", "async-test");
  await mkdir(join(directory, "reports"), { recursive: true });
  const snapshot = Effect.runSync(
    createTicket({
      ticketId: "T1",
      worktree: ticket,
      goal: "Implement",
      integrationBranch: "main",
    }),
  );
  const worker: WorkerRecord = {
    id: "impl",
    ticketId: "T1",
    pane: "t2",
    tab: null,
    name: "fleet_impl",
    pid: process.pid,
    callbackReady: true,
    model: "test/model",
    thinking: "high",
    launch: "started",
    launchError: null,
    snapshot: Effect.runSync(
      createWorker({
        workerId: "impl",
        role: "implementor",
        assignment: { id: "assignment", goal: "Implement", head: null },
      }),
    ),
  };
  const run: FleetRun = {
    version: 2,
    id: "async-test",
    directory,
    repository,
    commonDirectory: join(repository, ".git"),
    workspace: "w1",
    integrationBranch: "main",
    coordinatorPane: "t1",
    coordinatorSession: "test",
    coordinatorPid: process.pid,
    hostname: hostname(),
    checks: ["git diff --exit-code"],
    commandTimeoutMs: 1000,
    workers: [worker],
    tickets: [{ id: "T1", implementor: "impl", reviewer: null, snapshot }],
    reports: [],
    outbox: [],
  };
  return {
    repository,
    ticket,
    decoy,
    contaminated,
    platform: nodeFleetPlatform(runner, contaminated, undefined, async () => {
      if (waitReason !== "status")
        throw new Error("Startup registration timed out; inspect before retrying");
    }),
    run,
    worker,
    commands: mutableCommands,
    bindings,
    bind: async (address: string) => {
      bindings.push(address);
    },
    probeFailure: () => {
      probeFails = true;
    },
    foreign: () => {
      occupant = "other_user";
    },
    move: () => {
      space = "other";
    },
    working: () => {
      status = "working";
    },
    uncertain: () => {
      waitReason = "timeout";
    },
  };
};

test("real Git facts, checks, and ancestry use the requested worktree despite hook env contamination", async () => {
  const f = await fixture();
  const facts = await f.platform.facts(f.ticket, "main");
  expect(facts.worktree).toBe(f.ticket);
  expect(facts.commonDirectory).toBe(join(f.repository, ".git"));
  expect(facts.branch).toBe("ticket");
  expect(facts.clean).toBe(true);
  expect(await f.platform.scratchIgnored(f.repository)).toBe(true);
  expect(await f.platform.checks(f.ticket, ["git diff --exit-code"], 1000)).toEqual([
    "git diff --exit-code: passed",
  ]);
  expect(await rejected(f.platform.landed(f.ticket, "main", facts.head))).toContain("failed");
  spawnGit(f.repository, ["merge", "--ff-only", "ticket"]);
  expect(await f.platform.landed(f.ticket, "main", facts.head)).toBe(facts.head);
  expect((await f.platform.facts(f.ticket, "main")).base).toBe(facts.head);
  expect(spawnGit(f.decoy, ["rev-list", "--count", "HEAD"])).toBe("1");
  expect(spawnGit(f.decoy, ["ls-tree", "HEAD"])).toBe("");
});

test("real report files reject traversal, outside paths, and symlinks", async () => {
  const f = await fixture();
  const filename = ".scratch/to-code/async-test/reports/review.md";
  await writeFile(join(f.repository, filename), "# Review\n");
  expect((await f.platform.reviewFile(f.run, filename)).text).toBe("# Review\n");
  expect(await rejected(f.platform.reviewFile(f.run, ".scratch/../source.txt"))).toContain(
    "relative scratch",
  );
  await symlink(join(f.ticket, "source.txt"), join(f.run.directory, "reports", "linked.md"));
  expect(
    await rejected(f.platform.reviewFile(f.run, ".scratch/to-code/async-test/reports/linked.md")),
  ).toContain("outside");
});

test("verification commands time out as process groups and honor an already-aborted signal", async () => {
  const f = await fixture();
  await expect(f.platform.checks(f.ticket, ["sleep 10"], 25)).rejects.toThrow("timed out");
  const controller = new AbortController();
  controller.abort();
  const runner: Runner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const aborted = nodeFleetPlatform(runner, f.contaminated, controller.signal);
  await expect(aborted.checks(f.ticket, ["sleep 10"], 1000)).rejects.toThrow("aborted");
});

test("launch uses hc background terminals, selected-space labels and exact role/model flags", async () => {
  const f = await fixture();
  expect(await f.platform.workspaceExists("remote")).toBe(false);
  expect(await f.platform.workspaceExists("w1")).toBe(true);
  expect(await f.platform.prepareWorker("w1", f.ticket, "fleet_impl")).toEqual({
    pane: "fleet_impl",
    tab: null,
  });
  expect(f.commands).toEqual([
    ["herdr-app", "ls"],
    ["herdr-app", "ls"],
  ]);
  await f.platform.start(f.run, f.worker, f.bind);
  expect(f.commands[2]?.slice(0, 13)).toEqual([
    "hc",
    "run",
    "--bg",
    "--outlive-parent",
    "--name",
    "fleet_impl",
    "--cwd",
    f.ticket,
    "--label",
    "herdr.space=w1",
    "--label",
    "to-code.run=async-test",
    "--label",
  ]);
  expect(f.commands[2]?.slice(-8)).toEqual([
    "--model",
    "test/model",
    "--thinking",
    "high",
    "--fleet-run",
    f.run.directory,
    "--fleet-implementor",
    "impl",
  ]);
  expect(f.commands.at(-1)).toEqual(["hc", "get", "t2"]);
  expect(f.commands.filter((command) => command[1] === "wait")).toEqual([]);
  expect(f.bindings).toEqual(["t2"]);
});

test("cleanup refuses a foreign occupant, moved terminal or working worker", async () => {
  for (const change of ["foreign", "move", "working"] as const) {
    const f = await fixture();
    f[change]();
    await rejected(f.platform.closeOwned(f.run, f.worker));
    expect(f.commands.filter((command) => ["kill", "rm"].includes(command[1]!))).toEqual([]);
  }
});

test("cleanup kills and removes only the owned terminal and never closes an app tab", async () => {
  const f = await fixture();
  await f.platform.closeOwned(f.run, f.worker);
  expect(f.commands.filter((command) => ["kill", "rm"].includes(command[1]!))).toEqual([
    ["hc", "kill", "t2"],
    ["hc", "rm", "t2"],
  ]);
  expect(f.commands.every((command) => command[0] === "hc")).toBe(true);
});

test("cleanup retries after removal using exact-address not_found proof, not just a missing list row", async () => {
  const f = await fixture();
  await f.platform.closeOwned(f.run, f.worker);
  await f.platform.closeOwned(f.run, f.worker);
  expect(f.commands.filter((command) => ["kill", "rm"].includes(command[1]!))).toEqual([
    ["hc", "kill", "t2"],
    ["hc", "rm", "t2"],
  ]);
  f.probeFailure();
  expect(await rejected(f.platform.closeOwned(f.run, f.worker))).toContain("transport");
});

test("startup timeouts remain uncertain instead of claiming completion or relaunching", async () => {
  const f = await fixture();
  f.uncertain();
  expect(await rejected(f.platform.start(f.run, f.worker, f.bind))).toContain(
    "inspect before retrying",
  );
  expect(f.commands.filter((command) => command[1] === "run")).toHaveLength(1);
  expect(f.bindings).toEqual(["t2"]);
});
