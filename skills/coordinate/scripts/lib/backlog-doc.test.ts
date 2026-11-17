import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { BacklogError, itemAdd, itemClose, showBacklog } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import { failureOf, runWith, tempDir } from "./fixture.ts";
import { Refused } from "./fleet.ts";
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
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
const NOW = "2026-11-17T10:00:00.000Z";
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
    ]);
    expect(read(path).legacy).toBe(join(state, "md", "app-backlog.md"));
    expect(read(path).items).toEqual([]);
  });

  it("keeps an existing document when run again", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "keep me", json: false, now: NOW }));
    const lines = await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t9" }), hcFake().layer);
    expect(lines.slice(1)).toEqual([`backlog ${path}`]);
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

describe("backlog show", () => {
  it("renders Markdown with the legacy pointer, open and done items", async () => {
    const state = dir();
    const cfg = await config(state);
    mkdirSync(join(state, "md"));
    writeFileSync(join(state, "md", "app-backlog.md"), "old\n");
    await runWith(start(cfg, "app", { HC_TERMINAL_ID: "t9" }), hcFake().layer);
    await runWith(itemAdd(cfg, "app", { title: "fix login", json: false, now: NOW }));
    await runWith(itemAdd(cfg, "app", { title: "docs", json: false, now: NOW }));
    await runWith(
      itemClose(cfg, "app", {
        id: "i2",
        outcome: "merged",
        dismissed: false,
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
        "## Standing yes",
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
      ].join("\n"),
    ]);
  });

  it("prints the document with --json", async () => {
    const { cfg, path } = await started();
    await runWith(itemAdd(cfg, "app", { title: "a", json: false, now: NOW }));
    expect(JSON.parse((await runWith(showBacklog(cfg, "app", true))).join("\n"))).toEqual(
      read(path),
    );
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
    standingYes: [],
    items: [],
    findings: [],
    nextId: 3,
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
    const configFile = join(state, "config.json");
    writeFileSync(configFile, JSON.stringify({ state_dir: state, backlog_dir: join(state, "md") }));
    const env = { ...process.env, COORDINATE_CONFIG: configFile };
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
});
