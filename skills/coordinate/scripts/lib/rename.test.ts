import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument, itemAdd, readDocument } from "./backlog-doc.ts";
import { configPath, resolveConfig } from "./config.ts";
import { cliEnv, eachBackend, failureOf, readState, runWith, tempDir } from "./fixture.ts";
import { Refused } from "./fleet.ts";
import { capacityQueuePath, enqueueCapacityWait, readCapacityQueue } from "./capacity-queue.ts";
import { FAKE_CORE, fakeProc, ok, type RunOutput } from "./proc.ts";
import { type RenameOptions, renameDomain } from "./rename.ts";
import { keys } from "./state-store.ts";

const dirs: string[] = [];
const dir = () => {
  const made = tempDir();
  dirs.push(made);
  return made;
};
const children: Bun.Subprocess[] = [];
afterAll(() => {
  for (const child of children) child.kill();
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});

const NOW = "2026-11-18T10:00:00.000Z";
const config = (state: string, keepRunning: string[] = []) =>
  Effect.runPromise(
    resolveConfig(
      { backlog_dir: join(state, "md"), state_dir: state, keep_running: keepRunning },
      "/c",
    ),
  );
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);
const listing = (path: string) => readdirSync(path).toSorted();

const COORDINATOR = {
  address: "t1",
  state: "live",
  labels: { "fleet.role": "coordinator", "fleet.domain": "tracked-prs" },
};
const DELEGATE = {
  address: "t2",
  name: "fix-a",
  state: "live",
  labels: { "fleet.domain": "tracked-prs" },
};

/**
 * Answers for hc: the domain's terminals (the coordinator t1, plus `others`), and `hc label`
 * succeeding unless `labelError` is given.
 */
