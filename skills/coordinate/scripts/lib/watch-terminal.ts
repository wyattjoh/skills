import { basename, join } from "node:path";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { checkDomainName, domainNamePart, L } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { watcherAlive } from "./watch-lock.ts";
import type { Item } from "./backlog-store/schema.ts";
import type { SeenDelegate, SeenPr, WatchEvent } from "./watch.ts";

/**
 * One watcher event as displayed in the terminal's append-only log.
 */
export type WatchLogEntry = {
  at: number;
  event: WatchEvent;
  delivery: string;
};

/**
 * Data displayed by the read-only live watcher view.
 */
export type WatchView = {
  domain: string;
  owner: string;
  ownerState: "live" | "unknown" | "gone";
  pid: number;
  started: number;
  intervalMs: number;
  forgeIntervalMs: number;
  lastTick: number | undefined;
  nextForge: number;
  nextDue: number;
  outboxDepth: number;
  lastDelivery: string;
  delegates: Readonly<Record<string, SeenDelegate>>;
  repos: readonly string[];
  prs: Readonly<Record<string, SeenPr>>;
  items: readonly Item[];
  log: readonly WatchLogEntry[];
};

/** A watcher-domain label that is deliberately separate from the delegate fleet label. */
export const WATCHER_DOMAIN_LABEL = "coordinate.watch-domain";

/** What a coordinator can observe about its domain watcher. */
export type WatcherInfo = {
  state: "running" | "starting" | "missing" | "unavailable";
  terminal: string | undefined;
  pid: number | undefined;
  detail: string | undefined;
};

/**
 * Render watcher state for status and lifecycle command output.
 * @param info Observed watcher state.
 * @returns A concise status line.
 */
export const watcherInfoLine = (info: WatcherInfo): string => {
  if (info.state === "running")
    return `watcher running (${info.terminal ? `${info.terminal}, ` : ""}pid ${info.pid})`;
  if (info.state === "starting") return `watcher starting (${info.terminal})`;
  if (info.state === "unavailable")
    return `watcher unavailable: ${info.detail ?? "Herdr could not launch it"}; use the Watch fallback in coordinate/SKILL.md`;
  return "no watcher running";
};

const pad2 = (part: number): string => String(part).padStart(2, "0");

const time = (value: number | undefined): string => {
  if (value === undefined) return "not yet";
  const date = new Date(value);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
};

