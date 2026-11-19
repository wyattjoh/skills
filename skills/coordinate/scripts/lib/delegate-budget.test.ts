import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { itemAdd } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { failureOf, g, initRepo, runWith, tempDir } from "./fixture.ts";
import { delegate, start, type DelegateOptions } from "./lifecycle.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";

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
const config = (state: string, budget = 2, cores = 8) =>
  Effect.runPromise(
    resolveConfig(
      {
        backlog_dir: join(state, "backlogs"),
        state_dir: state,
        max_fleet_delegates: budget,
      },
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
  ...fields,
});

const withItem = async (state: string, budget = 2, cores = 8) => {
  const cfg = await config(state, budget, cores);
  const setup = fleet(COORDINATOR, []);
  await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t1" }), setup.layer);
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
) => {
  const terminals = new Map<string, ReturnType<typeof terminalDoc>>([
    ["t1", terminalDoc("t1", callerLabels)],
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
    const fake = fleet(COORDINATOR, [{ address: "t2", domain: "app" }]);
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
    ]);
    const error = await failureOf(
      delegate(cfg, options({ repo, item: "i1" }), () => 3),
      fake.layer,
    );
    expect(error instanceof Error ? error.message : String(error)).toBe(
      "fleet has 2 live delegates (budget 2); refusing new-delegate for item i1; pass --over-budget to start anyway",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(repo, ".claude", "worktrees", "new-delegate"))).toBe(false);
    expect(g(repo, "branch", "--format=%(refname:short)")).toBe("main");
    expect(fake.calls.filter(({ argv }) => argv[1] === "run").length).toBe(0);
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
