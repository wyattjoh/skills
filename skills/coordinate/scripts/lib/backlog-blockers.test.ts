import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { seedDocument } from "./backlog-doc.ts";
import {
  addItem,
  closeItem,
  emptyBacklog,
  type ItemUpdate,
  updateItem,
} from "./backlog-store/ops.ts";
import { renderBacklog } from "./backlog-store/render.ts";
import {
  type Backlog,
  blockedItems,
  blockerDomains,
  blockerStates,
  parseBlockerRef,
  validateBacklog,
} from "./backlog-store/schema.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, cliState, eachBackend, readState, runWith, tempDir } from "./fixture.ts";
import { start } from "./lifecycle.ts";
import { fakeProc, ok } from "./proc.ts";
import { keys } from "./state-store.ts";
import { unblockedEvents } from "./watch.ts";

const NOW = "2026-11-25T09:00:00.000Z";
const LATER = "2026-11-25T10:00:00.000Z";

const unwrap = <A>(
  result: { ok: true; backlog: Backlog; value: A } | { ok: false; reason: string },
) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};

const update = (id: string, change: Partial<ItemUpdate>): ItemUpdate => ({
  id,
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
  answer: undefined,
  now: NOW,
  ...change,
});

// i1, i2 and i3 open in app.
const three = (domain = "app"): Backlog =>
  ["Ship login", "Migrate db", "Write docs"].reduce(
    (backlog, title) => unwrap(addItem(backlog, { title, now: NOW })).backlog,
    emptyBacklog(domain, null),
  );
const blocked = (backlog: Backlog, id: string, refs: string[]): Backlog =>
  unwrap(updateItem(backlog, update(id, { blockedBy: refs }))).backlog;
const close = (backlog: Backlog, id: string, dismissed = false): Backlog =>
  unwrap(
    closeItem(backlog, { id, outcome: dismissed ? "dropped" : "shipped", dismissed, now: LATER }),
  ).backlog;
const refsOf = (backlog: Backlog, id: string) =>
  backlog.items.find((item) => item.id === id)?.blockedBy;

