import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initRepo } from "./lib/fixture.ts";
import {
  onStrix,
  shellWord,
  STRIX,
  strixReadiness,
  strixRun,
  type StrixRun,
} from "./lib/strix-fixture.ts";

// The real-strix integration suite. It runs only with COORDINATE_STRIX=1 and a connected strix
// that has Claude Code and git; otherwise it prints one line saying why and skips.
const readiness = strixReadiness();
if (!readiness.ready) console.log(`strix suite skipped: ${readiness.reason}`);
const ready = readiness.ready;

describe.skipIf(!ready)("strix: Boundary checkout map", () => {
  let run: StrixRun | undefined;
  let local = "";
  beforeAll(() => {
    run = strixRun();
    local = initRepo();
  }, 60_000);
  afterAll(() => {
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 120_000);

  it("records a strix checkout, lists it in backlog show, and removes it", () => {
    if (!run) return;
    const remote = run.remoteRepo("app");
    expect(onStrix(`git -C ${shellWord(remote)} rev-parse --abbrev-ref HEAD`, 20)).toEqual({
      exitCode: 0,
      output: "main\n",
    });
    run.seed({ owned: [local], adjacent: [] });
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote]),
    ).toEqual({ exitCode: 0, output: `owned: added checkout of ${local} on strix: ${remote}\n` });
    const shown = run.cli(["backlog", "show", "--json"]);
    expect([shown.exitCode, JSON.parse(shown.output).boundary]).toEqual([
      0,
      { owned: [local], adjacent: [], checkouts: { [local]: { strix: remote } } },
    ]);
    const text = run.cli(["backlog", "show"]);
    expect([text.exitCode, text.output.split("\n").slice(2, 7)]).toEqual([
      0,
      [
        "## Boundary",
        "",
        `- Owned: ${local}`,
        `  - ${local} on strix: ${remote}`,
        "- Adjacent: (none)",
      ],
    ]);
    expect(run.cli(["backlog", "boundary", "rm", local, "--machine", STRIX])).toEqual({
      exitCode: 0,
      output: `owned: removed checkout of ${local} on strix\n`,
    });
    const after = run.cli(["backlog", "show", "--json"]);
    expect(JSON.parse(after.output).boundary).toEqual({ owned: [local], adjacent: [] });
  }, 120_000);

  it("refuses a machine Herdr does not know and this machine's own name", () => {
    if (!run) return;
    run.seed({ owned: [local], adjacent: [] });
    const listed = Bun.spawnSync(["hc", "machine", "ls", "--json"], {
      env: run.env,
      stdout: "pipe",
      timeout: 15_000,
    });
    const known = (
      JSON.parse(listed.stdout.toString()) as { machines: { name: string }[] }
    ).machines.map((machine) => machine.name);
    expect(
      run.cli([
        "backlog",
        "boundary",
        "add",
        local,
        "--machine",
        "coordinate-no-such-machine",
        "--checkout",
        "/tmp/x",
      ]),
    ).toEqual({
      exitCode: 1,
      output: `refused: unknown Herdr machine coordinate-no-such-machine; known machines: ${known.join(", ")}\n`,
    });
    const status = Bun.spawnSync(["hc", "server", "status", "--json"], {
      env: run.env,
      stdout: "pipe",
      timeout: 15_000,
    });
    const core = (JSON.parse(status.stdout.toString()) as { core: { name: string } }).core.name;
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", core, "--checkout", "/tmp/x"]),
    ).toEqual({
      exitCode: 1,
      output: `refused: ${core} is this machine (${core}); its checkout is the owned path itself\n`,
    });
  }, 60_000);
});

