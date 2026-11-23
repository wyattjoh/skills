import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, g, initRepo, tempDir } from "./lib/fixture.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const cli = process.env.COORDINATE_CLI ?? join(import.meta.dir, "coordinate.ts");

type Result = { exit: number; stdout: string; stderr: string };

const sandbox = (domain = "app") => {
  const state = tempDir("coordinate-wiki-cli-");
  made.push(state);
  const env = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": domain });
  const run = (args: string[]): Result => {
    const result = Bun.spawnSync(["bun", cli, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    return {
      exit: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  return { state, env, run };
};

const log = (dir: string): string[] => g(dir, "log", "--format=%s").split("\n");

describe("coordinate wiki path", () => {
  it("creates and git-initializes the domain wiki once and prints its path", () => {
    const { state, run } = sandbox();
    const first = run(["wiki", "path"]);
    expect(first).toEqual({ exit: 0, stdout: `${state}/wiki/app\n`, stderr: "" });
    const wiki = join(state, "wiki", "app");
    expect(readFileSync(join(wiki, "index.md"), "utf8")).toBe("# app wiki\n");
    expect(readFileSync(join(wiki, ".gitignore"), "utf8")).toBe(".scratch/\n");
    expect(log(wiki)).toEqual(["start the app wiki"]);
    expect(run(["wiki", "path"]).stdout).toBe(`${wiki}\n`);
    expect(log(wiki)).toEqual(["start the app wiki"]);
    expect(JSON.parse(run(["wiki", "path", "--json"]).stdout)).toEqual({
      domain: "app",
      shared: false,
      path: wiki,
    });
  }, 30_000);

  it("lets only the manager coordinator create the shared wiki", () => {
    const app = sandbox();
    const refused = app.run(["wiki", "path", "--shared"]);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain(
      `refused: there is no shared wiki at ${app.state}/wiki/_shared yet; only the manager coordinator creates and writes it\n`,
    );
    const manager = sandbox("manager");
    const shared = join(manager.state, "wiki", "_shared");
    expect(manager.run(["wiki", "path", "--shared"]).stdout).toBe(`${shared}\n`);
    expect(log(shared)).toEqual(["start the shared wiki"]);
    expect(readFileSync(join(shared, "index.md"), "utf8")).toBe("# shared wiki\n");
  }, 30_000);

  it("prints an existing shared wiki's path to any coordinator for reading", () => {
    const app = sandbox();
    mkdirSync(join(app.state, "wiki", "_shared"), { recursive: true });
    expect(app.run(["wiki", "path", "--shared"])).toEqual({
      exit: 0,
      stdout: `${app.state}/wiki/_shared\n`,
      stderr: "",
    });
  }, 30_000);
});

const page = (fields: Record<string, unknown>, body: string): string =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n\n${body}`;

const fields = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `about ${name}`,
  type: "subsystem",
  created: "2026-11-20",
  updated: "2026-11-21",
  sources: ["item:i1"],
  supersedes: [],
  ...extra,
});

/**
 * A domain whose Boundary owns a repo with an origin remote and `src/a.ts`, and whose wiki exists.
 */
const linted = () => {
  const box = sandbox();
  const repo = initRepo();
  made.push(repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
  g(repo, "remote", "add", "origin", "git@github.com:Acme/Widgets.git");
  const root = tempDir("coordinate-wiki-root-");
  made.push(root);
  mkdirSync(join(root, "herdr"));
  writeFileSync(join(root, "herdr", "x.toml"), "");
  expect(box.run(["start", "app"]).exit).toBe(0);
  expect(box.run(["backlog", "boundary", "add", repo]).exit).toBe(0);
  const wiki = box.run(["wiki", "path"]).stdout.trim();
  return { ...box, repo, root, wiki };
};

describe("coordinate wiki lint", () => {
  it("passes a wiki whose pages are indexed, linked, dated and covered", () => {
    const { run, wiki, root } = linted();
    writeFileSync(join(wiki, "index.md"), "# app wiki\n\n- [[alpha]]\n- [[beta]]\n");
    writeFileSync(
      join(wiki, "alpha.md"),
      page(
        fields("alpha", {
          covers: [
            { repo: "github.com/acme/widgets", globs: ["src/*.ts"] },
            { root, globs: ["herdr/*.toml"] },
          ],
        }),
        "As of 2026-11-21 (abc1234), `watch.ts` polls every 5s. See [[beta]].\n\n```ts\nconst x = 1; // this is code\n```\n",
      ),
    );
    writeFileSync(
      join(wiki, "beta.md"),
      page(fields("beta", { type: "decision" }), "Back to [[alpha|the subsystem]].\n"),
    );
    const clean = run(["wiki", "lint"]);
    expect(clean).toEqual({
      exit: 0,
      stdout: `wiki lint: ${wiki} is clean (2 pages)\n`,
      stderr: "",
    });
    expect(JSON.parse(run(["wiki", "lint", "--json"]).stdout)).toEqual({
      path: wiki,
      pages: 2,
      problems: [],
    });
  }, 30_000);

  it("reports each problem with an exact message and exits 1", () => {
    const { state, run, wiki, root } = linted();
    writeFileSync(join(wiki, "index.md"), "# app wiki\n\n- [[alpha]]\n- [[bad]]\n- [[ghost]]\n");
    writeFileSync(
      join(wiki, "alpha.md"),
      page(
        fields("alpha", {
          covers: [
            { repo: "github.com/acme/widgets", globs: ["src/*.ts", "lib/*.ts"] },
            { repo: "github.com/acme/missing", globs: ["*"] },
            { root, globs: ["nix/*.nix"] },
          ],
        }),
        "# Watcher\n\nThe watcher in `watch.ts` uses a 5s interval.\nSee [[gamma]] and [[nowhere]].\n",
      ),
    );
    writeFileSync(
      join(wiki, "bad.md"),
      page(fields("bad", { type: "rumor", description: "" }), "Text.\n"),
    );
    writeFileSync(join(wiki, "gamma.md"), page(fields("gamma"), "Linked, not indexed.\n"));
    writeFileSync(join(wiki, "delta.md"), page(fields("delta"), "Nobody links here.\n"));
    writeFileSync(join(wiki, "plain.md"), "No frontmatter.\n");
    const claimLine =
      readFileSync(join(wiki, "alpha.md"), "utf8")
        .split("\n")
        .indexOf("The watcher in `watch.ts` uses a 5s interval.") + 1;
    expect(run(["finding", "add", "old thing", "--kind", "issue", "--detail-md", "old"]).exit).toBe(
      0,
    );
    expect(
      run(["finding", "add", "new thing", "--kind", "opportunity", "--detail-md", "new"]).exit,
    ).toBe(0);
    const documentFile = join(state, "backlogs", "app.json");
    const document = JSON.parse(readFileSync(documentFile, "utf8"));
    expect(document.findings[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    document.findings[0].createdAt = old;
    writeFileSync(documentFile, JSON.stringify(document, null, 2));

    const expected = [
      "invalid frontmatter: bad.md: description must be one non-empty line",
      "invalid frontmatter: bad.md: type must be one of decision, problem, subsystem, preference, retro",
      "invalid frontmatter: plain.md: the page does not start with a --- frontmatter block",
      "orphan: delta.md: no page and no index.md entry links to [[delta]]",
      "orphan: plain.md: no page and no index.md entry links to [[plain]]",
      "not in index: gamma.md: index.md does not link to [[gamma]]",
      "broken link: alpha.md: [[nowhere]] names no page",
      "broken link: index.md: [[ghost]] names no page",
      `undated claim: alpha.md:${claimLine}: date it or cite a commit: The watcher in \`watch.ts\` uses a 5s interval.`,
      "covers: alpha.md: github.com/acme/widgets lib/*.ts matches no files",
      `covers: alpha.md: ${root} nix/*.nix matches no files`,
      `stale finding: f1 has been open since ${old.slice(0, 10)}, over 14 days: close or promote it`,
    ];
    const failed = run(["wiki", "lint"]);
    expect(failed).toEqual({
      exit: 1,
      stdout: `${[...expected, `wiki lint: ${expected.length} problems in ${wiki}`].join("\n")}\n`,
      stderr: "",
    });
    const json = run(["wiki", "lint", "--json"]);
    expect(json.exit).toBe(1);
    expect(
      JSON.parse(json.stdout).problems.map(
        (problem: { kind: string; message: string }) => `${problem.kind}: ${problem.message}`,
      ),
    ).toEqual(expected);
  }, 30_000);
});

