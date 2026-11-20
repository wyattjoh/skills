import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, tempDir } from "./lib/fixture.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const cli = process.env.COORDINATE_CLI ?? join(import.meta.dir, "coordinate.ts");
const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };

type Result = {
  args: string[];
  exit: number;
  stdout: string;
  stderr: string;
};

describe("coordinate CLI answer notes", () => {
  it("accepts notes for answer and update, renders them, and preserves Discuss", () => {
    const state = tempDir("coordinate-note-cli-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const run = (args: string[]): Result => {
      const result = Bun.spawnSync(["bun", cli, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return {
        args,
        exit: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    expect(run(["start", "app"]).exit).toBe(0);
    expect(run(["item", "add", "choose", "--domain", "app"]).exit).toBe(0);
    expect(
      run([
        "item",
        "update",
        "i1",
        "--status",
        "waiting-user",
        "--ask",
        "Which?",
        "--domain",
        "app",
      ]).exit,
    ).toBe(0);
    expect(run(["item", "answer", "i1", "yes", "--note", "one\ntwo", "--domain", "app"]).exit).toBe(
      0,
    );
    expect(run(["backlog", "show", "--domain", "app"]).stdout).toContain("answer note: one\ntwo");
    expect(run(["item", "update", "i1", "--ask", "Again?", "--domain", "app"]).exit).toBe(0);
    expect(
      run(["item", "update", "i1", "--answer", "Discuss", "--note", "talk more", "--domain", "app"])
        .exit,
    ).toBe(0);
    const shown = run(["backlog", "show", "--domain", "app"]).stdout;
    expect(shown).toContain("discussion requested");
    expect(shown).toContain("talk more");
  });
});

describe("coordinate CLI Done history", () => {
  it("hides closed items from text views unless --done and keeps JSON unchanged", () => {
    const state = tempDir("coordinate-done-cli-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const run = (args: string[]): string => {
      const result = Bun.spawnSync(["bun", cli, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };

    run(["start", "app"]);
    run(["item", "add", "closed task", "--domain", "app"]);
    run(["item", "close", "i1", "--outcome", "finished", "--domain", "app"]);
    const closedDate = new Date().toISOString().slice(0, 10);

    const backlog = run(["backlog", "show", "--domain", "app"]);
    expect(backlog.split("## Done\n\n")[1]).toBe(
      "1 closed items hidden (coordinate backlog show --done)\n",
    );
    const backlogWithDone = run(["backlog", "show", "--done", "--domain", "app"]);
    expect(backlogWithDone.split("## Done\n\n")[1]).toBe(
      `- i1 [done ${closedDate}] closed task: finished\n`,
    );

    const status = run(["status", "--resume", "--domain", "app"]);
    expect(status).toContain("1 closed items hidden (coordinate backlog show --done)");
    const statusWithDone = run(["status", "--resume", "--done", "--domain", "app"]);
    expect(statusWithDone).toContain(`- i1 [done ${closedDate}] closed task: finished`);

    const document = JSON.parse(run(["backlog", "show", "--json", "--done", "--domain", "app"]));
    expect(document.items[0].status).toBe("done");
  }, 30_000);
});

describe("coordinate CLI parity", () => {
  it("records representative invocations across every command", () => {
    const state = tempDir("coordinate-cli-parity-");
    made.push(state);
    const other = join(state, "other");
    mkdirSync(other);
    const run = (
      args: string[],
      labels: Record<string, string> = COORDINATOR,
      terminals: Record<string, unknown> = {},
      terminalId = true,
    ): Result => {
      const env = cliEnv(state, labels, undefined, terminals);
      if (!terminalId) delete env.HC_TERMINAL_ID;
      const done = Bun.spawnSync(["bun", cli, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return {
        args,
        exit: done.exitCode,
        stdout: done.stdout.toString(),
        stderr: done.stderr.toString(),
      };
    };

    const results = [
      run(["start", "app"]),
      run([
        "delegate",
        "fix-a",
        "--task",
        "check parser",
        "--harness",
        "pi",
        "--model",
        "test/model",
        "--effort",
        "low",
        "--skill",
        "implement",
        "--args",
        "--verbose",
        "--domain",
        "app",
        "--item",
        "i1",
        "--over-budget",
        "--no-space",
      ]),
      run(["send", "gone", "--", "--text"], COORDINATOR, {
        gone: { address: "gone", name: "gone", state: "ended", labels: {} },
      }),
      run(["notify", "done, report at /tmp/report"], { "fleet.domain": "app" }),
      run(["end", "t1", "--now", "--item-status", "parked"]),
      run(["resume", "missing", "--no-space"]),
      run(["status", "--domain", "app", "--resume"]),
      run(["backlog", "show", "--domain", "app", "--json"]),
      run(["backlog", "rename", "app", "--domain", "app", "--json"]),
      run(["backlog", "boundary", "add", state, "--adjacent", "--domain", "app", "--json"]),
      run(["backlog", "boundary", "rm", state, "--adjacent", "--domain", "app", "--json"]),
      run([
        "backlog",
        "standing",
        "add",
        "ship it",
        "--at",
        "2026-11-19",
        "--domain",
        "app",
        "--json",
      ]),
      run(["backlog", "focus", "parser parity", "--domain", "app"]),
      run(["backlog", "focus", "--clear", "--domain", "app", "--json"]),
      run(["item", "add", "fix parser", "--domain", "app"]),
      run([
        "delegate",
        "fix-b",
        "--task",
        "check cwd",
        "--harness",
        "claude",
        "--model",
        "claude-sonnet",
        "--effort",
        "low",
        "--brief",
        join(state, "brief.md"),
        "--cwd",
        join(state, "missing"),
        "--domain",
        "app",
        "--item",
        "i1",
        "--over-budget",
      ]),
      run([
        "delegate",
        "fix-c",
        "--task",
        "check repo",
        "--harness",
        "pi",
        "--repo",
        state,
        "--base",
        "main",
        "--brief",
        join(state, "brief.md"),
        "--domain",
        "app",
        "--item",
        "i1",
      ]),
      run([
        "item",
        "update",
        "i1",
        "--status",
        "waiting-user",
        "--decided",
        "first decision",
        "--decided",
        "second decision",
        "--touch",
        state,
        "--touch",
        other,
        "--due",
        "2026-12-01",
        "--no-due",
        "--ask",
        "which provider?",
        "--context",
        "migration",
        "--option",
        "-none-",
        "--option",
        "okta",
        "--option",
        "a :: b",
        "--rec",
        "a",
        "--why",
        "approved provider",
        "--domain",
        "app",
      ]),
      run(["item", "update", "i1", "--untouch", other, "--domain", "app"]),
      run(["item", "answer", "--domain", "app", "--", "i1", "-none-"], {}, {}, false),
      run(["item", "add", "close me", "--domain", "app"]),
      run(["item", "close", "i2", "--outcome", "not needed", "--dismissed", "--domain", "app"]),
      run(["item", "attach", "i1", "t1", "--session", "session-1", "--domain", "app", "--json"]),
      run(["item", "detach", "i1", "missing", "--domain", "app", "--json"]),
      run([
        "finding",
        "add",
        "ignored option",
        "--kind",
        "issue",
        "--detail",
        "preserve this flag",
        "--path",
        state,
        "--from",
        "i1",
        "--domain",
        "app",
      ]),
      run(["finding", "close", "f3", "--outcome", "documented", "--dismissed", "--domain", "app"]),
      run([
        "watch",
        "--domain",
        "app",
        "--interval",
        "1",
        "--forge-interval",
        "2",
        "--max-minutes",
        "0",
        "--replace",
      ]),
      run([
        "sweep",
        "report",
        "--domain",
        "app",
        "--base",
        "main",
        "--base",
        "trunk",
        "--keep",
        state,
        "--keep",
        other,
        "--sizes",
      ]),
      run([
        "sweep",
        "remove",
        "--all-safe",
        "--repo",
        state,
        "--repo",
        other,
        "--base",
        "main",
        "--base",
        "trunk",
        "--domain",
        "app",
      ]),
      run([
        "sweep",
        "prune-branches",
        state,
        "unlanded",
        "another",
        "--list",
        "--base",
        "main",
        "--base",
        "trunk",
      ]),
      run(["sweep", "prune-ended"]),
    ];

    const observed = results.map(({ exit, stdout, stderr }) => ({
      exit,
      stdout: stdout.replaceAll(state, "<state>").replaceAll("\n", "\\n"),
      stderr: stderr.replaceAll(state, "<state>").replaceAll("\n", "\\n"),
    }));
    expect(observed).toEqual([
      {
        exit: 0,
        stdout:
          "labelled t1: fleet.role=coordinator fleet.domain=app\\ncreated backlog <state>/backlogs/app.json\\nwatcher starting (t-watch)\\n\\napp: 0 live delegates, 0 ended\\n\\nsweep:\\nnothing to sweep: no worktrees, landed branches, stale scratch or stray processes\\n\\nno delegate of app has been quiet for 24h\\n",
        stderr: "",
      },
      {
        exit: 1,
        stdout: "",
        stderr:
          "refused: pass exactly one of --repo (new worktree) or --cwd (a folder with no repo work)\\n",
      },
      { exit: 1, stdout: "", stderr: "refused: no live terminal gone\\n" },
      {
        exit: 0,
        stdout: "no live coordinator for app; nothing sent: done, report at /tmp/report\\n",
        stderr: "",
      },
      { exit: 1, stdout: "", stderr: "refused: t1 is a coordinator\\n" },
      {
        exit: 1,
        stdout: "",
        stderr: "refused: no ended record for missing in <state>/ended\\n",
      },
      {
        exit: 0,
        stdout:
          "app: 0 live delegates, 0 ended\\n\\n# app backlog\\n\\n## Boundary\\n\\n- Owned: (none)\\n- Adjacent: (none)\\n\\n## Policies\\n\\n(none)\\n\\n## Open\\n\\n(none)\\n\\n## Findings\\n\\n(none)\\n\\n## Done\\n\\nwatcher starting (t-watch)\\n",
        stderr: "",
      },
      {
        exit: 0,
        stdout:
          '{\\n  "schemaVersion": 1,\\n  "domain": "app",\\n  "focus": null,\\n  "legacy": null,\\n  "boundary": {\\n    "owned": [],\\n    "adjacent": []\\n  },\\n  "policies": [],\\n  "items": [],\\n  "findings": [],\\n  "nextId": 1,\\n  "nextPolicyId": 1\\n}\\n',
        stderr: "",
      },
      { exit: 1, stdout: "", stderr: "refused: app is already named app\\n" },
      {
        exit: 0,
        stdout: '{\\n  "owned": [],\\n  "adjacent": [\\n    "<state>"\\n  ]\\n}\\n',
        stderr: "",
      },
      {
        exit: 0,
        stdout: '{\\n  "owned": [],\\n  "adjacent": []\\n}\\n',
        stderr: "",
      },
      {
        exit: 0,
        stdout: '{\\n  "id": "p1",\\n  "text": "ship it",\\n  "at": "2026-11-19"\\n}\\n',
        stderr: "",
      },
      { exit: 0, stdout: "focus: parser parity\\n", stderr: "" },
      { exit: 0, stdout: '{\\n  "focus": null\\n}\\n', stderr: "" },
      { exit: 0, stdout: "added i1: fix parser\\n", stderr: "" },
      { exit: 1, stdout: "", stderr: "refused: <state>/missing does not exist\\n" },
      { exit: 1, stdout: "", stderr: "refused: <state> is not a Git checkout\\n" },
      { exit: 0, stdout: "updated i1 [waiting-user] fix parser\\n", stderr: "" },
      { exit: 0, stdout: "updated i1 [waiting-user] fix parser\\n", stderr: "" },
      { exit: 0, stdout: "updated i1 [waiting-user] fix parser\\n", stderr: "" },
      { exit: 0, stdout: "added i2: close me\\n", stderr: "" },
      { exit: 0, stdout: "dismissed i2: not needed\\n", stderr: "" },
      { exit: 1, stdout: "", stderr: "refused: t1 is a coordinator, not a delegate\\n" },
      { exit: 1, stdout: "", stderr: "refused: i1 has no delegate missing\\n" },
      { exit: 0, stdout: "added f3: ignored option\\n", stderr: "" },
      { exit: 0, stdout: "dismissed f3: documented\\n", stderr: "" },
      { exit: 0, stdout: "alive: no events in 0m; re-arm the watcher\\n", stderr: "" },
      {
        exit: 0,
        stdout:
          "nothing to sweep: no worktrees, landed branches, stale scratch or stray processes\\n",
        stderr: "",
      },
      {
        exit: 1,
        stdout: "",
        stderr: "refused: <state> is not a Git checkout\\n",
      },
      {
        exit: 1,
        stdout: "",
        stderr: "refused: <state> is not a Git checkout\\n",
      },
      { exit: 0, stdout: "pruned 0 of 0 ended records whose folder is gone\\n", stderr: "" },
    ]);

    const helpCases: Array<[string[], string[]]> = [
      [["start"], ["domain", "label this terminal"]],
      [["delegate"], ["name", "--task", "--harness", "--no-space"]],
      [["send"], ["target", "text"]],
      [["notify"], ["text", "one line"]],
      [["end"], ["target", "--now", "--item-status", "--list-idle"]],
      [["resume"], ["name", "--space", "--no-space"]],
      [["status"], ["--domain", "--resume"]],
      [
        ["backlog", "show"],
        ["--domain", "--json"],
      ],
      [
        ["backlog", "rename"],
        ["new", "--domain", "--json"],
      ],
      [
        ["backlog", "boundary", "add"],
        ["path", "--adjacent", "--json"],
      ],
      [
        ["backlog", "boundary", "rm"],
        ["path", "--adjacent", "--json"],
      ],
      [["backlog"], ["policy", "boundary", "focus"]],
      [
        ["backlog", "policy", "add"],
        ["text", "--at", "--domain"],
      ],
      [
        ["backlog", "policy", "ls"],
        ["--domain", "--json"],
      ],
      [
        ["backlog", "policy", "rm"],
        ["id", "--domain", "--json"],
      ],
      [
        ["backlog", "policy", "replace"],
        ["id", "text", "--at", "--domain", "--json"],
      ],
      [
        ["backlog", "focus"],
        ["text", "--clear", "--json"],
      ],
      [
        ["item", "add"],
        ["title", "--domain", "--json"],
      ],
      [
        ["item", "update"],
        [
          "id",
          "--status",
          "--decided",
          "--untouch",
          "--no-due",
          "--answer",
          "optionally '<label> :: <detail>'",
          "recommended option label",
          "Discuss",
        ],
      ],
      [
        ["item", "answer"],
        ["id", "answer", "--domain", "--json", "Discuss"],
      ],
      [
        ["item", "close"],
        ["id", "--outcome", "--dismissed", "--json"],
      ],
      [
        ["item", "attach"],
        ["id", "delegate", "--session", "--json"],
      ],
      [
        ["item", "detach"],
        ["id", "delegate", "--domain", "--json"],
      ],
      [
        ["finding", "add"],
        ["title", "--kind", "--detail", "--from"],
      ],
      [
        ["finding", "close"],
        ["id", "--outcome", "--dismissed", "--json"],
      ],
      [["watch"], ["--interval", "--forge-interval", "--max-minutes", "--follow", "--replace"]],
      [
        ["sweep", "report"],
        ["repos", "--base", "--keep", "--sizes"],
      ],
      [
        ["sweep", "remove"],
        ["worktrees", "--all-safe", "--repo", "--base"],
      ],
      [
        ["sweep", "prune-branches"],
        ["repo", "branches", "--list", "--base"],
      ],
      [["sweep", "prune-ended"], ["delete ended-delegate records"]],
    ];
    for (const [path, markers] of helpCases) {
      const args = [...path, "--help"];
      const result = run(args);
      expect({ args, exit: result.exit }).toEqual({ args, exit: 0 });
      const help = `${result.stdout}\n${result.stderr}`.replace(/\s+/g, " ");
      for (const marker of markers) expect(help).toContain(marker);
    }
    const backlogHelp = run(["backlog", "--help"]);
    const visibleBacklogHelp = `${backlogHelp.stdout}\n${backlogHelp.stderr}`;
    expect(backlogHelp.exit).toBe(0);
    expect(visibleBacklogHelp.match(/\bstanding\b/gi) ?? []).toEqual([]);

    const shortHelp = run(["start", "-h"]);
    expect(shortHelp.exit).toBe(0);
    expect(shortHelp.stdout).toContain("label this terminal");
  }, 60_000);
});

describe("coordinate Discuss answers", () => {
  it("keeps the ask open through both answer commands and clears discussion on revision or answer", () => {
    const state = tempDir("coordinate-discuss-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const run = (args: string[]): Result => {
      const done = Bun.spawnSync(["bun", cli, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return {
        args,
        exit: done.exitCode,
        stdout: done.stdout.toString(),
        stderr: done.stderr.toString(),
      };
    };

    expect(run(["start", "app"]).exit).toBe(0);
    expect(run(["item", "add", "pick a store", "--domain", "app"]).exit).toBe(0);
    expect(
      run([
        "item",
        "update",
        "i1",
        "--status",
        "waiting-user",
        "--ask",
        "Which store?",
        "--option",
        "A",
        "--option",
        "B",
        "--domain",
        "app",
      ]).exit,
    ).toBe(0);

    expect(
      run(["item", "answer", "--domain", "app", "i1", "Discuss: compare migrations"]).exit,
    ).toBe(0);
    const path = join(state, "backlogs", "app.json");
    const discussedByAnswer = JSON.parse(readFileSync(path, "utf8")).items[0];
    expect(discussedByAnswer.status).toBe("waiting-user");
    expect(discussedByAnswer.ask.discuss.note).toBe("compare migrations");
    expect(discussedByAnswer.ask.discuss.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(discussedByAnswer.answered).toEqual([]);

    expect(
      run([
        "item",
        "update",
        "i1",
        "--status",
        "waiting-user",
        "--ask",
        "Revised question?",
        "--option",
        "C",
        "--domain",
        "app",
      ]).exit,
    ).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).items[0].ask.discuss).toBe(null);

    expect(run(["item", "update", "i1", "--answer", "Discuss", "--domain", "app"]).exit).toBe(0);
    const discussedByUpdate = JSON.parse(readFileSync(path, "utf8")).items[0];
    expect(discussedByUpdate.status).toBe("waiting-user");
    expect(discussedByUpdate.ask.discuss.note).toBe("");
    expect(discussedByUpdate.answered).toEqual([]);

    expect(run(["item", "answer", "--domain", "app", "i1", "C"]).exit).toBe(0);
    const answered = JSON.parse(readFileSync(path, "utf8")).items[0];
    expect(answered.ask).toBe(null);
    expect(answered.answered[0]).toMatchObject({ discuss: null, answer: "C" });
  }, 60_000);
});

describe("coordinate watch delivery", () => {
  it("requires explicit domain and owner flags instead of inferring them from the child terminal", () => {
    const state = tempDir("coordinate-watch-cli-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const run = (args: string[]): Result => {
      const result = Bun.spawnSync(["bun", cli, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return {
        args,
        exit: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };

    expect(run(["watch", "--deliver"]).exit).toBe(1);
    expect(run(["watch", "--deliver", "--domain", "app"]).stderr).toBe(
      "refused: watch --deliver requires explicit --domain <domain> and --owner <coordinator address>\n",
    );
    expect(run(["watch", "--deliver", "--owner", "t1"]).stderr).toBe(
      "refused: watch --deliver requires explicit --domain <domain> and --owner <coordinator address>\n",
    );
  });
});

describe("coordinate status --resume", () => {
  it("does not arm a watcher before validating that the domain has a backlog", () => {
    const state = tempDir("coordinate-status-resume-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const result = Bun.spawnSync(["bun", cli, "status", "--resume", "--domain", "app"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      `refused: no backlog for app at ${join(state, "backlogs", "app.json")}; run coordinate start app\n`,
    );
    expect(existsSync(join(state, "bin", "calls.log"))).toBe(false);
  });
});
