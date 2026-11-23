import { describe, expect, it } from "bun:test";
import { failureOf, processMachine, runWith } from "./fixture.ts";
import { fakeProc } from "./proc.ts";
import {
  ownedBy,
  parsePs,
  scanProcesses,
  type StopOptions,
  stopProcesses,
  teardownEnded,
} from "./processes.ts";

const STOP: StopOptions = { graceMs: 0, pollMs: 0, selfPid: "999999" };
const HOLD = "/Apps/Herdr Core.app/Contents/MacOS/herdr-core hold --socket /s.sock";
const WT = "/r/.claude/worktrees/x";

describe("parsePs", () => {
  it("reads pid, parent, start time and command line", () => {
    expect(parsePs("  812     1 Mon Nov  2 04:50:09 2026 node server.js --port 1\n")).toEqual([
      {
        pid: "812",
        ppid: "1",
        started: "Mon Nov 2 04:50:09 2026",
        args: "node server.js --port 1",
      },
    ]);
  });
});

describe("scanProcesses", () => {
  it("fails rather than return an empty table when ps rows do not parse", async () => {
    const fake = fakeProc((argv) =>
      argv[0] === "lsof"
        ? { exitCode: 0, stdout: "p5\ncherdr-core\nfcwd\nn/\n", stderr: "" }
        : { exitCode: 0, stdout: "5 1 lun. 23 nov. 04:50:09 2026 herdr-core hold\n", stderr: "" },
    );
    const error = await failureOf(scanProcesses(), fake.layer);
    expect(String((error as { kind?: string }).kind)).toBe("unreadable_output");
  });
});

describe("ownedBy", () => {
  it("takes orphans rooted in the folder with their descendants, and nothing a terminal or app holds", async () => {
    const machine = processMachine([
      { pid: 5, ppid: 1, args: `herdr-core hold`, cwd: "/" },
      { pid: 20, ppid: 1, args: "sh -c pnpm dev", cwd: WT },
      { pid: 21, ppid: 20, args: "node wrangler dev", cwd: `${WT}/apps/server` },
      { pid: 22, ppid: 21, args: "chrome --headless", cwd: "/" },
      { pid: 30, ppid: 5, args: "sh preview", cwd: WT },
      { pid: 31, ppid: 30, args: "node preview", cwd: WT },
      { pid: 40, ppid: 1, args: "Ghostty", cwd: "/" },
      { pid: 41, ppid: 40, args: "zsh", cwd: WT },
      { pid: 50, ppid: 1, args: "node other", cwd: "/r/.claude/worktrees/xy" },
    ]);
    const fake = fakeProc((argv) =>
      argv[0] === "ps"
        ? {
            ...machine.answer(argv),
            stdout: machine.answer(argv).stdout.replace("herdr-core hold", HOLD),
          }
        : machine.answer(argv),
    );
    const table = await runWith(scanProcesses(), fake.layer);
    expect([...table.core]).toEqual(["5"]);
    expect([...ownedBy(table, WT)].toSorted()).toEqual(["20", "21", "22"]);
  });
});