describe("coordinate wiki lint --mark", () => {
  it("records the last-lint date only when lint passes, for the domain wiki only", () => {
    const { state, run, wiki } = linted();
    const clock = join(state, "wiki-lint", "app.json");
    writeFileSync(join(wiki, "index.md"), "# app wiki\n\n- [[ghost]]\n");
    expect(run(["wiki", "lint", "--mark"])).toEqual({
      exit: 1,
      stdout: `broken link: index.md: [[ghost]] names no page\nwiki lint: 1 problems in ${wiki}\n`,
      stderr: "",
    });
    expect(existsSync(clock)).toBe(false);

    writeFileSync(join(wiki, "index.md"), "# app wiki\n");
    const today = new Date().toISOString().slice(0, 10);
    expect(run(["wiki", "lint", "--mark"])).toEqual({
      exit: 0,
      stdout: `wiki lint: ${wiki} is clean (0 pages)\nrecorded the last lint as ${today}; the watcher's next lint-due is 7 days later\n`,
      stderr: "",
    });
    expect(JSON.parse(readFileSync(clock, "utf8"))).toEqual({ lastLint: today });
    expect(JSON.parse(run(["wiki", "lint", "--mark", "--json"]).stdout)).toEqual({
      path: wiki,
      pages: 0,
      problems: [],
      marked: today,
    });

    mkdirSync(join(state, "wiki", "_shared"), { recursive: true });
    const shared = run(["wiki", "lint", "--mark", "--shared"]);
    expect([shared.exit, shared.stdout]).toEqual([1, ""]);
    expect(shared.stderr).toContain(
      "refused: --mark records the domain wiki's lint clock; run it without --shared\n",
    );
  }, 30_000);
});

