import { hostname } from "node:os";
import { Effect } from "effect";
import type { ListedTerminal } from "./herdr.ts";
import * as hc from "./herdr.ts";
import type { Config } from "./config.ts";
import { L, Refused } from "./fleet.ts";

/**
 * The config key that names this machine whatever its Herdr name.
 */
const LOCAL_MACHINE_KEY = "local";

/**
 * This core's Herdr machine name, the canonical name of this machine.
 * @returns The name.
 */
export const localMachine = Effect.fn("localMachine")(function* () {
  return yield* hc.coreName();
});

/**
 * Resolve a machine name to its Herdr machine name: `local` and this host's OS hostname name this
 * core; any other name is already a Herdr machine name.
 * @param name Machine name as written in a config key, queue entry or record.
 * @param core This core's Herdr machine name.
 * @returns The canonical name.
 */
export const canonicalMachine = (name: string, core: string): string =>
  name === LOCAL_MACHINE_KEY || name === hostname() ? core : name;

/**
 * The machine that owns a terminal address: an unqualified address is on this core.
 * @param address Herdr terminal address.
 * @param core This core's Herdr machine name.
 * @returns Herdr machine name.
 */
export const machineOfAddress = (address: string, core: string): string =>
  remoteMachineOf(address) ?? core;

/**
 * The other machine a terminal address names (`strix/t5`), or undefined for this core's own.
 * @param address Herdr terminal address.
 * @returns Herdr machine name, or undefined for an unqualified address.
 */
export const remoteMachineOf = (address: string): string | undefined => {
  const separator = address.indexOf("/");
  return separator === -1 ? undefined : address.slice(0, separator);
};

/**
 * Which machine each ended record's folder is on. Records of local delegates name this core too,
 * so its name is read once, and only when some record names a machine. Without it a named
 * record's machine cannot be told apart from this one, so it is "unknown".
 * @param records Ended records.
 * @returns A lookup by record: the other machine's canonical name, undefined for this one, or
 * "unknown".
 */
export const endedRecordMachines = Effect.fn("endedRecordMachines")(function* (
  records: readonly { record: { machine?: string | null | undefined } }[],
) {
  const named = records.some(({ record }) => record.machine);
  const core = named
    ? yield* localMachine().pipe(Effect.catch(() => Effect.succeed(undefined)))
    : undefined;
  return (record: { machine?: string | null | undefined }): string | undefined => {
    if (!record.machine) return undefined;
    if (core === undefined) return "unknown";
    const machine = canonicalMachine(record.machine, core);
    return machine === core ? undefined : machine;
  };
});

/**
 * Count the target machine's live delegates, including settled delegates that still have live
 * terminals. Another machine's delegates are its own Herdr's answer, relayed in this core's
 * listing; a machine that listing does not show connected lists none of its terminals, so it is
 * refused rather than counted as idle.
 * @param machine Target Herdr machine name.
 * @param listing Herdr's current live-terminal listing, with the machines it reaches.
 * @param core This core's Herdr machine name.
 * @returns Number of live delegates on the target machine, across all domains.
 */
export const liveDelegateCount = Effect.fn("liveDelegateCount")(function* (
  machine: string,
  listing: {
    terminals: readonly ListedTerminal[];
    machines: readonly { name: string; state: string }[];
  },
  core: string,
) {
  if (machine !== core) {
    const state = listing.machines.find((known) => known.name === machine)?.state;
    if (state !== "connected")
      return yield* new Refused({
        message: `cannot count live delegates on machine ${machine}: ${state === undefined ? "Herdr does not list it" : `Herdr lists it as ${state}`}`,
      });
  }
  let count = 0;
  for (const listed of listing.terminals) {
    if (!listed.live || machineOfAddress(listed.address, core) !== machine) continue;
    const terminal = yield* hc.get(listed.address);
    if (terminal?.live && terminal.labels[L.domain] && terminal.labels[L.role] !== "coordinator")
      count += 1;
  }
  return count;
});

/**
 * Resolve the same per-machine limit used by the delegate launch gate. For this core, a key naming
 * its Herdr machine name wins over one naming the OS hostname, which wins over `local`.
 * @param config Coordinate config.
 * @param machine Target Herdr machine name.
 * @param core This core's Herdr machine name.
 * @param readRemoteCores Whether to use the default remote core-based budget when no override exists.
 * @returns Budget and optional fallback warning.
 */
export const machineDelegateBudget = Effect.fn("machineDelegateBudget")(function* (
  config: Config,
  machine: string,
  core: string,
  readRemoteCores = true,
) {
  const local = machine === core;
  const configured = (name: string): number | undefined =>
    Object.hasOwn(config.maxFleetDelegatesByMachine, name)
      ? config.maxFleetDelegatesByMachine[name]
      : undefined;
  const machineBudget = local
    ? (configured(core) ?? configured(hostname()) ?? configured(LOCAL_MACHINE_KEY))
    : configured(machine);
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
