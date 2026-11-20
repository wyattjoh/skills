import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { checkDomainName, L } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { watcherAlive } from "./watch-lock.ts";

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

const watcherName = (domain: string): string => {
  const safe = domain.replaceAll(".", "-");
  if (safe.length <= 26) return `watch-${safe}`;
  const hash = createHash("sha256").update(domain).digest("hex").slice(0, 8);
  return `watch-${safe.slice(0, 14)}-${hash}`;
};

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
