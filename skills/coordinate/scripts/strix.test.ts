import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initRepo } from "./lib/fixture.ts";
import {
  answerTrustDialog,
  onStrix,
  shellWord,
  STRIX,
  strixReadiness,
  strixRun,
  SUITE_LABEL,
  type StrixRun,
  watchEvents,
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

describe.skipIf(!ready)("strix: watching a remote delegate", () => {
  let run: StrixRun | undefined;
  let local = "";
  let remote = "";
  let brief = "";
  let item = "";
  beforeAll(() => {
    run = strixRun();
    local = initRepo();
    remote = run.remoteRepo("app");
    brief = join(run.stateDir, "brief.md");
    writeFileSync(brief, run.brief);
    run.seed({ owned: [local], adjacent: [] });
    run.becomeCoordinator();
    run.configure({ max_fleet_delegates_by_machine: { strix: 99 } });
    const added = run.cli(["item", "add", "strix watch"]);
    expect(added.exitCode).toBe(0);
    item = /\bi\d+\b/.exec(added.output)?.[0] ?? "";
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote])
        .exitCode,
    ).toBe(0);
  }, 90_000);
  afterAll(() => {
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 180_000);

  it("fires settled and gone for Claude Code on strix, and status names its machine", () => {
    if (!run) return;
    // A first pass seeds the watcher's snapshot, so the launch below is a change it sees.
    expect(watchEvents(run, () => true, 0, 3)).toEqual([]);
    const name = `sw-${run.id}`;
    const launched = run.cli(
      [
        "delegate",
        name,
        "--task",
        "strix watch",
        "--repo",
        local,
        "--brief",
        brief,
        "--item",
        item,
        "--machine",
        STRIX,
        "--harness",
        "claude",
      ],
      150_000,
    );
    const address = /\((strix\/t[0-9a-z]+)\)/.exec(launched.output)?.[1] ?? "";
    const space = / in its own space (strix\/\S+)/.exec(launched.output)?.[1] ?? "";
    if (address !== "") run.trackTerminal(address);
    if (space !== "") run.trackSpace(space);
    expect([launched.exitCode, address.startsWith("strix/t")]).toEqual([0, true]);

    const settled = `<event kind="settled" delegate="${name}" address="${address}">read its REPORT.md, verify, then report</event>`;
    const { env } = run;
    const screen = () =>
      Bun.spawnSync(["hc", "read", address, "--lines", "40"], {
        env,
        stdout: "pipe",
        timeout: 15_000,
      }).stdout.toString();
    const blocked = (event: string) => event.includes(' kind="blocked"');
    const events = watchEvents(run, (event) => event === settled || blocked(event), 300_000);
    // Claude Code asks once whether to trust a folder strix has never seen; this throwaway one is
    // the suite's own, so the suite answers yes in its own terminal.
    if (
      !events.includes(settled) &&
      events.some(blocked) &&
      screen().includes("trust this folder")
    ) {
      console.log(`answered Claude Code's trust dialog in ${address}`);
      Bun.spawnSync(["hc", "keys", address, "down", "enter"], { env: run.env, timeout: 15_000 });
      events.push(...watchEvents(run, (event) => event === settled, 300_000));
    }
    // Name what the watcher saw and what the delegate shows, so a miss is diagnosable.
    if (!events.includes(settled))
      console.log(`events: ${JSON.stringify(events)}\nscreen:\n${screen()}`);
    expect(events.filter((event) => event.includes(' kind="settled"'))).toEqual([settled]);
    expect(
      onStrix(`cat ${shellWord(`${remote}/.claude/worktrees/${name}/.scratch/REPORT.md`)}`, 20),
    ).toEqual({ exitCode: 0, output: "done\n" });

    const status = run.cli(["status"], 60_000);
    const line = status.output.split("\n").find((entry) => entry.startsWith(`  ${name} `)) ?? "";
    expect([status.exitCode, line]).toEqual([
      0,
      expect.stringMatching(
        new RegExp(
          `^  ${name} \\[strix\\] ${address} (idle|done) \\d+m · wyattjoh/${name} · next: coordinator: read its REPORT\\.md$`,
        ),
      ),
    ]);
    const json = run.cli(["status", "--json"], 60_000);
    const listed = (
      JSON.parse(json.output.slice(json.output.indexOf("{"), json.output.lastIndexOf("}") + 1)) as {
        delegates: { name: string; address: string; machine: string | null }[];
      }
    ).delegates.map((entry) => [entry.name, entry.address, entry.machine]);
    expect(listed).toEqual([[name, address, "strix"]]);

    // Closing its space ends the terminal on strix; the next pass reports it gone.
    const closed = Bun.spawnSync(
      ["herdr-app", "do", "space.close", JSON.stringify({ id: space, confirmed: true })],
      { env: run.env, stdout: "pipe", timeout: 15_000 },
    );
    expect(closed.exitCode).toBe(0);
    const gone = `<event kind="gone" delegate="${name}" address="${address}">resume with coordinate resume ${name}, or record it ended</event>`;
    expect(
      watchEvents(run, (event) => event === gone, 60_000).filter((event) =>
        event.includes(' kind="gone"'),
      ),
    ).toEqual([gone]);
  }, 600_000);
});

