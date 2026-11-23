import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  BacklogError,
  findingAdd,
  findingClose,
  findingPromote,
  itemAdd,
  itemClose,
  itemUpdate,
  policyAdd,
  showBacklog,
} from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, failureOf, runWith, tempDir } from "./fixture.ts";
import { domainOfCaller, Refused } from "./fleet.ts";
import { FINDING_DETAIL_SHAPE, validateBacklog } from "./backlog-store/schema.ts";
import { start } from "./lifecycle.ts";
import { fakeProc, ok } from "./proc.ts";
import { domainStatus } from "./status.ts";

const dirs: string[] = [];
const dir = () => {
  const made = tempDir();
  dirs.push(made);
  return made;
};
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});
const config = (state: string) =>
  Effect.runPromise(resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"));
const hcFake = () =>
  fakeProc((argv) => {
    if (argv[0] === "hc" && argv[1] === "ls") return ok('{"terminals":[]}');
    if (argv[0] === "hc" && argv[1] === "label") return ok("{}");
    if (argv[0] === "hc" && argv[1] === "get")
      return ok(
        JSON.stringify({
          address: "t9",
          state: "live",
          labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
        }),
      );
    if (argv[0] === "hc" && argv[1] === "run") return ok('{"address":"t-watch"}');
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
const NOW = "2026-11-17T10:00:00.000Z";
const COORDINATOR = { "fleet.role": "coordinator", "fleet.domain": "app" };
const LATER = "2026-11-18T09:30:00.000Z";

const started = async () => {
  const state = dir();
  const cfg = await config(state);
  await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t9" }), hcFake().layer);
  return { state, cfg, path: join(state, "backlogs", "app.json") };
};
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const tagged = (error: unknown) =>
  error instanceof Refused || error instanceof BacklogError
    ? { tag: error.constructor.name, message: error.message }
    : { tag: "none", message: String(error) };

describe("start", () => {
  it("records an old Markdown backlog as legacy without reading it", async () => {
    const state = dir();
    const cfg = await config(state);
    mkdirSync(join(state, "md"));
    writeFileSync(join(state, "md", "app-backlog.md"), "## Open\n- i1 not an item {{\n");
    const lines = await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t9" }), hcFake().layer);
    const path = join(state, "backlogs", "app.json");
    expect(lines.slice(1)).toEqual([
      `created backlog ${path}`,
      `recorded legacy Markdown backlog ${join(state, "md", "app-backlog.md")} (reference only, not read)`,
      "watcher starting (t-watch)",
      `harness policy revision 0 (${join(state, "delegate-harness-policy.json")})`,
      "global (legacy): enabled pi, claude; default none",
      "domain app (inherit): enabled pi, claude; default none",
    ]);
    expect(read(path).legacy).toBe(join(state, "md", "app-backlog.md"));
    expect(read(path).items).toEqual([]);
  });

  it("keeps an existing document when run again", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "keep me", json: false, now: NOW }));
    const lines = await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t9" }), hcFake().layer);
    expect(lines.slice(1)).toEqual([
      `backlog ${path}`,
      "watcher starting (t-watch)",
      `harness policy revision 0 (${join(cfg.stateDir, "delegate-harness-policy.json")})`,
      "global (legacy): enabled pi, claude; default none",
      "domain app (inherit): enabled pi, claude; default none",
    ]);
    expect(read(path).items.map((item: { title: string }) => item.title)).toEqual(["keep me"]);
  });

  it("lets status run for a domain that has only its document", async () => {
    const { cfg } = await started();
    expect(await runWith(domainStatus(cfg, "app", false, Date.parse(NOW)), hcFake().layer)).toEqual(
      ["app: 0 live delegates, 0 ended"],
    );
  });
});

describe("item add", () => {
  it("adds open items with short sequential ids", async () => {
    const { cfg, path } = await started();
    expect(
      await runWith(itemAdd(cfg, "app", { title: " fix login ", json: false, now: NOW })),
    ).toEqual(["added i1: fix login"]);
    const printed = await runWith(itemAdd(cfg, "app", { title: "docs", json: true, now: LATER }));
    const second = {
      id: "i2",
      title: "docs",
      status: "open",
      touches: [],
      decided: [],
      ask: null,
      answered: [],
      due: null,
      delegates: [],
      createdAt: LATER,
      closedAt: null,
      outcome: null,
    };
    expect(JSON.parse(printed.join("\n"))).toEqual(second);
    const doc = read(path);
    expect(doc.items.map((item: { id: string }) => item.id)).toEqual(["i1", "i2"]);
    expect(doc.items[1]).toEqual(second);
    expect(doc.nextId).toBe(3);
  });

  it.each([
    ["", "title is empty"],
    ["   ", "title is empty"],
    ["two\nlines", "title must be one line"],
  ])("refuses the title %j and leaves the file unchanged", async (title, message) => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "first", json: false, now: NOW }));
    const before = readFileSync(path, "utf8");
    const error = await failureOf(itemAdd(cfg, "app", { title, json: false, now: NOW }));
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a domain that was never started", async () => {
    const state = dir();
    const error = await failureOf(
      itemAdd(await config(state), "app", { title: "x", json: false, now: NOW }),
    );
    expect(tagged(error)).toEqual({
      tag: "Refused",
      message: `no backlog for app at ${join(state, "backlogs", "app.json")}; run coordinate start app`,
    });
  });

  it("fails as could-not-check on an invalid document, writing nothing", async () => {
    const { cfg, path } = await started();
    writeFileSync(path, '{"schemaVersion":2}');
    const error = await failureOf(itemAdd(cfg, "app", { title: "x", json: false, now: NOW }));
    expect(tagged(error).tag).toBe("BacklogError");
    expect(readFileSync(path, "utf8")).toBe('{"schemaVersion":2}');
  });

  it("never loses or corrupts a write when eight writers race", async () => {
    const { cfg, path } = await started();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runWith(itemAdd(cfg, "app", { title: `w${index}`, json: false, now: NOW })),
      ),
    );
    const doc = read(path);
    expect(doc.items.map((item: { id: string }) => item.id)).toEqual([
      "i1",
      "i2",
      "i3",
      "i4",
      "i5",
      "i6",
      "i7",
      "i8",
    ]);
    expect(doc.items.map((item: { title: string }) => item.title).toSorted()).toEqual([
      "w0",
      "w1",
      "w2",
      "w3",
      "w4",
      "w5",
      "w6",
      "w7",
    ]);
    expect(doc.nextId).toBe(9);
    expect(readdirSync(join(path, "..")).toSorted()).toEqual(["app.json"]);
  });
});

describe("item close", () => {
  it("closes as done or dismissed with the outcome and time", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(itemAdd(cfg, "app", { title: "b", json: false, now: NOW }));
    expect(
      await runWith(
        itemClose(cfg, "app", {
          id: "i1",
          outcome: "shipped",
          dismissed: false,
          json: false,
          now: LATER,
        }),
      ),
    ).toEqual(["done i1: shipped"]);
    const printed = await runWith(
      itemClose(cfg, "app", {
        id: "i2",
        outcome: "not needed",
        dismissed: true,
        json: true,
        now: LATER,
      }),
    );
    expect(JSON.parse(printed.join("\n")).status).toBe("dismissed");
    const doc = read(path);
    expect(
      doc.items.map((item: { status: string; closedAt: string; outcome: string }) => [
        item.status,
        item.closedAt,
        item.outcome,
      ]),
    ).toEqual([
      ["done", LATER, "shipped"],
      ["dismissed", LATER, "not needed"],
    ]);
  });

  it.each([
    ["i1", "", "closing i1 needs an outcome: outcome is empty"],
    ["i1", " ", "closing i1 needs an outcome: outcome is empty"],
    ["i7", "done", "no item i7 in app"],
  ])("refuses %s with outcome %j and leaves the file unchanged", async (id, outcome, message) => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    const before = readFileSync(path, "utf8");
    const error = await failureOf(
      itemClose(cfg, "app", { id, outcome, dismissed: false, json: false, now: LATER }),
    );
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses to close an item twice", async () => {
    const { cfg } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    const close = { id: "i1", outcome: "ok", dismissed: false, json: false, now: LATER };
    await runWith(itemClose(cfg, "app", close));
    expect(tagged(await failureOf(itemClose(cfg, "app", close)))).toEqual({
      tag: "Refused",
      message: "i1 is already done",
    });
  });
});

const finding = (fields: Partial<Parameters<typeof findingAdd>[2]>) => ({
  kind: "issue" as const,
  title: "flaky test",
  detail: "fails one run in ten",
  path: undefined,
  from: undefined,
  source: undefined,
  json: false,
  now: undefined,
  ...fields,
});

