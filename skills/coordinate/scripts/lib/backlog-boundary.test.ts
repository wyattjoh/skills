import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  BacklogError,
  boundaryAdd,
  boundaryReplace,
  boundaryRm,
  checkoutAdd,
  checkoutRm,
  focusSet,
  showBacklog,
  policyAdd,
} from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import {
  cliEnv,
  cliState,
  commitFile,
  eachBackend,
  readState,
  failureOf,
  g,
  gitAndFake,
  initRepo,
  runWith,
  tempDir,
} from "./fixture.ts";
import { Refused, writeEnded } from "./fleet.ts";
import { start } from "./lifecycle.ts";
import { FAKE_CORE, fakeProc, ok, type RunOutput } from "./proc.ts";
import { domainRepos, domainStatus } from "./status.ts";
import { keys } from "./state-store.ts";
import { report } from "./sweep.ts";

const dirs: string[] = [];
const dir = (made: string = tempDir()) => {
  dirs.push(made);
  return made;
};
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});
const config = (state: string) =>
  Effect.runPromise(resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"));
const NOW = "2026-11-17T10:00:00.000Z";

const started = async (prepare: (state: string) => void = () => undefined) => {
  const state = dir();
  prepare(state);
  const cfg = await config(state);
  await runWith(
    start(cfg, "app", { HC_TERMINAL_ID: "t9" }),
    fakeProc((argv) => {
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "get")
        return ok(
          JSON.stringify({
            address: "t9",
            state: "live",
            labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
          }),
        );
      if (argv[1] === "run") return ok('{"address":"t-watch","state":"live"}');
      return ok("{}");
    }).layer,
  );
  return { state, cfg, path: join(state, "backlogs", "app.json") };
};
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const tagged = (error: unknown) =>
  error instanceof Refused || error instanceof BacklogError
    ? { tag: error.constructor.name, message: error.message }
    : { tag: "none", message: String(error) };
const add = (cfg: Awaited<ReturnType<typeof config>>, path: string, adjacent = false) =>
  runWith(boundaryAdd(cfg, "app", { path, adjacent, json: false, outsideTerminal: false }));

describe("backlog boundary", () => {
  it("adds owned and adjacent paths to separate lists, resolved and deduplicated", async () => {
    const { cfg, path, state } = await started();
    const owned = dir();
    const adjacent = dir();
    expect(await add(cfg, `${owned}/`)).toEqual([`owned: added ${owned}`]);
    expect(await add(cfg, owned)).toEqual([`owned: ${owned} is already listed`]);
    expect(await add(cfg, adjacent, true)).toEqual([`adjacent: added ${adjacent}`]);
    expect(
      JSON.parse(
        (
          await runWith(
            boundaryAdd(cfg, "app", {
              path: join(state, ".."),
              adjacent: true,
              json: true,
              outsideTerminal: false,
            }),
          )
        ).join("\n"),
      ),
    ).toEqual({ owned: [owned], adjacent: [adjacent, join(state, "..")] });
    expect(read(path).boundary).toEqual({
      owned: [owned],
      adjacent: [adjacent, join(state, "..")],
    });
  });

  it("expands ~ to the home directory", async () => {
    const { cfg, path } = await started();
    expect(await add(cfg, "~")).toEqual([`owned: added ${homedir()}`]);
    expect(read(path).boundary.owned).toEqual([homedir()]);
  });

  it.each([
    [
      "a missing path",
      (root: string) => join(root, "nope"),
      (root: string) => `${join(root, "nope")} does not exist`,
    ],
    ["an empty path", () => "", () => "path is empty"],
    ["a two-line path", (root: string) => `${root}\nx`, () => "path must be one line"],
  ])("refuses %s and leaves the file unchanged", async (_name, given, message) => {
    const { cfg, path } = await started();
    const root = dir();
    const before = readFileSync(path, "utf8");
    const error = await failureOf(
      boundaryAdd(cfg, "app", {
        path: given(root),
        adjacent: false,
        json: false,
        outsideTerminal: false,
      }),
    );
    expect(tagged(error)).toEqual({ tag: "Refused", message: message(root) });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a path already in the other list", async () => {
    const { cfg, path } = await started();
    const repo = dir();
    await add(cfg, repo, true);
    const error = await failureOf(
      boundaryAdd(cfg, "app", {
        path: repo,
        adjacent: false,
        json: false,
        outsideTerminal: false,
      }),
    );
    expect(tagged(error)).toEqual({
      tag: "Refused",
      message: `${repo} is already adjacent; remove it first: coordinate backlog boundary rm ${repo} --adjacent`,
    });
    expect(read(path).boundary).toEqual({ owned: [], adjacent: [repo] });
  });

  it("removes a path from its list, even when the folder no longer exists", async () => {
    const { cfg, path } = await started();
    const keep = dir();
    const gone = dir();
    await add(cfg, keep);
    await add(cfg, gone);
    rmSync(gone, { recursive: true });
    expect(
      await runWith(
        boundaryRm(cfg, "app", {
          path: `${gone}/`,
          adjacent: false,
          json: false,
          outsideTerminal: false,
        }),
      ),
    ).toEqual([`owned: removed ${gone}`]);
    expect(read(path).boundary).toEqual({ owned: [keep], adjacent: [] });
  });

  it("refuses to remove a path that is not in the named list", async () => {
    const { cfg } = await started();
    const repo = dir();
    await add(cfg, repo);
    const error = await failureOf(
      boundaryRm(cfg, "app", {
        path: repo,
        adjacent: true,
        json: false,
        outsideTerminal: false,
      }),
    );
    expect(tagged(error)).toEqual({
      tag: "Refused",
      message: `${repo} is not in the adjacent Boundary`,
    });
  });
});

