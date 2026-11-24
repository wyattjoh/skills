import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { localMachine } from "./delegate-capacity.ts";
import { Refused } from "./fleet.ts";
import { skillLinks } from "./path-wrapper.ts";
import { spoken } from "./remote-launch.ts";
import { stateStore } from "./state.ts";
import { keys } from "./state-store.ts";

/**
 * What the home's unreachable message says went wrong, without its framing.
 * @param message A `StoreOffline` message.
 * @returns The cause.
 */
const offlineCause = (message: string): string =>
  /is unreachable \((.*)\); shared state was not read or written$/.exec(message)?.[1] ?? message;

/**
 * Before `coordinate start` on the herdr-doc backend, where a coordinator may run on any machine:
 * confirm this machine has bun on its PATH (delegates and briefs run `bun <skill>/scripts/...`),
 * a coordinate skill link, and a Herdr route to the state home (one document read). Refuses (exit
 * 1) naming everything missing and that the machine's own domain owns the fix. The files backend
 * keeps every coordinator on the machine that holds the state, so it is not checked.
 * @param config Config.
 * @param domain Domain being started.
 * @param env Environment (PATH and HOME are read from it).
 */
export const preflightStart = Effect.fn("preflightStart")(function* (
  config: Config,
  domain: string,
  env: Record<string, string | undefined>,
) {
  if (config.stateBackend !== "herdr-doc") return;
  const links = skillLinks(env.HOME ?? "~");
  const home = yield* stateStore(config.stateDir)
    .read(keys.backlog(domain))
    .pipe(
      Effect.as(undefined),
      Effect.catchTags({
        StoreOffline: (error) =>
          Effect.succeed(
            `a Herdr route to the state home ${error.home} (${offlineCause(error.message)})`,
          ),
        // Reached, just not readable: the backlog commands report that.
        StoreUnreadable: () => Effect.succeed(undefined),
      }),
    );
  const lacks = [
    ...(Bun.which("bun", { PATH: env.PATH ?? "" }) === null ? ["bun on its PATH"] : []),
    ...(env.HOME !== undefined && links.some((link) => existsSync(link))
      ? []
      : [`the coordinate skill (no link at ${links.slice(0, -1).join(", ")} or ${links.at(-1)})`]),
    ...(home === undefined ? [] : [home]),
  ];
  if (lacks.length === 0) return;
  const machine = yield* localMachine();
  return yield* new Refused({
    message: `${machine} lacks ${spoken(lacks)}; setting up ${machine} belongs to ${machine}'s own domain, so file it there`,
  });
});
