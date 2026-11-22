import { hostname } from "node:os";
import { Effect } from "effect";
import type { ListedTerminal } from "./herdr.ts";
import * as hc from "./herdr.ts";
import type { Config } from "./config.ts";
import { L } from "./fleet.ts";

/**
 * The machine that owns a terminal address, using the local hostname for unqualified addresses.
 * @param address Herdr terminal address.
 * @returns Machine name.
 */
export const machineOfAddress = (address: string): string => {
  const separator = address.indexOf("/");
  return separator === -1 ? hostname() : address.slice(0, separator);
};

/**
 * Count the target machine's live delegates, including settled delegates that still have live terminals.
 * @param machine Target machine name.
 * @param terminals Herdr's current live-terminal listing.
 * @returns Number of live delegates on the target machine, across all domains.
 */
export const liveDelegateCount = Effect.fn("liveDelegateCount")(function* (
  machine: string,
  terminals: readonly ListedTerminal[],
) {
  let count = 0;
  for (const listed of terminals) {
    if (!listed.live || machineOfAddress(listed.address) !== machine) continue;
    const terminal = yield* hc.get(listed.address);
    if (terminal?.live && terminal.labels[L.domain] && terminal.labels[L.role] !== "coordinator")
      count += 1;
  }
  return count;
});

/**
 * Resolve the same per-machine limit used by the delegate launch gate.
 * @param config Coordinate config.
 * @param machine Target machine.
 * @param local Whether the target is the local Herdr machine.
 * @param readRemoteCores Whether to use the default remote core-based budget when no override exists.
 * @returns Budget and optional fallback warning.
 */
export const machineDelegateBudget = Effect.fn("machineDelegateBudget")(function* (
  config: Config,
  machine: string,
  local: boolean,
  readRemoteCores = true,
) {
  const configured = (name: string): number | undefined =>
    Object.hasOwn(config.maxFleetDelegatesByMachine, name)
      ? config.maxFleetDelegatesByMachine[name]
      : undefined;
  const machineBudget = configured(machine) ?? (local ? configured("local") : undefined);
  if (machineBudget !== undefined) return { budget: machineBudget, warning: undefined };

  let budget = config.maxFleetDelegates;
  let warning: string | undefined;
  if (readRemoteCores && !local && config.maxFleetDelegatesOverride === undefined) {
    const cores = yield* hc.coresOn(machine).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (cores === undefined)
      warning = `warning: could not read core count for machine ${machine}; using configured max_fleet_delegates default ${budget}`;
    else budget = Math.max(2, Math.floor(cores / 4));
  }
  return { budget, warning };
});
