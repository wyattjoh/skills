import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { cliEnv, tempDir } from "./lib/fixture.ts";
import type { FakeDocCores } from "./lib/herdr-docs-fake.ts";
import { FAKE_CORE } from "./lib/proc.ts";
import { WATCHER_DOMAIN_LABEL } from "./lib/watch-terminal.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) {
    // The backup files are read-only; their folders are not, so removal needs no chmod.
    rmSync(path, { recursive: true, force: true });
  }
});

const cli = join(import.meta.dir, "coordinate.ts");
const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };

type Result = { exit: number; stdout: string; stderr: string };

/**
 * A sandboxed CLI whose config names the home (this fake core, so the archives are here) and
 * starts on the files backend. `backend` rewrites the config's state_backend, as the user would.
 */
const sandbox = (
  terminals: Record<string, unknown> = {},
  lists: Record<string, unknown[]> = {},
  home: string = FAKE_CORE,
) => {
  const state = tempDir("coordinate-migrate-");
  made.push(state);
  // Built on herdr-doc once, so the fixture writes the fake cores file the home store answers from.
  const env = cliEnv(state, COORDINATOR, undefined, terminals, lists, "herdr-doc");
  const configFile = join(state, "config.json");
  const base = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  const backend = (name: "files" | "herdr-doc") =>
    writeFileSync(configFile, JSON.stringify({ ...base, state_backend: name, state_home: home }));
  backend("files");
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
      exit: done.exitCode ?? 1,
      stdout: done.stdout.toString(),
      stderr: done.stderr.toString(),
    };
  };
  const cores = (): FakeDocCores =>
    JSON.parse(readFileSync(join(state, "herdr-docs.json"), "utf8")) as FakeDocCores;
  return { state, run, outside, backend, cores, configFile };
};

const ENDED = {
  name: "d-s-1",
  domain: "app",
  session: "s-1",
  cwd: "/nowhere",
  ended_at: "2026-11-18T10:00:00.000Z",
  upstream_only: "kept",
};
const QUEUE = { version: 1, nextOrder: 2, entries: [{ item: "i1", machine: "strix", order: 1 }] };

/**
 * A files state with two domains, a closed item, a finding, the harness policy, a capacity queue
 * and an ended record.
 */
