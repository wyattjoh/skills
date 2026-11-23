import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { boundaryAdd, createDocument, itemAdd, itemClose, itemUpdate } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { commitFile, g, gitAndFake, initRepo, runWith, tempDir } from "./fixture.ts";
import { domainStatus } from "./status.ts";
import { ok } from "./proc.ts";

const made: string[] = [];
const track = (path: string): string => {
  made.push(path);
  return path;
};
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const liveStatus = async (landed: boolean): Promise<string[]> => {
  const repo = track(initRepo());
  const baseSha = g(repo, "rev-parse", "HEAD");
  const branch = "wyattjoh/live";
  const cwd = join(repo, ".claude", "worktrees", "live");
  g(repo, "worktree", "add", "-q", cwd, "-b", branch);
  if (landed) {
    commitFile(cwd, "feature.txt", "feature\n");
    g(repo, "merge", "-q", "--ff-only", branch);
  }

  const state = track(tempDir());
  const config = await Effect.runPromise(
    resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
  );
  await runWith(createDocument(config, "app"));
  await runWith(
    boundaryAdd(config, "app", {
      path: repo,
      adjacent: false,
      json: false,
      outsideTerminal: false,
    }),
  );

  const listed = {
    address: "t2",
    name: "live",
    agent: "pi",
    state: "live",
    status: "working",
    cwd,
  };
  const terminal = {
    ...listed,
    labels: {
      "fleet.domain": "app",
      "fleet.session": "s-live",
      "fleet.worktree": cwd,
      "fleet.branch": branch,
      "fleet.base": baseSha,
    },
    status: { state: "working" },
  };
  const fake = gitAndFake((argv) => {
    if (argv[0] === "hc" && argv[1] === "ls") return ok(JSON.stringify({ terminals: [listed] }));
    if (argv[0] === "hc" && argv[1] === "get") return ok(JSON.stringify(terminal));
    return ok("{}");
  });
  return runWith(
    domainStatus(config, "app", false, Date.parse("2026-11-18T00:00:00Z")),
    fake.layer,
  );
};

describe("domainStatus discussion requests", () => {
  it("prints a pending discussion summary without treating it as an answer", async () => {
    const state = track(tempDir());
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
    );
    await runWith(createDocument(config, "app"));
    await runWith(
      itemAdd(config, "app", { title: "Choose store", json: false, now: "2026-11-18" }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i1",
        status: "waiting-user",
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: "Which store?",
        context: undefined,
        options: ["sqlite", "json"],
        rec: undefined,
        why: undefined,
        answer: undefined,
        now: "2026-11-18",
        json: false,
      }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i1",
        status: undefined,
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: undefined,
        context: undefined,
        options: [],
        rec: undefined,
        why: undefined,
        answer: "Discuss: compare migrations",
        now: "2026-11-18",
        json: false,
      }),
    );
    const fake = gitAndFake((argv) =>
      argv[0] === "hc" && argv[1] === "ls" ? ok(JSON.stringify({ terminals: [] })) : ok("{}"),
    );
    const lines = await runWith(
      domainStatus(config, "app", false, Date.parse("2026-11-18T00:00:00Z")),
      fake.layer,
    );
    expect(lines).toContain(
      '  discuss i1 Choose store: "Which store?" (2026-11-18; compare migrations)',
    );
    expect(lines.filter((line) => line.includes("answer"))).toEqual([]);
  });
});

describe("domainStatus answer notes", () => {
  it("prints notes from resolved answers", async () => {
    const state = track(tempDir());
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
    );
    await runWith(createDocument(config, "app"));
    await runWith(
      itemAdd(config, "app", { title: "Choose store", json: false, now: "2026-11-18" }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i1",
        status: "waiting-user",
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: "Which store?",
        context: undefined,
        options: ["sqlite"],
        rec: undefined,
        why: undefined,
        answer: undefined,
        now: "2026-11-18",
        json: false,
      }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i1",
        status: undefined,
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: undefined,
        context: undefined,
        options: [],
        rec: undefined,
        why: undefined,
        answer: "sqlite",
        note: "because it is simple",
        now: "2026-11-18",
        json: false,
      }),
    );
    const fake = gitAndFake((argv) =>
      argv[0] === "hc" && argv[1] === "ls" ? ok(JSON.stringify({ terminals: [] })) : ok("{}"),
    );
    const lines = await runWith(
      domainStatus(config, "app", false, Date.parse("2026-11-18T00:00:00Z")),
      fake.layer,
    );
    expect(lines).toContain("  answer note i1 Choose store: because it is simple");
  });
});

