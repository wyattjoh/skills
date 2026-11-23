import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { Effect } from "effect";
import { itemAdd } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { failureOf, g, initRepo, runWith, tempDir } from "./fixture.ts";
import { delegate, start, type DelegateOptions } from "./lifecycle.ts";
import { FAKE_CORE, fakeProc, ok, type RunOutput } from "./proc.ts";
import { capacityQueuePath, enqueueCapacityWait, readCapacityQueue } from "./capacity-queue.ts";
import { HarnessPolicyError, harnessPolicyPath, setHarnessPolicy } from "./harness-policy.ts";
import { liveDelegateCount } from "./delegate-capacity.ts";
import type { ListedTerminal } from "./herdr.ts";

const dirs: string[] = [];
const dir = () => {
  const made = tempDir();
  dirs.push(made);
  return made;
};
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});

const NOW = "2026-11-18T10:00:00.000Z";
const config = (
  state: string,
  budget = 2,
  cores = 8,
  machineBudgets: Record<string, number> = {},
) =>
  Effect.runPromise(
    resolveConfig(
      {
        backlog_dir: join(state, "backlogs"),
        state_dir: state,
        max_fleet_delegates: budget,
        ...(Object.keys(machineBudgets).length === 0
          ? {}
          : { max_fleet_delegates_by_machine: machineBudgets }),
      },
      "/config.json",
      cores,
    ),
  );
const configFromMachineCores = (state: string, cores = 8) =>
  Effect.runPromise(
    resolveConfig(
      { backlog_dir: join(state, "backlogs"), state_dir: state },
      "/config.json",
      cores,
    ),
  );
const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };
const DELEGATE = { "fleet.domain": "app", "fleet.session": "s-parent" };

const options = (fields: Partial<DelegateOptions> = {}): DelegateOptions => ({
  name: "new-delegate",
  task: "native gate work",
  repo: undefined,
  cwd: undefined,
  base: undefined,
  harness: "pi",
  model: undefined,
  effort: undefined,
  message: { kind: "skill", skill: "implement", args: "" },
  space: false,
  domain: undefined,
  item: undefined,
  overBudget: false,
  queueIfFull: false,
  retryQueued: false,
  machine: undefined,
  ...fields,
});

const withItem = async (
  state: string,
  budget: number | null = 2,
  cores = 8,
  machineBudgets: Record<string, number> = {},
  callerAddress = "t1",
) => {
  const cfg =
    budget === null
      ? await configFromMachineCores(state, cores)
      : await config(state, budget, cores, machineBudgets);
  const setup = fleet(COORDINATOR, [], callerAddress);
  await runWith(start(cfg, "app", { HC_TERMINAL_ID: callerAddress }), setup.layer);
  await runWith(itemAdd(cfg, "app", { title: "native gate work", json: false, now: NOW }));
  return { cfg, path: join(state, "backlogs", "app.json") };
};

const terminalDoc = (address: string, labels: Record<string, string>) => ({
  address,
  name: address === "t1" ? "caller" : address,
  cwd: "/tmp",
  state: "live",
  labels,
  status: { app: "pi", state: "working" },
});