describe.skipIf(!ready)("strix: remote delegate launch", () => {
  let run: StrixRun | undefined;
  let local = "";
  let remote = "";
  let brief = "";
  let item = "";
  let queuedItem = "";
  beforeAll(() => {
    run = strixRun();
    local = initRepo();
    remote = run.remoteRepo("app");
    brief = join(run.stateDir, "brief.md");
    writeFileSync(brief, run.brief);
    run.seed({ owned: [local], adjacent: [] });
    run.becomeCoordinator();
    const added = run.cli(["item", "add", "strix launch"]);
    expect(added.exitCode).toBe(0);
    item = /\bi\d+\b/.exec(added.output)?.[0] ?? "";
    const second = run.cli(["item", "add", "strix budget"]);
    expect(second.exitCode).toBe(0);
    queuedItem = /\bi\d+\b/.exec(second.output)?.[0] ?? "";
  }, 90_000);
  afterAll(() => {
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 180_000);

  const launch = (name: string, extra: readonly string[] = [], timeoutMs = 60_000) =>
    run?.cli(
      [
        "delegate",
        name,
        "--task",
        "strix check",
        "--repo",
        local,
        "--brief",
        brief,
        "--item",
        item,
        "--machine",
        STRIX,
        ...extra,
      ],
      timeoutMs,
    );

  it("refuses a repo with no checkout recorded for the machine", () => {
    if (!run) return;
    expect(launch(`nc-${run.id}`, ["--harness", "claude"])).toEqual({
      exitCode: 1,
      output: `refused: ${local} has no checkout on strix; record one with coordinate backlog boundary add ${local} --machine strix --checkout <path>\n`,
    });
  }, 90_000);

  it("refuses a machine that lacks the harness, naming the machine's own domain", () => {
    if (!run) return;
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote]),
    ).toEqual({ exitCode: 0, output: `owned: added checkout of ${local} on strix: ${remote}\n` });
    expect(launch(`np-${run.id}`, ["--harness", "pi"])).toEqual({
      exitCode: 1,
      output:
        "refused: strix lacks pi on its login PATH; setting up strix belongs to strix's own domain, so file it there\n",
    });
  }, 90_000);

  it("refuses a recorded checkout that is not a Git repository there", () => {
    if (!run) return;
    const other = initRepo();
    try {
      const plain = `${run.remoteRoot}/plain`;
      expect(onStrix(`mkdir -p ${shellWord(plain)}`, 15).exitCode).toBe(0);
      expect(run.cli(["backlog", "boundary", "add", other]).exitCode).toBe(0);
      expect(
        run.cli(["backlog", "boundary", "add", other, "--machine", STRIX, "--checkout", plain])
          .exitCode,
      ).toBe(0);
      expect(
        run.cli([
          "delegate",
          `nr-${run.id}`,
          "--task",
          "strix check",
          "--repo",
          other,
          "--brief",
          brief,
          "--item",
          item,
          "--machine",
          STRIX,
          "--harness",
          "claude",
        ]),
      ).toEqual({
        exitCode: 1,
        output: `refused: ${plain} on strix is not a Git checkout; fix its entry with coordinate backlog boundary rm and add\n`,
      });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 90_000);

  it("starts Claude Code on strix in a remote worktree while this machine's budget is full", () => {
    if (!run) return;
    // A placeholder delegate fills this machine's budget; strix's own budget still has room.
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote])
        .exitCode,
    ).toBe(0);
    run.configure({ max_fleet_delegates_by_machine: { local: 1, strix: 99 } });
    run.placeholder(undefined, { "fleet.domain": run.domain, "fleet.task": "placeholder" });
    const name = `sd-${run.id}`;
    const launched = launch(name, ["--harness", "claude"], 150_000);
    const address = /\((strix\/t[0-9a-z]+)\)/.exec(launched?.output ?? "")?.[1] ?? "";
    const space = / in its own space (strix\/\S+)/.exec(launched?.output ?? "")?.[1] ?? "";
    if (address !== "") run.trackTerminal(address);
    if (space !== "") run.trackSpace(space);
    const worktree = `${remote}/.claude/worktrees/${name}`;
    const branch = `wyattjoh/${name}`;
    expect(launched).toEqual({
      exitCode: 0,
      output: [
        `worktree ${worktree} on ${branch} from main on strix`,
        "added .scratch/ to the repo's info/exclude on strix",
        `started ${name} (${address}) in its own space ${space}`,
        `filed ${name} under ${item} [delegated]`,
        `watcher for ${run.domain} is down; arm it (coordinate watch --arm)`,
        "",
      ].join("\n"),
    });
    const base = onStrix(`git -C ${shellWord(remote)} rev-parse main`, 20).output.trim();
    expect(
      onStrix(
        `cd ${shellWord(worktree)} && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain --untracked-files=all && cat .scratch/BRIEF.md`,
        20,
      ),
    ).toEqual({ exitCode: 0, output: `${branch}\n${base}\n${run.brief}` });

    // The CLI prints the watcher banner beside the JSON while the run has live delegates.
    const shown = run.cli(["backlog", "show", "--json"]).output;
    const filed = (
      JSON.parse(shown.slice(shown.indexOf("{"), shown.lastIndexOf("}") + 1)) as {
        items: { id: string; delegates: Record<string, string>[] }[];
      }
    ).items.find((entry) => entry.id === item)?.delegates;
    const session = filed?.[0]?.session ?? "";
    expect(filed).toEqual([
      {
        name,
        session,
        branch,
        worktree,
        brief: `${worktree}/.scratch/BRIEF.md`,
        report: `${worktree}/.scratch/REPORT.md`,
        machine: "strix",
      },
    ]);

    const got = Bun.spawnSync(["hc", "get", address, "--json"], {
      env: run.env,
      stdout: "pipe",
      timeout: 15_000,
    });
    const terminal = JSON.parse(got.stdout.toString()) as {
      name: string;
      state: string;
      cwd: string;
      labels: Record<string, string>;
    };
    const fleet = Object.fromEntries(
      Object.entries(terminal.labels).filter(([key]) => key.startsWith("fleet.")),
    );
    expect([terminal.name, terminal.state, terminal.cwd, fleet]).toEqual([
      name,
      "live",
      worktree,
      {
        "fleet.domain": run.domain,
        "fleet.task": "strix check",
        "fleet.session": session,
        "fleet.harness": "claude",
        "fleet.worktree": worktree,
        "fleet.machine": "strix",
        "fleet.branch": branch,
        "fleet.base": base,
        "fleet.space": space,
      },
    ]);

    // Claude Code is running on strix under its session id, which is split so this script's own
    // command line never matches it.
    const half = Math.floor(session.length / 2);
    expect(
      onStrix(
        [
          `pattern=${shellWord(session.slice(0, half))}`,
          `pattern="$pattern"${shellWord(session.slice(half))}`,
          "for attempt in $(seq 1 20); do",
          '  count=$(pgrep -f -c -- "$pattern")',
          '  [ "$count" -gt 0 ] && break',
          "  sleep 1",
          "done",
          'if [ "$count" -gt 0 ]; then echo running; else echo none; fi',
        ].join("\n"),
        40,
      ),
    ).toEqual({ exitCode: 0, output: "running\n" });
    // Teardown finds a launch by the run's domain label even when the CLI never printed it.
    const byLabel = Bun.spawnSync(
      ["hc", "ls", "--json", "--all", "--label", `fleet.domain=${run.domain}`],
      { env: run.env, stdout: "pipe", timeout: 15_000 },
    );
    expect(
      (JSON.parse(byLabel.stdout.toString()) as { terminals: { address: string }[] }).terminals
        .map((listed) => listed.address)
        .filter((listed) => listed.startsWith("strix/")),
    ).toEqual([address]);

    // End it: closing its space ends the terminal and the Claude Code session on strix.
    const closed = Bun.spawnSync(
      ["herdr-app", "do", "space.close", JSON.stringify({ id: space, confirmed: true })],
      { env: run.env, stdout: "pipe", timeout: 15_000 },
    );
    expect(closed.exitCode).toBe(0);
    expect(
      onStrix(
        [
          `pattern=${shellWord(session.slice(0, half))}`,
          `pattern="$pattern"${shellWord(session.slice(half))}`,
          "for attempt in 1 2 3 4 5 6 7 8 9 10; do",
          '  count=$(pgrep -f -c -- "$pattern")',
          '  [ "$count" = 0 ] && break',
          "  sleep 1",
          "done",
          'echo "$count"',
        ].join("\n"),
        30,
      ),
    ).toEqual({ exitCode: 0, output: "0\n" });
  }, 180_000);

  it("applies strix's own budget: refuses when it is full and queues with --queue-if-full", () => {
    if (!run) return;
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote])
        .exitCode,
    ).toBe(0);
    // A placeholder delegate on strix fills its budget of one; this machine's budget has room.
    run.configure({ max_fleet_delegates_by_machine: { local: 99, strix: 1 } });
    run.placeholder(STRIX, { "fleet.domain": run.domain, "fleet.task": "placeholder" });
    const name = `bq-${run.id}`;
    const flags = ["--harness", "claude"];
    const refused = run.cli(
      [
        "delegate",
        name,
        "--task",
        "strix check",
        "--repo",
        local,
        "--brief",
        brief,
        "--item",
        queuedItem,
        "--machine",
        STRIX,
        ...flags,
      ],
      90_000,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toMatch(
      new RegExp(
        `^watcher for ${run.domain} is down; arm it \\(coordinate watch --arm\\)\\nrefused: machine strix has [1-9][0-9]* live delegates \\(budget 1\\); refusing ${name} for item ${queuedItem}; pass --over-budget to start anyway\\n$`,
      ),
    );
    expect(
      run.cli(
        [
          "delegate",
          name,
          "--task",
          "strix check",
          "--repo",
          local,
          "--brief",
          brief,
          "--item",
          queuedItem,
          "--machine",
          STRIX,
          "--queue-if-full",
          ...flags,
        ],
        90_000,
      ),
    ).toEqual({
      exitCode: 0,
      output: [
        `queued delegate for item ${queuedItem} on machine strix (order 1); no launch was started; the domain watcher will wake this coordinator when capacity is available`,
        `watcher for ${run.domain} is down; arm it (coordinate watch --arm)`,
        "",
      ].join("\n"),
    });
    expect(
      onStrix(`test -e ${shellWord(`${remote}/.claude/worktrees/${name}`)} || echo absent`, 20),
    ).toEqual({ exitCode: 0, output: "absent\n" });
  }, 180_000);
});