const populate = (box: ReturnType<typeof sandbox>) => {
  const { state, run, outside } = box;
  const steps = [
    run(["start", "app"]),
    run(["item", "add", "fix parser", "--domain", "app"]),
    run(["item", "add", "close me", "--domain", "app"]),
    run(["item", "close", "i2", "--outcome", "not needed", "--domain", "app"]),
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
    run(["start", "web"]),
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
  ];
  expect(steps.map((step) => step.exit)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  mkdirSync(join(state, "capacity"), { recursive: true });
  writeFileSync(join(state, "capacity", "app.json"), `${JSON.stringify(QUEUE, null, 2)}\n`);
  mkdirSync(join(state, "ended"), { recursive: true });
  writeFileSync(join(state, "ended", "s-1.json"), `${JSON.stringify(ENDED, null, 1)}\n`);
};

/**
 * What a reader sees of the shared state: both backlogs, the queue, the policy and ended records.
 */
const views = (box: ReturnType<typeof sandbox>) =>
  [
    ["backlog", "show", "--done", "--domain", "app"],
    ["backlog", "show", "--json", "--domain", "app"],
    ["backlog", "show", "--json", "--domain", "web"],
    ["queue", "show", "--json", "--domain", "app"],
    ["harness-policy", "show", "--json"],
    ["status", "--json", "--domain", "app"],
  ].map((args) => {
    const result = box.run(args, box.outside);
    // The policy view names where the policy lives, the one line that differs by backend.
    const stdout = result.stdout.replaceAll(
      `herdr-doc://${FAKE_CORE}/cs.policy`,
      join(box.state, "delegate-harness-policy.json"),
    );
    return { args, exit: result.exit, stdout };
  });

const stamp = (text: string) =>
  text.replaceAll(/files-backup-\d{8}T\d{6}Z(-\d+)?/g, "files-backup-<stamp>");

describe("coordinate state migrate", () => {
  it("moves the shared state to the home and back, and every reader sees the same documents", () => {
    const box = sandbox();
    const { state, run, backend, cores, configFile } = box;
    populate(box);
    const before = views(box);
    expect(before.map((view) => view.exit)).toEqual([0, 0, 0, 0, 0, 0]);
    // The status view carries the ended record, so the comparisons below cover it too.
    expect(before[5]?.stdout).toContain('"name": "d-s-1"');

    const there = run(["state", "migrate", "--to", "herdr-doc"]);
    const home = `herdr-doc://${FAKE_CORE}`;
    expect({ ...there, stdout: stamp(there.stdout) }).toEqual({
      exit: 0,
      stderr: "",
      stdout: [
        `migrated shared state from files to herdr-doc on ${FAKE_CORE}:`,
        `  backlog app: ${state}/backlogs/app.json -> ${home}/cs.b.app`,
        `  backlog web: ${state}/backlogs/web.json -> ${home}/cs.b.web`,
        `  queue app: ${state}/capacity/app.json -> ${home}/cs.q.app`,
        `  policy: ${state}/delegate-harness-policy.json -> ${home}/cs.policy`,
        `  ended s-1: ${state}/ended/s-1.json -> ${home}/cs.ended.2#s-1`,
        "copied 5 documents; no queued launch claim is held, and claims are never copied",
        `backup: the source files moved to ${state}/files-backup-<stamp>, read-only`,
        `archives, session state, the wiki lint clock and watcher files stay files in ${state}`,
        `next: set "state_backend": "herdr-doc" in ${configFile} (migrate does not edit the config)`,
        "",
      ].join("\n"),
    });
    const [backup] = readdirSync(state).filter((name) => name.startsWith("files-backup-"));
    const backupDir = join(state, backup ?? "");
    expect(readdirSync(join(backupDir, "backlogs")).toSorted()).toEqual(["app.json", "web.json"]);
    expect(statSync(join(backupDir, "backlogs", "app.json")).mode & 0o777).toBe(0o444);
    expect(readdirSync(join(state, "backlogs")).filter((name) => name.endsWith(".json"))).toEqual(
      [],
    );
    expect(Object.keys(cores().docs[FAKE_CORE] ?? {}).toSorted()).toEqual([
      "cs.b.app",
      "cs.b.web",
      "cs.domains",
      "cs.ended.2",
      "cs.policy",
      "cs.q.app",
    ]);

    backend("herdr-doc");
    expect(views(box)).toEqual(before);

    const back = run(["state", "migrate", "--to", "files"]);
    expect(back).toEqual({
      exit: 0,
      stderr: "",
      stdout: [
        `migrated shared state from herdr-doc on ${FAKE_CORE} to files:`,
        `  backlog app: ${home}/cs.b.app -> ${state}/backlogs/app.json`,
        `  backlog web: ${home}/cs.b.web -> ${state}/backlogs/web.json`,
        `  queue app: ${home}/cs.q.app -> ${state}/capacity/app.json`,
        `  policy: ${home}/cs.policy -> ${state}/delegate-harness-policy.json`,
        `  ended s-1: ${home}/cs.ended.2#s-1 -> ${state}/ended/s-1.json`,
        "copied 5 documents; no queued launch claim is held, and claims are never copied",
        `cleared: the documents on ${FAKE_CORE} now hold null (Herdr keeps each name as a tombstone)`,
        `archives, session state, the wiki lint clock and watcher files stay files in ${state}`,
        `next: set "state_backend": "files" in ${configFile} (migrate does not edit the config)`,
        "",
      ].join("\n"),
    });
    backend("files");
    expect(views(box)).toEqual(before);

    // And there again: the cleared documents and the first backup do not stand in the way.
    expect(run(["state", "migrate", "--to", "herdr-doc"]).exit).toBe(0);
    backend("herdr-doc");
    expect(views(box)).toEqual(before);
  }, 180_000);

  it("refuses with exit 1 while a watcher, a delegate or a queued retry is live, moving nothing", () => {
    const watching = sandbox(
      {},
      { [`${WATCHER_DOMAIN_LABEL}=app`]: [{ address: "t9", state: "live" }] },
    );
    const delegating = sandbox(
      { t2: { address: "t2", name: "fix-a", state: "live", labels: { "fleet.domain": "app" } } },
      { "fleet.domain=app": [{ address: "t2", state: "live" }] },
    );
    const retrying = sandbox();
    for (const box of [watching, delegating, retrying])
      expect(box.run(["start", "app"]).exit).toBe(0);
    const claim = join(retrying.state, "capacity", "claims", "app-i1.lock");
    mkdirSync(claim, { recursive: true });
    writeFileSync(
      join(claim, "owner.json"),
      JSON.stringify({ pid: process.pid, hostname: hostname(), token: "t" }),
    );
    const refused = [watching, delegating, retrying].map((box) => {
      const result = box.run(["state", "migrate", "--to", "herdr-doc"]);
      return [result.exit, result.stdout, result.stderr, readdirSync(join(box.state, "backlogs"))];
    });
    expect(refused).toEqual([
      [
        1,
        "",
        "refused: app has a live watcher (t9); stop every watcher and delegate before migrating\n",
        ["app.json"],
      ],
      [
        1,
        "",
        "refused: app has live delegates: fix-a (t2); stop every watcher and delegate before migrating\n",
        ["app.json"],
      ],
      [
        1,
        "",
        `refused: queued launch claims are held: ${claim}; let those retries finish before migrating\n`,
        ["app.json"],
      ],
    ]);
    expect(watching.cores().docs[FAKE_CORE]).toBeUndefined();
  }, 120_000);

  it("refuses away from the home, whose archive files it cannot move", () => {
    const box = sandbox({}, {}, "homebase");
    expect(box.run(["start", "app"]).exit).toBe(0);
    const result = box.run(["state", "migrate", "--to", "herdr-doc"]);
    expect([result.exit, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "refused: archives stay files on the state home homebase; run coordinate state migrate on that machine\n",
    ]);
  }, 60_000);

  it("refuses to overwrite a different document already on the target", () => {
    const box = sandbox();
    expect(box.run(["start", "app"]).exit).toBe(0);
    expect(box.run(["state", "migrate", "--to", "herdr-doc"]).exit).toBe(0);
    expect(box.run(["start", "app"]).exit).toBe(0);
    expect(box.run(["item", "add", "made after the move", "--domain", "app"]).exit).toBe(0);
    const result = box.run(["state", "migrate", "--to", "herdr-doc"]);
    expect([result.exit, result.stdout, result.stderr]).toEqual([
      1,
      "",
      `refused: herdr-doc://${FAKE_CORE}/cs.b.app already holds a different document; nothing was moved, so compare it with backlog app and remove the stale one\n`,
    ]);
    expect(readdirSync(join(box.state, "backlogs"))).toEqual(["app.json"]);
  }, 60_000);

  it("writes nothing to the home when a later document is refused", () => {
    const box = sandbox();
    const long = "zz-a-domain-name-that-is-long";
    for (const domain of ["app", long]) expect(box.run(["start", domain]).exit).toBe(0);
    const result = box.run(["state", "migrate", "--to", "herdr-doc"]);
    expect([result.exit, result.stdout, result.stderr]).toEqual([
      1,
      "",
      `refused: domain ${long} cannot be stored in the herdr-doc backend: cs.b.${long} is 34 characters, over Herdr's 32-character document name limit\n`,
    ]);
    expect({
      documents: Object.keys(box.cores().docs[FAKE_CORE] ?? {}),
      files: readdirSync(join(box.state, "backlogs")).toSorted(),
    }).toEqual({ documents: [], files: ["app.json", `${long}.json`] });
  }, 60_000);

  it("skips a document the target already holds, as after an interrupted run", () => {
    const box = sandbox();
    const { state, run, configFile } = box;
    expect(run(["start", "app"]).exit).toBe(0);
    expect(run(["state", "migrate", "--to", "herdr-doc"]).exit).toBe(0);
    const [backup] = readdirSync(state).filter((name) => name.startsWith("files-backup-"));
    writeFileSync(
      join(state, "backlogs", "app.json"),
      readFileSync(join(state, backup ?? "", "backlogs", "app.json")),
    );
    const again = run(["state", "migrate", "--to", "herdr-doc"]);
    expect({ ...again, stdout: stamp(again.stdout) }).toEqual({
      exit: 0,
      stderr: "",
      stdout: [
        `migrated shared state from files to herdr-doc on ${FAKE_CORE}:`,
        `  backlog app: ${state}/backlogs/app.json -> herdr-doc://${FAKE_CORE}/cs.b.app (already there)`,
        "copied 1 document; no queued launch claim is held, and claims are never copied",
        `backup: the source files moved to ${state}/files-backup-<stamp>, read-only`,
        `archives, session state, the wiki lint clock and watcher files stay files in ${state}`,
        `next: set "state_backend": "herdr-doc" in ${configFile} (migrate does not edit the config)`,
        "",
      ].join("\n"),
    });
  }, 60_000);
});