describe("blocker refs", () => {
  it("parse a bare id or a domain-qualified one and nothing else", () => {
    expect(["i3", " ops:i12 ", "f3", "ops:", "Ops:i1", "i0"].map(parseBlockerRef)).toEqual([
      { domain: undefined, id: "i3" },
      { domain: "ops", id: "i12" },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("item update --blocked-by and --unblock", () => {
  it("records refs in order, stores this domain's prefix bare, and removes them", () => {
    const next = blocked(three(), "i1", ["i2", "app:i3", "ops:i7", "i2"]);
    expect(refsOf(next, "i1")).toEqual(["i2", "i3", "ops:i7"]);
    expect(validateBacklog(next).ok).toBe(true);
    const fewer = unwrap(updateItem(next, update("i1", { unblock: ["app:i2", "ops:i7"] }))).backlog;
    expect(refsOf(fewer, "i1")).toEqual(["i3"]);
    const none = unwrap(updateItem(fewer, update("i1", { unblock: ["i3"] }))).backlog;
    expect(none.items[0]).toEqual(three().items[0]!);
  });

  it("refuses a malformed ref, the item itself, an unknown item, an unlisted ref and a cycle", () => {
    const chained = blocked(blocked(three(), "i1", ["i2"]), "i2", ["i3"]);
    expect(
      [
        update("i1", { blockedBy: ["f2"] }),
        update("i1", { blockedBy: ["app:i1"] }),
        update("i1", { blockedBy: ["i9"] }),
        update("i1", { unblock: ["i3"] }),
        update("i3", { blockedBy: ["i1"] }),
        update("i2", { blockedBy: ["i1"] }),
      ].map((input) => updateItem(chained, input)),
    ).toEqual([
      { ok: false, reason: "--blocked-by f2 must look like i3 or <domain>:i3" },
      { ok: false, reason: "i1 cannot be blocked by itself" },
      { ok: false, reason: "no item i9 in app" },
      { ok: false, reason: "i1 is not blocked by i3" },
      { ok: false, reason: "i3 cannot wait on i1: i3 waits on i1 waits on i2 waits on i3" },
      { ok: false, reason: "i2 cannot wait on i1: i2 waits on i1 waits on i2" },
    ]);
  });

  it("is rejected by the validator when malformed, empty, repeated or self-referencing", () => {
    const base = three();
    const withRefs = (refs: unknown) => ({
      ...base,
      items: [{ ...base.items[0]!, blockedBy: refs }, ...base.items.slice(1)],
    });
    expect(
      [["x"], [], ["i2", "i2"], ["i1"]].map((refs) => {
        const checked = validateBacklog(withRefs(refs));
        return checked.ok ? [] : checked.errors;
      }),
    ).toEqual([
      ["items[0].blockedBy[0] must look like i1 or <domain>:i1"],
      ["items[0].blockedBy must be a non-empty array"],
      ["items[0].blockedBy has a repeated ref"],
      ["items[0].blockedBy[0] names the item itself"],
    ]);
  });
});

describe("blocker states", () => {
  it("reads open, done, dismissed, archived and unknown blockers, and what waits on an item", () => {
    const ops = close(three("ops"), "i1", true);
    const app = close(blocked(three(), "i1", ["i2", "ops:i1", "ops:i9", "web:i1"]), "i2");
    expect(
      blockerStates(app.items[0]!, app, (domain) => (domain === "ops" ? ops : undefined)).map(
        (blocker) => [blocker.ref, blocker.state],
      ),
    ).toEqual([
      ["i2", "done"],
      ["ops:i1", "dismissed"],
      ["ops:i9", "archived"],
      ["web:i1", "unknown"],
    ]);
    expect(blockerDomains(app)).toEqual(["ops", "web"]);
    expect([blockedItems(app, "app", "i2"), blockedItems(app, "ops", "i1")]).toEqual([
      ["i1"],
      ["app:i1"],
    ]);
  });
});

describe("backlog show", () => {
  it("marks a blocked item, lists its blockers with their states, and what each item blocks", () => {
    const app = blocked(blocked(three(), "i1", ["i2", "ops:i4"]), "i3", ["i2"]);
    const shown = renderBacklog(app, new Set(), false, false, {
      other: () => undefined,
      blocks: (id) => (id === "i2" ? ["i1", "i3"] : id === "i3" ? ["web:i5"] : []),
    });
    expect(shown.split("## Open\n\n")[1]?.split("\n\n")[0]).toBe(
      [
        "- i1 [open, blocked] Ship login",
        "  - blocked by i2 [open], ops:i4 [unknown]",
        "- i2 [open] Migrate db",
        "  - blocks i1, i3",
        "- i3 [open, blocked] Write docs",
        "  - blocked by i2 [open]",
        "  - blocks web:i5",
      ].join("\n"),
    );
    const resolved = renderBacklog(close(app, "i2"), new Set(), false, false, {
      other: (domain) => (domain === "ops" ? three("ops") : undefined),
    });
    expect(resolved.split("## Open\n\n")[1]?.split("\n\n")[0]).toBe(
      [
        "- i1 [open] Ship login",
        "  - blockers resolved: i2 [done], ops:i4 [archived]",
        "- i3 [open] Write docs",
        "  - blockers resolved: i2 [done]",
      ].join("\n"),
    );
  });
});

describe("unblocked events", () => {
  const ops = three("ops");
  const other = (backlog: Backlog | undefined) => (domain: string) =>
    domain === "ops" ? backlog : undefined;

  it("seeds on the first read and fires once when the last blocker closes", () => {
    const app = blocked(three(), "i1", ["i2", "ops:i1"]);
    const seeded = unblockedEvents(app, other(ops), null);
    expect(seeded).toEqual({ events: [], blocked: { i1: ["i2", "ops:i1"] } });
    const one = unblockedEvents(close(app, "i2"), other(ops), seeded.blocked);
    expect(one).toEqual({ events: [], blocked: { i1: ["ops:i1"] } });
    const last = unblockedEvents(close(app, "i2"), other(close(ops, "i1")), one.blocked);
    expect(last).toEqual({
      events: [
        {
          kind: "unblocked",
          attrs: { item: "i1" },
          fields: { title: "Ship login", resolved: ["i2 done: shipped", "ops:i1 done: shipped"] },
          text: "every item this one waited on has closed: route it per the skill and policies",
        },
      ],
      blocked: {},
    });
    expect(unblockedEvents(close(app, "i2"), other(close(ops, "i1")), last.blocked).events).toEqual(
      [],
    );
  });

  it("flags a dismissed blocker", () => {
    const app = blocked(three(), "i1", ["i2"]);
    const fired = unblockedEvents(close(app, "i2", true), other(ops), { i1: ["i2"] });
    expect(fired.events).toEqual([
      {
        kind: "unblocked",
        attrs: { item: "i1" },
        fields: { title: "Ship login", resolved: ["i2 dismissed: dropped"], dismissed: "i2" },
        text: "every item this one waited on has closed, but a blocker was dismissed rather than done: check the item still stands, then route it per the skill and policies",
      },
    ]);
  });

  it("fires nothing when a blocker is removed, its backlog is unreadable, or the item closed", () => {
    const app = blocked(three(), "i1", ["i2", "ops:i1"]);
    const removed = unwrap(updateItem(app, update("i1", { unblock: ["i2", "ops:i1"] }))).backlog;
    expect(unblockedEvents(removed, other(ops), { i1: ["i2", "ops:i1"] })).toEqual({
      events: [],
      blocked: {},
    });
    expect(unblockedEvents(close(app, "i2"), other(undefined), { i1: ["i2", "ops:i1"] })).toEqual({
      events: [],
      blocked: { i1: ["ops:i1"] },
    });
    const partly = unwrap(updateItem(app, update("i1", { unblock: ["ops:i1"] }))).backlog;
    expect(unblockedEvents(close(partly, "i1"), other(ops), { i1: ["i2"] }).events).toEqual([]);
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});

eachBackend("coordinate item update --blocked-by", () => {
  it("checks refs across backlogs and shows blockers in both", async () => {
    const state = tempDir();
    dirs.push(state);
    cliState(state);
    const cfg = await Effect.runPromise(
      resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"),
    );
    await runWith(
      start(cfg, "app", { HC_TERMINAL_ID: "t9" }),
      fakeProc((argv) => {
        if (argv[1] === "ls") return ok('{"terminals":[]}');
        if (argv[1] === "get")
          return ok(
            JSON.stringify({
              address: "t9",
              state: "live",
              labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
            }),
          );
        if (argv[1] === "run") return ok('{"address":"t-watch","state":"live"}');
        return ok("{}");
      }).layer,
    );
    await runWith(seedDocument(cfg, "app", { owned: state, titles: ["Ship login"], now: NOW }));
    await runWith(seedDocument(cfg, "ops", { owned: state, titles: ["Migrate db"], now: NOW }));
    const env = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": "app" });
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const run = (...args: string[]) => {
      const done = Bun.spawnSync(["bun", script, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return [done.exitCode, done.stdout.toString() + done.stderr.toString()];
    };
    expect(run("item", "update", "i1", "--blocked-by", "web:i1")).toEqual([
      1,
      "refused: no backlog for domain web, so web:i1 names no item\n",
    ]);
    expect(run("item", "update", "i1", "--blocked-by", "ops:i9")).toEqual([
      1,
      "refused: no item i9 in ops\n",
    ]);
    expect(run("item", "update", "i1", "--blocked-by", "ops:i1")).toEqual([
      0,
      "updated i1 [open] Ship login\n",
    ]);
    expect(readState(state, keys.backlog("app")).items[0].blockedBy).toEqual(["ops:i1"]);
    const open = (domain: string) => {
      const [code, out] = run("backlog", "show", "--domain", domain);
      return [code, String(out).split("## Open\n\n")[1]?.split("\n\n")[0]];
    };
    expect(open("app")).toEqual([
      0,
      ["- i1 [open, blocked] Ship login", "  - blocked by ops:i1 [open]"].join("\n"),
    ]);
    expect(open("ops")).toEqual([0, ["- i1 [open] Migrate db", "  - blocks app:i1"].join("\n")]);
  }, 30_000);
});
