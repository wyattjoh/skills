import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { boundaryAdd, createDocument } from "./backlog-doc.ts";
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
  await runWith(boundaryAdd(config, "app", { path: repo, adjacent: false, json: false }));

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