describe("coordinate wiki commit", () => {
  it("refuses a commit while lint fails and commits once it passes", () => {
    const { run, wiki, env } = linted();
    writeFileSync(join(wiki, "alpha.md"), page(fields("alpha"), "First notes.\n"));
    const refused = run(["wiki", "commit", "-m", "add alpha"]);
    expect(refused).toEqual({
      exit: 1,
      stdout: "orphan: alpha.md: no page and no index.md entry links to [[alpha]]\n",
      stderr: `refused: wiki lint found 1 problems in ${wiki}, nothing committed\n`,
    });
    expect(log(wiki)).toEqual(["start the app wiki"]);

    writeFileSync(join(wiki, "index.md"), "# app wiki\n\n- [[alpha]]\n");
    // A hook inside a linked worktree exports GIT_DIR; the wiki commit must not follow it.
    const decoy = initRepo();
    made.push(decoy);
    const committed = Bun.spawnSync(["bun", cli, "wiki", "commit", "-m", "add alpha"], {
      env: { ...env, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const sha = g(wiki, "rev-parse", "--short", "HEAD");
    expect([committed.exitCode, committed.stdout.toString()]).toEqual([
      0,
      `committed ${sha} in ${wiki}: add alpha\n`,
    ]);
    expect(log(wiki)).toEqual(["add alpha", "start the app wiki"]);
    expect(g(wiki, "status", "--porcelain")).toBe("");
    expect(log(decoy)).toEqual(["init"]);

    expect(run(["wiki", "commit", "--message", "again"])).toEqual({
      exit: 0,
      stdout: `nothing to commit in ${wiki}\n`,
      stderr: "",
    });
    writeFileSync(join(wiki, "alpha.md"), page(fields("alpha"), "Second notes.\n"));
    const json = run(["wiki", "commit", "-m", "revise alpha", "--json"]);
    expect([json.exit, JSON.parse(json.stdout)]).toEqual([
      0,
      { path: wiki, committed: g(wiki, "rev-parse", "--short", "HEAD"), problems: [] },
    ]);
  }, 30_000);

  it("prints the problems as JSON when lint refuses the commit", () => {
    const { run, wiki } = linted();
    writeFileSync(join(wiki, "index.md"), "# app wiki\n\n- [[ghost]]\n");
    const refused = run(["wiki", "commit", "-m", "x", "--json"]);
    expect([refused.exit, JSON.parse(refused.stdout)]).toEqual([
      1,
      {
        path: wiki,
        committed: null,
        problems: [{ kind: "broken link", message: "index.md: [[ghost]] names no page" }],
      },
    ]);
  }, 30_000);

  it("refuses the shared wiki to any coordinator but the manager", () => {
    const { run, state } = linted();
    mkdirSync(join(state, "wiki", "_shared"), { recursive: true });
    const refused = run(["wiki", "commit", "--shared", "-m", "x"]);
    expect([refused.exit, refused.stdout]).toEqual([1, ""]);
    expect(refused.stderr).toContain(
      'refused: only the manager coordinator writes the shared wiki; request the change as an item in the manager domain: coordinate item add "<change> (from app)" --domain manager\n',
    );
  }, 30_000);
});

const DELEGATE_TERMINALS = {
  "t-watch": { address: "t-watch", state: "live", status: { state: "working" }, labels: {} },
};

/**
 * A coordinator of app whose domain wiki and shared wiki both hold pages, and whose fake hc answers
 * the new delegate terminal as working, so `delegate` returns at once.
 */
const launching = () => {
  const state = tempDir("coordinate-wiki-launch-");
  made.push(state);
  const env = cliEnv(
    state,
    { "fleet.role": "coordinator", "fleet.domain": "app" },
    undefined,
    DELEGATE_TERMINALS,
  );
  const run = (args: string[]): Result => {
    const result = Bun.spawnSync(["bun", cli, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    return {
      exit: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  expect(run(["start", "app"]).exit).toBe(0);
  expect(run(["item", "add", "work"]).exit).toBe(0);
  const wiki = join(state, "wiki", "app");
  const shared = join(state, "wiki", "_shared");
  mkdirSync(wiki, { recursive: true });
  mkdirSync(shared, { recursive: true });
  const firstMessage = (): string => {
    const calls = readFileSync(join(state, "bin", "calls.log"), "utf8").split("\n");
    return calls.find((line) => line.startsWith("run ") && line.includes(" --name fix-")) ?? "";
  };
  return { state, run, wiki, shared, firstMessage };
};

describe("coordinate delegate WIKI.md", () => {
  it("lists the domain and shared pages covering a --repo delegate's repo beside its brief", () => {
    const { state, run, wiki, shared, firstMessage } = launching();
    const repo = initRepo();
    made.push(repo);
    g(repo, "remote", "add", "origin", "git@github.com:Acme/Widgets.git");
    const root = tempDir("coordinate-wiki-root-");
    made.push(root);
    writeFileSync(
      join(wiki, "alpha.md"),
      page(
        fields("alpha", {
          covers: [
            { repo: "github.com/acme/widgets", globs: ["src/*.ts", "lib/*.ts"] },
            { root, globs: ["herdr/*.toml"] },
          ],
        }),
        "Alpha.\n",
      ),
    );
    writeFileSync(
      join(wiki, "beta.md"),
      page(fields("beta", { covers: [{ repo: "github.com/acme/other", globs: ["*"] }] }), "B.\n"),
    );
    writeFileSync(join(wiki, "gamma.md"), page(fields("gamma"), "Unscoped.\n"));
    writeFileSync(
      join(shared, "house-style.md"),
      page(
        fields("house-style", {
          type: "preference",
          covers: [{ repo: "https://github.com/acme/widgets.git", globs: ["**/*.md"] }],
        }),
        "Style.\n",
      ),
    );
    const source = join(state, "brief.md");
    writeFileSync(source, "# Brief\n");
    const started = run([
      "delegate",
      "fix-a",
      "--task",
      "fix a",
      "--repo",
      repo,
      "--harness",
      "claude",
      "--brief",
      source,
      "--item",
      "i1",
      "--no-space",
    ]);
    expect([started.exit, started.stderr]).toEqual([0, ""]);
    const scratch = join(repo, ".claude", "worktrees", "fix-a", ".scratch");
    expect(readFileSync(join(scratch, "WIKI.md"), "utf8")).toBe(
      [
        "# Wiki pages for fix-a",
        "",
        "Pages from the app and shared wikis whose covers name github.com/acme/widgets. Open a page before you change the files its globs match. If a claim looks stale, say so in your report: only the coordinator edits the wiki.",
        "",
        "## app wiki",
        "",
        `- ${join(wiki, "alpha.md")}: about alpha`,
        "  - globs: src/*.ts, lib/*.ts",
        "",
        "## shared wiki",
        "",
        `- ${join(shared, "house-style.md")}: about house-style`,
        "  - globs: **/*.md",
        "",
      ].join("\n"),
    );
    const launched = firstMessage();
    expect(launched.slice(launched.indexOf("Read "))).toBe(
      `Read ${join(scratch, "BRIEF.md")} and do what it says. The wiki pages that cover this work are listed in ${join(scratch, "WIKI.md")}; open the ones your task touches.`,
    );
  }, 30_000);

  it("matches root covers containing a --cwd delegate's folder for a pi skill start", () => {
    const { run, wiki, shared, firstMessage } = launching();
    const root = tempDir("coordinate-wiki-root-");
    made.push(root);
    const cwd = join(root, "herdr");
    mkdirSync(cwd);
    writeFileSync(
      join(wiki, "alpha.md"),
      page(
        fields("alpha", {
          covers: [
            { repo: "github.com/acme/widgets", globs: ["src/*.ts"] },
            { root, globs: ["herdr/*.toml"] },
          ],
        }),
        "Alpha.\n",
      ),
    );
    writeFileSync(
      join(wiki, "beta.md"),
      page(fields("beta", { covers: [{ root: join(root, "elsewhere"), globs: ["*"] }] }), "B.\n"),
    );
    writeFileSync(
      join(shared, "infra.md"),
      page(fields("infra", { covers: [{ root: cwd, globs: ["*.toml"] }] }), "I.\n"),
    );
    const started = run([
      "delegate",
      "fix-b",
      "--task",
      "fix b",
      "--cwd",
      cwd,
      "--harness",
      "pi",
      "--skill",
      "implement",
      "--args",
      "the ticket",
      "--item",
      "i1",
      "--no-space",
    ]);
    expect([started.exit, started.stderr]).toEqual([0, ""]);
    const scratch = join(cwd, ".scratch", "fix-b");
    expect(readFileSync(join(scratch, "WIKI.md"), "utf8")).toBe(
      [
        "# Wiki pages for fix-b",
        "",
        `Pages from the app and shared wikis whose covers name ${cwd}. Open a page before you change the files its globs match. If a claim looks stale, say so in your report: only the coordinator edits the wiki.`,
        "",
        "## app wiki",
        "",
        `- ${join(wiki, "alpha.md")}: about alpha`,
        "  - globs: herdr/*.toml",
        "",
        "## shared wiki",
        "",
        `- ${join(shared, "infra.md")}: about infra`,
        "  - globs: *.toml",
        "",
      ].join("\n"),
    );
    const launched = firstMessage();
    expect(launched.slice(launched.indexOf("/skill:"))).toBe(
      `/skill:implement the ticket The wiki pages that cover this work are listed in ${join(scratch, "WIKI.md")}; open the ones your task touches.`,
    );
  }, 30_000);

  it("writes no WIKI.md and adds no pointer when no page covers the delegate", () => {
    const { state, run, wiki, firstMessage } = launching();
    const repo = initRepo();
    made.push(repo);
    writeFileSync(join(wiki, "gamma.md"), page(fields("gamma"), "Unscoped.\n"));
    writeFileSync(
      join(wiki, "beta.md"),
      page(fields("beta", { covers: [{ repo: "github.com/acme/other", globs: ["*"] }] }), "B.\n"),
    );
    const source = join(state, "brief.md");
    writeFileSync(source, "# Brief\n");
    const started = run([
      "delegate",
      "fix-c",
      "--task",
      "fix c",
      "--repo",
      repo,
      "--harness",
      "claude",
      "--skill",
      "implement-spec",
      "--args",
      "spec 1",
      "--brief",
      source,
      "--item",
      "i1",
      "--no-space",
    ]);
    expect([started.exit, started.stderr]).toEqual([0, ""]);
    const scratch = join(repo, ".claude", "worktrees", "fix-c", ".scratch");
    expect(readdirSync(scratch)).toEqual(["BRIEF.md"]);
    const launched = firstMessage();
    expect(launched.slice(launched.indexOf("/implement-spec"))).toBe(
      `/implement-spec spec 1 Also read ${join(scratch, "BRIEF.md")} and follow its Boundary, Stop points and Report sections.`,
    );
  }, 30_000);

  it("starts a delegate with any skill name, such as pr-review", () => {
    const { state, run, firstMessage } = launching();
    const cwd = join(state, "review");
    mkdirSync(cwd);
    const started = run([
      "delegate",
      "fix-d",
      "--task",
      "review pr",
      "--cwd",
      cwd,
      "--harness",
      "claude",
      "--skill",
      "pr-review",
      "--args",
      "42",
      "--item",
      "i1",
      "--no-space",
    ]);
    expect([started.exit, started.stderr]).toEqual([0, ""]);
    const launched = firstMessage();
    expect(launched.slice(launched.indexOf("/pr-review"))).toBe("/pr-review 42");
  }, 30_000);
});

describe("coordinate backlog policy add --wiki", () => {
  it("cites a domain or shared wiki page and shows the citation in show, ls and --json", () => {
    const { state, run, wiki } = linted();
    writeFileSync(join(wiki, "poll-interval.md"), page(fields("poll-interval"), "Why 5s.\n"));
    const shared = join(state, "wiki", "_shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "no-push.md"), page(fields("no-push"), "Why local only.\n"));

    expect(
      run([
        "backlog",
        "policy",
        "add",
        "poll every 5s",
        "--at",
        "2026-11-23",
        "--wiki",
        "poll-interval",
      ]),
    ).toEqual({
      exit: 0,
      stdout: "added policy p1: poll every 5s (wiki: [[poll-interval]])\n",
      stderr: "",
    });
    const json = run([
      "backlog",
      "policy",
      "add",
      "never push",
      "--at",
      "2026-11-23",
      "--wiki",
      "no-push",
      "--json",
    ]);
    expect([json.exit, JSON.parse(json.stdout)]).toEqual([
      0,
      { id: "p2", text: "never push", at: "2026-11-23", wiki: "no-push" },
    ]);
    expect(run(["backlog", "policy", "add", "plain", "--at", "2026-11-23"]).exit).toBe(0);

    const shown = run(["backlog", "show"]);
    expect(shown.stdout.split("## Policies\n\n")[1]?.split("\n\n")[0]).toBe(
      [
        "- p1 2026-11-23: poll every 5s (wiki: [[poll-interval]])",
        "- p2 2026-11-23: never push (wiki: [[no-push]])",
        "- p3 2026-11-23: plain",
      ].join("\n"),
    );
    expect(JSON.parse(run(["backlog", "show", "--json"]).stdout).policies).toEqual([
      { id: "p1", text: "poll every 5s", at: "2026-11-23", wiki: "poll-interval" },
      { id: "p2", text: "never push", at: "2026-11-23", wiki: "no-push" },
      { id: "p3", text: "plain", at: "2026-11-23" },
    ]);
    expect(run(["backlog", "policy", "ls"]).stdout).toBe(
      "p1 2026-11-23: poll every 5s (wiki: [[poll-interval]])\np2 2026-11-23: never push (wiki: [[no-push]])\np3 2026-11-23: plain\n",
    );
    expect(
      run(["backlog", "policy", "replace", "p1", "poll every 10s", "--at", "2026-11-24"]).stdout,
    ).toBe("replaced policy p1: poll every 10s (wiki: [[poll-interval]])\n");
  }, 30_000);

  it("refuses a page missing from both wikis and leaves the backlog unchanged", () => {
    const { state, run, wiki } = linted();
    writeFileSync(join(wiki, "index.md"), "# app wiki\n\n- [[ghost]]\n");
    const documentFile = join(state, "backlogs", "app.json");
    const before = readFileSync(documentFile, "utf8");
    const shared = join(state, "wiki", "_shared");
    for (const ref of ["ghost", "index", "../app/index"])
      expect(run(["backlog", "policy", "add", "rule", "--wiki", ref])).toEqual({
        exit: 1,
        stdout: "",
        stderr: `refused: no page [[${ref}]] in the app wiki (${wiki}) or the shared wiki (${shared})\n`,
      });
    expect(readFileSync(documentFile, "utf8")).toBe(before);
    expect(existsSync(shared)).toBe(false);
  }, 30_000);

  it("refuses a citation when no wiki exists yet, without creating one", () => {
    const { state, run } = sandbox();
    expect(run(["start", "app"]).exit).toBe(0);
    const result = run(["backlog", "policy", "add", "rule", "--wiki", "poll-interval"]);
    expect(result).toEqual({
      exit: 1,
      stdout: "",
      stderr: `refused: no page [[poll-interval]] in the app wiki (${state}/wiki/app) or the shared wiki (${state}/wiki/_shared)\n`,
    });
    expect(existsSync(join(state, "wiki"))).toBe(false);
    expect(JSON.parse(run(["backlog", "show", "--json"]).stdout).policies).toEqual([]);
  }, 30_000);
});

// Run the CLI as the Backlog panel does: outside every Herdr terminal, HC_TERMINAL_ID unset.
const outside = (env: Record<string, string>, args: string[]): Result => {
  const { HC_TERMINAL_ID: _, ...rest } = env;
  const result = Bun.spawnSync(["bun", cli, ...args], {
    env: rest,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  return {
    exit: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

describe("coordinate wiki list and show", () => {
  it("lists no pages for a missing wiki and creates nothing", () => {
    const { state, run, env } = sandbox();
    expect(JSON.parse(run(["wiki", "list", "--json"]).stdout)).toEqual({
      domain: "app",
      path: join(state, "wiki", "app"),
      lastLint: null,
      pages: [],
      invalid: [],
    });
    expect(run(["wiki", "list"])).toEqual({
      exit: 0,
      stdout: `no pages in the app wiki (${state}/wiki/app)\n`,
      stderr: "",
    });
    expect(outside(env, ["wiki", "show", "poll-interval", "--domain", "app"])).toEqual({
      exit: 1,
      stdout: "",
      stderr: `refused: no page [[poll-interval]] in the app wiki (${state}/wiki/app)\n`,
    });
    expect(existsSync(join(state, "wiki"))).toBe(false);
  }, 30_000);

  it("lists pages in index order with their frontmatter and the last lint, from outside a terminal", () => {
    const { state, env, run } = sandbox();
    const wiki = run(["wiki", "path"]).stdout.trim();
    writeFileSync(
      join(wiki, "index.md"),
      "# app wiki\n\n## problem\n\n- [[zeta]]: z\n\n## subsystem\n\n- [[alpha]]: a\n",
    );
    writeFileSync(join(wiki, "alpha.md"), page(fields("alpha"), "# Alpha\n\nSee [[zeta]].\n"));
    writeFileSync(
      join(wiki, "zeta.md"),
      page(
        fields("zeta", {
          type: "problem",
          covers: [{ repo: "github.com/acme/widgets", globs: ["src/*.ts"] }],
        }),
        "Zeta.\n",
      ),
    );
    writeFileSync(join(wiki, "middle.md"), page(fields("middle"), "Unindexed.\n"));
    writeFileSync(join(wiki, "broken.md"), "no frontmatter\n");
    mkdirSync(join(state, "wiki-lint"), { recursive: true });
    writeFileSync(join(state, "wiki-lint", "app.json"), '{"lastLint":"2026-11-22"}\n');

    const meta = (name: string, extra: Record<string, unknown> = {}) => ({
      ...fields(name),
      covers: [],
      ...extra,
    });
    const listed = outside(env, ["wiki", "list", "--domain", "app", "--json"]);
    expect([listed.exit, JSON.parse(listed.stdout)]).toEqual([
      0,
      {
        domain: "app",
        path: wiki,
        lastLint: "2026-11-22",
        pages: [
          meta("zeta", {
            type: "problem",
            covers: [{ repo: "github.com/acme/widgets", globs: ["src/*.ts"] }],
          }),
          meta("alpha"),
          meta("middle"),
        ],
        invalid: ["broken"],
      },
    ]);
    expect(Object.keys(JSON.parse(listed.stdout).pages[1])).toEqual([
      "name",
      "description",
      "type",
      "covers",
      "created",
      "updated",
      "sources",
      "supersedes",
    ]);
    expect(run(["wiki", "list"]).stdout).toBe(
      [
        "zeta (problem): about zeta",
        "alpha (subsystem): about alpha",
        "middle (subsystem): about middle",
        "broken: invalid frontmatter, run coordinate wiki lint",
        "last lint: 2026-11-22",
        "",
      ].join("\n"),
    );

    // The panel's form: flags first, then the name after --.
    const shown = outside(env, ["wiki", "show", "--domain", "app", "--json", "--", "alpha"]);
    expect([shown.exit, JSON.parse(shown.stdout)]).toEqual([
      0,
      {
        domain: "app",
        name: "alpha",
        file: join(wiki, "alpha.md"),
        meta: meta("alpha"),
        errors: [],
        body: "# Alpha\n\nSee [[zeta]].\n",
      },
    ]);
    expect(run(["wiki", "show", "alpha"]).stdout).toBe(
      "alpha (subsystem): about alpha\ncreated 2026-11-20, updated 2026-11-21\n\n# Alpha\n\nSee [[zeta]].\n",
    );
    const invalid = JSON.parse(run(["wiki", "show", "broken", "--json"]).stdout);
    expect([invalid.meta, invalid.errors, invalid.body]).toEqual([
      null,
      ["the page does not start with a --- frontmatter block"],
      "no frontmatter\n",
    ]);
    for (const ref of ["index", "../app/alpha", "ghost"])
      expect(run(["wiki", "show", ref])).toEqual({
        exit: 1,
        stdout: "",
        stderr: `refused: no page [[${ref}]] in the app wiki (${wiki})\n`,
      });
  }, 30_000);
});

describe("coordinate backlog policy replace --wiki", () => {
  it("cites a new page, keeps the citation without the flag, and refuses an unknown page", () => {
    const { state, run, wiki } = linted();
    writeFileSync(join(wiki, "old-reason.md"), page(fields("old-reason"), "Old.\n"));
    writeFileSync(join(wiki, "new-reason.md"), page(fields("new-reason"), "New.\n"));
    expect(
      run(["backlog", "policy", "add", "rule", "--at", "2026-11-23", "--wiki", "old-reason"]).exit,
    ).toBe(0);
    expect(run(["backlog", "policy", "add", "plain", "--at", "2026-11-23"]).exit).toBe(0);

    const documentFile = join(state, "backlogs", "app.json");
    const before = readFileSync(documentFile, "utf8");
    const shared = join(state, "wiki", "_shared");
    for (const ref of ["ghost", "index"])
      expect(run(["backlog", "policy", "replace", "p1", "rule 2", "--wiki", ref])).toEqual({
        exit: 1,
        stdout: "",
        stderr: `refused: no page [[${ref}]] in the app wiki (${wiki}) or the shared wiki (${shared})\n`,
      });
    expect(readFileSync(documentFile, "utf8")).toBe(before);

    expect(
      run([
        "backlog",
        "policy",
        "replace",
        "p1",
        "rule 2",
        "--at",
        "2026-11-24",
        "--wiki",
        "new-reason",
      ]),
    ).toEqual({
      exit: 0,
      stdout: "replaced policy p1: rule 2 (wiki: [[new-reason]])\n",
      stderr: "",
    });
    const cited = run([
      "backlog",
      "policy",
      "replace",
      "p2",
      "plain 2",
      "--at",
      "2026-11-24",
      "--wiki",
      "old-reason",
      "--json",
    ]);
    expect(JSON.parse(cited.stdout)).toEqual({
      id: "p2",
      text: "plain 2",
      at: "2026-11-24",
      wiki: "old-reason",
    });
    expect(run(["backlog", "policy", "replace", "p1", "rule 3", "--at", "2026-11-25"]).stdout).toBe(
      "replaced policy p1: rule 3 (wiki: [[new-reason]])\n",
    );
  }, 30_000);
});
