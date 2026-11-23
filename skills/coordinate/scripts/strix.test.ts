import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { g, initRepo } from "./lib/fixture.ts";
import { shellWord } from "./lib/git-env.ts";
import {
  answerTrustDialog,
  onStrix,
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

const blockedEvent = (event: string) => event.includes(' kind="blocked"');

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
    ).toEqual({
      exitCode: 0,
      output: `${branch}\n${base}\n${run.brief}${outboxSection(`${worktree}/.scratch/OUTBOX.jsonl`)}`,
    });

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
    const events = watchEvents(run, (event) => event === settled || blockedEvent(event), 300_000);
    // Claude Code asks once whether to trust a folder strix has never seen; this throwaway one is
    // the suite's own, so the suite answers yes in its own terminal.
    if (
      !events.includes(settled) &&
      events.some(blockedEvent) &&
      answerTrustDialog(address, `${remote}/.claude/worktrees/${name}`)
    ) {
      console.log(`answered Claude Code's trust dialog in ${address}`);
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

/**
 * The section a remote launch appends to the brief it writes on the delegate's machine.
 * @param outbox Absolute outbox path there.
 * @returns The section, with the blank line that separates it from the brief.
 */
const outboxSection = (outbox: string): string =>
  [
    "",
    "## Delegate outbox",
    "",
    `This delegate runs on strix, which has no coordinate CLI. Do not run \`coordinate finding add\` or \`coordinate notify\`: wherever this brief says to run one, append one JSON object on its own line to \`${outbox}\` instead, and never change earlier lines. Your coordinator's watcher reads the file and applies each line once.`,
    "",
    '- A finding: `{"type":"finding","kind":"issue","title":"<title>","from":"<item id>","detailMarkdown":"<what, as Markdown>","path":"<file or folder>"}`. `kind` is `issue` or `opportunity`; `from`, `detailMarkdown` and `path` are optional; plain-text `detail` is deprecated.',
    '- The notify: `{"type":"notify","text":"<name>: <status>, report at <absolute report path>"}`.',
    "",
  ].join("\n");

describe.skipIf(!ready)("strix: draining a remote delegate's outbox", () => {
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
    const added = run.cli(["item", "add", "strix outbox"]);
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

  it("briefs the delegate on its outbox and applies each finding and notify line once", () => {
    if (!run) return;
    expect(watchEvents(run, () => true, 0, 3)).toEqual([]);
    const name = `so-${run.id}`;
    const launched = run.cli(
      [
        "delegate",
        name,
        "--task",
        "strix outbox",
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
    const worktree = `${remote}/.claude/worktrees/${name}`;
    const outbox = `${worktree}/.scratch/OUTBOX.jsonl`;
    expect(onStrix(`cat ${shellWord(`${worktree}/.scratch/BRIEF.md`)}`, 20)).toEqual({
      exitCode: 0,
      output: `${run.brief}${outboxSection(outbox)}`,
    });

    const settled = `<event kind="settled" delegate="${name}" address="${address}">read its REPORT.md, verify, then report</event>`;
    const notified = `<event kind="notify" delegate="${name}" address="${address}">done</event>`;
    const { env } = run;
    const screen = () =>
      Bun.spawnSync(["hc", "read", address, "--lines", "40"], {
        env,
        stdout: "pipe",
        timeout: 15_000,
      }).stdout.toString();
    const events: string[] = [];
    const both = () => events.includes(settled) && events.includes(notified);
    events.push(...watchEvents(run, (event) => event === settled || blockedEvent(event), 300_000));
    // Claude Code asks once whether to trust a folder strix has never seen; this throwaway one is
    // the suite's own, so the suite answers yes in its own terminal.
    if (
      !events.includes(settled) &&
      events.some(blockedEvent) &&
      answerTrustDialog(address, worktree)
    ) {
      console.log(`answered Claude Code's trust dialog in ${address}`);
      events.push(...watchEvents(run, (event) => event === settled, 300_000));
    }
    if (!both()) events.push(...watchEvents(run, () => both(), 60_000, 5));
    if (!both()) console.log(`events: ${JSON.stringify(events)}\nscreen:\n${screen()}`);
    expect(events.filter((event) => event.includes(' kind="notify"'))).toEqual([notified]);

    // A finding line appended by hand, as a remote delegate would, lands with its source delegate.
    const line = JSON.stringify({
      type: "finding",
      kind: "issue",
      title: "strix outbox finding",
      from: item,
      detail: "noticed on strix",
    });
    expect(onStrix(`printf '%s\\n' ${shellWord(line)} >> ${shellWord(outbox)}`, 20).exitCode).toBe(
      0,
    );
    const findings = () => {
      const shown = run?.cli(["backlog", "show", "--json"]).output ?? "";
      return (
        JSON.parse(shown.slice(shown.indexOf("{"), shown.lastIndexOf("}") + 1)) as {
          findings: Record<string, unknown>[];
        }
      ).findings;
    };
    // Items and findings share one id counter, and the item took the first.
    const applied = {
      id: "f2",
      kind: "issue",
      title: "strix outbox finding",
      detail: "noticed on strix",
      path: null,
      from: item,
      source: `delegate:${name}`,
      createdAt: expect.any(String),
      status: "open",
      closedAt: null,
      outcome: null,
    };
    // Each pass is a new watcher process, so later passes are restarts reading the same outbox.
    const outboxEvents = () =>
      watchEvents(run as StrixRun, () => true, 0, 5).filter(
        (event) =>
          event.includes(' kind="notify"') || event.includes(' kind="delegate-outbox-invalid"'),
      );
    expect(outboxEvents()).toEqual([]);
    expect(findings()).toEqual([applied]);
    expect(outboxEvents()).toEqual([]);
    expect(outboxEvents()).toEqual([]);
    expect(findings()).toEqual([applied]);
  }, 600_000);
});

describe.skipIf(!ready)("strix: copy-back and bundle fetch", () => {
  let run: StrixRun | undefined;
  let local = "";
  let remote = "";
  let brief = "";
  let item = "";
  beforeAll(() => {
    run = strixRun();
    local = initRepo();
    remote = run.remoteClone(local, "app");
    brief = join(run.stateDir, "brief.md");
    writeFileSync(brief, run.brief);
    run.seed({ owned: [local], adjacent: [] });
    run.becomeCoordinator();
    run.configure({ max_fleet_delegates_by_machine: { strix: 99 } });
    const added = run.cli(["item", "add", "strix fetch"]);
    expect(added.exitCode).toBe(0);
    item = /\bi\d+\b/.exec(added.output)?.[0] ?? "";
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote])
        .exitCode,
    ).toBe(0);
  }, 120_000);
  afterAll(() => {
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 180_000);

  it("copies the settled delegate's .scratch here and fetches its branch as a bundle", () => {
    if (!run) return;
    expect(watchEvents(run, () => true, 0, 3)).toEqual([]);
    const name = `sf-${run.id}`;
    const branch = `wyattjoh/${name}`;
    const worktree = `${remote}/.claude/worktrees/${name}`;
    const launched = run.cli(
      [
        "delegate",
        name,
        "--task",
        "strix fetch",
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
    // A binary file deeper in .scratch: the copy-back must carry exact bytes, not text.
    expect(
      onStrix(
        `mkdir -p ${shellWord(`${worktree}/.scratch/nested`)} && printf '\\000\\377bin\\n' > ${shellWord(`${worktree}/.scratch/nested/blob.bin`)}`,
        20,
      ).exitCode,
    ).toBe(0);

    const settled = `<event kind="settled" delegate="${name}" address="${address}">read its REPORT.md, verify, then report</event>`;
    const { env } = run;
    const screen = () =>
      Bun.spawnSync(["hc", "read", address, "--lines", "40"], {
        env,
        stdout: "pipe",
        timeout: 15_000,
      }).stdout.toString();
    const events = watchEvents(run, (event) => event === settled || blockedEvent(event), 300_000);
    if (
      !events.includes(settled) &&
      events.some(blockedEvent) &&
      answerTrustDialog(address, worktree)
    ) {
      console.log(`answered Claude Code's trust dialog in ${address}`);
      events.push(...watchEvents(run, (event) => event === settled, 300_000));
    }
    if (!events.includes(settled))
      console.log(`events: ${JSON.stringify(events)}\nscreen:\n${screen()}`);
    expect(events.filter((event) => event.includes(' kind="settled"'))).toEqual([settled]);

    // Sweep sees the live delegate's session in its worktree on strix: KEEP, never ASK or SAFE.
    const swept = run.cli(["sweep", "report"], 300_000);
    const row = swept.output.split("\n").find((line) => line.includes(`strix:${worktree} `)) ?? "";
    expect([swept.exitCode, row.replace(/ in "[^"]*"$/, "")]).toEqual([
      0,
      `KEEP  worktree strix:${worktree} [${branch}] PRs unknown: no remote · 1 commit on no remote or base · session ${name}`,
    ]);

    // At settle the watcher copied the remote .scratch into this Mac's parked folder for it.
    const parked = join(local, ".scratch", "parked", name);
    expect(readFileSync(join(parked, ".scratch", "REPORT.md"), "utf8")).toBe("done\n");
    expect([...readFileSync(join(parked, ".scratch", "nested", "blob.bin"))]).toEqual([
      0, 255, 98, 105, 110, 10,
    ]);
    expect(g(local, "status", "--porcelain")).toBe("");

    const base = g(local, "rev-parse", "main").trim();
    const there = onStrix(
      `cd ${shellWord(worktree)} && git rev-list --count ${base}..HEAD && git rev-parse HEAD`,
      20,
    );
    const [count, tip] = there.output.trim().split("\n");
    expect([there.exitCode, count]).toEqual([0, "1"]);

    const fetched = run.cli(["fetch", name], 180_000);
    expect(fetched).toEqual({
      exitCode: 0,
      output: [
        `copied .scratch of ${name} from strix to ${parked}`,
        `fetched ${branch} from ${name} on strix into ${local}: 1 commit past ${base.slice(0, 7)}, tip ${(tip ?? "").slice(0, 7)}`,
        "land it as a local branch; nothing was pushed",
        // The suite's coordinator has no watcher armed, so the CLI's stderr banner says so.
        `watcher for ${run.domain} is down; arm it (coordinate watch --arm)`,
        "",
      ].join("\n"),
    });
    expect(g(local, "rev-parse", branch).trim()).toBe(tip ?? "");
    expect(g(local, "log", "--format=%s", `main..${branch}`)).toBe("test: hello");
    expect(g(local, "show", `${branch}:hello.txt`)).toBe("hello");
    // Nothing here or there has a remote to push to, and the fetch came from a bundle file.
    expect([g(local, "remote"), onStrix(`git -C ${shellWord(remote)} remote`, 20)]).toEqual([
      "",
      { exitCode: 0, output: "" },
    ]);

    // Fetching again is a no-op fast-forward with the same tip.
    expect(run.cli(["fetch", name], 180_000).exitCode).toBe(0);
    expect(g(local, "rev-parse", branch).trim()).toBe(tip ?? "");

    expect(run.cli(["fetch", `nobody-${run.id}`], 60_000)).toEqual({
      exitCode: 1,
      output: `watcher for ${run.domain} is down; arm it (coordinate watch --arm)\nrefused: no delegate nobody-${run.id}: no live terminal or ended record has that name\n`,
    });
  }, 900_000);

  it("fetches an ended remote delegate's branch and a .scratch larger than one read chunk", () => {
    if (!run) return;
    // No session: a hand-made worktree on strix and its ended record stand in for an ended delegate.
    const base = g(local, "rev-parse", "main").trim();
    const made = (name: string, commit: boolean) => {
      const worktree = `${remote}/.claude/worktrees/${name}`;
      const ran = onStrix(
        [
          `cd ${shellWord(remote)}`,
          `git worktree add -q -b ${shellWord(`wyattjoh/${name}`)} ${shellWord(worktree)} main`,
          `cd ${shellWord(worktree)}`,
          "mkdir -p .scratch",
          // About 6 MB of random bytes: over 100 000 base64 lines, so more than one read chunk.
          "head -c 6000000 /dev/urandom > .scratch/big.bin",
          ...(commit
            ? ["printf 'x\\n' > x.txt", "git add x.txt", "git commit -q -m 'test: x'"]
            : []),
          "sha256sum .scratch/big.bin | cut -d ' ' -f 1",
          "git rev-parse HEAD",
        ].join(" && "),
        60,
      );
      expect(ran.exitCode).toBe(0);
      const [sha, tip] = ran.output.trim().split("\n");
      const session = crypto.randomUUID();
      writeFileSync(
        join(run?.stateDir ?? "", "ended", `${session}.json`),
        `${JSON.stringify({ name, domain: run?.domain, session, cwd: worktree, branch: `wyattjoh/${name}`, base_sha: base, ended_at: new Date().toISOString(), machine: STRIX })}\n`,
      );
      return { sha: sha ?? "", tip: tip ?? "" };
    };
    mkdirSync(join(run.stateDir, "ended"), { recursive: true });
    // Whether the CLI prints the watcher-down banner depends on what ran before; leave it out.
    const banner = `watcher for ${run.domain} is down; arm it (coordinate watch --arm)\n`;
    const fetch = (target: string) => {
      const ran = run?.cli(["fetch", target], 300_000) ?? { exitCode: null, output: "" };
      return { exitCode: ran.exitCode, output: ran.output.replace(banner, "") };
    };
    const name = `se-${run.id}`;
    const ended = made(name, true);
    const parked = join(local, ".scratch", "parked", name);
    expect(fetch(name)).toEqual({
      exitCode: 0,
      output: [
        `copied .scratch of ${name} from strix to ${parked}`,
        `fetched wyattjoh/${name} from ${name} on strix into ${local}: 1 commit past ${base.slice(0, 7)}, tip ${ended.tip.slice(0, 7)}`,
        "land it as a local branch; nothing was pushed",
        "",
      ].join("\n"),
    });
    expect(g(local, "rev-parse", `wyattjoh/${name}`).trim()).toBe(ended.tip);
    expect(
      createHash("sha256")
        .update(readFileSync(join(parked, ".scratch", "big.bin")))
        .digest("hex"),
    ).toBe(ended.sha);

    const still = `sb-${run.id}`;
    made(still, false);
    expect(fetch(still)).toEqual({
      exitCode: 1,
      output: `refused: wyattjoh/${still} has no commits past ${base.slice(0, 7)} on strix; nothing to fetch\n`,
    });
  }, 600_000);
});

describe.skipIf(!ready)("strix: sweep remote worktrees", () => {
  let run: StrixRun | undefined;
  let local = "";
  let remote = "";
  beforeAll(() => {
    run = strixRun();
    local = initRepo();
    remote = run.remoteClone(local, "app");
    // A remote launch adds .scratch/ to the checkout's info/exclude; the fixture does it by hand.
    expect(
      onStrix(`printf '.scratch/\\n' >> ${shellWord(`${remote}/.git/info/exclude`)}`, 20).exitCode,
    ).toBe(0);
    run.seed({ owned: [local], adjacent: [] });
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote])
        .exitCode,
    ).toBe(0);
    mkdirSync(join(run.stateDir, "ended"), { recursive: true });
  }, 120_000);
  afterAll(() => {
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 180_000);

  it("reports remote worktrees by git on strix, removes the SAFE one there, and keeps live records", () => {
    if (!run) return;
    const banner = `watcher for ${run.domain} is down; arm it (coordinate watch --arm)\n`;
    const cli = (args: readonly string[]) => {
      const ran = run?.cli(args, 300_000) ?? { exitCode: null, output: "" };
      return { exitCode: ran.exitCode, output: ran.output.replace(banner, "") };
    };
    const base = g(local, "rev-parse", "main").trim();
    const worktree = (name: string) => `${remote}/.claude/worktrees/${name}`;
    const record = (name: string, cwd: string) => {
      const session = crypto.randomUUID();
      const path = join(run?.stateDir ?? "", "ended", `${session}.json`);
      writeFileSync(
        path,
        `${JSON.stringify({ name, domain: run?.domain, session, cwd, branch: `wyattjoh/${name}`, base_sha: base, ended_at: new Date().toISOString(), machine: STRIX })}\n`,
      );
      return path;
    };
    const safe = `ss-${run.id}`;
    const ask = `sa-${run.id}`;
    const keep = `sk-${run.id}`;
    const gone = `sg-${run.id}`;
    const vanished = `sx-${run.id}`;
    // SAFE: one commit, fast-forwarded into main there, its ended record, a report in .scratch.
    // ASK: an uncommitted file. KEEP: no commits and no record. ASK too: a folder deleted there.
    const made = onStrix(
      [
        `cd ${shellWord(remote)}`,
        ...[safe, ask, keep, vanished].map(
          (name) =>
            `git worktree add -q -b ${shellWord(`wyattjoh/${name}`)} ${shellWord(worktree(name))} main`,
        ),
        `cd ${shellWord(worktree(safe))}`,
        "mkdir -p .scratch",
        "printf 'done\\n' > .scratch/REPORT.md",
        "printf 'x\\n' > x.txt",
        "git add x.txt",
        "git commit -q -m 'test: x'",
        `cd ${shellWord(remote)}`,
        `git merge -q --ff-only ${shellWord(`wyattjoh/${safe}`)}`,
        `printf 'wip\\n' > ${shellWord(`${worktree(ask)}/wip.txt`)}`,
        `rm -rf ${shellWord(worktree(vanished))}`,
        `git rev-parse --short ${shellWord(`wyattjoh/${safe}`)}`,
      ].join(" && "),
      60,
    );
    expect(made.exitCode).toBe(0);
    const sha = made.output.trim();
    const safeRecord = record(safe, worktree(safe));

    const rows = [
      `SAFE  worktree strix:${worktree(safe)} [wyattjoh/${safe}] PRs unknown: no remote · on base (ancestor) · ended delegate record`,
      `ASK   worktree strix:${worktree(ask)} [wyattjoh/${ask}] PRs unknown: no remote · no commits yet · 1 uncommitted`,
      `KEEP  worktree strix:${worktree(keep)} [wyattjoh/${keep}] PRs unknown: no remote · no commits yet`,
      `INFO  PRs for ${local} unknown: no remote`,
    ];
    // A worktree whose folder is gone there reads as gone, not as a git failure.
    const vanishedRow = `ASK   worktree strix:${worktree(vanished)} [wyattjoh/${vanished}] PRs unknown: no remote · no commits yet · folder gone on strix`;
    const reported = cli(["sweep", "report"]);
    const reportLines = reported.output.split("\n");
    expect([
      reported.exitCode,
      reportLines.filter((line) => !line.includes(vanished)),
      reportLines.filter((line) => line.includes(vanished)),
    ]).toEqual([0, [...rows, ""], [vanishedRow]]);

    // Every remove target is under this run's own folder on strix.
    const targets = [safe, ask].map((name) => `strix:${worktree(name)}`);
    const outside = `strix:${run.remoteRoot}/elsewhere/.claude/worktrees/x`;
    expect(
      [...targets, outside].map((target) => target.startsWith(`strix:${run?.remoteRoot}/`)),
    ).toEqual([true, true, true]);
    const parked = join(local, ".scratch", "parked", safe);
    const askKept = `strix:${worktree(ask)}: ASK, [wyattjoh/${ask}] PRs unknown: no remote · no commits yet · 1 uncommitted`;
    const outsideKept = `${outside}: in no checkout the Boundary records on strix`;
    expect(cli(["sweep", "remove", ...targets, outside])).toEqual({
      exitCode: 0,
      output: [
        `removed worktree strix:${worktree(safe)}`,
        `  copied .scratch of ${safe} from strix to ${parked}`,
        `  deleted branch wyattjoh/${safe} ${sha}`,
        `  pruned ended record ${safe}`,
        `kept ${askKept}`,
        `kept ${outsideKept}`,
        `removed 1 of 3; 2 kept because: ${askKept}; ${outsideKept}`,
        "",
      ].join("\n"),
    });
    expect(readFileSync(join(parked, ".scratch", "REPORT.md"), "utf8")).toBe("done\n");
    expect(existsSync(safeRecord)).toBe(false);
    expect(
      onStrix(
        [
          `cd ${shellWord(remote)}`,
          `if [ -e ${shellWord(worktree(safe))} ]; then echo present; else echo absent; fi`,
          `git branch --list --format='%(refname:short)' | sort`,
          `git -C ${shellWord(worktree(ask))} status --porcelain`,
        ].join(" && "),
        30,
      ),
    ).toEqual({
      exitCode: 0,
      output: [
        "absent",
        "main",
        `wyattjoh/${ask}`,
        `wyattjoh/${keep}`,
        `wyattjoh/${vanished}`,
        "?? wip.txt",
        "",
      ].join("\n"),
    });

    // prune-ended judges a remote record by its folder on strix, never on this Mac.
    const keepRecord = record(keep, worktree(keep));
    const goneRecord = record(gone, worktree(gone));
    expect(run.bare(["sweep", "prune-ended"], 120_000)).toEqual({
      exitCode: 0,
      output: `pruned 1 of 2 ended records whose folder is gone\n  ${gone}\n`,
    });
    expect([existsSync(keepRecord), existsSync(goneRecord)]).toEqual([true, false]);
  }, 600_000);
});

describe.skipIf(!ready)("strix: sweep a remote worktree fetched and landed here", () => {
  let run: StrixRun | undefined;
  let local = "";
  let remote = "";
  beforeAll(() => {
    run = strixRun();
    local = initRepo();
    remote = run.remoteClone(local, "app");
    expect(
      onStrix(`printf '.scratch/\\n' >> ${shellWord(`${remote}/.git/info/exclude`)}`, 20).exitCode,
    ).toBe(0);
    run.seed({ owned: [local], adjacent: [] });
    expect(
      run.cli(["backlog", "boundary", "add", local, "--machine", STRIX, "--checkout", remote])
        .exitCode,
    ).toBe(0);
    mkdirSync(join(run.stateDir, "ended"), { recursive: true });
  }, 120_000);
  afterAll(() => {
    if (local !== "") rmSync(local, { recursive: true, force: true });
    const left = run?.teardown() ?? [];
    expect(left).toEqual([]);
  }, 180_000);

  it("reports it SAFE once its tip is on main here, removes it on strix and keeps the unmerged branch there", () => {
    if (!run) return;
    const banner = `watcher for ${run.domain} is down; arm it (coordinate watch --arm)\n`;
    const cli = (args: readonly string[]) => {
      const ran = run?.cli(args, 300_000) ?? { exitCode: null, output: "" };
      return { exitCode: ran.exitCode, output: ran.output.replace(banner, "") };
    };
    const base = g(local, "rev-parse", "main").trim();
    const name = `sl-${run.id}`;
    const branch = `wyattjoh/${name}`;
    const worktree = `${remote}/.claude/worktrees/${name}`;
    // An ended delegate's worktree on strix: one commit that strix's own main never gets.
    const made = onStrix(
      [
        `cd ${shellWord(remote)}`,
        `git worktree add -q -b ${shellWord(branch)} ${shellWord(worktree)} main`,
        `cd ${shellWord(worktree)}`,
        "mkdir -p .scratch",
        "printf 'done\\n' > .scratch/REPORT.md",
        "printf 'x\\n' > x.txt",
        "git add x.txt",
        "git commit -q -m 'test: x'",
        "git rev-parse --short HEAD",
      ].join(" && "),
      60,
    );
    expect(made.exitCode).toBe(0);
    const sha = made.output.trim();
    const session = crypto.randomUUID();
    const record = join(run.stateDir, "ended", `${session}.json`);
    writeFileSync(
      record,
      `${JSON.stringify({ name, domain: run.domain, session, cwd: worktree, branch, base_sha: base, ended_at: new Date().toISOString(), machine: STRIX })}\n`,
    );
    const askRow = `ASK   worktree strix:${worktree} [${branch}] PRs unknown: no remote · 1 commit on no remote or base · ended delegate record`;
    const info = `INFO  PRs for ${local} unknown: no remote`;
    // Fetched but not landed: the commit is on no base anywhere yet.
    expect(cli(["fetch", name]).exitCode).toBe(0);
    expect(cli(["sweep", "report"])).toEqual({ exitCode: 0, output: `${askRow}\n${info}\n` });

    // Landed on this Mac's main by fast-forward: the exact tip is on a base here.
    g(local, "merge", "-q", "--ff-only", branch);
    expect(cli(["sweep", "report"])).toEqual({
      exitCode: 0,
      output: [
        `SAFE  worktree strix:${worktree} [${branch}] PRs unknown: no remote · tip on main on this Mac · ended delegate record`,
        info,
        "",
      ].join("\n"),
    });

    const parked = join(local, ".scratch", "parked", name);
    expect(cli(["sweep", "remove", `strix:${worktree}`])).toEqual({
      exitCode: 0,
      output: [
        `removed worktree strix:${worktree}`,
        `  copied .scratch of ${name} from strix to ${parked}`,
        `  kept branch ${branch} ${sha}: git branch -d refused (error: the branch '${branch}' is not fully merged). Its tip is on main on this Mac, not on a base on strix; to delete it, the user runs on strix: cd ${remote} && git branch -D ${branch}`,
        `  pruned ended record ${name}`,
        "removed 1 of 1",
        "",
      ].join("\n"),
    });
    expect(existsSync(record)).toBe(false);
    expect(
      onStrix(
        [
          `cd ${shellWord(remote)}`,
          `if [ -e ${shellWord(worktree)} ]; then echo present; else echo absent; fi`,
          `git branch --list --format='%(refname:short) %(objectname:short)' | sort`,
        ].join(" && "),
        30,
      ),
    ).toEqual({
      exitCode: 0,
      output: ["absent", "main " + base.slice(0, 7), `${branch} ${sha}`, ""].join("\n"),
    });
  }, 600_000);
});
