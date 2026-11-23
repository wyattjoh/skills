import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { failureOf, runWith } from "./fixture.ts";
import { coreName, coresOn, get, isAgent, newSpace, parseGet, parseList, run } from "./herdr.ts";
import { fakeProc, ok } from "./proc.ts";

const testdata = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "testdata", name), "utf8");

describe("parseList", () => {
  it("reads hc ls and tells agents from shells", async () => {
    const terminals = await Effect.runPromise(parseList(testdata("hc-ls.json")));
    expect(
      terminals.map((terminal) => [terminal.address, terminal.live, isAgent(terminal)]),
    ).toEqual([
      ["t1", true, false],
      ["t2", true, true],
      ["t3", true, true],
      ["t4", false, true],
    ]);
    expect(terminals[1]?.name).toBe("fix-a");
  });
});

describe("parseGet", () => {
  it("reads labels, foreground cwd and status", async () => {
    const terminal = await Effect.runPromise(parseGet(testdata("hc-get.json")));
    expect(terminal.labels["fleet.domain"]).toBe("app");
    expect(terminal.status).toBe("working");
    expect(terminal.app).toBe("pi");
    expect(terminal.cwd).toBe("/home/u/code/app/.claude/worktrees/fix-a");
    expect(terminal.argv).toEqual(["pi", "--session-id", "0b9c2a51-0000-4000-8000-000000000001"]);
  });
});

describe("get", () => {
  it("returns undefined for not_found", async () => {
    const fake = fakeProc(() => ({
      exitCode: 3,
      stdout: '{"error":{"kind":"not_found","message":"no terminal"}}',
      stderr: "",
    }));
    expect(await runWith(get("t9"), fake.layer)).toBe(undefined);
  });

  it("fails on other core errors with the kind", async () => {
    const fake = fakeProc(() => ({
      exitCode: 1,
      stdout: '{"error":{"kind":"unavailable","message":"core down"}}',
      stderr: "",
    }));
    const error = await failureOf(get("t9"), fake.layer);
    expect(error === "no failure" ? "" : error.kind).toBe("unavailable");
  });
});

describe("coreName", () => {
  it("reads this core's Herdr machine name from hc server status", async () => {
    const status = {
      core: { id: "40feaceb425315c41846705a3a0c71fd", name: "finbar" },
      live: 16,
      version: "0.1.22",
    };
    const fake = fakeProc(() => ok(JSON.stringify(status)), { core: undefined });
    expect(await runWith(coreName(), fake.layer)).toBe("finbar");
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "server", "status", "--json"]]);
  });
});

describe("coresOn", () => {
  it("reads and parses the online core count from a remote machine", async () => {
    const fake = fakeProc(() => ok("32\n"));
    expect(await runWith(coresOn("strix"), fake.layer)).toBe(32);
    expect(fake.calls[0]?.argv).toEqual([
      "hc",
      "exec",
      "--on",
      "strix",
      "--timeout",
      "5",
      "getconf",
      "_NPROCESSORS_ONLN",
    ]);
  });

  it("returns undefined for an unreadable core count", async () => {
    const fake = fakeProc(() => ok("not-a-number\n"));
    expect(await runWith(coresOn("nigelsheldon"), fake.layer)).toBe(undefined);
  });
});

describe("run", () => {
  it("passes name, cwd, lineage and labels before the argv", async () => {
    const fake = fakeProc(() => ok('{"address":"t7"}'));
    const address = await runWith(
      run({
        name: "fix-a",
        cwd: "/w",
        labels: { "fleet.domain": "app" },
        machine: undefined,
        parent: "t1",
        outliveParent: true,
        notifyParent: false,
        argv: ["pi", "go"],
      }),
      fake.layer,
    );
    expect(address).toBe("t7");
    expect(fake.calls[0]?.argv).toEqual([
      "hc",
      "run",
      "--bg",
      "--json",
      "--name",
      "fix-a",
      "--cwd",
      "/w",
      "--parent",
      "t1",
      "--outlive-parent",
      "--no-notify",
      "--label",
      "fleet.domain=app",
      "--",
      "pi",
      "go",
    ]);
  });
});

describe("newSpace", () => {
  it("creates the space in the background and returns its ids", async () => {
    const fake = fakeProc(() => ok(testdata("herdr-app-space-new.json")));
    expect(await runWith(newSpace("app [fix a]", "/w"), fake.layer)).toEqual({
      space: "sp1",
      tab: "tb1",
      terminal: "t5",
    });
    expect(fake.calls[0]?.argv).toEqual([
      "herdr-app",
      "do",
      "space.new",
      '{"name":"app [fix a]","folder":"/w","focus":false}',
    ]);
  });
});
