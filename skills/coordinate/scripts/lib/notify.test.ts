import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, eachBackend, tempDir } from "./fixture.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const cli = join(import.meta.dir, "..", "coordinate.ts");
const DELEGATE = { "fleet.domain": "app", "fleet.session": "s-1" };
const LINE = "fix-a: done, report at /w/fix-a/.scratch/REPORT.md";
const coordinator = (status: string) => ({
  address: "t5",
  name: "coord",
  state: "live",
  status: { state: status },
  labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
});

const notify = (
  labels: Record<string, string>,
  listed: unknown[],
  terminals: Record<string, unknown> = {},
) => {
  const state = tempDir();
  made.push(state);
  const env = cliEnv(state, labels, undefined, terminals, {
    "fleet.role=coordinator": listed,
  });
  const done = Bun.spawnSync(["bun", cli, "notify", LINE], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const log = join(state, "bin", "calls.log");
  const sends = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("send "))
    : [];
  return {
    exit: done.exitCode,
    stdout: done.stdout.toString(),
    stderr: done.stderr.toString(),
    sends,
  };
};

eachBackend("coordinate notify", () => {
  it("sends one line to the domain's live coordinator", () => {
    expect(
      notify(DELEGATE, [{ address: "t5", state: "live" }], { t5: coordinator("idle") }),
    ).toEqual({
      exit: 0,
      stdout: "sent to coord (t5, idle)\n",
      stderr: "",
      sends: [`send t5 ${LINE} --json`],
    });
  }, 30_000);

  it("prints and exits 0 when no coordinator runs", () => {
    expect(notify(DELEGATE, [])).toEqual({
      exit: 0,
      stdout: `no live coordinator for app; nothing sent: ${LINE}\n`,
      stderr: "",
      sends: [],
    });
  }, 30_000);

  it("refuses a coordinator blocked on a dialog, sending nothing", () => {
    expect(
      notify(DELEGATE, [{ address: "t5", state: "live" }], { t5: coordinator("blocked") }),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr:
        'refused: t5 is blocked on a dialog, which is the user\'s to answer in "t5"; read it with hc read t5\n',
      sends: [],
    });
  }, 30_000);

  it("refuses the coordinator itself", () => {
    expect(notify({ "fleet.role": "coordinator", "fleet.domain": "app" }, [])).toEqual({
      exit: 1,
      stdout: "",
      stderr:
        "refused: terminal t1 is the coordinator; notify is for delegates, use coordinate send\n",
      sends: [],
    });
  }, 30_000);
});
