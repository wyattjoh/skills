import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument, itemAdd, recordDelegate, showBacklog } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { failureOf, runWith, tempDir } from "./fixture.ts";
import { endDelegate } from "./lifecycle.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";
import { domainStatus } from "./status.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});
const NOW = "2026-11-17T10:00:00.000Z";

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const ref = (name: string, session: string) => ({
  name,
  session,
  branch: null,
  worktree: null,
  brief: "",
  report: "",
});

/**
 * A state dir with item i1 "fix login" delegated to the given refs (name, session pairs), and a
 * second, open item i2.
 */
const setup = async (refs: Array<[string, string]>) => {
  const state = tempDir();
  dirs.push(state);
  const cfg = await Effect.runPromise(
    resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"),
  );
  await runWith(createDocument(cfg, "app"));
  await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
  await runWith(itemAdd(cfg, "app", { title: "other", json: false, now: NOW }));
  for (const [name, session] of refs)
    await runWith(recordDelegate(cfg, "app", { id: "i1", ref: ref(name, session) }));
  const path = join(state, "backlogs", "app.json");
  const item = () => JSON.parse(readFileSync(path, "utf8")).items[0];
  return { state, cfg, item };
};

/**
 * hc answers: `live` maps each live terminal address to its session; fix-a is t2.
 */
const answers =
  (live: Record<string, string>) =>
  (argv: readonly string[]): RunOutput => {
    if (argv[1] === "ls")
      return ok(
        JSON.stringify({
          terminals: Object.keys(live).map((address) => ({
            address,
            state: "live",
            status: "idle",
          })),
        }),
      );
    if (argv[1] === "get") {
      const address = argv[2] === "fix-a" ? "t2" : (argv[2] ?? "");
      return ok(
        JSON.stringify({
          address,
          name: address === "t2" ? "fix-a" : `other-${address}`,
          state: "live",
          status: { state: "idle" },
          status_ms: 0,
          cwd: "/nonexistent/wt",
          labels: { "fleet.domain": "app", "fleet.session": live[address] ?? "" },
        }),
      );
    }
    return ok("{}");
  };

const ENDED = [
  "ended fix-a (t2); record STATE/ended/s-1.json",
  "worktree, branch and session stay; resume with: coordinate resume fix-a",
  "no processes of fix-a were left running",
];
const endedLines = (state: string): string[] => ENDED.map((line) => line.replace("STATE", state));

describe("end of an item's last delegate", () => {
  it("prints the next-status hint when no --item-status is given", async () => {
    const { state, cfg, item } = await setup([["fix-a", "s-1"]]);
    const fake = fakeProc(answers({ t2: "s-1" }));
    expect(await runWith(endDelegate(cfg, "fix-a", false), fake.layer)).toEqual([
      ...endedLines(state),
      "i1 is still delegated with no live delegate; set its next status (coordinate item update i1 --status ...)",
    ]);
    expect(item().status).toBe("delegated");
  });

  it("sets the item's status with --item-status", async () => {
    const { state, cfg, item } = await setup([["fix-a", "s-1"]]);
    const fake = fakeProc(answers({ t2: "s-1" }));
    expect(await runWith(endDelegate(cfg, "fix-a", false, "parked"), fake.layer)).toEqual([
      ...endedLines(state),
      "updated i1 [parked] fix login",
    ]);
    expect([item().status, item().delegates.length]).toEqual(["parked", 1]);
  });

  it("leaves the item alone, with no hint, while another delegate lives", async () => {
    const { state, cfg, item } = await setup([
      ["fix-a", "s-1"],
      ["fix-b", "s-2"],
    ]);
    const fake = fakeProc(answers({ t2: "s-1", t3: "s-2" }));
    expect(await runWith(endDelegate(cfg, "fix-a", false, "parked"), fake.layer)).toEqual(
      endedLines(state),
    );
    expect(item().status).toBe("delegated");
  });

  it("refuses a status the item cannot take before ending anything", async () => {
    const { state, cfg, item } = await setup([["fix-a", "s-1"]]);
    const fake = fakeProc(answers({ t2: "s-1" }));
    const closed = await failureOf(endDelegate(cfg, "fix-a", false, "done"), fake.layer);
    expect(messageOf(closed)).toBe(
      "--item-status done is not one of waiting-user, building, in-review, open, parked; close an item with coordinate item close",
    );
    const waiting = await failureOf(endDelegate(cfg, "fix-a", false, "waiting-user"), fake.layer);
    expect(messageOf(waiting)).toBe(
      "i1 cannot wait on the user without an ask (--ask) or a decision naming the pending integration (--decided)",
    );
    expect(item().status).toBe("delegated");
    expect(existsSync(join(state, "ended"))).toBe(false);
    expect(fake.calls.filter((call) => call.argv[1] === "kill")).toEqual([]);
  });

  it("says an unfiled delegate's --item-status was ignored", async () => {
    const { state, cfg } = await setup([]);
    const fake = fakeProc(answers({ t2: "s-1" }));
    expect(await runWith(endDelegate(cfg, "fix-a", false, "parked"), fake.layer)).toEqual([
      ...endedLines(state),
      "--item-status ignored: fix-a is not filed under a delegated item",
    ]);
  });
});

describe("delegated items with no live delegate", () => {
  it("status lists each as a coordinator step, and backlog show marks it", async () => {
    const { cfg } = await setup([["fix-a", "s-1"]]);
    const fake = fakeProc(answers({}));
    expect(await runWith(domainStatus(cfg, "app", false, Date.parse(NOW)), fake.layer)).toEqual([
      "app: 0 live delegates, 0 ended",
      "  i1 delegated, no live delegate · fix login · next: coordinator: set its next status",
    ]);
    const shown = await runWith(showBacklog(cfg, "app", false), fake.layer);
    expect(shown[0]?.split("\n").filter((line) => line.startsWith("- i"))).toEqual([
      "- i1 [delegated, none live] fix login",
      "- i2 [open] other",
    ]);
  });

  it("flags nothing while a delegate is live", async () => {
    const { cfg } = await setup([["fix-a", "s-1"]]);
    const fake = fakeProc(answers({ t5: "s-1" }));
    const lines = await runWith(domainStatus(cfg, "app", false, Date.parse(NOW)), fake.layer);
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("app: 1 live delegates, 0 ended");
    const shown = await runWith(showBacklog(cfg, "app", false), fake.layer);
    expect(shown[0]?.split("\n").filter((line) => line.startsWith("- i"))).toEqual([
      "- i1 [delegated] fix login",
      "- i2 [open] other",
    ]);
  });
});