const fleet = (
  callerLabels: Record<string, string>,
  delegates: ReadonlyArray<{ address: string; domain: string }>,
  callerAddress = "t1",
  coreAnswers: Record<string, RunOutput> = {},
) => {
  const terminals = new Map<string, ReturnType<typeof terminalDoc>>([
    [callerAddress, terminalDoc(callerAddress, callerLabels)],
    ...delegates.map(
      ({ address, domain }) =>
        [
          address,
          terminalDoc(address, { "fleet.domain": domain, "fleet.session": `s-${address}` }),
        ] as const,
    ),
  ]);
  const fake = fakeProc((argv): RunOutput => {
    if (argv[0] === "hc" && argv[1] === "ls")
      return ok(
        JSON.stringify({
          terminals: [...terminals.values()].map((terminal) => ({
            address: terminal.address,
            name: terminal.name,
            state: "live",
          })),
        }),
      );
    if (argv[0] === "hc" && argv[1] === "get") {
      const terminal = terminals.get(argv[2] ?? "");
      return terminal
        ? ok(JSON.stringify(terminal))
        : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (argv[0] === "hc" && argv[1] === "exec") {
      const machine = argv[argv.indexOf("--on") + 1] ?? "";
      return coreAnswers[machine] ?? { exitCode: 1, stdout: "", stderr: "machine unavailable" };
    }
    if (argv[0] === "hc" && argv[1] === "run") {
      const address = "t-new";
      const labels: Record<string, string> = {};
      for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== "--label") continue;
        const [key, value] = argv[index + 1]?.split("=", 2) ?? [];
        if (key && value) labels[key] = value;
      }
      terminals.set(address, terminalDoc(address, labels));
      return ok(JSON.stringify({ address }));
    }
    if (argv[0] === "hc" && argv[1] === "label") return ok("{}");
    if (argv[0] === "herdr-app") return ok("{}");
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
  return fake;
};

let originalTerminal: string | undefined;
beforeEach(() => {
  originalTerminal = process.env.HC_TERMINAL_ID;
  process.env.HC_TERMINAL_ID = "t1";
});
afterEach(() => {
  if (originalTerminal === undefined) delete process.env.HC_TERMINAL_ID;
  else process.env.HC_TERMINAL_ID = originalTerminal;
});

describe("fleet delegate budget", () => {
  it("starts under budget", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const fake = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "strix/t3", domain: "app" },
    ]);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(lines.slice(0, 1)).toEqual(["started new-delegate (t-new)"]);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(1);
  });

  it("refuses at budget without changing the item or creating a worktree", async () => {
    const state = dir();
    const { cfg, path } = await withItem(state);
    const before = readFileSync(path, "utf8");
    const repo = initRepo();
    dirs.push(repo);
    const fake = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "t3", domain: "infra" },
      { address: "strix/t4", domain: "app" },
    ]);
    const error = await failureOf(
      delegate(cfg, options({ repo, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      `machine ${FAKE_CORE} has 2 live delegates (budget 2); refusing new-delegate for item i1; pass --over-budget to start anyway`,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(repo, ".claude", "worktrees", "new-delegate"))).toBe(false);
    expect(g(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
  });

  it("uses the target remote machine's cores and counts only its delegates", async () => {
    const state = dir();
    const callerAddress = "strix/t1";
    const { cfg } = await withItem(state, null, 8, {}, callerAddress);
    process.env.HC_TERMINAL_ID = callerAddress;
    const elsewhere = Array.from({ length: 7 }, (_, index) => ({
      address: `t${index + 3}`,
      domain: "infra",
    }));
    const fake = fleet(
      COORDINATOR,
      [
        { address: "strix/t2", domain: "app" },
        { address: "strix/t3", domain: "infra" },
        ...elsewhere,
      ],
      callerAddress,
      { strix: ok("32") },
    );
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(lines[0]).toBe("started new-delegate (t-new)");
    expect(fake.calls.filter(({ argv }) => argv[1] === "exec").length).toBe(1);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(1);
  });

  it.each(["local", hostname(), FAKE_CORE])(
    "applies a per-machine budget keyed by %s to this core's Herdr machine name",
    async (key) => {
      const state = dir();
      const { cfg } = await withItem(state, 2, 8, { [key]: 1 });
      const fake = fleet(COORDINATOR, [{ address: "t2", domain: "app" }]);
      const error = await failureOf(
        delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
        fake.layer,
      );
      expect(error instanceof Error ? error.message : String(error)).toBe(
        `machine ${FAKE_CORE} has 1 live delegates (budget 1); refusing new-delegate for item i1; pass --over-budget to start anyway`,
      );
    },
  );

  it.each([
    [{ local: 5, [hostname()]: 4, [FAKE_CORE]: 1 }, 1],
    [{ local: 5, [hostname()]: 1 }, 1],
  ])("prefers the Herdr name, then the hostname, then local (%o)", async (budgets, expected) => {
    const state = dir();
    const { cfg } = await withItem(state, 2, 8, budgets);
    const fake = fleet(COORDINATOR, [{ address: "t2", domain: "app" }]);
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      `machine ${FAKE_CORE} has 1 live delegates (budget ${expected}); refusing new-delegate for item i1; pass --over-budget to start anyway`,
    );
  });

  it("labels a new delegate with this core's Herdr machine name", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const fake = fleet(COORDINATOR, []);
    await runWith(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    const run = fake.calls.find(({ argv }) => argv[1] === "run");
    expect(run?.argv).toContain(`fleet.machine=${FAKE_CORE}`);
  });

  it("retries a queue entry keyed by the OS hostname as this core's entry", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    await runWith(enqueueCapacityWait(cfg, "app", { item: "i1", machine: hostname() }));
    const available = fleet(COORDINATOR, []);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", retryQueued: true }), () => 3),
      available.layer,
    );
    expect(lines).toEqual([
      "started new-delegate (t-new)",
      "filed new-delegate under i1 [delegated]",
    ]);
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([]);
  });

  it("refuses a delegate launch when this core's Herdr machine name cannot be read", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const fake = fakeProc(
      (argv) => {
        if (argv[1] === "get") return ok(JSON.stringify(terminalDoc("t1", COORDINATOR)));
        if (argv[1] === "server")
          return { exitCode: 1, stdout: "", stderr: "herdr-core is not answering" };
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      },
      { core: undefined },
    );
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "herdr-core is not answering",
    );
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
  });

  it("uses a configured target-machine override instead of reading remote cores", async () => {
    const state = dir();
    const callerAddress = "strix/t1";
    const { cfg } = await withItem(state, 2, 8, { strix: 1 }, callerAddress);
    process.env.HC_TERMINAL_ID = callerAddress;
    const fake = fleet(COORDINATOR, [{ address: "strix/t2", domain: "app" }], callerAddress);
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "machine strix has 1 live delegates (budget 1); refusing new-delegate for item i1; pass --over-budget to start anyway",
    );
    expect(fake.calls.filter(({ argv }) => argv[1] === "exec").length).toBe(0);
  });

  it("falls back to the configured default and warns once when remote cores are unavailable", async () => {
    const state = dir();
    const callerAddress = "strix/t1";
    const { cfg } = await withItem(state, null, 8, {}, callerAddress);
    process.env.HC_TERMINAL_ID = callerAddress;
    const fake = fleet(COORDINATOR, [{ address: "strix/t2", domain: "app" }], callerAddress);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    const warning =
      "warning: could not read core count for machine strix; using configured max_fleet_delegates default 2";
    expect(lines.slice(0, 2)).toEqual([warning, "started new-delegate (t-new)"]);
    expect(lines.filter((line) => line === warning).length).toBe(1);
  });

  it("includes the core-read fallback when refusing at the configured default", async () => {
    const state = dir();
    const callerAddress = "strix/t1";
    const { cfg } = await withItem(state, null, 8, {}, callerAddress);
    process.env.HC_TERMINAL_ID = callerAddress;
    const fake = fleet(
      COORDINATOR,
      [
        { address: "strix/t2", domain: "app" },
        { address: "strix/t3", domain: "infra" },
      ],
      callerAddress,
    );
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "machine strix has 2 live delegates (budget 2); refusing new-delegate for item i1; pass --over-budget to start anyway; warning: could not read core count for machine strix; using configured max_fleet_delegates default 2",
    );
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
  });

  it("uses an enabled configured default when a new launch omits --harness", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    await Effect.runPromise(
      setHarnessPolicy(cfg, {
        scope: "global",
        domain: undefined,
        selection: { enabled: ["claude"], default: "claude" },
        expectedRevision: 0,
        json: true,
      }),
    );
    const fake = fleet(COORDINATOR, []);
    await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", harness: undefined }), () => 3),
      fake.layer,
    );
    const run = fake.calls.find(({ argv }) => argv[1] === "run");
    expect(run?.argv).toContain("fleet.harness=claude");
    expect(run?.argv).toContain("claude");
  });

  it("refuses an omitted harness in legacy state before launch side effects", async () => {
    const state = dir();
    const { cfg, path } = await withItem(state);
    const before = readFileSync(path, "utf8");
    const fake = fleet(COORDINATOR, []);
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1", harness: undefined }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "no harness was selected for app: pass --harness pi|claude or configure an enabled default with coordinate harness-policy",
    );
    expect(fake.calls.filter(({ argv }) => argv[1] === "run")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("fails closed on malformed policy before creating a worktree or launching", async () => {
    const state = dir();
    const { cfg, path: backlogPath } = await withItem(state);
    const before = readFileSync(backlogPath, "utf8");
    const policyPath = harnessPolicyPath(state);
    writeFileSync(policyPath, "{");
    const repo = initRepo();
    dirs.push(repo);
    const fake = fleet(COORDINATOR, []);
    const error = await failureOf(
      delegate(cfg, options({ repo, item: "i1", harness: "pi" }), () => 3),
      fake.layer,
    );
    expect(error instanceof HarnessPolicyError).toBe(true);
    expect(existsSync(join(repo, ".claude", "worktrees", "new-delegate"))).toBe(false);
    expect(g(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(fake.calls.filter(({ argv }) => argv[1] === "run")).toEqual([]);
    expect(readFileSync(backlogPath, "utf8")).toBe(before);
  });

  it("does not let --over-budget bypass a disabled harness or block child policy checks", async () => {
    const state = dir();
    const { cfg, path } = await withItem(state);
    await Effect.runPromise(
      setHarnessPolicy(cfg, {
        scope: "global",
        domain: undefined,
        selection: { enabled: ["claude"], default: "claude" },
        expectedRevision: 0,
        json: true,
      }),
    );
    const before = readFileSync(path, "utf8");
    const coordinator = fleet(COORDINATOR, []);
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1", overBudget: true }), () => 3),
      coordinator.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "harness pi is disabled by global policy for app; enabled harnesses: claude",
    );
    expect(coordinator.calls.filter(({ argv }) => argv[1] === "run")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);

    const child = fleet(DELEGATE, []);
    const childError = await failureOf(
      delegate(cfg, options({ cwd: state, domain: "app", harness: "pi" }), () => 3),
      child.layer,
    );
    expect(childError instanceof Error ? childError.message : String(childError)).toBe(
      "harness pi is disabled by global policy for app; enabled harnesses: claude",
    );
    expect(child.calls.filter(({ argv }) => argv[1] === "run")).toEqual([]);
  });

  it("queues a full-pool launch with only item, machine and order metadata", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const fake = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "t3", domain: "infra" },
    ]);
    const sensitive = "inline launch context: never persist this";
    const lines = await runWith(
      delegate(
        cfg,
        options({
          cwd: state,
          item: "i1",
          queueIfFull: true,
          message: { kind: "skill", skill: "implement", args: sensitive },
        }),
        () => 3,
      ),
      fake.layer,
    );
    expect(lines).toEqual([
      `queued delegate for item i1 on machine ${FAKE_CORE} (order 1); no launch was started; the domain watcher will wake this coordinator when capacity is available`,
    ]);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
    const path = capacityQueuePath(state, "app");
    const stored = readFileSync(path, "utf8");
    expect(stored.includes(sensitive)).toBe(false);
    expect(JSON.parse(stored)).toEqual({
      version: 1,
      nextOrder: 2,
      entries: [{ item: "i1", machine: FAKE_CORE, order: 1 }],
    });
    expect(await runWith(readCapacityQueue(cfg, "app"))).toEqual({
      version: 1,
      nextOrder: 2,
      entries: [{ item: "i1", machine: FAKE_CORE, order: 1 }],
    });
    const retry = await runWith(
      delegate(
        cfg,
        options({
          cwd: state,
          item: "i1",
          retryQueued: true,
          message: { kind: "skill", skill: "implement", args: sensitive },
        }),
        () => 3,
      ),
      fake.layer,
    );
    expect(retry).toEqual(lines);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([
      { item: "i1", machine: FAKE_CORE, order: 1 },
    ]);
  });

  it("refuses to retry past the oldest eligible item, reading hostname-keyed entries as this core", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    await runWith(itemAdd(cfg, "app", { title: "Second queued task", json: false, now: NOW }));
    await runWith(enqueueCapacityWait(cfg, "app", { item: "i1", machine: hostname() }));
    await runWith(enqueueCapacityWait(cfg, "app", { item: "i2", machine: hostname() }));
    const fake = fleet(COORDINATOR, []);
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i2", retryQueued: true }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      `item i2 is queued but is not the oldest eligible launch for machine ${FAKE_CORE}; retry i1 first`,
    );
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([
      { item: "i1", machine: hostname(), order: 1 },
      { item: "i2", machine: hostname(), order: 2 },
    ]);
  });

  it("launches a queued retry only after the regular budget gate passes", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const full = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "t3", domain: "infra" },
    ]);
    await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", queueIfFull: true }), () => 3),
      full.layer,
    );
    const available = fleet(COORDINATOR, []);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", retryQueued: true }), () => 3),
      available.layer,
    );
    expect(lines).toEqual([
      "started new-delegate (t-new)",
      "filed new-delegate under i1 [delegated]",
    ]);
    const run = available.calls.find(({ argv }) => argv[1] === "run");
    expect(run?.argv).toContain("fleet.queue=app:i1:1");
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([]);
  });

  it("requires the original harness explicitly on retry and preserves the queue entry", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const full = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "t3", domain: "infra" },
    ]);
    await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", queueIfFull: true }), () => 3),
      full.layer,
    );
    const retry = fleet(COORDINATOR, []);
    const error = await failureOf(
      delegate(
        cfg,
        options({ cwd: state, item: "i1", retryQueued: true, harness: undefined }),
        () => 3,
      ),
      retry.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "--retry-queued requires the original authorized harness explicitly: pass --harness pi|claude when retrying app's queued item",
    );
    expect(retry.calls.filter(({ argv }) => argv[1] === "run")).toEqual([]);
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([
      { item: "i1", machine: FAKE_CORE, order: 1 },
    ]);
  });

  it("rechecks current policy on a queued retry without dropping a blocked entry", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const full = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "t3", domain: "infra" },
    ]);
    await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", queueIfFull: true }), () => 3),
      full.layer,
    );
    await Effect.runPromise(
      setHarnessPolicy(cfg, {
        scope: "global",
        domain: undefined,
        selection: { enabled: ["claude"], default: "claude" },
        expectedRevision: 0,
        json: true,
      }),
    );
    const retry = fleet(COORDINATOR, []);
    const error = await failureOf(
      delegate(cfg, options({ cwd: state, item: "i1", retryQueued: true, harness: "pi" }), () => 3),
      retry.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "harness pi is disabled by global policy for app; enabled harnesses: claude",
    );
    expect(retry.calls.filter(({ argv }) => argv[1] === "run")).toEqual([]);
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([
      { item: "i1", machine: FAKE_CORE, order: 1 },
    ]);
  });

  it("does not relaunch a queued delegate whose terminal ended before acknowledgement", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    await runWith(enqueueCapacityWait(cfg, "app", { item: "i1", machine: hostname() }));
    const terminal = {
      ...terminalDoc("t2", {
        "fleet.domain": "app",
        "fleet.queue": "app:i1:1",
      }),
      state: "ended",
    };
    let listedAll = false;
    const fake = fakeProc((argv) => {
      if (argv[1] === "ls") {
        listedAll = argv.includes("--all");
        return ok(
          JSON.stringify({
            terminals: [
              { address: "t1", name: "caller", state: "live" },
              { address: "t2", name: "t2", state: "ended" },
            ],
          }),
        );
      }
      if (argv[1] === "get")
        return argv[2] === "t2"
          ? ok(JSON.stringify(terminal))
          : ok(JSON.stringify(terminalDoc("t1", COORDINATOR)));
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", retryQueued: true }), () => 3),
      fake.layer,
    );
    expect(listedAll).toBe(true);
    expect(lines).toEqual([
      "already started queued delegate t2 (t2) for i1 order 1; no duplicate launch; verify it is filed under the item",
    ]);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
    expect((await runWith(readCapacityQueue(cfg, "app"))).entries).toEqual([]);
  });

  it("counts live settled delegates across domains on the same machine", async () => {
    const terminals: ListedTerminal[] = ["t2", "t3", "elsewhere/t4"].map((address) => ({
      address,
      agent: "pi",
      cwd: "/tmp",
      live: true,
      status: "idle",
      turn: 1,
      name: address,
      parent: undefined,
      where: "",
    }));
    const fake = fakeProc((argv) => {
      if (argv[1] === "get")
        return ok(
          JSON.stringify({
            address: argv[2],
            state: "live",
            status: { state: "idle" },
            labels: { "fleet.domain": argv[2] === "t2" ? "infra" : "app" },
          }),
        );
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });
    expect(await runWith(liveDelegateCount(FAKE_CORE, terminals, FAKE_CORE), fake.layer)).toBe(2);
    expect(fake.calls.filter(({ argv }) => argv[1] === "get").map(({ argv }) => argv[2])).toEqual([
      "t2",
      "t3",
    ]);
  });

  it("starts at budget with --over-budget", async () => {
    const state = dir();
    const { cfg } = await withItem(state);
    const fake = fleet(COORDINATOR, [
      { address: "t2", domain: "app" },
      { address: "t3", domain: "infra" },
    ]);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1", overBudget: true }), () => 3),
      fake.layer,
    );
    expect(lines).toEqual([
      "started new-delegate (t-new)",
      "filed new-delegate under i1 [delegated]",
    ]);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(1);
  });

  it("warns when the injected one-minute load average exceeds the injected core count", async () => {
    const state = dir();
    const { cfg } = await withItem(state, 2, 8);
    const fake = fleet(COORDINATOR, []);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, item: "i1" }), () => 9),
      fake.layer,
    );
    expect(lines[0]).toBe(
      "warning: 1-minute load average 9 exceeds 8 cores; native gates may be slow",
    );
    expect(lines[1]).toBe("started new-delegate (t-new)");
  });

  it("counts delegates across domains but does not refuse a child review", async () => {
    const state = dir();
    const cfg = await config(state);
    const fake = fleet(DELEGATE, [
      { address: "t2", domain: "infra" },
      { address: "t3", domain: "app" },
    ]);
    const lines = await runWith(
      delegate(cfg, options({ cwd: state, domain: "app" }), () => 3),
      fake.layer,
    );
    expect(lines[0]).toBe("started new-delegate (t-new)");
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatch(/^session [0-9a-f-]{36}$/);
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(1);
  });
});
