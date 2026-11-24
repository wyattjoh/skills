import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateBackend } from "./lib/config.ts";
import { asFileAddresses, cliEnv, FAKE_HOME, tempDir } from "./lib/fixture.ts";
import type { FakeDocCores } from "./lib/herdr-docs-fake.ts";
import { FAKE_CORE } from "./lib/proc.ts";

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
    const done = Bun.spawnSync([process.execPath, cli, ...args], {
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
  asFileAddresses(text, state)
    .replaceAll(state, "<state>")
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

  it("names every document under state_prefix, so a test namespace never touches cs. names", () => {
    const { state, run, cores } = sandbox("herdr-doc", "coordinate-backend-prefix-");
    const configFile = join(state, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    writeFileSync(configFile, JSON.stringify({ ...config, state_prefix: "ct9f8e7d." }));
    expect(run(["start", "app"]).exit).toBe(0);
    expect(run(["item", "add", "fix parser", "--domain", "app"]).exit).toBe(0);
    const listed = run(["backlog", "list", "--json"]);
    expect([
      listed.exit,
      (JSON.parse(listed.stdout) as { domains: { domain: string }[] }).domains.map(
        (entry) => entry.domain,
      ),
    ]).toEqual([0, ["app"]]);
    expect(Object.keys(cores().docs[FAKE_HOME] ?? {}).toSorted()).toEqual([
      "ct9f8e7d.b.app",
      "ct9f8e7d.domains",
    ]);
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

  it("renames a domain on the home itself, moving its documents and its index entry", () => {
    const { state, run, cores } = sandbox("herdr-doc", "coordinate-backend-home-");
    const configFile = join(state, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    writeFileSync(configFile, JSON.stringify({ ...config, state_home: FAKE_CORE }));
    expect(run(["start", "app"]).exit).toBe(0);
    const renamed = run(["backlog", "rename", "web", "--domain", "app"]);
    expect([renamed.exit, renamed.stderr]).toEqual([0, ""]);
    const docs = cores().docs[FAKE_CORE] ?? {};
    expect([docs["cs.b.app"]?.value, docs["cs.domains"]?.value]).toEqual([
      null,
      { domains: ["web"] },
    ]);
    expect((docs["cs.b.web"] as { value: { domain: string } }).value.domain).toBe("web");
  }, 60_000);

  it("retries a rename that loses a write race, and refuses with exit 1 after three", () => {
    const { state, run, cores, setCores } = sandbox("herdr-doc", "coordinate-backend-rename-race-");
    const configFile = join(state, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    writeFileSync(configFile, JSON.stringify({ ...config, state_home: FAKE_CORE }));
    expect(run(["start", "app"]).exit).toBe(0);
    expect(run(["item", "add", "fix parser", "--domain", "app"]).exit).toBe(0);
    setCores((current) => {
      // Not cs.b.app: the old backlog's delete is never retried (the next test).
      current.races = { "cs.b.web": 2, "cs.domains": 2 };
    });
    const renamed = run(["backlog", "rename", "web", "--domain", "app"]);
    expect([renamed.exit, renamed.stderr]).toEqual([0, ""]);
    const docs = cores().docs[FAKE_CORE] ?? {};
    expect([docs["cs.b.app"]?.value, docs["cs.domains"]?.value]).toEqual([
      null,
      { domains: ["web"] },
    ]);
    expect(
      (docs["cs.b.web"] as { value: { domain: string; items: Array<{ title: string }> } }).value,
    ).toMatchObject({ domain: "web", items: [{ title: "fix parser" }] });

    expect(run(["start", "ops"]).exit).toBe(0);
    setCores((current) => {
      current.contended = ["cs.b.api"];
    });
    const refused = run(["backlog", "rename", "api", "--domain", "ops"]);
    expect([refused.exit, refused.stdout, refused.stderr]).toEqual([
      1,
      "",
      `refused: herdr-doc://${FAKE_CORE}/cs.b.api kept changing: 3 attempts lost a write race; run the command again\n`,
    ]);
  }, 60_000);

  it("refuses a rename whose old backlog changed after the copy, keeping that edit", () => {
    const { state, run, cores, setCores } = sandbox("herdr-doc", "coordinate-backend-rename-edit-");
    const configFile = join(state, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    writeFileSync(configFile, JSON.stringify({ ...config, state_home: FAKE_CORE }));
    expect(run(["start", "app"]).exit).toBe(0);
    const stored = cores().docs[FAKE_CORE]?.["cs.b.app"];
    if (stored === undefined) throw new Error("app has no backlog on the home");
    const edited = { ...(stored.value as Record<string, unknown>), focus: "edited mid-rename" };
    setCores((current) => {
      current.interject = { "cs.b.app": edited };
    });
    const renamed = run(["backlog", "rename", "web", "--domain", "app"]);
    expect([renamed.exit, renamed.stdout, renamed.stderr]).toEqual([
      1,
      "",
      `refused: herdr-doc://${FAKE_CORE}/cs.b.app changed while the command ran; run the command again\n`,
    ]);
    const docs = cores().docs[FAKE_CORE] ?? {};
    expect([docs["cs.b.app"]?.value, docs["cs.b.app"]?.version]).toEqual([
      edited,
      stored.version + 1,
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

describe.each<StateBackend>(["files", "herdr-doc"])("coordinator leases on %s", (backend) => {
  /**
   * Write a lease into app's backlog behind the CLI's back, the way a coordinator on another
   * machine would have taken it.
   */
  const leased = (box: ReturnType<typeof sandbox>, lease: Record<string, string>) => {
    if (backend === "files") {
      const path = join(box.state, "backlogs", "app.json");
      const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...document, lease }));
      return;
    }
    box.setCores((current) => {
      const stored = current.docs[FAKE_HOME]?.["cs.b.app"];
      if (stored === undefined) throw new Error("app has no backlog on the home");
      stored.value = { ...(stored.value as Record<string, unknown>), lease };
      stored.version += 1;
    });
  };
  const leaseNow = (box: ReturnType<typeof sandbox>) =>
    (
      JSON.parse(box.run(["backlog", "show", "--json", "--domain", "app"]).stdout) as {
        lease: { machine: string; address: string; expiry: string };
      }
    ).lease;

  it("refuses a second start for a domain with a live lease, naming the holder", () => {
    const box = sandbox(backend, `coordinate-lease-live-${backend}-`);
    expect(box.run(["start", "app"]).exit).toBe(0);
    const second = box.run(["start", "app"], { ...box.outside, HC_TERMINAL_ID: "t2" });
    const held = leaseNow(box);
    expect([second.exit, second.stdout, second.stderr]).toEqual([
      1,
      "",
      `refused: app already has a coordinator: ${FAKE_CORE}/t1 holds its lease until ${held.expiry}; go to it, or wait for that lease to expire (3 minutes after its watcher last renewed it)\n`,
    ]);
    leased(box, { machine: "strix", address: "t1fn", expiry: "2099-01-01T00:00:00.000Z" });
    const elsewhere = box.run(["start", "app"]);
    expect([elsewhere.exit, elsewhere.stderr]).toEqual([
      1,
      "refused: app already has a coordinator: strix/t1fn holds its lease until 2099-01-01T00:00:00.000Z; go to it, or wait for that lease to expire (3 minutes after its watcher last renewed it)\n",
    ]);
    expect(leaseNow(box)).toEqual({
      machine: "strix",
      address: "t1fn",
      expiry: "2099-01-01T00:00:00.000Z",
    });
  }, 60_000);

  it("lets a new start take a lease its holder has not renewed for three minutes", () => {
    const box = sandbox(backend, `coordinate-lease-lapsed-${backend}-`);
    expect(box.run(["start", "app"]).exit).toBe(0);
    const lapsed = new Date(Date.now() - 1000).toISOString();
    leased(box, { machine: "strix", address: "t1fn", expiry: lapsed });
    const before = Date.now();
    const started = box.run(["start", "app"]);
    expect([started.exit, started.stderr]).toEqual([0, ""]);
    const { expiry, ...holder } = leaseNow(box);
    expect(holder).toEqual({ machine: FAKE_CORE, address: "t1" });
    // Three minutes from the start that took it.
    expect(
      Date.parse(expiry) - before >= 180_000 && Date.parse(expiry) - Date.now() <= 180_000,
    ).toBe(true);
  }, 60_000);
});

describe("coordinate start preflight on herdr-doc", () => {
  it("refuses on a machine missing bun, the coordinate skill and a route to the home, naming each and whose fix it is", () => {
    const box = sandbox("herdr-doc", "coordinate-preflight-");
    rmSync(join(box.state, "home", ".claude"), { recursive: true, force: true });
    box.setCores((current) => {
      delete current.machines[FAKE_HOME];
    });
    const started = box.run(["start", "app"], {
      ...box.outside,
      HC_TERMINAL_ID: "t1",
      PATH: `${join(box.state, "bin")}:/usr/bin:/bin`,
    });
    expect([started.exit, started.stdout, started.stderr]).toEqual([
      1,
      "",
      `refused: ${FAKE_CORE} lacks bun on its login PATH, the coordinate skill (no link at ${join(box.state, "home", ".claude/skills/coordinate")}, ${join(box.state, "home", ".pi/agent/skills/coordinate")} or ${join(box.state, "home", ".agents/skills/coordinate")}), and a Herdr route to the state home ${FAKE_HOME} (unknown machine "${FAKE_HOME}"); setting up ${FAKE_CORE} belongs to ${FAKE_CORE}'s own domain, so file it there\n`,
    ]);
    // Nothing was labelled or written.
    expect(
      readFileSync(join(box.state, "bin", "calls.log"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("label")),
    ).toEqual([]);
    expect(Object.keys(box.cores().docs[FAKE_HOME] ?? {})).toEqual([]);
  }, 60_000);

  it("refuses when only the home is unreachable, then starts once it is back", () => {
    const box = sandbox("herdr-doc", "coordinate-preflight-home-");
    box.setCores((current) => {
      current.machines[FAKE_HOME] = "down";
    });
    const refused = box.run(["start", "app"]);
    expect([refused.exit, refused.stderr]).toEqual([
      1,
      `refused: ${FAKE_CORE} lacks a Herdr route to the state home ${FAKE_HOME} (${FAKE_HOME} is unreachable: cannot reach ${FAKE_HOME}); setting up ${FAKE_CORE} belongs to ${FAKE_CORE}'s own domain, so file it there\n`,
    ]);
    box.setCores((current) => {
      current.machines[FAKE_HOME] = "up";
    });
    expect(box.run(["start", "app"]).exit).toBe(0);
  }, 60_000);
});

describe.each<StateBackend>(["files", "herdr-doc"])("backlog list on %s", (backend) => {
  it("lists every domain with its lease, composed for this machine, and changes nothing", () => {
    const box = sandbox(backend, `coordinate-list-${backend}-`);
    expect(box.run(["start", "app"]).exit).toBe(0);
    expect(box.run(["start", "web"], { ...box.outside, HC_TERMINAL_ID: "t1" }).exit).toBe(0);
    const before = backend === "herdr-doc" ? JSON.stringify(box.cores().docs) : "";
    const shown = box.run(["backlog", "list", "--json"], box.outside);
    const app = JSON.parse(box.run(["backlog", "show", "--json", "--domain", "app"]).stdout) as {
      lease: { expiry: string };
    };
    expect([shown.exit, shown.stderr]).toEqual([0, ""]);
    expect(JSON.parse(shown.stdout)).toEqual({
      machine: FAKE_CORE,
      domains: [
        {
          domain: "app",
          lease: {
            machine: FAKE_CORE,
            address: "t1",
            expiry: app.lease.expiry,
            live: true,
            terminal: "t1",
          },
        },
        {
          domain: "web",
          lease: {
            machine: FAKE_CORE,
            address: "t1",
            expiry: (
              JSON.parse(box.run(["backlog", "show", "--json", "--domain", "web"]).stdout) as {
                lease: { expiry: string };
              }
            ).lease.expiry,
            live: true,
            terminal: "t1",
          },
        },
      ],
    });
    const documents = box.run(
      ["backlog", "list", "--json", "--documents", "--domain", "app"],
      box.outside,
    );
    expect(documents.exit).toBe(0);
    expect(JSON.parse(documents.stdout)).toEqual({
      machine: FAKE_CORE,
      domains: [
        {
          domain: "app",
          lease: {
            machine: FAKE_CORE,
            address: "t1",
            expiry: app.lease.expiry,
            live: true,
            terminal: "t1",
          },
          document: app,
          unreadable: null,
          ended: {},
        },
      ],
    });
    if (backend === "herdr-doc") expect(JSON.stringify(box.cores().docs)).toBe(before);
  }, 60_000);
});

describe("backlog list off the home", () => {
  it("names another machine's lease holder by machine and address, and exits 2 when the home is down", () => {
    const box = sandbox("herdr-doc", "coordinate-list-remote-");
    expect(box.run(["start", "app"]).exit).toBe(0);
    box.setCores((current) => {
      const stored = current.docs[FAKE_HOME]?.["cs.b.app"];
      if (stored === undefined) throw new Error("app has no backlog on the home");
      stored.value = {
        ...(stored.value as Record<string, unknown>),
        lease: { machine: "strix", address: "t1fn", expiry: "2099-01-01T00:00:00.000Z" },
      };
      stored.version += 1;
    });
    const shown = box.run(["backlog", "list", "--json"], box.outside);
    expect(JSON.parse(shown.stdout)).toEqual({
      machine: FAKE_CORE,
      domains: [
        {
          domain: "app",
          lease: {
            machine: "strix",
            address: "t1fn",
            expiry: "2099-01-01T00:00:00.000Z",
            live: true,
            terminal: "strix/t1fn",
          },
        },
      ],
    });
    box.setCores((current) => {
      current.machines[FAKE_HOME] = "down";
    });
    const down = box.run(["backlog", "list", "--json"], box.outside);
    expect([down.exit, down.stdout]).toEqual([2, ""]);
    expect(down.stderr.includes(`the state home ${FAKE_HOME} is unreachable`)).toBe(true);
  }, 60_000);
});
