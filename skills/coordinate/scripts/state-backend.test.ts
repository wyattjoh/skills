import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateBackend } from "./lib/config.ts";
import { cliEnv, FAKE_HOME, tempDir } from "./lib/fixture.ts";
import type { FakeDocCores } from "./lib/herdr-docs-fake.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const cli = join(import.meta.dir, "coordinate.ts");
const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };

type Result = { args: string[]; exit: number; stdout: string; stderr: string };

/**
 * A sandboxed CLI on one backend: the state dir, a runner, and (herdr-doc) the fake cores file.
 */
const sandbox = (backend: StateBackend, prefix: string) => {
  const state = tempDir(prefix);
  made.push(state);
  const env = cliEnv(state, COORDINATOR, undefined, {}, {}, backend);
  const outside = { ...env };
  delete outside.HC_TERMINAL_ID;
  const run = (args: string[], commandEnv = env): Result => {
    const done = Bun.spawnSync(["bun", cli, ...args], {
      env: commandEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    return {
      args,
      exit: done.exitCode ?? 1,
      stdout: done.stdout.toString(),
      stderr: done.stderr.toString(),
    };
  };
  const coresFile = join(state, "herdr-docs.json");
  const cores = (): FakeDocCores => JSON.parse(readFileSync(coresFile, "utf8")) as FakeDocCores;
  const setCores = (change: (cores: FakeDocCores) => void) => {
    const next = cores();
    change(next);
    writeFileSync(coresFile, JSON.stringify(next));
  };
  return { state, run, outside, cores, setCores };
};

/**
 * One output with its state dir and per-run ids replaced, and herdr-doc addresses written as the
 * files they stand for, so both backends' outputs compare equal when they behave the same.
 */
const normalize = (text: string, state: string): string =>
  text
    .replaceAll(state, "<state>")
    .replaceAll(
      new RegExp(`herdr-doc://${FAKE_HOME}/cs\\.b\\.([a-z0-9._-]+)`, "g"),
      "<state>/backlogs/$1.json",
    )
    .replaceAll(
      new RegExp(`herdr-doc://${FAKE_HOME}/cs\\.q\\.([a-z0-9._-]+)`, "g"),
      "<state>/capacity/$1.json",
    )
    .replaceAll(`herdr-doc://${FAKE_HOME}/cs.policy`, "<state>/delegate-harness-policy.json")
    .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>");

const scenario = (backend: StateBackend) => {
  const { state, run, outside } = sandbox(backend, `coordinate-backend-${backend}-`);
  const results = [
    run(["start", "app"]),
    run(["item", "add", "fix parser", "--domain", "app"]),
    run([
      "item",
      "update",
      "i1",
      "--status",
      "waiting-user",
      "--ask",
      "Which store?",
      "--option",
      "a :: first",
      "--option",
      "b :: second",
      "--rec",
      "a",
      "--why",
      "simplest",
      "--domain",
      "app",
    ]),
    run(["item", "answer", "i1", "a", "--note", "go", "--domain", "app"]),
    run(["item", "add", "close me", "--domain", "app"]),
    run(["item", "close", "i2", "--outcome", "not needed", "--domain", "app"]),
    run(["item", "add", "", "--domain", "app"]),
    run([
      "finding",
      "add",
      "flaky",
      "--kind",
      "issue",
      "--detail",
      "seen twice",
      "--domain",
      "app",
    ]),
    run(["backlog", "boundary", "add", state, "--adjacent", "--domain", "app", "--json"]),
    run(["backlog", "focus", "parser", "--domain", "app"]),
    run(
      [
        "harness-policy",
        "global-set",
        "--enabled",
        "pi,claude",
        "--default",
        "pi",
        "--expected-revision",
        "0",
      ],
      outside,
    ),
    run(["harness-policy", "global-set", "--enabled", "pi", "--expected-revision", "0"], outside),
    run(["item", "update", "i1", "--status", "parked", "--domain", "app"]),
    run(["status", "--resume", "--done", "--domain", "app"]),
    run(["backlog", "show", "--done", "--domain", "app"]),
    run(["backlog", "show", "--json", "--domain", "app"]),
    run(["queue", "show", "--json", "--domain", "app"]),
    run(["start", "web"]),
  ];
  return { state, results };
};

describe("coordinate CLI on the herdr-doc backend", () => {
  it("behaves as the files backend does, command for command", () => {
    const files = scenario("files");
    const herdr = scenario("herdr-doc");
    const view = (run: ReturnType<typeof scenario>) =>
      run.results.map((result) => ({
        args: result.args.map((arg) => normalize(arg, run.state)),
        exit: result.exit,
        stdout: normalize(result.stdout, run.state),
        stderr: normalize(result.stderr, run.state),
      }));
    expect(files.results.map((result) => result.exit)).toEqual([
      0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    ]);
    expect(view(herdr)).toEqual(view(files));
  }, 120_000);

  it("keeps the shared documents on the home and lists the domains in an index", () => {
    const { run, cores } = sandbox("herdr-doc", "coordinate-backend-docs-");
    expect(run(["start", "app"]).exit).toBe(0);
    expect(run(["start", "web"]).exit).toBe(0);
    expect(run(["item", "add", "fix parser", "--domain", "app"]).exit).toBe(0);
    const docs = cores().docs[FAKE_HOME] ?? {};
    expect(Object.keys(docs).toSorted()).toEqual(["cs.b.app", "cs.b.web", "cs.domains"]);
    expect(docs["cs.domains"]?.value).toEqual({ domains: ["app", "web"] });
    expect(
      (docs["cs.b.app"] as { value: { items: Array<{ title: string }> } }).value.items.map(
        (item) => item.title,
      ),
    ).toEqual(["fix parser"]);
  }, 60_000);

  it("refuses with exit 1 after three lost write races", () => {
    const { run, cores, setCores } = sandbox("herdr-doc", "coordinate-backend-race-");
    expect(run(["start", "app"]).exit).toBe(0);
    const before = cores().docs[FAKE_HOME]?.["cs.b.app"]?.version ?? 0;
    setCores((current) => {
      current.contended = ["cs.b.app"];
    });
    const added = run(["item", "add", "fix parser", "--domain", "app"]);
    expect([added.exit, added.stdout, added.stderr]).toEqual([
      1,
      "",
      `refused: herdr-doc://${FAKE_HOME}/cs.b.app kept changing: 3 attempts lost a write race; run the command again\n`,
    ]);
    // Each attempt lost to the other writer once.
    expect(cores().docs[FAKE_HOME]?.["cs.b.app"]?.version).toBe(before + 3);
  }, 60_000);

  it("exits 2 naming the home when it is unreachable, for reads and writes", () => {
    const { run, setCores } = sandbox("herdr-doc", "coordinate-backend-offline-");
    expect(run(["start", "app"]).exit).toBe(0);
    setCores((current) => {
      current.machines[FAKE_HOME] = "down";
    });
    const refusal = `could not check: StoreOffline: the state home ${FAKE_HOME} is unreachable (${FAKE_HOME} is unreachable: cannot reach ${FAKE_HOME}); shared state was not read or written\n`;
    const results = [
      run(["backlog", "show", "--domain", "app"]),
      run(["item", "add", "fix parser", "--domain", "app"]),
      run(["status", "--domain", "app"]),
    ].map((result) => [result.exit, result.stdout, result.stderr]);
    expect(results).toEqual([
      [2, "", refusal],
      [2, "", refusal],
      [2, "", refusal],
    ]);
  }, 60_000);

  it("refuses a rename away from the home, whose archive file it would have to move", () => {
    const { run } = sandbox("herdr-doc", "coordinate-backend-rename-");
    expect(run(["start", "app"]).exit).toBe(0);
    const renamed = run(["backlog", "rename", "web", "--domain", "app"]);
    expect([renamed.exit, renamed.stderr]).toEqual([
      1,
      `refused: app's archive is a file on the state home that holds herdr-doc://${FAKE_HOME}/cs.b.app; run coordinate backlog rename on that machine\n`,
    ]);
  }, 60_000);

  it("refuses a domain whose document name would pass Herdr's 32-character limit", () => {
    const { run } = sandbox("herdr-doc", "coordinate-backend-long-");
    const domain = "a-domain-name-that-is-too-long";
    const started = run(["start", domain]);
    expect([started.exit, started.stderr]).toEqual([
      1,
      `refused: domain ${domain} cannot be stored in the herdr-doc backend: cs.b.${domain} is 35 characters, over Herdr's 32-character document name limit\n`,
    ]);
  }, 60_000);
});