// Whether a process running the given command line exists on strix; the pattern is split so the
// probe's own command line never matches it.
const runningOnStrix = (text: string, wantRunning: boolean, attempts = 20): boolean => {
  const half = Math.floor(text.length / 2);
  const probe = onStrix(
    [
      `pattern=${shellWord(text.slice(0, half))}`,
      `pattern="$pattern"${shellWord(text.slice(half))}`,
      `for attempt in $(seq 1 ${attempts}); do`,
      '  count=$(pgrep -f -c -- "$pattern")',
      `  [ ${wantRunning ? '"$count" -gt 0' : '"$count" = 0'} ] && break`,
      "  sleep 1",
      "done",
      'if [ "$count" -gt 0 ]; then echo running; else echo none; fi',
    ].join("\n"),
    attempts + 20,
  );
  return probe.output === "running\n";
};

describe.skipIf(!ready)("strix: remote send, end and resume", () => {
  let run: StrixRun | undefined;
  let local = "";
  let remote = "";
  let item = "";
  let name = "";
  let address = "";
  let worktree = "";
  let session = "";
  let base = "";
  // Processes planted on strix for the end test, killed in afterAll if end left them.
  const planted: string[] = [];

  // The coordinate CLI as the run's coordinator, without the --domain flag run.cli appends.
  const coordinate = (args: readonly string[], timeoutMs = 60_000) => {
    const done = Bun.spawnSync(["bun", join(import.meta.dir, "coordinate.ts"), ...args], {
      env: run?.env ?? {},
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    return { exitCode: done.exitCode, output: done.stdout.toString() + done.stderr.toString() };
  };

  const hcJson = (argv: readonly string[]): Record<string, unknown> => {
    const done = Bun.spawnSync(["hc", ...argv, "--json"], {
      env: run?.env ?? {},
      stdout: "pipe",
      timeout: 15_000,
    });
    return JSON.parse(done.stdout.toString()) as Record<string, unknown>;
  };

  // The agent status Herdr reports for a terminal once it settles, polled for at most timeoutMs.
  const settled = (target: string, timeoutMs: number): string => {
    const until = Date.now() + timeoutMs;
    let status = "";
    while (Date.now() < until) {
      const got = hcJson(["get", target]) as { status?: { state?: string } | null };
      status = got.status?.state ?? "";
      if (["idle", "done", "blocked", "error"].includes(status)) return status;
      Bun.sleepSync(3000);
    }
    return `still ${status || "starting"} after ${timeoutMs / 1000}s`;
  };

  beforeAll(() => {
    run = strixRun();
    local = initRepo();
    remote = run.remoteRepo("app");
    const brief = join(run.stateDir, "brief.md");
    writeFileSync(brief, run.brief);
    run.seed({ owned: [local], adjacent: [], checkouts: { [local]: { [STRIX]: remote } } });
    run.becomeCoordinator();
    const added = run.cli(["item", "add", "strix follow-up"]);
    expect(added.exitCode).toBe(0);
    item = /\bi\d+\b/.exec(added.output)?.[0] ?? "";
    name = `sr-${run.id}`;
    worktree = `${remote}/.claude/worktrees/${name}`;
    const launched = run.cli(
      [
        "delegate",
        name,
        "--task",
        "strix follow-up",
        "--repo",
        local,
        "--brief",
        brief,
        "--item",
        item,
        "--machine",
        STRIX,
        "--harness",
        "claude",
      ],
      150_000,
    );
    address = /\((strix\/t[0-9a-z]+)\)/.exec(launched.output)?.[1] ?? "";
    if (address !== "") run.trackTerminal(address);
    expect([launched.exitCode, address === ""]).toEqual([0, false]);
    const labels = (hcJson(["get", address]) as { labels: Record<string, string> }).labels;
    session = labels["fleet.session"] ?? "";
    base = labels["fleet.base"] ?? "";
    // The fresh worktree is not trusted on strix yet: answer the dialog for the suite's own delegate.
    if (settled(address, 120_000) === "blocked")
      expect(answerTrustDialog(address, worktree)).toBe(true);
  }, 300_000);
  afterAll(() => {
    if (planted.length > 0) onStrix(`kill -9 ${planted.join(" ")} 2>/dev/null; true`, 20);
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 180_000);

  it("send delivers a message to a remote delegate by its name", () => {
    if (!run) return;
    // Claude Code reports done after its turn, idle once that has been seen.
    const status = settled(address, 240_000);
    expect(["done", "idle"]).toContain(status);
    const text = `Reply with the single word pong-${run.id}, then stop.`;
    expect(coordinate(["send", name, text], 150_000)).toEqual({
      exitCode: 0,
      output: `sent to ${name} (${address}, ${status})\nwatcher for ${run.domain} is down; arm it (coordinate watch --arm)\n`,
    });
    const until = Date.now() + 60_000;
    let screen = "";
    while (Date.now() < until && !screen.includes(`pong-${run.id}`)) {
      Bun.sleepSync(3000);
      screen = Bun.spawnSync(["hc", "read", address, "--lines", "200"], {
        env: run.env,
        stdout: "pipe",
        timeout: 15_000,
      }).stdout.toString();
    }
    expect(screen.includes(`pong-${run.id}`)).toBe(true);
  }, 400_000);

  it("end stops the remote terminal and its leftover processes on strix, recording machine and worktree", () => {
    if (!run) return;
    expect(["done", "idle"]).toContain(settled(address, 240_000));
    // A leftover in the worktree, and a decoy in a sibling folder whose name extends the worktree's.
    const seconds = 3000 + Math.floor(Math.random() * 600);
    // hc exec ends what it started, so each is orphaned from a helper terminal the suite owns, which
    // stays alive outside both folders (and is removed in teardown); strix's user manager adopts it.
    const plant = (folder: string, lifetime: number): string => {
      expect(onStrix(`mkdir -p ${shellWord(folder)}`, 15).exitCode).toBe(0);
      const started = Bun.spawnSync(
        [
          "hc",
          "run",
          "--bg",
          "--json",
          "--no-parent",
          "--label",
          `${SUITE_LABEL}=${run?.id ?? ""}`,
          "--on",
          STRIX,
          "--cwd",
          run?.remoteRoot ?? "/tmp",
          "--",
          "sh",
          "-c",
          `(cd ${shellWord(folder)} && setsid sleep ${lifetime} </dev/null >/dev/null 2>&1 &); exec sleep 1800`,
        ],
        { env: run?.env ?? {}, stdout: "pipe", timeout: 20_000 },
      );
      run?.trackTerminal((JSON.parse(started.stdout.toString()) as { address: string }).address);
      return onStrix(
        `for attempt in 1 2 3 4 5 6 7 8 9 10; do pid=$(pgrep -f '^sleep ${lifetime}$') && break; sleep 1; done; echo "$pid"`,
        30,
      ).output.trim();
    };
    const leftover = plant(worktree, seconds);
    const decoy = plant(`${worktree}x`, seconds + 1);
    planted.push(leftover, decoy);
    expect([/^\d+$/.test(leftover), /^\d+$/.test(decoy)]).toEqual([true, true]);

    const ended = coordinate(["end", name], 120_000);
    const record = join(run.stateDir, "ended", `${session}.json`);
    const stoppedLines = ended.output.split("\n").filter((line) => line.startsWith("  stopped "));
    expect([
      ended.exitCode,
      ended.output.split("\n").filter((line) => !line.startsWith("  stopped ")),
      stoppedLines.filter((line) => line.includes(`sleep ${seconds}`)),
    ]).toEqual([
      0,
      [
        `ended ${name} (${address}); record ${record}`,
        `worktree, branch and session stay; resume with: coordinate resume ${name}`,
        `processes of ${name} on strix:`,
        `${item} is still delegated with no live delegate; set its next status (coordinate item update ${item} --status ...)`,
        "",
      ],
      [`  stopped ${leftover} sleep ${seconds}`],
    ]);
    // The decoy outside the worktree still runs; nothing is left in the worktree.
    expect(
      onStrix(
        [
          `kill -0 ${decoy} && echo decoy-alive`,
          `for p in /proc/[0-9]*; do case "$(readlink $p/cwd)" in ${shellWord(worktree)}|${shellWord(worktree)}/*) echo "left ${"$"}{p#/proc/}";; esac; done`,
          "true",
        ].join("\n"),
        20,
      ),
    ).toEqual({ exitCode: 0, output: "decoy-alive\n" });
    expect(runningOnStrix(session, false, 10)).toBe(false);
    const written = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    expect({
      name: written.name,
      domain: written.domain,
      session: written.session,
      program: written.program,
      cwd: written.cwd,
      repo: written.repo,
      branch: written.branch,
      base_sha: written.base_sha,
      space: written.space,
      machine: written.machine,
    }).toEqual({
      name,
      domain: run.domain,
      session,
      program: "claude",
      cwd: worktree,
      repo: remote,
      branch: `wyattjoh/${name}`,
      base_sha: base,
      space: true,
      machine: "strix",
    });
  }, 400_000);

  it("resume restarts the ended remote delegate on strix in its worktree", () => {
    if (!run) return;
    const resumed = coordinate(["resume", name], 150_000);
    const again = /resumed \S+ in (strix\/t[0-9a-z]+)/.exec(resumed.output)?.[1] ?? "";
    if (again !== "") run.trackTerminal(again);
    expect(resumed).toEqual({
      exitCode: 0,
      output: [
        `resumed ${name} in ${again} (resume 1 of session ${session})`,
        `send it what arrived: coordinate send ${name} "<message>"`,
        `watcher for ${run.domain} is down; arm it (coordinate watch --arm)`,
        "",
      ].join("\n"),
    });
    const terminal = hcJson(["get", again]) as {
      name: string;
      state: string;
      cwd: string;
      labels: Record<string, string>;
    };
    const space = terminal.labels["fleet.space"] ?? "";
    if (space !== "") run.trackSpace(space);
    const fleet = Object.fromEntries(
      Object.entries(terminal.labels).filter(([key]) => key.startsWith("fleet.")),
    );
    expect([
      terminal.name,
      terminal.state,
      terminal.cwd,
      space.startsWith("strix/"),
      fleet,
    ]).toEqual([
      name,
      "live",
      worktree,
      true,
      {
        "fleet.domain": run.domain,
        "fleet.task": "strix follow-up",
        "fleet.session": session,
        "fleet.harness": "claude",
        "fleet.worktree": worktree,
        "fleet.machine": "strix",
        "fleet.branch": `wyattjoh/${name}`,
        "fleet.base": base,
        "fleet.space": space,
      },
    ]);
    expect(runningOnStrix(session, true)).toBe(true);
    expect(existsSync(join(run.stateDir, "ended", `${session}.json`))).toBe(false);
  }, 400_000);
});
