import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FINDING_DETAIL_SHAPE } from "./lib/backlog-store/schema.ts";
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
        "--context",
        "Need to choose a store",
        "--option",
        "sqlite :: embedded",
        "--option",
        "json :: already installed",
        "--rec",
        "json",
        "--why",
        "already in use",
        "--domain",
        "app",
      ]).exit,
    ).toBe(0);
    expect(run(["item", "answer", "i1", "yes", "--note", "one\ntwo", "--domain", "app"]).exit).toBe(
      0,
    );
    const compact = run(["backlog", "show", "--domain", "app"]).stdout;
    expect(compact).toMatch(/  - answered \(\d{4}-\d{2}-\d{2}\): Which\? → yes\. Note: one two/);
    const verbose = run(["backlog", "show", "--verbose", "--domain", "app"]).stdout;
    expect(verbose).toContain("  - answered ask (");
    expect(verbose).toContain("    - context: Need to choose a store");
    expect(verbose).toContain("    - json (recommended: already in use): already installed");
    expect(verbose).toContain("    - sqlite: embedded");
    expect(verbose).toContain("    - answer: yes");
    expect(verbose).toContain("    - answer note: one\ntwo");
    expect(run(["backlog", "show", "--json", "--domain", "app"]).stdout).toBe(
      run(["backlog", "show", "--json", "--verbose", "--domain", "app"]).stdout,
    );

    const compactStatus = run(["status", "--resume", "--domain", "app"]).stdout;
    expect(compactStatus).toMatch(
      /  - answered \(\d{4}-\d{2}-\d{2}\): Which\? → yes\. Note: one two/,
    );
    const verboseStatus = run(["status", "--resume", "--verbose", "--domain", "app"]).stdout;
    expect(verboseStatus).toContain("  - answered ask (");
    expect(verboseStatus).toContain("    - context: Need to choose a store");
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

describe("coordinate CLI harness policy", () => {
  it("accepts an omitted harness flag and refuses when legacy state has no default", () => {
    const state = tempDir("coordinate-harness-cli-");
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
    expect(run(["item", "add", "work", "--domain", "app"]).exit).toBe(0);
    const refused = run([
      "delegate",
      "fix-a",
      "--task",
      "test policy default",
      "--cwd",
      state,
      "--skill",
      "implement",
      "--domain",
      "app",
      "--item",
      "i1",
    ]);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain(
      "refused: no harness was selected for app: pass --harness pi|claude or configure an enabled default with coordinate harness-policy",
    );
    const calls = readFileSync(join(state, "bin", "calls.log"), "utf8").split("\n");
    expect(calls.filter((call) => call.includes("fix-a"))).toEqual([]);
  });
});

