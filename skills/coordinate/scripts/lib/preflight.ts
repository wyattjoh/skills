import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { localMachine } from "./delegate-capacity.ts";
import { Refused } from "./fleet.ts";
import { skillLinks } from "./path-wrapper.ts";
import { spoken } from "./remote-launch.ts";
import { stateStore } from "./state.ts";
import { keys } from "./state-store.ts";
import { Proc } from "./proc.ts";

/**
 * Whether this machine's login shell finds bun: Herdr starts terminals, and so delegates and
 * watchers, with that PATH, which can lack a bun the calling shell has (a mise shim, say).
 * @param env Environment (SHELL names the login shell; the rest is passed to it).
 * @returns True when `command -v bun` prints a path.
 */
const loginBun = Effect.fn("loginBun")(function* (env: Record<string, string | undefined>) {
  const passed = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const found = yield* (yield* Proc)
    .run([env.SHELL || "/bin/sh", "-lc", "command -v bun"], { env: passed, timeoutMs: 30_000 })
    .pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
  return found.exitCode === 0 && found.stdout.trim() !== "";
});

/**
 * What the home's unreachable message says went wrong, without its framing.
 * @param message A `StoreOffline` message.
 * @returns The cause.
 */
const offlineCause = (message: string): string =>
  /is unreachable \((.*)\); shared state was not read or written$/.exec(message)?.[1] ?? message;

/**
 * Before `coordinate start` on the herdr-doc backend, where a coordinator may run on any machine:
 * confirm this machine's login shell finds bun (delegates and briefs run `bun <skill>/scripts/...`),
 * a coordinate skill link, and a Herdr route to the state home (one document read). Refuses (exit
 * 1) naming everything missing and that the machine's own domain owns the fix. The files backend
 * keeps every coordinator on the machine that holds the state, so it is not checked.
 * @param config Config.
 * @param domain Domain being started.
 * @param env Environment (SHELL, PATH and HOME are read from it).
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
    ...((yield* loginBun(env)) ? [] : ["bun on its login PATH"]),
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
