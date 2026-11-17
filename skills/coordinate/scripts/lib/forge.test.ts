import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { failureOf, runWith } from "./fixture.ts";
import {
  forgeKind,
  listPullRequests,
  parseForgejoChecks,
  parseForgejoPrs,
  parseGhPrs,
  parseRemote,
  prsForBranch,
  prSummary,
  type PullRequest,
} from "./forge.ts";
import { fakeProc, ok } from "./proc.ts";

const testdata = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "testdata", name), "utf8");

describe("parseRemote", () => {
  it("reads scp, ssh and https URLs", () => {
    expect(parseRemote("forgejo@git.example.net:owner/app.git")).toEqual({
      host: "git.example.net",
      slug: "owner/app",
    });
    expect(parseRemote("ssh://forgejo@git.example.net:2222/owner/app.git")).toEqual({
      host: "git.example.net",
      slug: "owner/app",
    });
    expect(parseRemote("https://github.com/Owner/repo")).toEqual({
      host: "github.com",
      slug: "Owner/repo",
    });
    expect(parseRemote("git@github.com:owner/repo.git")).toEqual({
      host: "github.com",
      slug: "owner/repo",
    });
  });

  it("rejects paths without owner/name", () => {
    expect(parseRemote("/srv/git/app.git")).toBe(undefined);
    expect(parseRemote("https://host/a/b/c")).toBe(undefined);
  });
});

describe("forgeKind", () => {
  it("uses the config map without spawning", async () => {
    const fake = fakeProc(() => ok());
    expect(await runWith(forgeKind("github.com", { "github.com": "github" }), fake.layer)).toBe(
      "github",
    );
    expect(fake.calls.length).toBe(0);
  });

  it("accepts a host the forgejo CLI holds credentials for", async () => {
    const fake = fakeProc(() => ok('{"status":"success","result":{}}'));
    expect(await runWith(forgeKind("git.example.net", {}), fake.layer)).toBe("forgejo");
    expect(fake.calls[0]?.argv).toEqual([
      "forgejo",
      "--agent",
      "auth",
      "status",
      "--host",
      "git.example.net",
    ]);
  });

  it("fails on an unknown host instead of guessing GitHub", async () => {
    const fake = fakeProc(() => ({ exitCode: 1, stdout: '{"status":"error"}', stderr: "" }));
    const error = await failureOf(forgeKind("git.example.net", {}), fake.layer);
    expect(error === "no failure" ? "" : error.constructor.name).toBe("UnknownForge");
  });
});

const envelope = (states: string[]) =>
  JSON.stringify({ status: "success", result: { statuses: states.map((state) => ({ state })) } });

describe("parse PR lists", () => {
  it("normalizes gh output", () => {
    const prs = parseGhPrs(testdata("gh-pr-list.json"));
    expect(prs.map((pr) => [pr.number, pr.state, pr.checks, pr.headRef])).toEqual([
      [99, "open", "pass", "wyattjoh/weekly-skill-freshness"],
      [98, "merged", "pass", "wyattjoh/fix-ci-spawnsync-hang"],
    ]);
  });

  it("normalizes forgejo output, with AGit heads as undefined", () => {
    const prs = parseForgejoPrs(testdata("forgejo-pr-list.json"));
    expect(Array.isArray(prs)).toBe(true);
    const list = Array.isArray(prs) ? prs : [];
    expect(list.map((pr) => [pr.number, pr.state, pr.headRef])).toEqual([
      [45, "merged", undefined],
      [44, "merged", undefined],
      [43, "merged", undefined],
      [46, "open", "owner/feature-x"],
    ]);
  });

  it("returns the envelope error", () => {
    expect(
      parseForgejoPrs(
        '{"status":"error","result":null,"error":{"code":"host.required","message":"host.required"}}',
      ),
    ).toEqual({
      error: "host.required: host.required",
    });
  });

  it("summarizes forgejo checks", () => {
    expect([
      parseForgejoChecks(envelope(["success"])),
      parseForgejoChecks(envelope(["success", "failure"])),
      parseForgejoChecks(envelope(["pending"])),
      parseForgejoChecks(envelope([])),
    ]).toEqual(["pass", "fail", "pending", "none"]);
  });
});

describe("listPullRequests", () => {
  it("queries gh with the host in -R", async () => {
    const fake = fakeProc(() => ok(testdata("gh-pr-list.json")));
    const prs = await runWith(
      listPullRequests({ host: "github.com", slug: "o/r" }, "github"),
      fake.layer,
    );
    expect(prs.length).toBe(2);
    expect(fake.calls[0]?.argv.slice(0, 5)).toEqual(["gh", "pr", "list", "-R", "github.com/o/r"]);
  });

  it("fetches forgejo checks for open PRs only", async () => {
    const fake = fakeProc((argv) =>
      argv[3] === "checks"
        ? ok(JSON.stringify({ status: "success", result: { statuses: [{ state: "failure" }] } }))
        : ok(testdata("forgejo-pr-list.json")),
    );
    const prs = await runWith(
      listPullRequests({ host: "git.example.net", slug: "owner/app" }, "forgejo", true),
      fake.layer,
    );
    expect(prs.find((pr) => pr.number === 46)?.checks).toBe("fail");
    expect(fake.calls.length).toBe(2);
  });
});

const pr = (fields: Partial<PullRequest>): PullRequest => ({
  number: 1,
  url: "u",
  state: "open",
  headRef: "b",
  headSha: "aaa",
  base: "main",
  checks: "none",
  review: "none",
  ...fields,
});

const within = (shas: string[]) => (sha: string) => Effect.succeed(shas.includes(sha));

describe("prsForBranch", () => {
  it("matches an open PR by name or tip", async () => {
    const prs = [
      pr({ number: 1 }),
      pr({ number: 2, headRef: undefined, headSha: "tip" }),
      pr({ number: 3, headRef: "other" }),
    ];
    const matched = await Effect.runPromise(prsForBranch(prs, "b", "tip", within([])));
    expect(matched.map((found) => found.number)).toEqual([1, 2]);
  });

  it("matches a merged PR by name when the branch holds nothing past its head, an AGit PR only at its exact head", async () => {
    const prs = [
      pr({ number: 1, state: "merged", headSha: "head1" }),
      pr({ number: 2, state: "merged", headRef: undefined, headSha: "head2" }),
      pr({ number: 3, state: "merged", headSha: "reused" }),
    ];
    const matched = await Effect.runPromise(
      prsForBranch(prs, "b", "tip", within(["head1", "head2"])),
    );
    expect(matched.map((found) => found.number)).toEqual([1]);
    const exact = await Effect.runPromise(prsForBranch(prs, "b", "head2", within([])));
    expect(exact.map((found) => found.number)).toEqual([2]);
  });
});

describe("prSummary", () => {
  it("prefers open, then merged", () => {
    expect(
      prSummary([pr({ number: 1, state: "closed" }), pr({ number: 2, state: "merged" })]),
    ).toEqual({
      state: "merged",
      label: "#1 closed,#2 merged",
    });
    expect(prSummary([])).toEqual({ state: undefined, label: "" });
  });
});
