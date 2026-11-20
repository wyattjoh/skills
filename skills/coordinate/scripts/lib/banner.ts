import { Effect } from "effect";
import type { Config } from "./config.ts";
import { L } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { watcherInfo } from "./watch-terminal.ts";

/**
 * The line a coordinator's command shows when its domain has live delegates and no watcher, or
 * undefined. Only a terminal labelled coordinator gets one, for its own domain. The delegate listing
 * runs only when no watcher holds the pid file; any failure of the check reads as no banner.
 * @param config Config.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns The banner line, or undefined.
 */
export const watcherBanner = Effect.fn("watcherBanner")(
  function* (config: Config, env: Record<string, string | undefined> = process.env) {
    const address = env.HC_TERMINAL_ID;
    if (!address) return undefined;
    const own = yield* hc.get(address);
    const domain = own?.labels[L.role] === "coordinator" ? own.labels[L.domain] : undefined;
    if (!domain) return undefined;
    if ((yield* watcherInfo(config, domain)).state !== "missing") return undefined;
    const listed = yield* hc.list([`${L.domain}=${domain}`]);
    const live = listed.filter((terminal) => terminal.live && terminal.address !== address);
    if (live.length === 0) return undefined;
    return `watcher for ${domain} is down; arm it (coordinate watch --arm)`;
  },
  // Defects too: the banner must never change a command's exit code.
  Effect.catchCause(() => Effect.succeed(undefined)),
);