describe("coordinate CLI delegate --skill", () => {
  it("refuses coordinate, which only spawn starts with", () => {
    const state = tempDir("coordinate-skill-cli-");
    made.push(state);
    const result = Bun.spawnSync(
      [
        "bun",
        cli,
        "delegate",
        "fix-a",
        "--task",
        "t",
        "--cwd",
        state,
        "--harness",
        "claude",
        "--skill",
        "coordinate",
        "--args",
        "tasks",
        "--domain",
        "app",
        "--item",
        "i1",
      ],
      { env: cliEnv(state, COORDINATOR), stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe(
      "refused: --skill coordinate starts a coordinator, which only coordinate spawn does\n",
    );
    expect(existsSync(join(state, "bin", "calls.log"))).toBe(false);
  });

  it("refuses a name with a leading slash or a space before any launch", () => {
    const state = tempDir("coordinate-skill-name-cli-");
    made.push(state);
    const refused = ["/pr-review", "pr review"].map((skill) => {
      const result = Bun.spawnSync(
        [
          "bun",
          cli,
          "delegate",
          "fix-a",
          "--task",
          "t",
          "--cwd",
          state,
          "--harness",
          "claude",
          "--skill",
          skill,
          "--domain",
          "app",
          "--item",
          "i1",
        ],
        { env: cliEnv(state, COORDINATOR), stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );
      return [result.exitCode, result.stderr.toString()];
    });
    expect(refused).toEqual([
      [
        1,
        'refused: --skill takes a bare skill name such as implement or pr-review, not "/pr-review" (no spaces, no leading /; the script adds the prefix)\n',
      ],
      [
        1,
        'refused: --skill takes a bare skill name such as implement or pr-review, not "pr review" (no spaces, no leading /; the script adds the prefix)\n',
      ],
    ]);
    expect(existsSync(join(state, "bin", "calls.log"))).toBe(false);
  });
});

describe("coordinate CLI spawn", () => {
  const watcherLive = {
    "coordinate.watch-domain=tasks": [{ address: "t-w", state: "live", parent: "t-watch" }],
  };
  const MANAGER = { "fleet.role": "coordinator", "fleet.domain": "manager" };

  it("passes the domain and flags through and prints the started and ready lines", () => {
    const state = tempDir("coordinate-spawn-cli-");
    made.push(state);
    const cwd = join(state, "work");
    mkdirSync(cwd);
    const document = join(state, "backlogs", "tasks.json");
    const result = Bun.spawnSync(
      [
        "bun",
        cli,
        "spawn",
        "tasks",
        "--cwd",
        cwd,
        "--harness",
        "claude",
        "--model",
        "opus",
        "--effort",
        "high",
        "--item",
        "first",
        "--item",
        "second",
      ],
      {
        env: cliEnv(state, MANAGER, undefined, {}, watcherLive),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const stdout = result.stdout.toString();
    const session = /session (\S+)\n/.exec(stdout)?.[1] ?? "";
    expect({ exit: result.exitCode, stdout, stderr: result.stderr.toString() }).toEqual({
      exit: 0,
      stdout: `created backlog ${document}\nowned: added ${cwd}\nadded i1: first\nadded i2: second\nstarted coordinator tasks-coordinator for tasks (t-watch) in its own space sp9, claude session ${session}\nready: tasks-coordinator (t-watch) armed watcher t-w\n`,
      stderr: "",
    });
    const seeded = JSON.parse(readFileSync(document, "utf8"));
    expect({
      owned: seeded.boundary.owned,
      items: seeded.items.map((item: { id: string; title: string; status: string }) => [
        item.id,
        item.title,
        item.status,
      ]),
    }).toEqual({
      owned: [cwd],
      items: [
        ["i1", "first", "open"],
        ["i2", "second", "open"],
      ],
    });
    const calls = readFileSync(join(state, "bin", "calls.log"), "utf8")
      .trim()
      .split("\n");
    const run = calls.find((line) => line.startsWith("run ")) ?? "";
    expect(run.slice(0, run.indexOf(" -- "))).toBe(
      `run --bg --json --name tasks-coordinator --cwd ${cwd} --no-parent --label herdr.space=sp9 --label herdr.tab=tab9 --label fleet.role=coordinator --label fleet.domain=tasks --label fleet.session=${session} --label fleet.harness=claude`,
    );
    expect(
      run.endsWith(
        `claude --session-id ${session} --name tasks-coordinator --model opus --effort high /coordinate tasks`,
      ),
    ).toBe(true);
    expect(readFileSync(join(state, "bin", "app-calls.log"), "utf8")).toBe(
      `do space.new {"name":"tasks","folder":"${cwd}","focus":false}\nls\ndo tab.rename {"id":"tab9","name":"Tasks · No active focus"}\n`,
    );
  });

  it("prints the same fields as JSON with --json", () => {
    const state = tempDir("coordinate-spawn-cli-json-");
    made.push(state);
    const result = Bun.spawnSync(
      ["bun", cli, "spawn", "tasks", "--cwd", state, "--harness", "claude", "--json"],
      {
        env: cliEnv(state, MANAGER, undefined, {}, watcherLive),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const printed = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
    expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(printed).toEqual({
      name: "tasks-coordinator",
      domain: "tasks",
      terminal: "t-watch",
      space: "sp9",
      harness: "claude",
      session: printed.session,
      backlog: {
        path: join(state, "backlogs", "tasks.json"),
        created: true,
        owned: state,
        items: [],
        present: [],
      },
      watcher: "t-w",
      status: "ready",
      timeoutMs: 120_000,
    });
  });

  it("refuses with exit 1 from a plain shell, launching nothing", () => {
    const state = tempDir("coordinate-spawn-cli-shell-");
    made.push(state);
    const env = cliEnv(state, MANAGER);
    delete env.HC_TERMINAL_ID;
    const result = Bun.spawnSync(
      ["bun", cli, "spawn", "tasks", "--cwd", state, "--harness", "claude"],
      { env, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    );
    expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exit: 1,
      stderr:
        "refused: spawn runs from a coordinator terminal, and HC_TERMINAL_ID is unset: this is not a Herdr terminal\n",
    });
    expect(existsSync(join(state, "bin", "calls.log"))).toBe(false);
  });

  it("exits 1 with the last state when the new terminal ends before its watcher is armed", () => {
    const state = tempDir("coordinate-spawn-cli-gone-");
    made.push(state);
    const result = Bun.spawnSync(
      ["bun", cli, "spawn", "tasks", "--cwd", state, "--harness", "claude"],
      {
        env: cliEnv(state, MANAGER, undefined, {
          "t-watch": { address: "t-watch", state: "exited" },
        }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const stdout = result.stdout.toString();
    const session = /session (\S+)\n/.exec(stdout)?.[1] ?? "";
    expect({ exit: result.exitCode, stdout, stderr: result.stderr.toString() }).toEqual({
      exit: 1,
      stdout: `created backlog ${join(state, "backlogs", "tasks.json")}\nowned: added ${state}\nstarted coordinator tasks-coordinator for tasks (t-watch) in its own space sp9, claude session ${session}\nnot ready: tasks-coordinator (t-watch) is gone, it ended before arming its watcher\n`,
      stderr: "",
    });
  });
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
          "labelled t1: fleet.role=coordinator fleet.domain=app\\ncreated backlog <state>/backlogs/app.json\\nwatcher starting (t-watch)\\nharness policy revision 0 (<state>/delegate-harness-policy.json)\\nglobal (legacy): enabled pi, claude; default none\\ndomain app (inherit): enabled pi, claude; default none\\n\\napp: 0 live delegates, 0 ended\\n\\nsweep:\\nnothing to sweep: no worktrees, landed branches, stale scratch or stray processes\\n\\nno delegate of app has been quiet for 24h\\nshort name coordinate unavailable: <state>/home/.local/bin is not on PATH; add it and run coordinate start again\\n",
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
          "app: 0 live delegates, 0 ended\\n\\n# app backlog\\n\\n## Boundary\\n\\n- Owned: (none)\\n- Adjacent: (none)\\n\\n## Policies\\n\\n(none)\\n\\n## Open\\n\\n(none)\\n\\n## Findings\\n\\n(none)\\n\\n## Done\\n\\nharness policy revision 0 (<state>/delegate-harness-policy.json)\\nglobal (legacy): enabled pi, claude; default none\\ndomain app (inherit): enabled pi, claude; default none\\n\\nwatcher starting (t-watch)\\nshort name coordinate unavailable: <state>/home/.local/bin is not on PATH; add it and run coordinate start again\\n",
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
      [
        ["spawn"],
        [
          "domain",
          "--cwd",
          "--harness",
          "--model",
          "--effort",
          "--item",
          "--json",
          "from a coordinator",
        ],
      ],
      [["send"], ["target", "text"]],
      [["notify"], ["text", "one line"]],
      [["end"], ["target", "--now", "--item-status", "--list-idle"]],
      [["resume"], ["name", "--space", "--no-space"]],
      [["status"], ["--domain", "--resume", "--verbose", "--json"]],
      [["verify"], ["delegate", "--ok", "--problem", "--json"]],
      [
        ["backlog", "show"],
        ["--domain", "--json", "--verbose"],
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
      [
        ["finding", "promote"],
        ["id", "--title", "--domain", "--json", "promoted to"],
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

describe("coordinate CLI harness policy", () => {
  it("shows legacy state, uses revision checks, replaces domain policy, and resets to inheritance", () => {
    const state = tempDir("coordinate-harness-policy-cli-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const run = (args: string[], commandEnv = env): Result => {
      const result = Bun.spawnSync(["bun", cli, ...args], {
        env: commandEnv,
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
    const localEnv = { ...env };
    delete localEnv.HC_TERMINAL_ID;
    const legacy = JSON.parse(run(["harness-policy", "show", "--json"], localEnv).stdout);
    expect(legacy.revision).toBe(0);
    expect(legacy.global).toEqual({
      source: "legacy",
      policy: { enabled: ["pi", "claude"], default: null },
      reenabledBy: [],
    });

    const global = run(
      [
        "harness-policy",
        "global-set",
        "--enabled",
        "pi,claude",
        "--no-default",
        "--expected-revision",
        "0",
        "--json",
      ],
      localEnv,
    );
    expect(global.exit).toBe(0);
    expect(JSON.parse(global.stdout).revision).toBe(1);

    const domain = run(
      [
        "harness-policy",
        "domain-set",
        "app",
        "--enabled",
        "claude",
        "--default",
        "claude",
        "--expected-revision",
        "1",
        "--json",
      ],
      localEnv,
    );
    expect(domain.exit).toBe(0);
    expect(JSON.parse(domain.stdout).domain).toEqual({
      name: "app",
      mode: "replace",
      override: { enabled: ["claude"], default: "claude" },
      effective: { enabled: ["claude"], default: "claude" },
      reenabled: [],
    });

    const stale = run(
      [
        "harness-policy",
        "global-set",
        "--enabled",
        "pi",
        "--default",
        "pi",
        "--expected-revision",
        "1",
      ],
      localEnv,
    );
    expect(stale.exit).toBe(1);
    expect(stale.stderr).toContain("refused: stale harness policy revision: expected 1, current 2");

    const reset = run(
      ["harness-policy", "domain-reset", "app", "--expected-revision", "2", "--json"],
      localEnv,
    );
    expect(reset.exit).toBe(0);
    expect(JSON.parse(reset.stdout).domain.mode).toBe("inherit");
    expect(JSON.parse(reset.stdout).revision).toBe(3);
  });
});

// Each call runs from its own folder, removed before the CLI starts: the shell cd's into it,
// removes it, then execs the CLI there. Spawning with a removed `cwd` would fail before the CLI ran.
const fromRemoved = (state: string, env: Record<string, string>) => {
  let calls = 0;
  return (args: string[]): Result => {
    const folder = join(state, `removed-${calls++}`);
    mkdirSync(folder);
    const result = Bun.spawnSync(
      [
        "sh",
        "-c",
        'cd "$1" && rmdir "$1" && shift && exec "$@"',
        "sh",
        folder,
        "bun",
        cli,
        ...args,
      ],
      { cwd: state, env, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    );
    return {
      args,
      exit: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
};

describe("coordinate CLI from a removed current folder", () => {
  it("writes the backlog with every backlog command, resolving the domain from the label", () => {
    const state = tempDir("coordinate-removed-cwd-");
    made.push(state);
    const run = fromRemoved(state, cliEnv(state, COORDINATOR));
    const start = run(["start", "app"]);
    expect(start.exit).toBe(0);
    expect(start.stderr).toBe("");
    expect(readFileSync(join(state, "bin", "calls.log"), "utf8")).toContain(
      `run --bg --json --name watch-app --cwd ${join(state, "home")} `,
    );
    expect(run(["item", "add", "first"]).stdout).toBe("added i1: first\n");
    expect(run(["item", "update", "i1", "--decided", "kept"]).stdout).toBe(
      "updated i1 [open] first\n",
    );
    expect(
      run(["finding", "add", "noticed", "--kind", "issue", "--detail-md", "seen"]).stdout,
    ).toBe("added f2: noticed\n");
    expect(run(["finding", "close", "f2", "--outcome", "acted on"]).stdout).toBe(
      "acted f2: acted on\n",
    );
    expect(run(["backlog", "focus", "steady"]).stdout).toBe("focus: steady\n");
    expect(run(["backlog", "boundary", "add", state]).stdout).toBe(`owned: added ${state}\n`);
    const close = run(["item", "close", "i1", "--outcome", "done"]);
    expect([close.exit, close.stdout, close.stderr]).toEqual([0, "done i1: done\n", ""]);
    expect(run(["status", "--resume"]).exit).toBe(0);

    const backlog = JSON.parse(readFileSync(join(state, "backlogs", "app.json"), "utf8"));
    expect(
      backlog.items.map((item: { id: string; status: string }) => [item.id, item.status]),
    ).toEqual([["i1", "done"]]);
    expect(
      backlog.findings.map((finding: { id: string; status: string }) => [
        finding.id,
        finding.status,
      ]),
    ).toEqual([["f2", "acted"]]);
    expect(backlog.focus).toBe("steady");
    expect(backlog.boundary.owned).toEqual([state]);
  });

  it("exits 2 naming the removed folder when a relative path needs it", () => {
    const state = tempDir("coordinate-removed-cwd-rel-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    const run = fromRemoved(state, env);
    expect(run(["start", "app"]).exit).toBe(0);

    const boundary = run(["backlog", "boundary", "add", "rel/path"]);
    expect([boundary.exit, boundary.stdout, boundary.stderr]).toEqual([
      2,
      "",
      `could not check: MissingFolder: ${join(state, "removed-1")} no longer exists, so the relative path "rel/path" cannot be resolved: cd to an existing folder or pass an absolute path\n`,
    ]);
    expect(
      JSON.parse(readFileSync(join(state, "backlogs", "app.json"), "utf8")).boundary.owned,
    ).toEqual([]);

    writeFileSync(env.COORDINATE_CONFIG, JSON.stringify({ state_dir: "relative-state" }));
    const relativeState = run(["item", "add", "lost"]);
    expect([relativeState.exit, relativeState.stdout, relativeState.stderr]).toEqual([
      2,
      "",
      `could not check: MissingFolder: ${join(state, "removed-2")} no longer exists, so the relative path "relative-state" cannot be resolved: cd to an existing folder or pass an absolute path\n`,
    ]);
  });
});

describe("coordinate CLI verify verdicts and resume counts", () => {
  const ENDED = (cwd: string) => ({
    name: "fix-a",
    domain: "app",
    session: "s-1",
    program: "pi",
    cwd,
    ended_at: "2026-11-20T00:00:00.000Z",
  });
  const setup = (prefix: string) => {
    const state = tempDir(prefix);
    made.push(state);
    const worktree = join(state, "wt");
    mkdirSync(worktree);
    const run = (
      args: string[],
      terminals: Record<string, unknown> = {},
      lists: Record<string, unknown[]> = {},
    ): Result => {
      const done = Bun.spawnSync(["bun", cli, ...args], {
        env: cliEnv(state, COORDINATOR, undefined, terminals, lists),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      });
      return {
        args,
        exit: done.exitCode,
        stdout: done.stdout.toString(),
        stderr: done.stderr.toString(),
      };
    };
    expect(run(["start", "app"]).exit).toBe(0);
    return { state, worktree, run };
  };
  const seedEnded = (state: string, record: Record<string, unknown>) => {
    mkdirSync(join(state, "ended"), { recursive: true });
    writeFileSync(join(state, "ended", `${String(record.session)}.json`), JSON.stringify(record));
  };
  const readEndedFile = (state: string, session: string) =>
    JSON.parse(readFileSync(join(state, "ended", `${session}.json`), "utf8"));
  const stamped = (verdict: { at: string } | null): unknown =>
    verdict === null
      ? null
      : { ...verdict, at: /^\d{4}-\d\d-\d\dT/.test(verdict.at) ? "<iso>" : verdict.at };

  it("records a problem verdict for an ended delegate in its ended record and status --json", () => {
    const { state, worktree, run } = setup("coordinate-verify-ended-");
    seedEnded(state, ENDED(worktree));

    const verified = run(["verify", "fix-a", "--problem", "crossed the push stop point"]);
    expect([verified.exit, verified.stdout, verified.stderr]).toEqual([
      0,
      "recorded problem for fix-a (session s-1): crossed the push stop point\n",
      "",
    ]);
    const record = readEndedFile(state, "s-1");
    expect([stamped(record.verdict), record.resumes]).toEqual([
      { result: "problem", reason: "crossed the push stop point", at: "<iso>" },
      0,
    ]);

    const status = run(["status", "--domain", "app", "--json"]);
    expect([status.exit, status.stderr]).toEqual([0, ""]);
    const parsed = JSON.parse(status.stdout);
    expect(parsed.domain).toBe("app");
    expect(parsed.delegates).toEqual([]);
    expect(
      parsed.ended.map(
        (entry: {
          name: string;
          session: string;
          verdict: { at: string } | null;
          resumes: number;
        }) => [entry.name, entry.session, stamped(entry.verdict), entry.resumes],
      ),
    ).toEqual([
      [
        "fix-a",
        "s-1",
        { result: "problem", reason: "crossed the push stop point", at: "<iso>" },
        0,
      ],
    ]);

    const ok = run(["verify", "fix-a", "--ok", "--json"]);
    expect(ok.exit).toBe(0);
    const okJson = JSON.parse(ok.stdout);
    expect([okJson.session, stamped(okJson.verdict), okJson.resumes]).toEqual([
      "s-1",
      { result: "ok", reason: null, at: "<iso>" },
      0,
    ]);
    expect(stamped(readEndedFile(state, "s-1").verdict)).toEqual({
      result: "ok",
      reason: null,
      at: "<iso>",
    });
  }, 60_000);

  it("refuses an unknown delegate and a verdict that is not exactly one of --ok or --problem", () => {
    const { state, worktree, run } = setup("coordinate-verify-refuse-");
    seedEnded(state, ENDED(worktree));
    const outcomes = [
      run(["verify", "nobody", "--ok"]),
      run(["verify", "fix-a"]),
      run(["verify", "fix-a", "--ok", "--problem", "both"]),
      run(["verify", "fix-a", "--problem", " "]),
    ].map(({ exit, stdout, stderr }) => [exit, stdout, stderr]);
    expect(outcomes).toEqual([
      [
        1,
        "",
        "refused: no delegate nobody: no live delegate terminal or ended record has that name\n",
      ],
      [1, "", 'refused: pass exactly one of --ok or --problem "<why>"\n'],
      [1, "", 'refused: pass exactly one of --ok or --problem "<why>"\n'],
      [1, "", 'refused: --problem needs a reason: --problem "<why>"\n'],
    ]);
    expect(existsSync(join(state, "sessions"))).toBe(false);
  }, 60_000);

  it("records a verdict for a live delegate by name and shows it in status --json", () => {
    const { run } = setup("coordinate-verify-live-");
    const live = {
      address: "t5",
      name: "fix-b",
      state: "live",
      status: { state: "idle" },
      cwd: "/nonexistent/wt",
      labels: {
        "fleet.domain": "app",
        "fleet.session": "s-2",
        "fleet.task": "fix b",
        "fleet.branch": "wyattjoh/fix-b",
      },
    };
    const terminals = { "fix-b": live, t5: live };
    const verified = run(["verify", "fix-b", "--ok"], terminals);
    expect([verified.exit, verified.stdout, verified.stderr]).toEqual([
      0,
      "recorded ok for fix-b (session s-2)\n",
      "",
    ]);
    const status = run(["status", "--domain", "app", "--json"], terminals, {
      "fleet.domain=app": [{ address: "t5", name: "fix-b", state: "live", status: "idle" }],
    });
    expect([status.exit, status.stderr]).toEqual([0, ""]);
    const parsed = JSON.parse(status.stdout);
    expect(
      parsed.delegates.map((entry: { verdict: { at: string } | null }) => ({
        ...entry,
        verdict: stamped(entry.verdict),
      })),
    ).toEqual([
      {
        name: "fix-b",
        address: "t5",
        status: "idle",
        session: "s-2",
        task: "fix b",
        cwd: "/nonexistent/wt",
        machine: null,
        branch: "wyattjoh/fix-b",
        verdict: { result: "ok", reason: null, at: "<iso>" },
        resumes: 0,
      },
    ]);
    expect(parsed.ended).toEqual([]);
  }, 60_000);

  it("counts each resume of a session across end and resume, in ended records and status", () => {
    const { state, worktree, run } = setup("coordinate-resume-count-");
    seedEnded(state, ENDED(worktree));
    const launched = {
      address: "t-watch",
      name: "fix-a",
      state: "live",
      status: { state: "idle" },
      labels: {},
    };
    const running = {
      ...launched,
      cwd: worktree,
      labels: {
        "fleet.domain": "app",
        "fleet.session": "s-1",
        "fleet.harness": "pi",
        "fleet.worktree": worktree,
      },
    };
    const resume = () => run(["resume", "fix-a", "--no-space"], { "t-watch": launched });
    const end = () => run(["end", "fix-a"], { "fix-a": running });

    const first = resume();
    expect([first.exit, first.stdout, first.stderr]).toEqual([
      0,
      'resumed fix-a in t-watch (resume 1 of session s-1)\nsend it what arrived: coordinate send fix-a "<message>"\n',
      "",
    ]);
    expect(end().exit).toBe(0);
    expect(readEndedFile(state, "s-1").resumes).toBe(1);
    expect(run(["verify", "fix-a", "--problem", "needed a second resume"]).exit).toBe(0);
    expect(resume().stdout).toBe(
      'resumed fix-a in t-watch (resume 2 of session s-1)\nsend it what arrived: coordinate send fix-a "<message>"\n',
    );
    expect(end().exit).toBe(0);
    const record = readEndedFile(state, "s-1");
    expect([record.resumes, stamped(record.verdict)]).toEqual([
      2,
      { result: "problem", reason: "needed a second resume", at: "<iso>" },
    ]);
    const parsed = JSON.parse(run(["status", "--domain", "app", "--json"]).stdout);
    expect(
      parsed.ended.map(
        (entry: { name: string; verdict: { at: string } | null; resumes: number }) => [
          entry.name,
          stamped(entry.verdict),
          entry.resumes,
        ],
      ),
    ).toEqual([["fix-a", { result: "problem", reason: "needed a second resume", at: "<iso>" }, 2]]);
    const text = run(["status", "--domain", "app"]).stdout;
    expect(text.split("\n")[1]).toBe(
      `  fix-a ended ${record.ended_at.slice(0, 10)} · no branch · problem: needed a second resume · resumed 2x · resume: coordinate resume fix-a`,
    );
  }, 60_000);

  it("names another machine beside an ended remote delegate, never this one", () => {
    const { state, worktree, run } = setup("coordinate-status-machine-");
    seedEnded(state, { ...ENDED(worktree), machine: "fake-core" });
    seedEnded(state, {
      ...ENDED("/home/someone/app/.claude/worktrees/fix-r"),
      name: "fix-r",
      session: "s-2",
      machine: "strix",
    });
    const text = run(["status", "--domain", "app"]).stdout;
    expect(text.split("\n").slice(1, 3)).toEqual([
      "  fix-a ended 2026-11-20 · no branch · resume: coordinate resume fix-a",
      "  fix-r [strix] ended 2026-11-20 · no branch · resume: coordinate resume fix-r",
    ]);
    const parsed = JSON.parse(run(["status", "--domain", "app", "--json"]).stdout);
    expect(
      parsed.ended.map((entry: { name: string; machine: string | null }) => [
        entry.name,
        entry.machine,
      ]),
    ).toEqual([
      ["fix-a", null],
      ["fix-r", "strix"],
    ]);
  }, 60_000);
});

describe("coordinate CLI finding add --source", () => {
  it("stores the source and shows it in backlog show and --json", () => {
    const state = tempDir("coordinate-finding-source-");
    made.push(state);
    const run = (args: string[]): Result => {
      const done = Bun.spawnSync(["bun", cli, ...args], {
        env: cliEnv(state, COORDINATOR),
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
    const added = run([
      "finding",
      "add",
      "brief the push stop point",
      "--kind",
      "opportunity",
      "--source",
      "retro:fix-a",
      "--detail-md",
      "**What** the brief omits the push stop point",
      "--domain",
      "app",
      "--json",
    ]);
    expect([added.exit, added.stderr]).toEqual([0, ""]);
    expect(JSON.parse(added.stdout)).toEqual({
      id: "f1",
      kind: "opportunity",
      title: "brief the push stop point",
      detail: null,
      detailMarkdown: "**What** the brief omits the push stop point",
      path: null,
      from: null,
      source: "retro:fix-a",
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      status: "open",
      closedAt: null,
      outcome: null,
    });
    expect(
      run(["finding", "add", "plain", "--kind", "issue", "--detail", "text", "--domain", "app"])
        .stdout,
    ).toBe("added f2: plain\n");
    const shown = run(["backlog", "show", "--domain", "app"]);
    expect(shown.stdout.split("\n").filter((line) => line.startsWith("- f"))).toEqual([
      "- f1 [opportunity] brief the push stop point (source retro:fix-a)",
      "- f2 [issue] plain",
    ]);
    const json = JSON.parse(run(["backlog", "show", "--domain", "app", "--json"]).stdout);
    expect(
      json.findings.map((finding: { id: string; source?: string }) => [finding.id, finding.source]),
    ).toEqual([
      ["f1", "retro:fix-a"],
      ["f2", undefined],
    ]);
    const empty = run([
      "finding",
      "add",
      "blank",
      "--kind",
      "issue",
      "--source",
      " ",
      "--detail-md",
      "seen",
      "--domain",
      "app",
    ]);
    expect([empty.exit, empty.stdout, empty.stderr]).toEqual([1, "", "refused: source is empty\n"]);
  });
});

describe("coordinate CLI finding add detail", () => {
  it("refuses a finding without a detail, accepts either form, and names the shape in --help", () => {
    const state = tempDir("coordinate-finding-detail-");
    made.push(state);
    const run = (args: string[]): Result => {
      const done = Bun.spawnSync(["bun", cli, ...args], {
        env: cliEnv(state, COORDINATOR),
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
    const bare = run(["finding", "add", "bare", "--kind", "issue", "--domain", "app"]);
    expect([bare.exit, bare.stdout, bare.stderr]).toEqual([
      1,
      "",
      `refused: a finding needs a detail: pass --detail-md with ${FINDING_DETAIL_SHAPE}\n`,
    ]);
    const blank = run(["finding", "add", "blank", "--kind", "issue", "--detail-md", " "]);
    expect([blank.exit, blank.stderr]).toEqual([1, "refused: --detail-md is empty\n"]);
    const detail = [
      "**What** the gate hangs",
      "**Where** `bun test`",
      "**Why it matters** blocks landing",
      "**Suggested fix** add a timeout",
    ].join("\n");
    expect(run(["finding", "add", "md", "--kind", "issue", "--detail-md", detail]).stdout).toBe(
      "added f1: md\n",
    );
    expect(run(["finding", "add", "text", "--kind", "issue", "--detail", "it hangs"]).stdout).toBe(
      "added f2: text\n",
    );
    const json = JSON.parse(run(["backlog", "show", "--json"]).stdout);
    expect(
      json.findings.map((finding: { detail: string | null; detailMarkdown?: string }) => [
        finding.detail,
        finding.detailMarkdown,
      ]),
    ).toEqual([
      [null, detail],
      ["it hangs", undefined],
    ]);
    const help = run(["finding", "add", "--help"]);
    expect(help.exit).toBe(0);
    expect(`${help.stdout}\n${help.stderr}`.replace(/\s+/g, " ")).toContain(FINDING_DETAIL_SHAPE);
  });
});

describe("coordinate CLI read-only queue and outbox views", () => {
  it("shows capacity entries with per-machine positions and undelivered events, writing nothing", () => {
    const state = tempDir("coordinate-queue-outbox-cli-");
    made.push(state);
    const env = cliEnv(state, COORDINATOR);
    delete env.HC_TERMINAL_ID;
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
    const empty = [
      run(["queue", "show", "--domain", "app", "--json"]),
      run(["watch", "outbox", "--domain", "app", "--json"]),
      run(["queue", "show", "--domain", "app"]),
      run(["watch", "outbox", "--domain", "app"]),
    ].map((result) => [result.exit, result.stdout]);
    expect(empty).toEqual([
      [0, '{"domain":"app","entries":[]}\n'],
      [0, '{"domain":"app","events":[]}\n'],
      [0, "no items queued for capacity in app\n"],
      [0, "no undelivered watcher events in app\n"],
    ]);
    expect([existsSync(join(state, "capacity")), existsSync(join(state, "watch"))]).toEqual([
      false,
      false,
    ]);

    mkdirSync(join(state, "capacity"));
    const queue = JSON.stringify({
      version: 1,
      nextOrder: 4,
      entries: [
        { item: "i3", machine: "local", order: 1 },
        { item: "i5", machine: "box", order: 2 },
        { item: "i7", machine: "local", order: 3 },
      ],
    });
    writeFileSync(join(state, "capacity", "app.json"), queue);
    mkdirSync(join(state, "watch"));
    const watchState = JSON.stringify({
      outbox: [
        {
          id: "4",
          kind: "settled",
          attrs: { delegate: "fix", address: "t9" },
          fields: { title: "Fix it", wiki: ["a", "b"] },
          text: "verify the report",
        },
        { id: "5", line: "an old line" },
      ],
      nextEventId: 6,
    });
    writeFileSync(join(state, "watch", "app.json"), watchState);

    expect(JSON.parse(run(["queue", "show", "--domain", "app", "--json"]).stdout)).toEqual({
      domain: "app",
      entries: [
        { item: "i3", machine: "local", order: 1, position: 1 },
        { item: "i5", machine: "box", order: 2, position: 1 },
        { item: "i7", machine: "local", order: 3, position: 2 },
      ],
    });
    expect(run(["queue", "show", "--domain", "app"]).stdout).toBe(
      [
        "i3 on local, #1 in that machine's queue",
        "i5 on box, #1 in that machine's queue",
        "i7 on local, #2 in that machine's queue",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(run(["watch", "outbox", "--domain", "app", "--json"]).stdout)).toEqual({
      domain: "app",
      events: [
        {
          id: "4",
          kind: "settled",
          attrs: { delegate: "fix", address: "t9" },
          fields: { title: "Fix it", wiki: ["a", "b"] },
          text: "verify the report",
        },
        { id: "5", kind: "legacy", attrs: {}, fields: {}, text: "an old line" },
      ],
    });
    expect(run(["watch", "outbox", "--domain", "app"]).stdout).toBe(
      "e4 settled fix t9 Fix it a b: verify the report\ne5 legacy: an old line\n",
    );
    expect([
      readFileSync(join(state, "capacity", "app.json"), "utf8"),
      readFileSync(join(state, "watch", "app.json"), "utf8"),
    ]).toEqual([queue, watchState]);

    const bad = run(["queue", "show", "--domain", "../x", "--json"]);
    expect(bad.exit).toBe(1);

    // The outbox subcommand leaves the watch loop's own flags reaching its handler.
    const deliver = run(["watch", "--deliver", "--domain", "app"]);
    expect([deliver.exit, deliver.stderr]).toEqual([
      1,
      "refused: watch --deliver requires explicit --domain <domain> and --owner <coordinator address>\n",
    ]);
    const arm = run(["watch", "--arm", "--domain", "app"]);
    expect([arm.exit, arm.stderr]).toEqual([
      1,
      "refused: HC_TERMINAL_ID is unset: run this in the coordinator terminal\n",
    ]);
  });
});