describe("backlog policy add", () => {
  it("records the text verbatim with a stable id and date", async () => {
    const { cfg, path } = await started();
    expect(
      await runWith(
        policyAdd(cfg, "app", {
          text: "  merge doc PRs, no need to ask ",
          at: undefined,
          wiki: undefined,
          json: false,
          now: NOW,
        }),
      ),
    ).toEqual(["added policy p1:   merge doc PRs, no need to ask "]);
    const printed = await runWith(
      policyAdd(cfg, "app", {
        text: "rebase freely",
        at: "2026-10-01",
        wiki: undefined,
        json: true,
        now: NOW,
      }),
    );
    expect(JSON.parse(printed.join("\n"))).toEqual({
      id: "p2",
      text: "rebase freely",
      at: "2026-10-01",
    });
    expect(read(path).policies).toEqual([
      { id: "p1", text: "  merge doc PRs, no need to ask ", at: "2026-11-17" },
      { id: "p2", text: "rebase freely", at: "2026-10-01" },
    ]);
  });

  it.each([
    ["   ", undefined, "text is empty"],
    ["two\nlines", undefined, "text must be one line"],
    ["ok", "17 Nov", "--at must be YYYY-MM-DD"],
  ])("refuses %j (at %j)", async (text, at, message) => {
    const { cfg, path } = await started();
    const before = readFileSync(path, "utf8");
    const error = await failureOf(
      policyAdd(cfg, "app", { text, at, wiki: undefined, json: false, now: NOW }),
    );
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

// `hc machine ls --json` as this core sees it: strix connected, nigelsheldon offline.
const machines = () =>
  fakeProc((argv) =>
    argv[0] === "hc" && argv[1] === "machine" && argv[2] === "ls"
      ? ok(
          JSON.stringify({
            machines: [
              { name: "strix", state: "connected" },
              { name: "nigelsheldon", state: "disconnected" },
            ],
          }),
        )
      : ok("{}"),
  ).layer;
const addCheckout = (
  cfg: Awaited<ReturnType<typeof config>>,
  path: string,
  machine: string,
  checkout: string,
  options: { json: boolean; outsideTerminal: boolean } = { json: false, outsideTerminal: false },
) => runWith(checkoutAdd(cfg, "app", { path, machine, checkout, ...options }), machines());

describe("backlog boundary checkouts", () => {
  it("records, shows and removes a checkout per machine on an owned path", async () => {
    const { cfg, path } = await started();
    const owned = dir();
    await add(cfg, owned);
    expect(await addCheckout(cfg, owned, "strix", "/home/me/code/app/")).toEqual([
      `owned: added checkout of ${owned} on strix: /home/me/code/app`,
    ]);
    expect(
      JSON.parse(
        (
          await addCheckout(cfg, owned, "nigelsheldon", "/Users/me/app", {
            json: true,
            outsideTerminal: false,
          })
        ).join("\n"),
      ),
    ).toEqual({
      owned: [owned],
      adjacent: [],
      checkouts: { [owned]: { strix: "/home/me/code/app", nigelsheldon: "/Users/me/app" } },
    });
    expect(await addCheckout(cfg, owned, "strix", "/home/me/code/app")).toEqual([
      `owned: checkout of ${owned} on strix is already listed`,
    ]);
    expect(JSON.parse((await runWith(showBacklog(cfg, "app", true))).join("\n")).boundary).toEqual({
      owned: [owned],
      adjacent: [],
      checkouts: { [owned]: { strix: "/home/me/code/app", nigelsheldon: "/Users/me/app" } },
    });
    expect((await runWith(showBacklog(cfg, "app", false)))[0]?.split("\n").slice(2, 10)).toEqual([
      "## Boundary",
      "",
      `- Owned: ${owned}`,
      `  - ${owned} on nigelsheldon: /Users/me/app`,
      `  - ${owned} on strix: /home/me/code/app`,
      "- Adjacent: (none)",
      "",
      "## Policies",
    ]);
    expect(
      await runWith(checkoutRm(cfg, "app", { path: owned, machine: "strix", json: false })),
    ).toEqual([`owned: removed checkout of ${owned} on strix`]);
    expect(read(path).boundary).toEqual({
      owned: [owned],
      adjacent: [],
      checkouts: { [owned]: { nigelsheldon: "/Users/me/app" } },
    });
    expect(
      await runWith(checkoutRm(cfg, "app", { path: owned, machine: "nigelsheldon", json: false })),
    ).toEqual([`owned: removed checkout of ${owned} on nigelsheldon`]);
    expect(read(path).boundary).toEqual({ owned: [owned], adjacent: [] });
  });

  it("replaces a path in place with its checkouts, and records the panel's replace and remove", async () => {
    const { cfg, path } = await started();
    const [first, second, next] = [dir(), dir(), dir()];
    await add(cfg, first);
    await add(cfg, second);
    await addCheckout(cfg, first, "strix", "/srv/app");
    expect(
      await runWith(
        boundaryReplace(cfg, "app", {
          from: first,
          to: next,
          adjacent: false,
          json: false,
          editedAt: NOW,
        }),
      ),
    ).toEqual([`owned: replaced ${first} with ${next}`]);
    await runWith(
      boundaryRm(cfg, "app", {
        path: second,
        adjacent: false,
        json: false,
        outsideTerminal: true,
        editedAt: NOW,
      }),
    );
    const doc = read(path);
    expect([doc.boundary, doc.edits]).toEqual([
      { owned: [next], adjacent: [], checkouts: { [next]: { strix: "/srv/app" } } },
      [
        { id: "c1", record: "boundary", field: "owned", old: first, new: next, at: NOW },
        { id: "c2", record: "boundary", field: "owned", old: second, new: null, at: NOW },
      ],
    ]);
    expect(
      tagged(
        await failureOf(
          boundaryReplace(cfg, "app", {
            from: next,
            to: join(next, "missing"),
            adjacent: false,
            json: false,
            editedAt: NOW,
          }),
        ),
      ),
    ).toEqual({ tag: "Refused", message: `${join(next, "missing")} does not exist` });
  });

  it("drops a path's checkouts when the path leaves the owned Boundary", async () => {
    const { cfg, path } = await started();
    const owned = dir();
    await add(cfg, owned);
    await addCheckout(cfg, owned, "strix", "/srv/app");
    await runWith(
      boundaryRm(cfg, "app", { path: owned, adjacent: false, json: false, outsideTerminal: false }),
    );
    expect(read(path).boundary).toEqual({ owned: [], adjacent: [] });
  });

  it.each([
    [
      "an unknown machine",
      "mars",
      "/srv/app",
      "unknown Herdr machine mars; known machines: strix, nigelsheldon",
    ],
    [
      "the local key",
      "local",
      "/srv/app",
      `local is this machine (${FAKE_CORE}); its checkout is the owned path itself`,
    ],
    [
      "this core's name",
      FAKE_CORE,
      "/srv/app",
      `${FAKE_CORE} is this machine (${FAKE_CORE}); its checkout is the owned path itself`,
    ],
    [
      "a malformed machine name",
      "a b",
      "/srv/app",
      "machine name a b must be letters, digits, . _ or -",
    ],
    ["a relative checkout", "strix", "srv/app", "srv/app is not an absolute path"],
    ["a two-line checkout", "strix", "/srv\napp", "checkout path must be one line"],
  ])("refuses %s and leaves the file unchanged", async (_name, machine, checkout, message) => {
    const { cfg, path } = await started();
    const owned = dir();
    await add(cfg, owned);
    const before = readFileSync(path, "utf8");
    const error = await failureOf(
      checkoutAdd(cfg, "app", {
        path: owned,
        machine,
        checkout,
        json: false,
        outsideTerminal: false,
      }),
      machines(),
    );
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a path outside the owned list, a second checkout and a missing entry", async () => {
    const { cfg } = await started();
    const owned = dir();
    const adjacent = dir();
    await add(cfg, owned);
    await add(cfg, adjacent, true);
    const refusal = async (effect: Parameters<typeof failureOf>[0]) =>
      tagged(await failureOf(effect, machines()));
    expect(
      await refusal(
        checkoutAdd(cfg, "app", {
          path: adjacent,
          machine: "strix",
          checkout: "/srv/app",
          json: false,
          outsideTerminal: false,
        }),
      ),
    ).toEqual({
      tag: "Refused",
      message: `${adjacent} is not in the owned Boundary; checkouts are recorded only on owned paths`,
    });
    await addCheckout(cfg, owned, "strix", "/srv/app");
    expect(
      await refusal(
        checkoutAdd(cfg, "app", {
          path: owned,
          machine: "strix",
          checkout: "/srv/other",
          json: false,
          outsideTerminal: false,
        }),
      ),
    ).toEqual({
      tag: "Refused",
      message: `${owned} already has a checkout on strix at /srv/app; remove it first: coordinate backlog boundary rm ${owned} --machine strix`,
    });
    expect(
      await refusal(
        checkoutAdd(cfg, "app", {
          path: owned,
          machine: "strix",
          checkout: "/srv/app",
          json: false,
          outsideTerminal: true,
        }),
      ),
    ).toEqual({ tag: "Refused", message: `checkout of ${owned} on strix is already listed` });
    expect(
      await refusal(checkoutRm(cfg, "app", { path: owned, machine: "nigelsheldon", json: false })),
    ).toEqual({ tag: "Refused", message: `${owned} has no checkout on nigelsheldon` });
  });
});

describe("backlog focus", () => {
  it("sets, replaces and clears the focus line", async () => {
    const { cfg, path } = await started();
    expect(await runWith(focusSet(cfg, "app", { focus: " ship login v2 ", json: false }))).toEqual([
      "focus: ship login v2",
    ]);
    expect(
      JSON.parse(
        (await runWith(focusSet(cfg, "app", { focus: "docs week", json: true }))).join("\n"),
      ),
    ).toEqual({ focus: "docs week" });
    expect(read(path).focus).toBe("docs week");
    expect(await runWith(focusSet(cfg, "app", { focus: null, json: false }))).toEqual([
      "focus cleared",
    ]);
    expect(read(path).focus).toBe(null);
  });

  it.each([
    ["  ", "focus is empty; pass --clear to clear it"],
    ["a\nb", "focus must be one line"],
  ])("refuses %j", async (focus, message) => {
    const { cfg } = await started();
    expect(tagged(await failureOf(focusSet(cfg, "app", { focus, json: false })))).toEqual({
      tag: "Refused",
      message,
    });
  });
});

describe("backlog show", () => {
  it("renders focus, Boundary and Policies", async () => {
    const { cfg } = await started();
    const owned = dir();
    const adjacent = dir();
    await add(cfg, owned);
    await add(cfg, adjacent, true);
    await runWith(
      policyAdd(cfg, "app", {
        text: "merge doc PRs",
        at: undefined,
        wiki: undefined,
        json: false,
        now: NOW,
      }),
    );
    await runWith(focusSet(cfg, "app", { focus: "ship login v2", json: false }));
    expect(await runWith(showBacklog(cfg, "app", false))).toEqual([
      [
        "# app backlog",
        "",
        "Focus: ship login v2",
        "",
        "## Boundary",
        "",
        `- Owned: ${owned}`,
        `- Adjacent: ${adjacent}`,
        "",
        "## Policies",
        "",
        "- p1 2026-11-17: merge doc PRs",
        "",
        "## Open",
        "",
        "(none)",
        "",
        "## Findings",
        "",
        "(none)",
        "",
        "## Done",
      ].join("\n"),
    ]);
  });
});

/**
 * A repo whose worktree x is squash-merged into main, so sweep judges it SAFE.
 */
const landedRepo = (): { repo: string; wt: string } => {
  const repo = dir(initRepo());
  commitFile(repo, ".gitignore", ".devenv/\n.scratch/\n");
  const wt = join(repo, ".claude", "worktrees", "x");
  g(repo, "worktree", "add", "-q", wt, "-b", "x");
  commitFile(wt, "feature.txt", "feature\n");
  commitFile(repo, "other.txt", "o\n");
  g(repo, "merge", "-q", "--squash", "x");
  g(repo, "commit", "-q", "-m", "squash x");
  return { repo, wt };
};

const ownedSetup = async () => {
  const { cfg, state } = await started();
  const owned = landedRepo();
  const adjacent = landedRepo();
  await add(cfg, owned.repo);
  await add(cfg, adjacent.repo, true);
  // An owned folder inside an adjacent repo must not make that repo the domain's.
  mkdirSync(join(adjacent.repo, "docs"));
  await add(cfg, join(adjacent.repo, "docs"));
  const delegateCwd = join(adjacent.repo, ".claude", "worktrees", "live");
  g(adjacent.repo, "worktree", "add", "-q", delegateCwd, "-b", "live");
  await runWith(
    writeEnded(state, {
      name: "old",
      domain: "app",
      session: "0b9c2a51-0000-4000-8000-000000000001",
      cwd: adjacent.wt,
      repo: adjacent.repo,
      branch: "x",
      ended_at: NOW,
    }),
  );
  const answer = (argv: readonly string[]): RunOutput => {
    const terminal = {
      address: "t2",
      name: "fix-a",
      agent: "pi",
      status: "idle",
      state: "live",
      cwd: delegateCwd,
    };
    if (argv[0] === "hc" && argv[1] === "ls")
      return ok(
        JSON.stringify({ terminals: argv.includes("fleet.role=coordinator") ? [] : [terminal] }),
      );
    if (argv[0] === "hc" && argv[1] === "get")
      return ok(
        JSON.stringify({
          address: terminal.address,
          name: terminal.name,
          state: "live",
          labels: { "fleet.domain": "app" },
          cwd: delegateCwd,
        }),
      );
    if (argv[0] === "lsof") return ok("p1\ncbash\nn/\n");
    if (argv[0] === "herdr-app") return ok('{"spaces":[]}');
    return ok("");
  };
  return { cfg, owned, adjacent, delegateCwd, layer: () => gitAndFake(answer).layer };
};

describe("owned-only domain repos", () => {
  it("derives the domain's repos from boundary.owned alone", async () => {
    const { cfg, owned, layer } = await ownedSetup();
    expect(await runWith(domainRepos(cfg, "app"), layer())).toEqual([owned.repo]);
  });

  it("gives sweep SAFE rows in the owned repo and none in the adjacent one", async () => {
    const { cfg, owned, adjacent, layer } = await ownedSetup();
    const repos = await runWith(domainRepos(cfg, "app"), layer());
    const rows = await runWith(
      report(cfg, repos, { bases: [], keep: [], sizes: false, nowMs: Date.parse(NOW) }),
      layer(),
    );
    expect(
      rows.filter((row) => row.text.startsWith("worktree ")).map((row) => [row.verdict, row.path]),
    ).toEqual([["SAFE", owned.wt]]);
    expect(rows.filter((row) => (row.path ?? "").startsWith(adjacent.repo))).toEqual([]);
  });

  it("polls PRs only in owned repos and marks delegates elsewhere as outside Boundary", async () => {
    const { cfg, owned, adjacent, layer } = await ownedSetup();
    expect(await runWith(domainStatus(cfg, "app", false, Date.parse(NOW)), layer())).toEqual([
      "app: 1 live delegates, 1 ended",
      `  fix-a t2 no status ? · live · repo ${adjacent.repo} is outside the owned Boundary · next: ?`,
      `  old ended 2026-11-17 · x · repo ${adjacent.repo} is outside the owned Boundary · resume: coordinate resume old`,
      `repo ${owned.repo}: could not read PRs: no remote`,
    ]);
  });
});

eachBackend("coordinate CLI", () => {
  it("wires policy, Boundary and focus, refusing focus with neither text nor --clear", async () => {
    const { state } = await started((made) => cliState(made));
    const backlog = () => readState(state, keys.backlog("app"));
    const env = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": "app" });
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const run = (...args: string[]) => {
      const done = Bun.spawnSync(["bun", script, ...args, "--domain", "app"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return [done.exitCode, done.stdout.toString() + done.stderr.toString()];
    };
    expect(run("backlog", "boundary", "add", state, "--adjacent")).toEqual([
      0,
      `adjacent: added ${state}\n`,
    ]);
    expect(run("backlog", "policy", "add", "ship it", "--at", "2026-11-01")).toEqual([
      0,
      "added policy p1: ship it\n",
    ]);
    expect(run("backlog", "focus", "login v2")).toEqual([0, "focus: login v2\n"]);
    expect(run("backlog", "focus")).toEqual([
      1,
      "refused: pass exactly one of --md, <text> or --clear\n",
    ]);
    expect(run("backlog", "boundary", "rm", state)).toEqual([
      1,
      `refused: ${state} is not in the owned Boundary\n`,
    ]);
    expect(run("backlog", "boundary", "rm", state, "--adjacent")).toEqual([
      0,
      `adjacent: removed ${state}\n`,
    ]);
    expect(run("backlog", "boundary", "add", state)).toEqual([0, `owned: added ${state}\n`]);
    expect(run("backlog", "boundary", "add", state, "--machine", "strix")).toEqual([
      1,
      "refused: pass --machine and --checkout together\n",
    ]);
    expect(
      run(
        "backlog",
        "boundary",
        "add",
        state,
        "--machine",
        "strix",
        "--checkout",
        "/srv/app",
        "--adjacent",
      ),
    ).toEqual([1, "refused: checkouts are recorded only on owned paths; drop --adjacent\n"]);
    expect(
      run("backlog", "boundary", "add", state, "--machine", "mars", "--checkout", "/srv/app"),
    ).toEqual([1, "refused: unknown Herdr machine mars; known machines: strix\n"]);
    expect(
      run("backlog", "boundary", "add", state, "--machine", "strix", "--checkout", "/srv/app"),
    ).toEqual([0, `owned: added checkout of ${state} on strix: /srv/app\n`]);
    expect(backlog().boundary).toEqual({
      owned: [state],
      adjacent: [],
      checkouts: { [state]: { strix: "/srv/app" } },
    });
    expect(run("backlog", "boundary", "rm", state, "--machine", "strix")).toEqual([
      0,
      `owned: removed checkout of ${state} on strix\n`,
    ]);
    expect(run("backlog", "boundary", "rm", state)).toEqual([0, `owned: removed ${state}\n`]);
    expect(run("backlog", "boundary", "add", state, "--adjacent")).toEqual([
      0,
      `adjacent: added ${state}\n`,
    ]);
    expect(backlog()).toEqual({
      ...backlog(),
      focus: "login v2",
      boundary: { owned: [], adjacent: [state] },
      policies: [{ id: "p1", text: "ship it", at: "2026-11-01" }],
    });
  }, 30_000);
});

describe("status without a readable document", () => {
  it("still reports delegates and says why no repos were polled", async () => {
    const { cfg, path } = await started();
    writeFileSync(path, '{"schemaVersion":2}');
    const lines = await runWith(
      domainStatus(cfg, "app", false, Date.parse(NOW)),
      fakeProc((argv) => ok(argv[1] === "ls" ? '{"terminals":[]}' : "{}")).layer,
    );
    expect(lines).toEqual([
      "app: 0 live delegates, 0 ended",
      `no repos polled: could not read the backlog: ${path} is invalid: schemaVersion must be 1; domain must be a non-empty string; focus must be a string or null; legacy must be a string or null; boundary must be an object; policies must be a list; nextId must be a positive integer; nextPolicyId must be a positive integer; items must be a list; findings must be a list`,
    ]);
  });
});

describe("domain repos without a document", () => {
  it("refuses a domain that was never started", async () => {
    const state = dir();
    mkdirSync(join(state, "md"), { recursive: true });
    writeFileSync(join(state, "md", "app-backlog.md"), "## Boundary\n- Owns: /srv/app\n");
    const error = await failureOf(domainRepos(await config(state), "app"));
    expect(tagged(error)).toEqual({
      tag: "Refused",
      message: `no backlog for app at ${join(state, "backlogs", "app.json")}; run coordinate start app`,
    });
  });
});