describe("stopProcesses", () => {
  it("sends SIGTERM, then SIGKILL to what ignores it, and prints each pid", async () => {
    const machine = processMachine(
      [
        { pid: 20, ppid: 1, args: "node dev", cwd: WT },
        { pid: 21, ppid: 1, args: "bun stubborn.ts", cwd: WT },
      ],
      { TERM: [21] },
    );
    const fake = fakeProc(machine.answer);
    const rows = parsePs(machine.answer(["ps"]).stdout);
    const result = await runWith(stopProcesses(rows, STOP), fake.layer);
    expect(result.lines).toEqual(["stopped 20 node dev", "stopped 21 bun stubborn.ts (SIGKILL)"]);
    expect(machine.kills).toEqual([
      ["kill", "-TERM", "20", "21"],
      ["kill", "-KILL", "21"],
    ]);
    expect(result.survivors).toEqual([]);
  });

  it("reports a process that survives SIGKILL", async () => {
    const machine = processMachine([{ pid: 20, ppid: 1, args: "node dev", cwd: WT }], {
      TERM: [20],
      KILL: [20],
    });
    const fake = fakeProc(machine.answer);
    const result = await runWith(
      stopProcesses(parsePs(machine.answer(["ps"]).stdout), STOP),
      fake.layer,
    );
    expect(result.lines).toEqual(["could not stop 20 node dev: still running after SIGKILL"]);
    expect(result.survivors.map((row) => row.pid)).toEqual(["20"]);
  });

  it("leaves a pid reused by a later process, and this command's own ancestry", async () => {
    const machine = processMachine([
      { pid: 20, ppid: 1, args: "node dev", cwd: WT },
      { pid: 30, ppid: 1, args: "zsh", cwd: WT },
      { pid: 31, ppid: 30, args: "bun coordinate.ts sweep remove", cwd: WT },
    ]);
    const fake = fakeProc(machine.answer);
    const reused = { pid: "20", ppid: "1", started: "Sun Nov 22 01:00:00 2026", args: "node dev" };
    const rows = parsePs(machine.answer(["ps"]).stdout).filter((row) => row.pid !== "20");
    const result = await runWith(
      stopProcesses([reused, ...rows], { ...STOP, selfPid: "31" }),
      fake.layer,
    );
    expect(result.lines).toEqual([
      "left 30 zsh: it runs this command",
      "left 31 bun coordinate.ts sweep remove: it runs this command",
    ]);
    expect(machine.kills).toEqual([]);
  });

  it("signals nothing when given nothing", async () => {
    const fake = fakeProc(() => {
      throw new Error("no process may be read or signalled");
    });
    expect(await runWith(stopProcesses([], STOP), fake.layer)).toEqual({
      lines: [],
      survivors: [],
    });
  });
});

const core = (machine: ReturnType<typeof processMachine>) =>
  fakeProc((argv) => {
    const out = machine.answer(argv);
    return argv[0] === "lsof"
      ? { ...out, stdout: out.stdout.replace("c/Apps/Herdr", "cherdr-core") }
      : out;
  });

describe("teardownEnded", () => {
  const start = [
    { pid: 5, ppid: 1, args: HOLD, cwd: "/" },
    { pid: 10, ppid: 5, args: "claude --session-id s-1", cwd: WT },
    { pid: 11, ppid: 10, args: "node chrome-devtools-mcp", cwd: "/" },
    { pid: 20, ppid: 1, args: "pnpm dev", cwd: WT },
    { pid: 60, ppid: 5, args: "sh preview", cwd: WT },
  ];

  it("stops the terminal's tree and the worktree's orphans, never another terminal's", async () => {
    const machine = processMachine(start);
    const fake = core(machine);
    const before = await runWith(scanProcesses(), fake.layer);
    const lines = await runWith(
      teardownEnded({ name: "fix-a", rootPid: 10, worktree: WT }, before, STOP),
      fake.layer,
    );
    expect(lines).toEqual([
      "processes of fix-a:",
      "  stopped 10 claude --session-id s-1",
      "  stopped 11 node chrome-devtools-mcp",
      "  stopped 20 pnpm dev",
    ]);
    expect([...machine.alive].toSorted()).toEqual([5, 60]);
  });

  it("leaves the tree alone when its root is not a local Herdr terminal process", async () => {
    const machine = processMachine(start);
    const fake = core(machine);
    const before = await runWith(scanProcesses(), fake.layer);
    const lines = await runWith(
      teardownEnded({ name: "fix-a", rootPid: 20, worktree: undefined }, before, STOP),
      fake.layer,
    );
    expect(lines).toEqual([
      "no processes of fix-a were left running",
      "  pid 20 is not a local Herdr terminal process, so its tree was left alone",
    ]);
    expect(machine.kills).toEqual([]);
  });
});