describe("finding add", () => {
  it("adds open findings with short ids f1, f2", async () => {
    const { cfg, path } = await started();
    expect(await runWith(findingAdd(cfg, "app", finding({ title: " flaky test " })))).toEqual([
      "added f1: flaky test",
    ]);
    const printed = await runWith(
      findingAdd(
        cfg,
        "app",
        finding({
          kind: "opportunity",
          title: "cache builds",
          detail: "CI rebuilds deps\nevery run",
          path: "ci/build.yml",
          json: true,
        }),
      ),
    );
    const second = {
      id: "f2",
      kind: "opportunity",
      title: "cache builds",
      detail: "CI rebuilds deps\nevery run",
      path: "ci/build.yml",
      from: null,
      status: "open",
      closedAt: null,
      outcome: null,
    };
    expect(JSON.parse(printed.join("\n"))).toEqual(second);
    const doc = read(path);
    expect(doc.findings.map((entry: { id: string }) => entry.id)).toEqual(["f1", "f2"]);
    expect(doc.findings[1]).toEqual(second);
    expect(doc.nextId).toBe(3);
  });

  it("links a finding to the item it came from", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    await runWith(findingAdd(cfg, "app", finding({ from: "i1" })));
    expect(
      read(path).findings.map((entry: { id: string; from: string }) => [entry.id, entry.from]),
    ).toEqual([["f2", "i1"]]);
  });

  it.each([
    [{ from: "i9" }, "no item i9 in app to file a finding from"],
    [{ title: "" }, "title is empty"],
    [{ title: "two\nlines" }, "title must be one line"],
    [{ path: "a\nb" }, "path must be one line"],
    [{ path: " " }, "path is empty"],
    [{ detail: " " }, "detail is empty"],
    [
      { detail: undefined },
      `a finding needs a detail: pass --detail-md with ${FINDING_DETAIL_SHAPE}`,
    ],
  ])("refuses %j and leaves the file unchanged", async (fields, message) => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    const before = readFileSync(path, "utf8");
    const error = await failureOf(findingAdd(cfg, "app", finding(fields)));
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

const hcGet = (labels: Record<string, string>) =>
  fakeProc((argv) => {
    if (argv.slice(0, 3).join(" ") === "hc get t2")
      return ok(JSON.stringify({ address: "t2", name: "fix-a", state: "live", labels }));
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
const addFrom = (cfg: Awaited<ReturnType<typeof config>>, env: Record<string, string>) =>
  Effect.flatMap(domainOfCaller(undefined, env), (domain) =>
    findingAdd(cfg, domain, finding({ from: "i1" })),
  );

describe("finding add from a delegate terminal", () => {
  it.each([
    ["a delegate", { "fleet.domain": "app" }],
    ["a coordinator", { "fleet.domain": "app", "fleet.role": "coordinator" }],
  ])("files into the domain labelled on %s terminal", async (_name, labels) => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    expect(await runWith(addFrom(cfg, { HC_TERMINAL_ID: "t2" }), hcGet(labels).layer)).toEqual([
      "added f2: flaky test",
    ]);
    expect(read(path).findings.map((entry: { from: string }) => entry.from)).toEqual(["i1"]);
  });

  it("refuses a terminal with no domain label", async () => {
    const { cfg } = await started();
    expect(
      tagged(await failureOf(addFrom(cfg, { HC_TERMINAL_ID: "t2" }), hcGet({}).layer)),
    ).toEqual({
      tag: "Refused",
      message: "terminal t2 carries no fleet.domain label; pass --domain",
    });
  });

  it("refuses outside a Herdr terminal", async () => {
    const { cfg } = await started();
    expect(tagged(await failureOf(addFrom(cfg, {}), hcGet({}).layer))).toEqual({
      tag: "Refused",
      message: "HC_TERMINAL_ID is unset: run this inside a Herdr terminal, or pass --domain",
    });
  });
});

describe("finding close", () => {
  it("closes as acted or dismissed with the outcome and time", async () => {
    const { cfg, path } = await started();
    await runWith(findingAdd(cfg, "app", finding({ title: "a" })));
    await runWith(findingAdd(cfg, "app", finding({ title: "b" })));
    expect(
      await runWith(
        findingClose(cfg, "app", {
          id: "f1",
          outcome: "filed as i3",
          dismissed: false,
          json: false,
          now: LATER,
        }),
      ),
    ).toEqual(["acted f1: filed as i3"]);
    const printed = await runWith(
      findingClose(cfg, "app", {
        id: "f2",
        outcome: "not worth it",
        dismissed: true,
        json: true,
        now: LATER,
      }),
    );
    expect(JSON.parse(printed.join("\n")).status).toBe("dismissed");
    expect(
      read(path).findings.map((entry: { status: string; closedAt: string; outcome: string }) => [
        entry.status,
        entry.closedAt,
        entry.outcome,
      ]),
    ).toEqual([
      ["acted", LATER, "filed as i3"],
      ["dismissed", LATER, "not worth it"],
    ]);
  });

  it.each([
    ["f1", "", "closing f1 needs an outcome: outcome is empty"],
    ["f1", "a\nb", "closing f1 needs an outcome: outcome must be one line"],
    ["f7", "done", "no finding f7 in app"],
    ["i1", "done", "no finding i1 in app"],
  ])("refuses %s with outcome %j and leaves the file unchanged", async (id, outcome, message) => {
    const { cfg, path } = await started();
    await runWith(findingAdd(cfg, "app", finding({})));
    const before = readFileSync(path, "utf8");
    const error = await failureOf(
      findingClose(cfg, "app", { id, outcome, dismissed: false, json: false, now: LATER }),
    );
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses to close a finding twice", async () => {
    const { cfg } = await started();
    await runWith(findingAdd(cfg, "app", finding({})));
    const close = { id: "f1", outcome: "ok", dismissed: true, json: false, now: LATER };
    await runWith(findingClose(cfg, "app", close));
    expect(tagged(await failureOf(findingClose(cfg, "app", close)))).toEqual({
      tag: "Refused",
      message: "f1 is already dismissed",
    });
  });
});

describe("finding promote", () => {
  it("adds an open item titled after the finding and closes it as promoted, in one write", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    await runWith(findingAdd(cfg, "app", finding({ title: "share the validator", from: "i1" })));
    expect(
      await runWith(
        findingPromote(cfg, "app", { id: "f2", title: undefined, json: false, now: LATER }),
      ),
    ).toEqual(["promoted f2 to i3: share the validator"]);
    const after = read(path);
    expect(
      after.items.map((item: { id: string; title: string; status: string }) => [
        item.id,
        item.title,
        item.status,
      ]),
    ).toEqual([
      ["i1", "fix login", "open"],
      ["i3", "share the validator", "open"],
    ]);
    expect(after.items[1].createdAt).toBe(LATER);
    expect(after.findings).toEqual([
      {
        id: "f2",
        kind: "issue",
        title: "share the validator",
        detail: "fails one run in ten",
        path: null,
        from: "i1",
        status: "acted",
        closedAt: LATER,
        outcome: "promoted to i3",
      },
    ]);
    expect(after.nextId).toBe(4);
  });

  it("uses a title override and prints both records as JSON", async () => {
    const { cfg } = await started();
    await runWith(findingAdd(cfg, "app", finding({ title: "flaky test" })));
    const printed = await runWith(
      findingPromote(cfg, "app", {
        id: "f1",
        title: " stabilize the watcher test ",
        json: true,
        now: LATER,
      }),
    );
    const parsed = JSON.parse(printed.join("\n"));
    expect([parsed.item.id, parsed.item.title, parsed.item.status]).toEqual([
      "i2",
      "stabilize the watcher test",
      "open",
    ]);
    expect([parsed.finding.id, parsed.finding.status, parsed.finding.outcome]).toEqual([
      "f1",
      "acted",
      "promoted to i2",
    ]);
  });

  it.each([
    ["f7", undefined, "no finding f7 in app"],
    ["i1", undefined, "no finding i1 in app"],
    ["f1", "a\nb", "title must be one line"],
    ["f1", " ", "title is empty"],
  ])("refuses %s with title %j and leaves the file unchanged", async (id, title, message) => {
    const { cfg, path } = await started();
    await runWith(findingAdd(cfg, "app", finding({})));
    const before = readFileSync(path, "utf8");
    const error = await failureOf(
      findingPromote(cfg, "app", { id, title, json: false, now: LATER }),
    );
    expect(tagged(error)).toEqual({ tag: "Refused", message });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each([
    [false, "f1 is already acted"],
    [true, "f1 is already dismissed"],
  ])(
    "refuses a closed finding (dismissed %p) before checking the title",
    async (dismissed, message) => {
      const { cfg, path } = await started();
      await runWith(findingAdd(cfg, "app", finding({})));
      await runWith(
        findingClose(cfg, "app", { id: "f1", outcome: "ok", dismissed, json: false, now: LATER }),
      );
      const before = readFileSync(path, "utf8");
      const error = await failureOf(
        findingPromote(cfg, "app", { id: "f1", title: "a\nb", json: false, now: LATER }),
      );
      expect(tagged(error)).toEqual({ tag: "Refused", message });
      expect(readFileSync(path, "utf8")).toBe(before);
    },
  );
});

const update = (fields: Partial<Parameters<typeof itemUpdate>[2]>) => ({
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
  answer: undefined,
  json: false,
  now: LATER,
  ...fields,
});

describe("item update", () => {
  it("sets open, building, in-review and parked, printing the item", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    expect(await runWith(itemUpdate(cfg, "app", update({ status: "building" })))).toEqual([
      "updated i1 [building] a",
    ]);
    expect(read(path).items[0].status).toBe("building");
    const printed = await runWith(itemUpdate(cfg, "app", update({ status: "parked", json: true })));
    expect(JSON.parse(printed.join("\n"))).toEqual(read(path).items[0]);
    expect(read(path).items[0].status).toBe("parked");
    await runWith(itemUpdate(cfg, "app", update({ status: "in-review" })));
    expect(read(path).items[0].status).toBe("in-review");
    await runWith(itemUpdate(cfg, "app", update({ status: "open" })));
    expect(read(path).items[0].status).toBe("open");
  });

  it("lists an in-review item as open, ahead of open items, in backlog show", async () => {
    const { cfg } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(itemAdd(cfg, "app", { title: "b", json: false, now: NOW }));
    await runWith(itemUpdate(cfg, "app", update({ id: "i2", status: "in-review" })));
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n");
    expect(shown.split("## Open\n\n")[1]?.split("\n\n")[0]).toBe(
      ["- i2 [in-review] b", "- i1 [open] a"].join("\n"),
    );
  });

  it("closes through done or dismissed with an outcome, and reopening clears it", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(itemAdd(cfg, "app", { title: "b", json: false, now: NOW }));
    await runWith(itemUpdate(cfg, "app", update({ status: "done", outcome: " shipped " })));
    await runWith(
      itemUpdate(cfg, "app", update({ id: "i2", status: "dismissed", outcome: "moot" })),
    );
    expect(
      read(path).items.map((entry: Record<string, unknown>) => [
        entry.status,
        entry.closedAt,
        entry.outcome,
      ]),
    ).toEqual([
      ["done", LATER, "shipped"],
      ["dismissed", LATER, "moot"],
    ]);
    expect(
      tagged(
        await failureOf(itemUpdate(cfg, "app", update({ status: "dismissed", outcome: "x" }))),
      ),
    ).toEqual({
      tag: "Refused",
      message: "i1 is already done",
    });
    expect(tagged(await failureOf(itemUpdate(cfg, "app", update({ ask: "q" }))))).toEqual({
      tag: "Refused",
      message: "an ask needs an item that is not done or dismissed",
    });
    await runWith(itemUpdate(cfg, "app", update({ status: "building" })));
    expect(read(path).items[0]).toMatchObject({
      status: "building",
      closedAt: null,
      outcome: null,
    });
  });

  it("sets delegated on an item that already has a delegate", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    const doc = read(path);
    const ref = {
      name: "fix-a",
      session: "s-1",
      branch: null,
      worktree: null,
      brief: "/b.md",
      report: "/r.md",
    };
    doc.items[0] = { ...doc.items[0], status: "building", delegates: [ref] };
    writeFileSync(path, JSON.stringify(doc));
    await runWith(itemUpdate(cfg, "app", update({ status: "delegated" })));
    expect(read(path).items[0]).toMatchObject({ status: "delegated", delegates: [ref] });
  });

  it("appends dated decisions, so waiting-user can rest on one", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(
      itemUpdate(
        cfg,
        "app",
        update({ status: "waiting-user", decided: ["land via PR; waiting on the user to merge"] }),
      ),
    );
    await runWith(itemUpdate(cfg, "app", update({ decided: [" keep v1 ", "no flag"], now: NOW })));
    expect(read(path).items[0]).toMatchObject({
      status: "waiting-user",
      decided: [
        { text: "land via PR; waiting on the user to merge", at: "2026-11-18" },
        { text: "keep v1", at: "2026-11-17" },
        { text: "no flag", at: "2026-11-17" },
      ],
    });
  });

  it("adds and removes touched repos, and sets and clears the due date", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(
      itemUpdate(cfg, "app", update({ touch: ["/r/api", "/r/web", "/r/api"], due: "2026-12-01" })),
    );
    expect(read(path).items[0]).toMatchObject({ touches: ["/r/api", "/r/web"], due: "2026-12-01" });
    await runWith(
      itemUpdate(cfg, "app", update({ touch: ["/r/cli"], untouch: ["/r/api"], due: null })),
    );
    expect(read(path).items[0]).toMatchObject({ touches: ["/r/web", "/r/cli"], due: null });
  });

  it("attaches a structured ask, rendered with the recommendation first", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "pick a store", json: false, now: NOW }));
    await runWith(
      itemUpdate(
        cfg,
        "app",
        update({
          status: "waiting-user",
          ask: "Which store?",
          context: "both work",
          options: ["sqlite", "json"],
          rec: "json",
          why: "no dependency",
        }),
      ),
    );
    expect(read(path).items[0].ask).toEqual({
      question: "Which store?",
      context: "both work",
      options: ["sqlite", "json"],
      rec: "json",
      recReason: "no dependency",
      discuss: null,
    });
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n");
    expect(shown.split("## Open\n\n")[1]?.split("\n\n")[0]).toBe(
      [
        "- i1 [waiting-user] pick a store",
        "  - ask: Which store?",
        "    - context: both work",
        "    - json (recommended: no dependency)",
        "    - sqlite",
      ].join("\n"),
    );
    await runWith(itemUpdate(cfg, "app", update({ ask: "Ship today?", options: ["yes", "no"] })));
    expect(read(path).items[0].ask).toEqual({
      question: "Ship today?",
      context: null,
      options: ["yes", "no"],
      rec: null,
      recReason: null,
      discuss: null,
    });
  });

  it("defaults answered history on legacy items when read and persists it on the next write", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    const legacy = read(path);
    delete legacy.items[0].answered;
    writeFileSync(path, JSON.stringify(legacy));

    const shown = JSON.parse((await runWith(showBacklog(cfg, "app", true))).join("\n"));
    expect(shown.items[0].answered).toEqual([]);
    expect(read(path).items[0].answered).toBe(undefined);

    await runWith(itemUpdate(cfg, "app", update({ decided: ["kept history"], now: NOW })));
    expect(read(path).items[0].answered).toEqual([]);
  });

  it("records Discuss as an open discussion request, not a completed answer", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(
      itemUpdate(
        cfg,
        "app",
        update({
          status: "waiting-user",
          ask: "Which store?",
          options: ["sqlite", "json"],
        }),
      ),
    );

    const printed = await runWith(
      itemUpdate(cfg, "app", update({ answer: "Discuss: compare migration support", json: true })),
    );
    const item = JSON.parse(printed.join("\n"));
    expect(item.status).toBe("waiting-user");
    expect(item.ask).toEqual({
      question: "Which store?",
      context: null,
      options: ["sqlite", "json"],
      rec: null,
      recReason: null,
      discuss: { note: "compare migration support", at: "2026-11-18" },
    });
    expect(item.answered).toEqual([]);
    expect(item.decided).toEqual([
      { text: 'Discuss "Which store?": compare migration support', at: "2026-11-18" },
    ]);
    expect(read(path).items[0]).toEqual(item);
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n");
    expect(shown).toContain("    - discussion requested (2026-11-18): compare migration support");
  });

  it("migrates missing discussion markers on open and answered asks", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(
      itemUpdate(
        cfg,
        "app",
        update({ status: "waiting-user", ask: "Which store?", options: ["A", "B"] }),
      ),
    );
    await runWith(itemUpdate(cfg, "app", update({ answer: "Discuss: compare migration" })));
    expect(read(path).items[0].ask.discuss).toEqual({
      note: "compare migration",
      at: "2026-11-18",
    });
    await runWith(itemUpdate(cfg, "app", update({ ask: "Revised question?", options: ["C"] })));
    expect(read(path).items[0].ask.discuss).toBe(null);
    await runWith(itemUpdate(cfg, "app", update({ answer: "Discuss" })));
    await runWith(itemUpdate(cfg, "app", update({ answer: "C" })));
    expect(read(path).items[0].answered[0].discuss).toBe(null);
    await runWith(itemUpdate(cfg, "app", update({ ask: "Where next?", options: ["D"] })));

    const legacy = read(path);
    delete legacy.items[0].ask.discuss;
    delete legacy.items[0].answered[0].discuss;
    delete legacy.items[0].answered[0].note;
    writeFileSync(path, JSON.stringify(legacy));

    const shown = JSON.parse((await runWith(showBacklog(cfg, "app", true))).join("\n"));
    expect(shown.items[0].ask.discuss).toBe(null);
    expect(shown.items[0].answered[0].discuss).toBe(null);
    expect(shown.items[0].answered[0].note).toBe(null);
    expect(read(path).items[0].ask.discuss).toBe(undefined);

    await runWith(itemUpdate(cfg, "app", update({ decided: ["persist migration"] })));
    expect(read(path).items[0].ask.discuss).toBe(null);
    expect(read(path).items[0].answered[0].discuss).toBe(null);
  });

  it("rejects malformed discussion request fields", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(
      itemUpdate(
        cfg,
        "app",
        update({ status: "waiting-user", ask: "Which store?", options: ["A", "B"] }),
      ),
    );
    const backlog = read(path);
    backlog.items[0].ask.discuss = { note: 12, at: "tomorrow" };
    expect(validateBacklog(backlog)).toEqual({
      ok: false,
      errors: [
        "items[0].ask.discuss.note must be a string",
        "items[0].ask.discuss.at must be YYYY-MM-DD",
      ],
    });
  });

  it("keeps a Discuss note verbatim while flattening its decision event", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(itemUpdate(cfg, "app", update({ status: "waiting-user", ask: "Proceed?" })));
    await runWith(itemUpdate(cfg, "app", update({ answer: "Discuss", note: "first\nsecond" })));
    const item = read(path).items[0];
    expect(item.status).toBe("waiting-user");
    expect(item.ask.discuss.note).toBe("first\nsecond");
    expect(item.decided.at(-1).text).toBe('Discuss "Proceed?": first second');
    expect(item.answered).toEqual([]);
    expect((await runWith(showBacklog(cfg, "app", false))).join("\n")).toContain(
      "discussion requested (2026-11-18): first\nsecond",
    );
  });

  it("stores a flattened answer note, appends it to the decision, and renders it", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(itemUpdate(cfg, "app", update({ status: "waiting-user", ask: "Proceed?" })));
    await runWith(itemUpdate(cfg, "app", update({ answer: "yes", note: "because\nit is safe" })));
    const answered = read(path).items[0].answered[0];
    expect(answered.note).toBe("because\nit is safe");
    expect(read(path).items[0].decided.at(-1).text).toBe(
      'Re "Proceed?": yes. Note: because it is safe',
    );
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n");
    expect(shown).toContain(
      `  - answered (${answered.answeredAt}): Proceed? → yes. Note: because it is safe`,
    );
  });

  it("answering an ask keeps its details in history and records the answer as a dated decision", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    await runWith(
      itemUpdate(
        cfg,
        "app",
        update({
          status: "waiting-user",
          ask: "Which store?",
          context: "Both options work",
          options: ["sqlite :: embedded", "json :: already installed"],
          rec: "json",
          why: "Already in use",
          now: NOW,
        }),
      ),
    );
    const printed = await runWith(
      itemUpdate(cfg, "app", update({ answer: "json, but keep it small", json: true })),
    );
    const answered = {
      id: "i1",
      title: "a",
      status: "waiting-user",
      touches: [],
      decided: [{ text: 'Re "Which store?": json, but keep it small', at: "2026-11-18" }],
      ask: null,
      answered: [
        {
          question: "Which store?",
          context: "Both options work",
          options: ["sqlite", "json"],
          optionDetails: ["embedded", "already installed"],
          rec: "json",
          recReason: "Already in use",
          discuss: null,
          answer: "json, but keep it small",
          note: null,
          answeredAt: "2026-11-18",
        },
      ],
      due: null,
      delegates: [],
      createdAt: NOW,
      closedAt: null,
      outcome: null,
    };
    expect(JSON.parse(printed.join("\n"))).toEqual(answered);
    expect(read(path).items[0]).toEqual(answered);
    await runWith(
      itemUpdate(cfg, "app", update({ ask: "Where next?", options: ["cache"], rec: "cache" })),
    );
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n");
    const item = shown.split("## Open\n\n")[1]?.split("\n\n")[0] ?? "";
    expect(item).toBe(
      [
        "- i1 [waiting-user] a",
        "  - ask: Where next?",
        "    - cache (recommended)",
        "  - answered (2026-11-18): Which store? → json, but keep it small",
        '  - decided 2026-11-18: Re "Which store?": json, but keep it small',
      ].join("\n"),
    );

    const verbose = (await runWith(showBacklog(cfg, "app", false, undefined, false, true))).join(
      "\n",
    );
    const verboseItem = verbose.split("## Open\n\n")[1]?.split("\n\n")[0] ?? "";
    expect(verboseItem).toBe(
      [
        "- i1 [waiting-user] a",
        "  - ask: Where next?",
        "    - cache (recommended)",
        "  - answered ask (2026-11-18): Which store?",
        "    - context: Both options work",
        "    - json (recommended: Already in use): already installed",
        "    - sqlite: embedded",
        "    - answer: json, but keep it small",
        '  - decided 2026-11-18: Re "Which store?": json, but keep it small',
      ].join("\n"),
    );

    await runWith(
      itemClose(cfg, "app", {
        id: "i1",
        outcome: "finished",
        dismissed: false,
        json: false,
        now: LATER,
      }),
    );
    const done = (await runWith(showBacklog(cfg, "app", false, undefined, true)))
      .join("\n")
      .split("## Done\n\n")[1];
    expect(done).toContain("  - answered (2026-11-18): Which store? → json, but keep it small");
    const verboseDone = (await runWith(showBacklog(cfg, "app", false, undefined, true, true)))
      .join("\n")
      .split("## Done\n\n")[1];
    expect(verboseDone).toContain("  - answered ask (2026-11-18): Which store?");
    expect(verboseDone).toContain("    - answer: json, but keep it small");
  });

  it.each([
    ["an unknown id", update({ id: "i7", status: "parked" }), "no item i7 in app"],
    ["no changes", update({}), "nothing to update on i1"],
    ["a note without an answer", update({ note: "extra context" }), "--note needs --answer"],
    ["done without an outcome", update({ status: "done" }), "i1 needs --outcome to become done"],
    [
      "dismissed with a blank outcome",
      update({ status: "dismissed", outcome: " " }),
      "i1 needs --outcome to become dismissed",
    ],
    [
      "an outcome without a closing status",
      update({ outcome: "x" }),
      "--outcome needs --status done or dismissed",
    ],
    ["a two-line decision", update({ decided: ["a\nb"] }), "decided must be one line"],
    ["a blank touch", update({ touch: [" "] }), "touch is empty"],
    ["removing an untouched repo", update({ untouch: ["/r/x"] }), "i1 does not touch /r/x"],
    ["a malformed due date", update({ due: "tomorrow" }), "due must be a date as YYYY-MM-DD"],
    ["an impossible due date", update({ due: "2026-02-30" }), "due must be a date as YYYY-MM-DD"],
    ["a thirteenth month", update({ due: "2026-13-01" }), "due must be a date as YYYY-MM-DD"],
    ["a 32nd day", update({ due: "2026-02-32" }), "due must be a date as YYYY-MM-DD"],
    [
      "an ask on an item it closes",
      update({ status: "done", outcome: "x", ask: "q" }),
      "an ask needs an item that is not done or dismissed",
    ],
    [
      "a rec outside the options",
      update({ ask: "q", options: ["a", "b"], rec: "c" }),
      "--rec c must be one of the --option values: a, b",
    ],
    [
      "a rec with no options",
      update({ ask: "q", rec: "a" }),
      "--rec a must be one of the --option values: (none)",
    ],
    ["a reason without a rec", update({ ask: "q", options: ["a"], why: "w" }), "--why needs --rec"],
    [
      "duplicate options",
      update({ ask: "q", options: ["a", "a"] }),
      "--option values must be unique",
    ],
    [
      "ask parts without an ask",
      update({ options: ["a"] }),
      "--context, --option, --rec and --why need --ask",
    ],
    ["a blank question", update({ ask: " " }), "ask is empty"],
    ["an answer with no ask", update({ answer: "yes" }), "i1 has no ask to answer"],
    [
      "an answer beside a new ask",
      update({ ask: "q", answer: "yes" }),
      "--answer and --ask cannot be combined",
    ],
    [
      "delegated without a delegate",
      update({ status: "delegated" }),
      "i1 cannot be delegated without a delegate; coordinate delegate --item i1 records one",
    ],
    [
      "waiting-user without an ask or decision",
      update({ status: "waiting-user" }),
      "i1 cannot wait on the user without an ask (--ask) or a decision naming the pending integration (--decided)",
    ],
  ])("refuses %s and leaves the file unchanged", async (_name, input, message) => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    const before = readFileSync(path, "utf8");
    expect(tagged(await failureOf(itemUpdate(cfg, "app", input)))).toEqual({
      tag: "Refused",
      message,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("status --resume", () => {
  it("prints option details in the rendered backlog", async () => {
    const { cfg } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    await runWith(
      itemUpdate(cfg, "app", {
        id: "i1",
        status: "waiting-user",
        outcome: undefined,
        decided: [],
        touch: [],
        untouch: [],
        due: undefined,
        ask: "Which?",
        context: "context",
        options: ["a :: alpha :: tail", "b"],
        rec: "a",
        why: "preferred",
        answer: undefined,
        now: NOW,
        json: false,
      }),
    );
    await runWith(itemUpdate(cfg, "app", update({ answer: "Discuss: compare options" })));
    const lines = await runWith(domainStatus(cfg, "app", true, Date.parse(NOW)), hcFake().layer);
    expect(lines).toEqual([
      "app: 0 live delegates, 0 ended",
      "",
      ...(await runWith(showBacklog(cfg, "app", false))),
      "",
      `harness policy revision 0 (${join(cfg.stateDir, "delegate-harness-policy.json")})`,
      "global (legacy): enabled pi, claude; default none",
      "domain app (inherit): enabled pi, claude; default none",
      "",
      "no watcher running",
    ]);
    expect(lines[2]?.split("\n").slice(0, 1)).toEqual(["# app backlog"]);
    expect(lines[2]).toContain("    - discussion requested (2026-11-18): compare options");
    expect(lines[2]?.split("\n").filter((line) => /^    - [ab](?: |$)/.test(line))).toEqual([
      "    - a (recommended: preferred): alpha :: tail",
      "    - b",
    ]);
  });

  it("names an invalid document instead of failing the whole status", async () => {
    const { cfg, path } = await started();
    writeFileSync(path, '{"schemaVersion":2}');
    const lines = await runWith(domainStatus(cfg, "app", true, Date.parse(NOW)), hcFake().layer);
    expect(lines[2]).toBe(
      `could not read the backlog: ${path} is invalid: schemaVersion must be 1; domain must be a non-empty string; focus must be a string or null; legacy must be a string or null; boundary must be an object; policies must be a list; nextId must be a positive integer; nextPolicyId must be a positive integer; items must be a list; findings must be a list`,
    );
  });

  it("refuses a domain with neither a document nor a legacy Markdown backlog", async () => {
    const state = dir();
    const error = await failureOf(
      domainStatus(await config(state), "app", true, Date.parse(NOW)),
      hcFake().layer,
    );
    expect(tagged(error)).toEqual({
      tag: "Refused",
      message: `no backlog for app at ${join(state, "backlogs", "app.json")}; run coordinate start app`,
    });
  });

  it("names the missing document when only a legacy Markdown backlog exists", async () => {
    const state = dir();
    const cfg = await config(state);
    mkdirSync(join(state, "md"));
    writeFileSync(join(state, "md", "app-backlog.md"), "## Open\n- old item\n");
    expect(await runWith(domainStatus(cfg, "app", true, Date.parse(NOW)), hcFake().layer)).toEqual([
      "app: 0 live delegates, 0 ended",
      "",
      `no backlog for app at ${join(state, "backlogs", "app.json")}; run coordinate start app`,
      "",
      "no watcher running",
    ]);
  });
});

describe("backlog show", () => {
  it("hides closed items by default and prints them with --done", async () => {
    const state = dir();
    const cfg = await config(state);
    mkdirSync(join(state, "md"));
    writeFileSync(join(state, "md", "app-backlog.md"), "old\n");
    await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t9" }), hcFake().layer);
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    await runWith(itemAdd(cfg, "app", { title: "docs", json: false, now: NOW }));
    await runWith(itemAdd(cfg, "app", { title: "ignored", json: false, now: NOW }));
    await runWith(
      itemClose(cfg, "app", {
        id: "i2",
        outcome: "merged",
        dismissed: false,
        json: false,
        now: LATER,
      }),
    );
    await runWith(
      itemClose(cfg, "app", {
        id: "i3",
        outcome: "not planned",
        dismissed: true,
        json: false,
        now: LATER,
      }),
    );
    expect(await runWith(showBacklog(cfg, "app", false))).toEqual([
      [
        "# app backlog",
        "",
        `Legacy Markdown backlog (reference only, not read): ${join(state, "md", "app-backlog.md")}`,
        "",
        "## Boundary",
        "",
        "- Owned: (none)",
        "- Adjacent: (none)",
        "",
        "## Policies",
        "",
        "(none)",
        "",
        "## Open",
        "",
        "- i1 [open] fix login",
        "",
        "## Findings",
        "",
        "(none)",
        "",
        "## Done",
        "",
        "2 closed items hidden (coordinate backlog show --done)",
      ].join("\n"),
    ]);
    expect(await runWith(showBacklog(cfg, "app", false, undefined, true))).toEqual([
      [
        "# app backlog",
        "",
        `Legacy Markdown backlog (reference only, not read): ${join(state, "md", "app-backlog.md")}`,
        "",
        "## Boundary",
        "",
        "- Owned: (none)",
        "- Adjacent: (none)",
        "",
        "## Policies",
        "",
        "(none)",
        "",
        "## Open",
        "",
        "- i1 [open] fix login",
        "",
        "## Findings",
        "",
        "(none)",
        "",
        "## Done",
        "",
        "- i2 [done 2026-11-18] docs: merged",
        "- i3 [dismissed 2026-11-18] ignored: not planned",
      ].join("\n"),
    ]);
  });

  it("lists open findings and leaves closed ones out", async () => {
    const { cfg } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    await runWith(findingAdd(cfg, "app", finding({ title: "flaky test", from: "i1" })));
    await runWith(findingAdd(cfg, "app", finding({ kind: "opportunity", title: "cache builds" })));
    await runWith(findingAdd(cfg, "app", finding({ title: "old typo" })));
    await runWith(
      findingClose(cfg, "app", {
        id: "f4",
        outcome: "fixed",
        dismissed: false,
        json: false,
        now: LATER,
      }),
    );
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n").split("\n");
    const at = shown.indexOf("## Findings");
    expect(shown.slice(at, shown.indexOf("## Done"))).toEqual([
      "## Findings",
      "",
      "- f2 [issue] flaky test (from i1)",
      "- f3 [opportunity] cache builds",
      "",
    ]);
  });

  it("prints the document with --json", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    expect(
      JSON.parse((await runWith(showBacklog(cfg, "app", true, undefined, true))).join("\n")),
    ).toEqual(read(path));
  });
});

describe("backlog policies", () => {
  it("migrates legacy entries in order on read and persists the new shape on write", async () => {
    const { cfg, path } = await started();
    const legacy = {
      schemaVersion: 1,
      domain: "app",
      focus: null,
      legacy: null,
      boundary: { owned: [], adjacent: [] },
      standingYes: [
        { text: "merge doc PRs", at: "2026-11-15" },
        { text: "rebase freely", at: "2026-11-16T08:00:00.000Z" },
      ],
      items: [],
      findings: [],
      nextId: 1,
    };
    writeFileSync(path, JSON.stringify(legacy));

    const shown = JSON.parse((await runWith(showBacklog(cfg, "app", true))).join("\n"));
    expect(shown.policies).toEqual([
      { id: "p1", text: "merge doc PRs", at: "2026-11-15" },
      { id: "p2", text: "rebase freely", at: "2026-11-16T08:00:00.000Z" },
    ]);
    expect(shown.nextPolicyId).toBe(3);
    expect(read(path)).toEqual(legacy);

    await runWith(
      policyAdd(cfg, "app", {
        text: "future builds use Bun",
        at: undefined,
        wiki: undefined,
        json: false,
        now: NOW,
      }),
    );
    const stored = read(path);
    expect(stored.policies).toEqual([
      { id: "p1", text: "merge doc PRs", at: "2026-11-15" },
      { id: "p2", text: "rebase freely", at: "2026-11-16T08:00:00.000Z" },
      { id: "p3", text: "future builds use Bun", at: "2026-11-17" },
    ]);
    expect(stored.nextPolicyId).toBe(4);
    expect(Object.keys(stored).toSorted()).toEqual([
      "boundary",
      "domain",
      "findings",
      "focus",
      "items",
      "legacy",
      "nextId",
      "nextPolicyId",
      "policies",
      "schemaVersion",
    ]);
  });

  it("adds, lists, replaces and removes policies by id, refusing unknown ids", async () => {
    const { state, path } = await started();
    const env = cliEnv(state, COORDINATOR);
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const run = (args: string[]) => {
      const result = Bun.spawnSync(["bun", script, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return [result.exitCode, result.stdout.toString(), result.stderr.toString()];
    };

    expect(
      run(["backlog", "policy", "add", "first", "--at", "2026-11-19", "--domain", "app"]),
    ).toEqual([0, "added policy p1: first\n", ""]);
    expect(
      run(["backlog", "policy", "add", "second", "--at", "2026-11-19", "--domain", "app"]),
    ).toEqual([0, "added policy p2: second\n", ""]);
    expect(run(["backlog", "policy", "ls", "--domain", "app"])).toEqual([
      0,
      "p1 2026-11-19: first\np2 2026-11-19: second\n",
      "",
    ]);
    const replaced = run([
      "backlog",
      "policy",
      "replace",
      "p1",
      "updated",
      "--at",
      "2026-11-20",
      "--domain",
      "app",
      "--json",
    ]);
    expect([replaced[0], JSON.parse(String(replaced[1] ?? "{}")), replaced[2]]).toEqual([
      0,
      { id: "p1", text: "updated", at: "2026-11-20" },
      "",
    ]);
    expect(run(["backlog", "policy", "rm", "p1", "--domain", "app"])).toEqual([
      0,
      "removed policy p1: updated\n",
      "",
    ]);
    expect(
      run(["backlog", "policy", "add", "third", "--at", "2026-11-21", "--domain", "app"]),
    ).toEqual([0, "added policy p3: third\n", ""]);
    expect(run(["backlog", "policy", "rm", "p3", "--domain", "app"])).toEqual([
      0,
      "removed policy p3: third\n",
      "",
    ]);
    expect(
      run(["backlog", "policy", "add", "fourth", "--at", "2026-11-22", "--domain", "app"]),
    ).toEqual([0, "added policy p4: fourth\n", ""]);
    expect(read(path).policies).toEqual([
      { id: "p2", text: "second", at: "2026-11-19" },
      { id: "p4", text: "fourth", at: "2026-11-22" },
    ]);
    expect(read(path).nextPolicyId).toBe(5);
    const beforeUnknown = readFileSync(path, "utf8");
    expect(run(["backlog", "policy", "rm", "p9", "--domain", "app"])).toEqual([
      1,
      "",
      "refused: no policy p9 in app\n",
    ]);
    expect(readFileSync(path, "utf8")).toBe(beforeUnknown);
  });
});

describe("invalid documents", () => {
  const item = (fields: Record<string, unknown>) => ({
    id: "i1",
    title: "a",
    status: "open",
    touches: [],
    decided: [],
    ask: null,
    due: null,
    delegates: [],
    createdAt: NOW,
    closedAt: null,
    outcome: null,
    ...fields,
  });
  const doc = (fields: Record<string, unknown>) => ({
    schemaVersion: 1,
    domain: "app",
    focus: null,
    legacy: null,
    boundary: { owned: [], adjacent: [] },
    policies: [],
    items: [],
    findings: [],
    nextId: 3,
    nextPolicyId: 1,
    ...fields,
  });
  it.each([
    ["a non-object", [], "the document must be a JSON object"],
    ["a missing list", doc({ items: undefined }), "items must be a list"],
    ["a duplicate id", doc({ items: [item({}), item({})] }), "items[1].id i1 is not unique"],
    [
      "an id not below nextId",
      doc({ items: [item({ id: "i3" })] }),
      "items[0].id i3 is not below nextId 3",
    ],
    [
      "done without an outcome",
      doc({ items: [item({ status: "done", closedAt: NOW })] }),
      "items[0].outcome must be a non-empty string",
    ],
    [
      "delegated without a delegate",
      doc({ items: [item({ status: "delegated" })] }),
      "items[0] is delegated but has no delegate",
    ],
    [
      "waiting-user with no ask or decision",
      doc({ items: [item({ status: "waiting-user" })] }),
      "items[0] is waiting-user but has no ask and no decision",
    ],
    [
      "option details with the wrong length",
      doc({
        items: [
          item({
            status: "waiting-user",
            ask: {
              question: "q",
              context: null,
              options: ["a", "b"],
              optionDetails: ["detail"],
              rec: "a",
              recReason: null,
            },
          }),
        ],
      }),
      "items[0].ask.optionDetails must have the same length as options",
    ],
    [
      "a rec outside its options",
      doc({
        items: [
          item({
            status: "waiting-user",
            ask: { question: "q", context: null, options: ["a", "b"], rec: "c", recReason: null },
          }),
        ],
      }),
      "items[0].ask.rec must be one of its options",
    ],
  ])("reports %s as could-not-check", async (_name, value, reason) => {
    const { cfg, path } = await started();
    writeFileSync(path, JSON.stringify(value));
    expect(tagged(await failureOf(showBacklog(cfg, "app", false)))).toEqual({
      tag: "BacklogError",
      message: `${path} is invalid: ${reason}`,
    });
  });
});

describe("retention", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const closedItem = (n: number, closedAt: string) => ({
    id: `i${n}`,
    title: `item ${n}`,
    status: "done",
    touches: [],
    decided: [],
    ask: null,
    answered: [],
    due: null,
    delegates: [],
    createdAt: NOW,
    closedAt,
    outcome: `shipped ${n}`,
  });
  const openItem = (n: number) => ({
    ...closedItem(n, NOW),
    status: "open",
    closedAt: null,
    outcome: null,
  });
  const seed = (path: string, items: unknown[], findings: unknown[], nextId: number) =>
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        domain: "app",
        focus: null,
        legacy: null,
        boundary: { owned: [], adjacent: [] },
        policies: [],
        items,
        findings,
        nextId,
      }),
    );
  const archived = (path: string) =>
    readFileSync(path.replace(/\.json$/, ".archive.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  const ids = (records: { id: string }[]) => records.map((record) => record.id);

  it("moves the oldest closed item to the archive when a 51st is closed", async () => {
    const { cfg, path } = await started();
    const fifty = Array.from({ length: 50 }, (_, index) => closedItem(index + 1, at(index + 1)));
    seed(path, [...fifty, openItem(51)], [], 52);
    await runWith(
      itemClose(cfg, "app", {
        id: "i51",
        outcome: "last",
        dismissed: false,
        json: false,
        now: at(60),
      }),
    );
    const doc = read(path);
    expect(ids(doc.items)).toEqual(Array.from({ length: 50 }, (_, index) => `i${index + 2}`));
    expect(archived(path)).toEqual([fifty[0]]);
  });

  it("archives closed items and findings from one pool in close order and keeps open ones", async () => {
    const { cfg, path } = await started();
    const closedFinding = (n: number, closedAt: string | null) => ({
      id: `f${n}`,
      kind: "issue",
      title: `finding ${n}`,
      detail: null,
      path: null,
      from: null,
      status: closedAt === null ? "open" : "acted",
      closedAt,
      outcome: closedAt === null ? null : `fixed ${n}`,
    });
    const items = Array.from({ length: 25 }, (_, index) =>
      closedItem(index + 1, at(2 * index + 2)),
    );
    const findings = Array.from({ length: 25 }, (_, index) =>
      closedFinding(index + 26, at(2 * index + 1)),
    );
    seed(
      path,
      [openItem(51), ...items, openItem(52)],
      [closedFinding(53, null), ...findings, closedFinding(54, null)],
      55,
    );
    await runWith(
      findingClose(cfg, "app", {
        id: "f54",
        outcome: "a",
        dismissed: false,
        json: false,
        now: at(90),
      }),
    );
    await runWith(
      itemClose(cfg, "app", { id: "i52", outcome: "b", dismissed: true, json: false, now: at(91) }),
    );
    await runWith(itemAdd(cfg, "app", { title: "fresh", json: false, now: at(92) }));
    const doc = read(path);
    expect(archived(path)).toEqual([findings[0], items[0]]);
    expect(ids(doc.items)).toEqual([
      "i51",
      ...Array.from({ length: 24 }, (_, index) => `i${index + 2}`),
      "i52",
      "i55",
    ]);
    expect(ids(doc.findings)).toEqual([
      "f53",
      ...Array.from({ length: 24 }, (_, index) => `f${index + 27}`),
      "f54",
    ]);
  });

  it("archives each record exactly once when sixty closes race", async () => {
    const { cfg, path } = await started();
    seed(
      path,
      Array.from({ length: 60 }, (_, index) => openItem(index + 1)),
      [],
      61,
    );
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        runWith(
          itemClose(cfg, "app", {
            id: `i${index + 1}`,
            outcome: "raced",
            dismissed: false,
            json: false,
            now: at(index + 1),
          }),
        ),
      ),
    );
    const kept = ids(read(path).items);
    const moved = ids(archived(path));
    expect(kept.length).toBe(50);
    expect(moved.length).toBe(10);
    expect([...kept, ...moved].toSorted()).toEqual(
      Array.from({ length: 60 }, (_, index) => `i${index + 1}`).toSorted(),
    );
    expect(readdirSync(join(path, "..")).toSorted()).toEqual(["app.archive.jsonl", "app.json"]);
  }, 45_000);
});