const startedTime = (value: number): string => {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time(value)}`;
};

const repoName = (repo: string): string => basename(repo) || repo;

const interval = (value: number): string => `${Math.round(value / 1000)}s`;

/**
 * Format watcher data as a header, status line and event log.
 * @param view Current watcher snapshot.
 * @returns Display lines in screen order.
 */
export const watchViewLines = (view: WatchView): string[] => {
  const delegates = Object.entries(view.delegates).map(
    ([address, delegate]) => `${delegate.name} [${delegate.status ?? "unknown"}] (${address})`,
  );
  const prs = Object.entries(view.prs).map(
    ([key, pr]) => `${key} ${pr.state}/${pr.checks}/${pr.review}`,
  );
  const due = view.items
    .filter((item) => item.due !== null && item.status !== "done" && item.status !== "dismissed")
    .toSorted((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))
    .map((item) => `${item.due} ${item.id} ${item.title}`);
  const asks = view.items
    .filter((item) => item.status === "waiting-user" && item.ask !== null)
    .map((item) => `${item.id} ${item.title}: ${item.ask?.question ?? "question pending"}`);
  const lines = [
    `coordinate watch: ${view.domain}`,
    `owner: ${view.owner} (${view.ownerState}) | pid ${view.pid} | started ${startedTime(view.started)}`,
    `poll: delegates/backlog ${interval(view.intervalMs)} | forge/PRs ${interval(view.forgeIntervalMs)}`,
    `live delegates (${delegates.length}): ${delegates.join(", ") || "none"}`,
    `owned repos (${view.repos.length}): ${view.repos.map(repoName).join(", ") || "none"}`,
    `PRs (${prs.length}): ${prs.join(", ") || "none"}`,
    `due dates (${due.length}): ${due.join(", ") || "none"}`,
    `asks waiting on user (${asks.length}): ${asks.join(", ") || "none"}`,
    `last tick ${time(view.lastTick)} | next forge ${time(view.nextForge)} | next due ${time(view.nextDue)} | outbox ${view.outboxDepth} | delivery ${view.lastDelivery}`,
    "events (newest at bottom):",
    ...view.log.map(
      (entry) => `${time(entry.at)} ${entry.event.line} [e${entry.event.id}] | ${entry.delivery}`,
    ),
  ];
  return lines;
};

const terminalRows = (rows: number): number => Math.max(11, rows);

const clipped = (line: string, columns: number): string => [...line].slice(0, columns).join("");

const headerOutput = (
  lines: readonly string[],
  rows: number,
  columns: number,
  logCount: number,
): string => {
  const logRows = Math.max(1, rows - 10);
  const cursorRow = logCount >= logRows ? rows : 11 + logCount;
  return `\u001b[r\u001b[1;1H${lines
    .slice(0, 10)
    .map((line) => `\u001b[2K${clipped(line, columns)}\r\n`)
    .join("")}\u001b[11;${rows}r\u001b[${cursorRow};1H`;
};

const eventLine = (entry: WatchLogEntry): string =>
  `${time(entry.at)} ${entry.event.line} [e${entry.event.id}] | ${entry.delivery}`;

const appendLogOutput = (
  entries: readonly WatchLogEntry[],
  existingCount: number,
  rows: number,
  columns: number,
): string => {
  const logRows = Math.max(1, rows - 10);
  let count = existingCount;
  let output = "";
  for (const entry of entries) {
    if (count >= logRows) output += "\r\n";
    output += clipped(eventLine(entry), columns);
    count += 1;
    if (count < logRows) output += "\r\n";
  }
  return output;
};

/**
 * Render the initial live view with a fixed header and a scrolling event region.
 * @param view Current watcher snapshot.
 * @param options Terminal color and dimensions.
 * @returns Text for the terminal.
 */
export const renderWatchView = (
  view: WatchView,
  options: { ansi: boolean; columns: number; rows: number },
): string => {
  const lines = watchViewLines(view);
  if (!options.ansi) return `${lines.join("\n")}\n`;
  const rows = terminalRows(options.rows);
  const entries = view.log.slice(-Math.max(1, rows - 10));
  const output = `${headerOutput(lines, rows, options.columns, 0)}${appendLogOutput(entries, 0, rows, options.columns)}`;
  return `\u001b[2J${output}`;
};

/**
 * Create a renderer that appends plain status and new event lines, or redraws an ANSI view.
 * @param write Output sink.
 * @param options Terminal color and dimensions.
 * @returns A writer for successive watcher snapshots.
 */
export const createWatchViewWriter = (
  write: (output: string) => void,
  options: { ansi: boolean; columns: number; rows: number },
): ((view: WatchView) => void) => {
  let rendered = false;
  let lastLogEntry: WatchLogEntry | undefined;
  return (view) => {
    const lines = watchViewLines(view);
    if (options.ansi && !rendered) {
      write(renderWatchView(view, options));
    } else if (options.ansi) {
      const rows = terminalRows(options.rows);
      const previousLogIndex = lastLogEntry === undefined ? -1 : view.log.indexOf(lastLogEntry);
      const existingCount = Math.max(0, previousLogIndex + 1);
      const newEntries = previousLogIndex < 0 ? view.log : view.log.slice(previousLogIndex + 1);
      write(
        `${headerOutput(lines, rows, options.columns, existingCount)}${appendLogOutput(newEntries, existingCount, rows, options.columns)}`,
      );
    } else if (!rendered) {
      write(`${lines.join("\n")}\n`);
    } else {
      const previousLogIndex = lastLogEntry === undefined ? -1 : view.log.indexOf(lastLogEntry);
      const newLogLines = lines.slice(10 + previousLogIndex + 1);
      const status = [lines[1], ...lines.slice(3, 9)].join(" | ");
      write(`${status}\n${newLogLines.length > 0 ? `${newLogLines.join("\n")}\n` : ""}`);
    }
    rendered = true;
    lastLogEntry = view.log.at(-1);
  };
};

/**
 * Find the live watcher terminal and verify its process lock.
 * @param config Coordinate config.
 * @param domain Domain.
 * @returns Terminal, process and startup state.
 */
export const watcherInfo = Effect.fn("watcherInfo")(function* (config: Config, domain: string) {
  const terminals = yield* hc.list([`${WATCHER_DOMAIN_LABEL}=${domain}`]);
  const terminal = terminals.find((candidate) => candidate.live);
  const pid = yield* watcherAlive(config.stateDir, domain);
  if (pid !== undefined)
    return {
      state: "running",
      terminal: terminal?.address,
      pid,
      detail: undefined,
    } satisfies WatcherInfo;
  if (terminal !== undefined)
    return {
      state: "starting",
      terminal: terminal.address,
      pid: undefined,
      detail: undefined,
    } satisfies WatcherInfo;
  return {
    state: "missing",
    terminal: undefined,
    pid: undefined,
    detail: undefined,
  } satisfies WatcherInfo;
});

const watcherName = (domain: string): string => `watch-${domainNamePart(domain, 26, 14)}`;

/**
 * Ensure the domain has one long-lived child terminal delivering watcher events to its coordinator.
 * @param config Coordinate config.
 * @param domain Domain to watch.
 * @param owner Coordinator terminal address, passed explicitly to the child.
 * @param replace Stop existing watcher terminals and replace the process holding the watch lock.
 * @returns The resulting watcher state.
 */
export const armWatcher = Effect.fn("armWatcher")(function* (
  config: Config,
  domain: string,
  owner: string,
  replace = false,
) {
  yield* checkDomainName(domain);
  const coordinator = yield* hc.get(owner);
  if (
    !coordinator?.live ||
    coordinator.labels[L.role] !== "coordinator" ||
    coordinator.labels[L.domain] !== domain
  )
    return {
      state: "unavailable",
      terminal: undefined,
      pid: undefined,
      detail: `owner ${owner} is not a live coordinator for ${domain}`,
    } satisfies WatcherInfo;

  const info = yield* watcherInfo(config, domain);
  if (!replace && info.state !== "missing") return info;

  if (replace) {
    const terminals = yield* hc.list([`${WATCHER_DOMAIN_LABEL}=${domain}`]);
    for (const terminal of terminals) if (terminal.live) yield* hc.end(terminal.address);
  }

  const argv = [
    process.execPath,
    join(import.meta.dir, "..", "coordinate.ts"),
    "watch",
    "--deliver",
    "--domain",
    domain,
    "--owner",
    owner,
    ...(replace ? ["--replace"] : []),
  ];
  const launched = yield* hc
    .run({
      name: watcherName(domain),
      cwd: coordinator.cwd || process.cwd(),
      labels: { [WATCHER_DOMAIN_LABEL]: domain, [L.role]: "watcher" },
      parent: owner,
      outliveParent: false,
      notifyParent: true,
      argv,
    })
    .pipe(
      Effect.map((address) => ({ address, detail: undefined as string | undefined })),
      Effect.catchTag("HerdrError", (error) =>
        Effect.succeed({ address: undefined, detail: error.message }),
      ),
    );
  if (launched.address === undefined)
    return {
      state: "unavailable",
      terminal: undefined,
      pid: undefined,
      detail: launched.detail ?? "Herdr could not launch the watcher terminal",
    } satisfies WatcherInfo;

  const pid = yield* watcherAlive(config.stateDir, domain);
  return {
    state: pid === undefined ? "starting" : "running",
    terminal: launched.address,
    pid,
    detail: undefined,
  } satisfies WatcherInfo;
});

/**
 * Stop every live watcher terminal for a domain, or the verified local watcher process if it has no terminal label.
 * @param config Coordinate config.
 * @param domain Domain.
 * @param owner Coordinator terminal address.
 * @returns A line describing what stopped.
 */
export const stopWatcher = Effect.fn("stopWatcher")(function* (
  config: Config,
  domain: string,
  owner: string,
) {
  yield* checkDomainName(domain);
  const coordinator = yield* hc.get(owner);
  if (
    !coordinator?.live ||
    coordinator.labels[L.role] !== "coordinator" ||
    coordinator.labels[L.domain] !== domain
  )
    return [`refused: owner ${owner} is not a live coordinator for ${domain}`];
  const terminals = yield* hc.list([`${WATCHER_DOMAIN_LABEL}=${domain}`]);
  const live = terminals.filter((terminal) => terminal.live);
  for (const terminal of live) yield* hc.end(terminal.address);
  if (live.length > 0) return live.map((terminal) => `stopped watcher ${terminal.address}`);
  const pid = yield* watcherAlive(config.stateDir, domain);
  if (pid === undefined) return ["no watcher running"];
  process.kill(pid, "SIGTERM");
  return [`stopped watcher process ${pid}`];
});
