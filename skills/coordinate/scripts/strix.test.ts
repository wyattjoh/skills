import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { initRepo } from "./lib/fixture.ts";
import { onStrix, shellWord, STRIX, strixReadiness, strixRun } from "./lib/strix-fixture.ts";

// The real-strix integration suite. It runs only with COORDINATE_STRIX=1 and a connected strix
// that has Claude Code and git; otherwise it prints one line saying why and skips.
const readiness = strixReadiness();
if (!readiness.ready) console.log(`strix suite skipped: ${readiness.reason}`);
const ready = readiness.ready;

describe.skipIf(!ready)("strix: Boundary checkout map", () => {
  const run = ready ? strixRun() : undefined;
  const local = ready ? initRepo() : "";
  afterAll(() => {
    rmSync(local, { recursive: true, force: true });
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