describe("backlog-store", () => {
  it("imports only files inside its own folder", () => {
    const folder = join(import.meta.dir, "backlog-store");
    const specifiers = readdirSync(folder)
      .toSorted()
      .flatMap((name) =>
        [
          ...readFileSync(join(folder, name), "utf8").matchAll(
            /(?:from|import)\s+["']([^"']+)["']/g,
          ),
        ].map((match) => `${name}: ${match[1]}`),
      );
    expect(specifiers).toEqual(["ops.ts: ./schema.ts", "render.ts: ./schema.ts"]);
  });
});

describe("coordinate CLI", () => {
  it("exits 1 with the reason on invalid input, and 0 for backlog show --json", async () => {
    const { state, path } = await started();
    const env = cliEnv(state, COORDINATOR);
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const before = readFileSync(path, "utf8");
    const refused = Bun.spawnSync(["bun", script, "item", "add", "", "--domain", "app"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect([refused.exitCode, refused.stderr.toString()]).toEqual([1, "refused: title is empty\n"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    const shown = Bun.spawnSync(["bun", script, "backlog", "show", "--json", "--domain", "app"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect([shown.exitCode, JSON.parse(shown.stdout.toString())]).toEqual([0, read(path)]);
  });

  it("parses finding add and finding close flags", async () => {
    const { state, cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    const env = cliEnv(state, COORDINATOR);
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const run = (args: string[]) => {
      const result = Bun.spawnSync(["bun", script, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return [result.exitCode, result.stdout.toString(), result.stderr.toString()];
    };
    expect(
      run([
        "finding",
        "add",
        "flaky test",
        "--kind",
        "issue",
        "--detail",
        "fails one run in ten",
        "--path",
        "src/login.test.ts",
        "--from",
        "i1",
        "--domain",
        "app",
      ]),
    ).toEqual([0, "added f2: flaky test\n", ""]);
    expect(
      run(["finding", "close", "f2", "--outcome", "duplicate", "--dismissed", "--domain", "app"]),
    ).toEqual([0, "dismissed f2: duplicate\n", ""]);
    const [stored] = read(path).findings;
    expect([stored.kind, stored.detail, stored.path, stored.from, stored.status]).toEqual([
      "issue",
      "fails one run in ten",
      "src/login.test.ts",
      "i1",
      "dismissed",
    ]);
    const before = readFileSync(path, "utf8");
    const [code, , stderr] = run(["finding", "add", "x", "--kind", "bug", "--domain", "app"]);
    expect([code, String(stderr).split("\n").filter(Boolean).at(-1)]).toEqual([
      1,
      '  Invalid value for flag --kind: "bug". Expected: "issue" | "opportunity"',
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("runs item update with every ask flag, and exits 1 with no write on a bad rec", async () => {
    const { cfg, state, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    const env = cliEnv(state, COORDINATOR);
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const run = (args: string[]) =>
      Bun.spawnSync(["bun", script, "item", "update", "i1", "--domain", "app", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
    const flags = ["--status", "waiting-user", "--ask", "Which?", "--context", "c"];
    const before = readFileSync(path, "utf8");
    const refused = run([...flags, "--option", "a", "--option", "b", "--rec", "z"]);
    expect([refused.exitCode, refused.stderr.toString()]).toEqual([
      1,
      "refused: --rec z must be one of the --option values: a, b\n",
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
    const updated = run([
      ...flags,
      "--option",
      "a :: alpha :: tail",
      "--option",
      "b",
      "--rec",
      "a",
      "--why",
      "w",
      "--touch",
      "/r/api",
      "--due",
      "2026-12-01",
      "--decided",
      "scope is api only",
      "--json",
    ]);
    expect([updated.exitCode, JSON.parse(updated.stdout.toString())]).toEqual([
      0,
      read(path).items[0],
    ]);
    expect(read(path).items[0]).toMatchObject({
      status: "waiting-user",
      ask: {
        question: "Which?",
        context: "c",
        options: ["a", "b"],
        optionDetails: ["alpha :: tail", ""],
        rec: "a",
        recReason: "w",
      },
      touches: ["/r/api"],
      due: "2026-12-01",
      decided: [{ text: "scope is api only" }],
    });
    const shown = (await runWith(showBacklog(cfg, "app", false))).join("\n");
    expect(shown.split("\n").filter((line) => /^    - [ab](?: |$)/.test(line))).toEqual([
      "    - a (recommended: w): alpha :: tail",
      "    - b",
    ]);
    const cleared = run(["--no-due", "--answer", "a"]);
    expect([
      cleared.exitCode,
      read(path).items[0].due,
      read(path).items[0].ask,
      read(path).items[0].decided.map((entry: { text: string }) => entry.text),
    ]).toEqual([0, null, null, ["scope is api only", 'Re "Which?": a']]);
  });
});

const cli = join(import.meta.dir, "..", "coordinate.ts");
const spawn = (env: Record<string, string>, args: string[]) => {
  const done = Bun.spawnSync(["bun", cli, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return [done.exitCode, done.stdout.toString() + done.stderr.toString()];
};
const prepared = async () => {
  const { state, cfg, path } = await started();
  await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
  await runWith(findingAdd(cfg, "app", finding({ from: "i1" })));
  return { state, path };
};
const mutations = (): string[][] => [
  ["backlog", "policy", "add", "ship it"],
  ["backlog", "focus", "login v2"],
  ["item", "add", "another"],
  ["item", "update", "i1", "--decided", "scope is api only"],
  ["item", "close", "i1", "--outcome", "shipped"],
  ["finding", "close", "f2", "--outcome", "fixed"],
  ["finding", "promote", "f2"],
];

describe("coordinator-only mutations", () => {
  it("refuses every mutation but finding add from a delegate, even with --domain", async () => {
    const { state, path } = await prepared();
    const env = cliEnv(state, { "fleet.domain": "app", "fleet.session": "s-parent" });
    const before = readFileSync(path, "utf8");
    expect(mutations().map((args) => spawn(env, [...args, "--domain", "app"]))).toEqual(
      mutations().map(() => [
        1,
        "refused: only a coordinator changes the backlog, and terminal t1 is not labelled as one; a delegate records what it notices with coordinate finding add\n",
      ]),
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      spawn(env, [
        "finding",
        "add",
        "flaky test",
        "--kind",
        "issue",
        "--from",
        "i1",
        "--detail-md",
        "fails one run in ten",
        "--domain",
        "app",
      ]),
    ).toEqual([0, "added f3: flaky test\n"]);
  });

  it("lets another domain's coordinator route an item in with --domain", async () => {
    const { state, path } = await prepared();
    const env = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": "web" });
    expect(spawn(env, ["item", "add", "rotate keys (from web)", "--domain", "app"])).toEqual([
      0,
      "added i3: rotate keys (from web)\n",
    ]);
    expect(read(path).items.map((item: { title: string }) => item.title)).toEqual([
      "fix login",
      "rotate keys (from web)",
    ]);
  });

  it("lets the domain's coordinator run them, with or without --domain", async () => {
    const { state, path } = await prepared();
    const env = cliEnv(state, COORDINATOR);
    expect([
      spawn(env, ["backlog", "focus", "login v2"]),
      spawn(env, ["item", "close", "i1", "--outcome", "shipped", "--domain", "app"]),
    ]).toEqual([
      [0, "focus: login v2\n"],
      [0, "done i1: shipped\n"],
    ]);
    expect([read(path).focus, read(path).items[0].status]).toEqual(["login v2", "done"]);
  });

  it("records an answer from outside a terminal with --domain, and nothing else", async () => {
    const { state, path } = await prepared();
    expect(
      spawn(cliEnv(state, COORDINATOR), [
        "item",
        "update",
        "i1",
        "--status",
        "waiting-user",
        "--ask",
        "Which provider?",
        "--option",
        "-none-",
        "--option",
        "okta",
      ]),
    ).toEqual([0, "updated i1 [waiting-user] fix login\n"]);
    expect(read(path).items[0].ask).toEqual({
      question: "Which provider?",
      context: null,
      options: ["-none-", "okta"],
      rec: null,
      recReason: null,
      discuss: null,
    });
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    const before = readFileSync(path, "utf8");
    expect(spawn(outside, ["item", "answer", "i1", "okta"])).toEqual([
      1,
      "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
    ]);
    expect(spawn(outside, ["item", "update", "i1", "--answer", "okta", "--domain", "app"])[0]).toBe(
      2,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(spawn(outside, ["item", "answer", "--domain", "app", "--", "i1", "-none-"])).toEqual([
      0,
      "updated i1 [waiting-user] fix login\n",
    ]);
    expect([
      read(path).items[0].ask,
      read(path).items[0].decided.map((d: { text: string }) => d.text),
    ]).toEqual([null, ['Re "Which provider?": -none-']]);
  });

  it("promotes and closes findings from outside a terminal with --domain", async () => {
    const { state, path } = await prepared();
    await runWith(findingAdd(await config(state), "app", finding({ title: "old crash" })));
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    const before = readFileSync(path, "utf8");
    expect([
      spawn(outside, ["finding", "promote", "f2"]),
      spawn(outside, ["finding", "close", "f3", "--outcome", "duplicate", "--dismissed"]),
    ]).toEqual([
      [
        1,
        "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
      ],
      [
        1,
        "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
      ],
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect([
      spawn(outside, ["finding", "promote", "--domain", "app", "--", "f2"]),
      spawn(outside, [
        "finding",
        "close",
        "--domain",
        "app",
        "--dismissed",
        "--outcome",
        "Dismissed from the Backlog panel",
        "--",
        "f3",
      ]),
    ]).toEqual([
      [0, "promoted f2 to i4: flaky test\n"],
      [0, "dismissed f3: Dismissed from the Backlog panel\n"],
    ]);
    expect(
      read(path).findings.map((entry: { id: string; status: string; outcome: string }) => [
        entry.id,
        entry.status,
        entry.outcome,
      ]),
    ).toEqual([
      ["f2", "acted", "promoted to i4"],
      ["f3", "dismissed", "Dismissed from the Backlog panel"],
    ]);
  });

  it("runs finding promote with --title and --json, and refuses unknown or closed findings with no write", async () => {
    const { state, path } = await prepared();
    const env = cliEnv(state, COORDINATOR);
    const promoted = Bun.spawnSync(
      ["bun", cli, "finding", "promote", "f2", "--title", "stabilize the test", "--json"],
      { env, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    );
    const after = read(path);
    expect([promoted.exitCode, JSON.parse(promoted.stdout.toString())]).toEqual([
      0,
      { item: after.items[1], finding: after.findings[0] },
    ]);
    expect([after.items[1].id, after.items[1].title, after.findings[0].outcome]).toEqual([
      "i3",
      "stabilize the test",
      "promoted to i3",
    ]);
    const before = readFileSync(path, "utf8");
    expect([
      spawn(env, ["finding", "promote", "f2"]),
      spawn(env, ["finding", "promote", "f9"]),
      spawn(env, ["finding", "promote", "i1"]),
    ]).toEqual([
      [1, "refused: f2 is already acted\n"],
      [1, "refused: no finding f9 in app\n"],
      [1, "refused: no finding i1 in app\n"],
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("allows boundary edits from outside a terminal with --domain", async () => {
    const { state, path } = await prepared();
    const owned = join(dir(), "owned");
    const adjacent = join(dir(), "adjacent");
    const missing = join(dir(), "missing");
    mkdirSync(owned);
    mkdirSync(adjacent);
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);

    expect(spawn(outside, ["backlog", "boundary", "add", owned])).toEqual([
      1,
      "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
    ]);
    expect(spawn(outside, ["backlog", "boundary", "rm", owned])).toEqual([
      1,
      "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
    ]);

    expect(
      spawn(outside, ["backlog", "boundary", "add", owned, "--domain", "app", "--json"]),
    ).toEqual([0, `${JSON.stringify({ owned: [owned], adjacent: [] }, null, 2)}\n`]);
    expect(
      spawn(outside, [
        "backlog",
        "boundary",
        "add",
        adjacent,
        "--adjacent",
        "--domain",
        "app",
        "--json",
      ]),
    ).toEqual([0, `${JSON.stringify({ owned: [owned], adjacent: [adjacent] }, null, 2)}\n`]);
    expect(read(path).boundary).toEqual({ owned: [owned], adjacent: [adjacent] });

    expect(spawn(outside, ["backlog", "boundary", "add", owned, "--domain", "app"])).toEqual([
      1,
      `refused: ${owned} is already in the owned Boundary\n`,
    ]);
    expect(spawn(outside, ["backlog", "boundary", "add", missing, "--domain", "app"])).toEqual([
      1,
      `refused: ${missing} does not exist\n`,
    ]);
    expect(
      spawn(outside, ["backlog", "boundary", "rm", owned, "--domain", "app", "--json"]),
    ).toEqual([0, `${JSON.stringify({ owned: [], adjacent: [adjacent] }, null, 2)}\n`]);
    expect(
      spawn(outside, ["backlog", "boundary", "rm", adjacent, "--domain", "app", "--json"]),
    ).toEqual([0, `${JSON.stringify({ owned: [], adjacent: [] }, null, 2)}\n`]);
    expect(read(path).boundary).toEqual({ owned: [], adjacent: [] });
    expect(spawn(outside, ["backlog", "boundary", "rm", missing, "--domain", "app"])).toEqual([
      1,
      `refused: ${missing} is not in the owned Boundary\n`,
    ]);
  });

  it("refuses an answer from a delegate or another non-coordinator terminal, even with --domain", async () => {
    const { state, path } = await prepared();
    spawn(cliEnv(state, COORDINATOR), ["item", "update", "i1", "--ask", "Which provider?"]);
    const before = readFileSync(path, "utf8");
    expect([
      spawn(cliEnv(state, { "fleet.domain": "app", "fleet.session": "s-parent" }), [
        "item",
        "answer",
        "i1",
        "okta",
        "--domain",
        "app",
      ]),
      spawn(cliEnv(state, {}), ["item", "answer", "i1", "okta", "--domain", "app"]),
    ]).toEqual([
      [
        1,
        "refused: only a coordinator changes the backlog, and terminal t1 is not labelled as one; a delegate records what it notices with coordinate finding add\n",
      ],
      [
        1,
        "refused: only a coordinator changes the backlog, and terminal t1 is not labelled as one; a delegate records what it notices with coordinate finding add\n",
      ],
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("closes an item from outside a terminal with --domain, and refuses it without", async () => {
    const { state, path } = await prepared();
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    const before = readFileSync(path, "utf8");
    expect(
      spawn(outside, ["item", "close", "--dismissed", "--outcome", "Dismissed", "--", "i1"]),
    ).toEqual([
      1,
      "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      spawn(outside, [
        "item",
        "close",
        "--domain",
        "app",
        "--dismissed",
        "--outcome",
        "Dismissed from the answer flow",
        "--",
        "i1",
      ]),
    ).toEqual([0, "dismissed i1: Dismissed from the answer flow\n"]);
    expect([read(path).items[0].status, read(path).items[0].outcome]).toEqual([
      "dismissed",
      "Dismissed from the answer flow",
    ]);
  });

  it("changes only an item's status from outside a terminal with --domain", async () => {
    const { state, path } = await prepared();
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    const before = readFileSync(path, "utf8");
    expect([
      spawn(outside, ["item", "update", "--status", "parked", "--", "i1"]),
      spawn(outside, [
        "item",
        "update",
        "--status",
        "parked",
        "--decided",
        "on hold",
        "--domain",
        "app",
        "--",
        "i1",
      ]),
      spawn(outside, ["item", "update", "--status", "delegated", "--domain", "app", "--", "i1"]),
      spawn(outside, ["item", "update", "--status", "waiting-user", "--domain", "app", "--", "i1"]),
      spawn(outside, ["item", "update", "--status", "done", "--domain", "app", "--", "i1"]),
    ]).toEqual([
      [
        1,
        "refused: a backlog change from outside a Herdr terminal names its domain: pass --domain\n",
      ],
      [
        2,
        "could not check: Unchecked: HC_TERMINAL_ID is unset, so this terminal's role cannot be checked: run this inside a Herdr terminal\n",
      ],
      ...["delegated", "waiting-user", "done"].map(() => [
        1,
        "refused: from outside a Herdr terminal, item update sets only --status open, building, in-review, parked; close an item with item close\n",
      ]),
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      spawn(outside, ["item", "update", "--status", "parked", "--domain", "app", "--", "i1"]),
    ).toEqual([0, "updated i1 [parked] fix login\n"]);
    expect(read(path).items[0].status).toBe("parked");
    expect(
      spawn(outside, ["item", "update", "--status", "open", "--domain", "app", "--", "i1"]),
    ).toEqual([0, "updated i1 [open] fix login\n"]);
    expect(read(path).items[0].status).toBe("open");
  });

  it("treats a -md flag beside --status as a full update from outside a terminal", async () => {
    const { state, path } = await prepared();
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    const before = readFileSync(path, "utf8");
    expect(
      ["--decided-md", "--outcome-md", "--note-md", "--answer-md", "--ask-md"].map((flag) =>
        spawn(outside, [
          "item",
          "update",
          "--status",
          "parked",
          flag,
          "x",
          "--domain",
          "app",
          "--",
          "i1",
        ]),
      ),
    ).toEqual(
      Array.from({ length: 5 }, () => [
        2,
        "could not check: Unchecked: HC_TERMINAL_ID is unset, so this terminal's role cannot be checked: run this inside a Herdr terminal\n",
      ]),
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a status change from a delegate terminal, even with --domain", async () => {
    const { state, path } = await prepared();
    const before = readFileSync(path, "utf8");
    expect(
      spawn(cliEnv(state, { "fleet.domain": "app", "fleet.session": "s-parent" }), [
        "item",
        "update",
        "--status",
        "parked",
        "--domain",
        "app",
        "--",
        "i1",
      ]),
    ).toEqual([
      1,
      "refused: only a coordinator changes the backlog, and terminal t1 is not labelled as one; a delegate records what it notices with coordinate finding add\n",
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses every other mutation from outside a terminal", async () => {
    const { state, path } = await prepared();
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    const before = readFileSync(path, "utf8");
    const others = mutations().filter(
      ([group, verb]) =>
        !(group === "item" && verb === "close") &&
        !(group === "finding" && (verb === "close" || verb === "promote")),
    );
    expect(others.map((args) => spawn(outside, [...args, "--domain", "app"])[0])).toEqual(
      others.map(() => 2),
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("exits 2 when the caller's role cannot be checked", async () => {
    const { state, path } = await prepared();
    const before = readFileSync(path, "utf8");
    const { HC_TERMINAL_ID: _unset, ...outside } = cliEnv(state, COORDINATOR);
    expect([
      spawn(outside, ["item", "update", "i1", "--decided", "scope is api only", "--domain", "app"]),
      spawn(cliEnv(state, COORDINATOR, "unavailable"), [
        "item",
        "close",
        "i1",
        "--outcome",
        "shipped",
        "--domain",
        "app",
      ]),
    ]).toEqual([
      [
        2,
        "could not check: Unchecked: HC_TERMINAL_ID is unset, so this terminal's role cannot be checked: run this inside a Herdr terminal\n",
      ],
      [2, "could not check: HerdrError: herdr-core is not answering\n"],
    ]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