describe("domainStatus resume history", () => {
  it("hides closed items unless showDone is enabled", async () => {
    const state = track(tempDir());
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
    );
    await runWith(createDocument(config, "app"));
    await runWith(itemAdd(config, "app", { title: "closed task", json: false, now: "2026-11-18" }));
    await runWith(
      itemClose(config, "app", {
        id: "i1",
        outcome: "finished",
        dismissed: false,
        json: false,
        now: "2026-11-19",
      }),
    );
    const fake = gitAndFake((argv) =>
      argv[0] === "hc" && argv[1] === "ls" ? ok(JSON.stringify({ terminals: [] })) : ok("{}"),
    );
    const hidden = await runWith(
      domainStatus(config, "app", true, Date.parse("2026-11-19T00:00:00Z")),
      fake.layer,
    );
    expect(hidden.join("\n")).toContain(
      `harness policy revision 0 (${join(state, "delegate-harness-policy.json")})`,
    );
    expect(hidden.join("\n")).toContain("1 closed items hidden (coordinate backlog show --done)");
    expect(hidden.filter((line) => line.includes("closed task"))).toEqual([]);

    const shown = await runWith(
      domainStatus(config, "app", true, Date.parse("2026-11-19T00:00:00Z"), true),
      fake.layer,
    );
    expect(shown.join("\n")).toContain("- i1 [done 2026-11-19] closed task: finished");
  });

  it("compacts answered asks in resume output and restores their details with verbose", async () => {
    const state = track(tempDir());
    const config = await Effect.runPromise(
      resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
    );
    await runWith(createDocument(config, "app"));
    await runWith(
      itemAdd(config, "app", { title: "choose store", json: false, now: "2026-11-18" }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i1",
        status: "waiting-user",
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: "Which store?",
        context: "Both options work",
        options: ["sqlite :: embedded", "json :: ready"],
        rec: "json",
        why: "Already in use",
        answer: undefined,
        now: "2026-11-18",
        json: false,
      }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i1",
        status: undefined,
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: undefined,
        context: undefined,
        options: [],
        rec: undefined,
        why: undefined,
        answer: "json",
        note: "because\nit is safe",
        now: "2026-11-19",
        json: false,
      }),
    );
    await runWith(
      itemAdd(config, "app", { title: "pending choice", json: false, now: "2026-11-18" }),
    );
    await runWith(
      itemUpdate(config, "app", {
        id: "i2",
        status: "waiting-user",
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: "Which route?",
        context: "Choose the faster path",
        options: ["direct", "queued"],
        rec: "direct",
        why: "Fastest",
        answer: undefined,
        now: "2026-11-18",
        json: false,
      }),
    );
    const fake = gitAndFake((argv) =>
      argv[0] === "hc" && argv[1] === "ls" ? ok(JSON.stringify({ terminals: [] })) : ok("{}"),
    );
    const compact = await runWith(
      domainStatus(config, "app", true, Date.parse("2026-11-19T00:00:00Z"), false, undefined),
      fake.layer,
    );
    const compactOpen =
      compact.join("\n").split("## Open\n\n")[1]?.split("\n\n## Findings")[0] ?? "";
    expect(compactOpen).toBe(
      [
        "- i1 [waiting-user] choose store",
        "  - answered (2026-11-19): Which store? → json. Note: because it is safe",
        '  - decided 2026-11-19: Re "Which store?": json. Note: because it is safe',
        "- i2 [waiting-user] pending choice",
        "  - ask: Which route?",
        "    - context: Choose the faster path",
        "    - direct (recommended: Fastest)",
        "    - queued",
      ].join("\n"),
    );

    const verbose = await runWith(
      domainStatus(config, "app", true, Date.parse("2026-11-19T00:00:00Z"), false, undefined, true),
      fake.layer,
    );
    const verboseOpen =
      verbose.join("\n").split("## Open\n\n")[1]?.split("\n\n## Findings")[0] ?? "";
    expect(verboseOpen).toBe(
      [
        "- i1 [waiting-user] choose store",
        "  - answered ask (2026-11-19): Which store?",
        "    - context: Both options work",
        "    - json (recommended: Already in use): ready",
        "    - sqlite: embedded",
        "    - answer: json",
        "    - answer note: because\nit is safe",
        '  - decided 2026-11-19: Re "Which store?": json. Note: because it is safe',
        "- i2 [waiting-user] pending choice",
        "  - ask: Which route?",
        "    - context: Choose the faster path",
        "    - direct (recommended: Fastest)",
        "    - queued",
      ].join("\n"),
    );
  });
});

describe("domainStatus branch commits", () => {
  it("reports a live delegate with no commits without calling it landed", async () => {
    const lines = await liveStatus(false);
    expect(lines[1]).toBe(
      "  live t2 working ? · wyattjoh/live · no commits yet · PRs unknown · next: delegate: working",
    );
  });

  it("reports a live delegate with landed commits as ready to sweep", async () => {
    const lines = await liveStatus(true);
    expect(lines[1]).toBe(
      "  live t2 working ? · wyattjoh/live · PRs unknown · landed (ancestor) · next: coordinator: landed, sweep it",
    );
  });
});