const answers =
  (others: (typeof DELEGATE)[] = [], labelError: string | undefined = undefined) =>
  (argv: readonly string[]): RunOutput => {
    if (argv[0] !== "hc") throw new Error(`unexpected command: ${argv.join(" ")}`);
    const terminals = [COORDINATOR, ...others];
    if (argv[1] === "ls")
      return ok(
        JSON.stringify({
          terminals: terminals.map(({ address, state }) => ({ address, state })),
        }),
      );
    if (argv[1] === "get") {
      const found = terminals.find((terminal) => terminal.address === argv[2]);
      if (found) return ok(JSON.stringify(found));
      return { exitCode: 3, stdout: "", stderr: '{"error":{"kind":"not_found","message":"no"}}' };
    }
    if (argv[1] === "label")
      return labelError === undefined
        ? ok("{}")
        : {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({ error: { kind: "not_found", message: labelError } }),
          };
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

const options = (fields: Partial<RenameOptions> = {}): RenameOptions => ({
  to: "clerk",
  domain: "tracked-prs",
  json: false,
  ...fields,
});

const endedRecord = (session: string, domain: string) => ({
  name: `d-${session}`,
  domain,
  session,
  cwd: "/nowhere",
  ended_at: NOW,
  upstream_only: "kept",
});

/**
 * A state folder holding the tracked-prs domain with an item, an archive, a watcher snapshot, a
 * stale watcher pid, two ended records (one of another domain), and a second domain's backlog.
 */
const populated = async (keepRunning: string[] = []) => {
  const state = dir();
  const cfg = await config(state, keepRunning);
  await runWith(createDocument(cfg, "tracked-prs"));
  await runWith(itemAdd(cfg, "tracked-prs", { title: "watch PR 12", json: false, now: NOW }));
  await runWith(createDocument(cfg, "web"));
  await runWith(
    itemAdd(cfg, "web", { title: "fix login (from tracked-prs)", json: false, now: NOW }),
  );
  const backlogs = join(state, "backlogs");
  writeFileSync(join(backlogs, "tracked-prs.archive.jsonl"), '{"id":"i0"}\n');
  mkdirSync(join(state, "watch"), { recursive: true });
  writeFileSync(join(state, "watch", "tracked-prs.json"), '{"delegates":{}}\n');
  const dead = Bun.spawnSync(["true"], { env: process.env }).pid;
  writeFileSync(join(state, "watch", "tracked-prs.pid"), `${dead}\n`);
  mkdirSync(join(state, "ended"), { recursive: true });
  writeFileSync(
    join(state, "ended", "s-1.json"),
    JSON.stringify(endedRecord("s-1", "tracked-prs")),
  );
  writeFileSync(join(state, "ended", "s-2.json"), JSON.stringify(endedRecord("s-2", "web")));
  return { state, cfg, backlogs };
};

const refusal = async (
  fields: Partial<RenameOptions>,
  others: (typeof DELEGATE)[] = [],
  prepare: (state: string) => void = () => undefined,
) => {
  const { state, cfg, backlogs } = await populated();
  prepare(state);
  const files = { backlogs: listing(backlogs), watch: listing(join(state, "watch")) };
  const ended = readFileSync(join(state, "ended", "s-1.json"), "utf8");
  const error = await failureOf(
    renameDomain(cfg, options(fields)),
    fakeProc(answers(others)).layer,
  );
  expect({ backlogs: listing(backlogs), watch: listing(join(state, "watch")) }).toEqual(files);
  expect(readFileSync(join(state, "ended", "s-1.json"), "utf8")).toBe(ended);
  return { state, error: messageOf(error), refused: error instanceof Refused };
};

describe("backlog rename", () => {
  it("moves the backlog, archive, snapshot, ended records and labels to the new name", async () => {
    const { state, cfg, backlogs } = await populated();
    const before = (await runWith(readDocument(cfg, "tracked-prs"))).backlog;
    const web = readFileSync(join(backlogs, "web.json"), "utf8");
    const fake = fakeProc(answers());
    const lines = await runWith(renameDomain(cfg, options()), fake.layer);
    expect(lines).toEqual([
      `renamed tracked-prs to clerk: backlog ${join(backlogs, "clerk.json")}`,
      `  archive ${join(backlogs, "clerk.archive.jsonl")}`,
      `  watcher snapshot ${join(state, "watch", "clerk.json")}`,
      `  removed stale watcher pid file ${join(state, "watch", "tracked-prs.pid")}`,
      "  ended records now clerk: 1",
      "  relabelled t1: fleet.domain=clerk",
    ]);
    expect(listing(backlogs)).toEqual(["clerk.archive.jsonl", "clerk.json", "web.json"]);
    expect(listing(join(state, "watch"))).toEqual(["clerk.json"]);
    expect(read(join(backlogs, "clerk.json"))).toEqual({ ...before, domain: "clerk" });
    expect(readFileSync(join(backlogs, "clerk.archive.jsonl"), "utf8")).toBe('{"id":"i0"}\n');
    expect(readFileSync(join(state, "watch", "clerk.json"), "utf8")).toBe('{"delegates":{}}\n');
    expect(read(join(state, "ended", "s-1.json"))).toEqual(endedRecord("s-1", "clerk"));
    expect(read(join(state, "ended", "s-2.json"))).toEqual(endedRecord("s-2", "web"));
    expect(readFileSync(join(backlogs, "web.json"), "utf8")).toBe(web);
    expect(fake.calls.filter(({ argv }) => argv[1] === "label").map(({ argv }) => argv)).toEqual([
      ["hc", "label", "t1", "fleet.domain=clerk", "--json"],
    ]);
  });

  it("moves a durable capacity queue with the renamed domain", async () => {
    const { state, cfg } = await populated();
    await runWith(enqueueCapacityWait(cfg, "tracked-prs", { item: "i1", machine: "worker" }));
    const original = capacityQueuePath(state, "tracked-prs");
    const lines = await runWith(renameDomain(cfg, options()), fakeProc(answers()).layer);
    expect(lines).toContain(`  capacity queue ${capacityQueuePath(state, "clerk")}`);
    expect(existsSync(original)).toBe(false);
    expect(await runWith(readCapacityQueue(cfg, "clerk"))).toEqual({
      version: 1,
      nextOrder: 2,
      entries: [{ item: "i1", machine: "worker", order: 1 }],
    });
  });

  it("prints what moved as JSON and warns when keep_running names the old domain", async () => {
    const { state, cfg, backlogs } = await populated(["tracked-prs"]);
    const [text] = await runWith(
      renameDomain(cfg, options({ json: true })),
      fakeProc(answers()).layer,
    );
    expect(JSON.parse(text ?? "")).toEqual({
      from: "tracked-prs",
      to: "clerk",
      backlog: join(backlogs, "clerk.json"),
      archive: join(backlogs, "clerk.archive.jsonl"),
      snapshot: join(state, "watch", "clerk.json"),
      stalePid: join(state, "watch", "tracked-prs.pid"),
      ended: [join(state, "ended", "s-1.json")],
      endedSkipped: [],
      relabelled: ["t1"],
      unrelabelled: [],
      warnings: [`keep_running in ${configPath()} lists tracked-prs; change it to clerk`],
    });
  });

  it("reports a terminal it could not relabel and still completes the move", async () => {
    const { cfg, backlogs } = await populated();
    const lines = await runWith(
      renameDomain(cfg, options()),
      fakeProc(answers([], "terminal t1 is gone")).layer,
    );
    expect(lines.slice(-2)).toEqual([
      "  ended records now clerk: 1",
      "  could not relabel t1: terminal t1 is gone; run hc label t1 fleet.domain=clerk",
    ]);
    expect(listing(backlogs)).toEqual(["clerk.archive.jsonl", "clerk.json", "web.json"]);
  });

  describe("refuses, changing nothing", () => {
    it("a new name that is not a domain name", async () => {
      expect(await refusal({ to: "Clerk" }).then(({ error, refused }) => [refused, error])).toEqual(
        [true, "Clerk is not a domain name: lowercase letters, digits, . _ -"],
      );
    });

    it("a new name that already has a backlog", async () => {
      const { state, error } = await refusal({ to: "web" });
      expect(error).toBe(
        `a backlog for web already exists at ${join(state, "backlogs", "web.json")}`,
      );
    });

    it("an old domain with no backlog", async () => {
      const { state, error } = await refusal({ domain: "nope" });
      expect(error).toBe(`no backlog for nope at ${join(state, "backlogs", "nope.json")}`);
    });

    it("a source domain with a harness replacement", async () => {
      const { error, refused } = await refusal({}, [], (state) =>
        writeFileSync(
          join(state, "delegate-harness-policy.json"),
          JSON.stringify({
            schemaVersion: 1,
            revision: 1,
            domains: { "tracked-prs": { enabled: ["pi"], default: "pi" } },
          }),
        ),
      );
      expect(refused).toBe(true);
      expect(error).toBe(
        "cannot rename tracked-prs to clerk while tracked-prs has a harness policy replacement; inspect it with coordinate harness-policy show --domain tracked-prs, then reset it explicitly with coordinate harness-policy domain-reset tracked-prs --expected-revision 1",
      );
    });

    it("a target domain with an orphaned harness replacement", async () => {
      const { error, refused } = await refusal({}, [], (state) =>
        writeFileSync(
          join(state, "delegate-harness-policy.json"),
          JSON.stringify({
            schemaVersion: 1,
            revision: 1,
            domains: { clerk: { enabled: ["claude"], default: null } },
          }),
        ),
      );
      expect(refused).toBe(true);
      expect(error).toContain("while clerk has a harness policy replacement");
    });

    it("an old domain with a live delegate, naming it", async () => {
      const { error } = await refusal({}, [DELEGATE]);
      expect(error).toBe(
        "tracked-prs has live delegates: fix-a (t2); end them first (coordinate end <name>)",
      );
    });

    it("an old domain a live watcher holds, naming its pid", async () => {
      const watcher = Bun.spawn(
        ["bun", "-e", "setTimeout(() => {}, 60_000)", "coordinate", "watch"],
        {
          env: process.env,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      children.push(watcher);
      const { state, error } = await refusal({}, [], (path) =>
        writeFileSync(join(path, "watch", "tracked-prs.pid"), `${watcher.pid}\n`),
      );
      expect(error).toBe(
        `a watcher (pid ${watcher.pid}) holds tracked-prs's lock at ${join(state, "watch", "tracked-prs.pid")}; stop it first (kill ${watcher.pid})`,
      );
    });
  });
});

// On herdr-doc the home is this machine: rename refuses anywhere else (state-backend.test.ts).
eachBackend("coordinate backlog rename (CLI)", (backend) => {
  const cli = join(import.meta.dir, "..", "coordinate.ts");
  const spawn = (env: Record<string, string>, args: string[]) => {
    const done = Bun.spawnSync(["bun", cli, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return [done.exitCode, done.stdout.toString() + done.stderr.toString()];
  };

  it("renames this coordinator's domain by default and exits 0", async () => {
    const state = dir();
    const env = cliEnv(state, COORDINATOR.labels, undefined, {}, {}, backend, FAKE_CORE);
    await runWith(createDocument(await config(state), "tracked-prs"));
    expect(spawn(env, ["backlog", "rename", "clerk"])).toEqual([
      0,
      `renamed tracked-prs to clerk: backlog ${backend === "files" ? join(state, "backlogs", "clerk.json") : `herdr-doc://${FAKE_CORE}/cs.b.clerk`}\n`,
    ]);
    expect([
      readState(state, keys.backlog("tracked-prs")),
      readState(state, keys.backlog("clerk")).domain,
    ]).toEqual([null, "clerk"]);
    // Files only: no backlog file of the old name is left beside the new one.
    if (backend === "files") expect(listing(join(state, "backlogs"))).toEqual(["clerk.json"]);
  }, 30_000);

  it("exits 1 with the cause when refused", async () => {
    const state = dir();
    const env = cliEnv(state, COORDINATOR.labels, undefined, {}, {}, backend, FAKE_CORE);
    await runWith(createDocument(await config(state), "tracked-prs"));
    expect(spawn(env, ["backlog", "rename", "tracked-prs"])).toEqual([
      1,
      "refused: tracked-prs is already named tracked-prs\n",
    ]);
  }, 30_000);
});
