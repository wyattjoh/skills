import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { Item } from "./backlog-store/schema.ts";
import { resolveConfig } from "./config.ts";
import { runWith, tempDir } from "./fixture.ts";
import { fakeProc, ok } from "./proc.ts";
import {
  armWatcher,
  createWatchViewWriter,
  renderWatchView,
  stopWatcher,
  watchViewLines,
  WATCHER_DOMAIN_LABEL,
  type WatchView,
} from "./watch-terminal.ts";

const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const config = async () => {
  const state = tempDir("coordinate-watcher-terminal-");
  made.push(state);
  return Effect.runPromise(
    resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
  );
};

const owner = JSON.stringify({
  address: "t1",
  name: "coordinator",
  state: "live",
  labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
});

describe("domain watcher terminal", () => {
  it("launches a child with explicit owner and domain labels, without delegate or no-notify flags", async () => {
    const cfg = await config();
    const fake = fakeProc((argv) => {
      if (argv[1] === "get" && argv[2] === "t1") return ok(owner);
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      if (argv[1] === "run") return ok('{"address":"t7"}');
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const info = await runWith(armWatcher(cfg, "app", "t1"), fake.layer);
    const run = fake.calls.find((call) => call.argv[1] === "run");
    expect(info).toEqual({
      state: "starting",
      terminal: "t7",
      pid: undefined,
      detail: undefined,
    });
    expect(run?.argv).toContain("--parent");
    expect(run?.argv).toContain("t1");
    expect(run?.argv).toContain("--label");
    expect(run?.argv).toContain(`${WATCHER_DOMAIN_LABEL}=app`);
    expect(run?.argv).toContain("fleet.role=watcher");
    expect(run?.argv).toContain("--deliver");
    expect(run?.argv).toContain("--domain");
    expect(run?.argv).toContain("--owner");
    expect(run?.argv).toContain("t1");
    expect(run?.argv.includes("fleet.domain=app")).toBe(false);
    expect(run?.argv.includes("--no-notify")).toBe(false);
    expect(run?.argv.includes("--outlive-parent")).toBe(false);
  });

  it("reuses a live watcher instead of launching a second terminal", async () => {
    const cfg = await config();
    const fake = fakeProc((argv) => {
      if (argv[1] === "get" && argv[2] === "t1") return ok(owner);
      if (argv[1] === "ls" && argv.includes(`${WATCHER_DOMAIN_LABEL}=app`))
        return ok('{"terminals":[{"address":"t7","state":"live"}]}');
      if (argv[1] === "ls") return ok('{"terminals":[]}');
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    expect(await runWith(armWatcher(cfg, "app", "t1"), fake.layer)).toEqual({
      state: "starting",
      terminal: "t7",
      pid: undefined,
      detail: undefined,
    });
    expect(fake.calls.filter((call) => call.argv[1] === "run")).toHaveLength(0);
  });

  it("ends the domain watcher on request", async () => {
    const cfg = await config();
    const fake = fakeProc((argv) => {
      if (argv[1] === "get" && argv[2] === "t1") return ok(owner);
      if (argv[1] === "ls") return ok('{"terminals":[{"address":"t7","state":"live"}]}');
      return ok("{}");
    });

    expect(await runWith(stopWatcher(cfg, "app", "t1"), fake.layer)).toEqual([
      "stopped watcher t7",
    ]);
    expect(fake.calls.map((call) => call.argv.slice(0, 3))).toContainEqual(["hc", "kill", "t7"]);
  });
});

const item: Item = {
  id: "i7",
  title: "Review deployment",
  status: "waiting-user",
  touches: [],
  decided: [],
  ask: {
    question: "Deploy today?",
    context: null,
    options: [],
    rec: null,
    recReason: null,
    discuss: null,
  },
  answered: [],
  due: "2026-11-22",
  delegates: [],
  createdAt: "2026-11-20T00:00:00.000Z",
  closedAt: null,
  outcome: null,
};

const localTime = (value: number | undefined): string => {
  if (value === undefined) return "not yet";
  const date = new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};

const localDateTime = (value: number): string => {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day} ${localTime(value)}`;
};

const view: WatchView = {
  domain: "app",
  owner: "t1",
  ownerState: "live",
  pid: 42,
  started: Date.parse("2026-11-20T10:00:00.000Z"),
  intervalMs: 5_000,
  forgeIntervalMs: 90_000,
  lastTick: Date.parse("2026-11-20T10:00:05.000Z"),
  nextForge: Date.parse("2026-11-20T10:01:30.000Z"),
  nextDue: Date.parse("2026-11-20T10:00:10.000Z"),
  outboxDepth: 1,
  lastDelivery: "refused: dialog; retry in 5s",
  delegates: { t2: { name: "worker", status: "working", turn: 2 } },
  repos: ["github.com/acme/app"],
  prs: {
    "github.com/acme/app#7": {
      state: "open",
      checks: "pass",
      review: "none",
      url: "https://example.test/7",
    },
  },
  items: [item],
  log: [
    {
      at: Date.parse("2026-11-20T10:00:05.000Z"),
      event: {
        id: "a",
        kind: "due",
        attrs: { item: "i7", due: "2026-11-22" },
        fields: { title: "Review deployment" },
        text: "",
      },
      delivery: "refused: dialog; retry in 5s",
    },
  ],
};

describe("watch terminal view", () => {
  it("shows the monitored domain, current status and delivered event history", () => {
    const lines = watchViewLines(view);
    expect(lines).toContain("coordinate watch: app");
    expect(lines).toContain(`owner: t1 (live) | pid 42 | started ${localDateTime(view.started)}`);
    expect(lines).toContain("live delegates (1): worker [working] (t2)");
    expect(lines).toContain("owned repos (1): app");
    expect(lines).toContain("PRs (1): github.com/acme/app#7 open/pass/none");
    expect(lines).toContain("due dates (1): 2026-11-22 i7 Review deployment");
    expect(lines).toContain("asks waiting on user (1): i7 Review deployment: Deploy today?");
    expect(lines[8]).toContain(`last tick ${localTime(view.lastTick)}`);
    expect(lines[8]).toContain(`next forge ${localTime(view.nextForge)}`);
    expect(lines[8]).toContain(`next due ${localTime(view.nextDue)}`);
    expect(lines.at(-1)).toBe(
      `${localTime(view.log[0]?.at)} due i7 2026-11-22 Review deployment [ea] | refused: dialog; retry in 5s`,
    );
    expect(lines[1]).toContain(`started ${localDateTime(view.started)}`);
  });

  it("uses a plain-text snapshot without ANSI controls when requested", () => {
    const output = renderWatchView(view, { ansi: false, columns: 100, rows: 24 });
    expect(output).toBe(`${watchViewLines(view).join("\n")}\n`);
  });

  it("prints current plain status and only newly appended log entries", () => {
    const writes: string[] = [];
    const writer = createWatchViewWriter((output) => writes.push(output), {
      ansi: false,
      columns: 120,
      rows: 24,
    });
    writer(view);
    const next = { ...view, lastDelivery: "sent to t1" };
    writer(next);
    const lines = watchViewLines(next);
    expect(writes).toEqual([
      `${watchViewLines(view).join("\n")}\n`,
      `${[lines[1], ...lines.slice(3, 9)].join(" | ")}\n`,
    ]);
  });

  it("renders a fixed header above the scrolling event region in interactive mode", () => {
    const output = renderWatchView(view, { ansi: true, columns: 120, rows: 24 });
    expect(output.startsWith("\u001b[2J\u001b[r\u001b[1;1H")).toBe(true);
    expect(output).toContain("coordinate watch: app");
    expect(output).toContain(
      `\u001b[11;1H${localTime(view.log[0]?.at)} due i7 2026-11-22 Review deployment [ea]`,
    );
  });

  it("updates the header without clearing previous events, then appends new events", () => {
    const writes: string[] = [];
    const writer = createWatchViewWriter((output) => writes.push(output), {
      ansi: true,
      columns: 120,
      rows: 24,
    });
    writer(view);
    const next: WatchView = {
      ...view,
      lastDelivery: "sent to t1",
      log: [
        ...view.log,
        {
          at: Date.parse("2026-11-20T10:00:10.000Z"),
          event: { id: "b", kind: "answered", attrs: { item: "i7" }, fields: {}, text: "" },
          delivery: "replayed from outbox, sent to t1",
        },
      ],
    };
    writer(next);
    expect(writes[1]?.startsWith("\u001b[r\u001b[1;1H")).toBe(true);
    expect(writes[1]).toContain("last tick");
    expect(writes[1]).toContain("[eb] | replayed from outbox, sent to t1");
  });
});
