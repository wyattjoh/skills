import { createHash } from "node:crypto";

/**
 * Application signature returned by the dashboard daemon health endpoint.
 */
export const DAEMON_APP_SIGNATURE = "task-orchestrator-dashboard-daemon";

/**
 * Default interval between registry reap passes.
 */
export const REAP_INTERVAL_MS = 15_000;

/**
 * Default grace period before a daemon exits because no registry entries remain.
 */
export const ZERO_REGISTRY_GRACE_MS = 60_000;

/**
 * Minimum process age required before a PID is accepted as a plausible lease.
 */
export const LEASE_MIN_AGE_MS = 3_000;

/**
 * A daemon lease persisted in the registry hint file.
 *
 * The registry key is the absolute journal path. The entry repeats that path so
 * callers can pass entries around without retaining the containing map.
 */
export interface DaemonRegistryEntry {
  journalPath: string;
  pid: number;
  repo: string;
  registeredAt: string;
}

/**
 * Alias for a lease held by a daemon for one task journal.
 */
export type DaemonLease = DaemonRegistryEntry;

/**
 * Registry hint file shape keyed by absolute task journal path.
 */
export type DaemonRegistry = Record<string, DaemonRegistryEntry>;

/**
 * Observed result from probing the daemon health endpoint.
 */
export type HealthzResult =
  | {
      kind: "absent";
    }
  | {
      kind: "healthy";
      app: string;
      versionHash: string;
      pid: number;
    }
  | {
      kind: "foreign";
      app: string | null;
    };

/**
 * Decision for ensuring that the dashboard daemon is available.
 */
export type EnsureDecision =
  | {
      action: "spawn";
    }
  | {
      action: "reuse";
      pid: number;
    }
  | {
      action: "shutdown-and-spawn";
      pid: number;
      remoteHash: string;
    }
  | {
      action: "foreign-port-error";
      app: string | null;
    };

const JOURNAL_SUFFIX = /\/\.claude\/task-orchestrator\/[^/]+\/state\.json$/;

/**
 * Derives the repository label from an absolute task journal path.
 *
 * The registry is keyed by journal path because batch names can collide across
 * repositories. A path that does not match the task journal suffix is returned
 * unchanged so callers can handle malformed input without exceptions.
 */
export function repoFromJournalPath(journalPath: string): string {
  return journalPath.replace(JOURNAL_SUFFIX, "");
}

/**
 * Checks whether a PID is plausible for a newly registered lease.
 *
 * Callers provide liveness and process start time facts. The predicate accepts
 * only positive integer PIDs that are alive and at least LEASE_MIN_AGE_MS old.
 */
export function isPlausibleLeasePid(
  pid: number,
  pidAlive: boolean,
  pidStartMs: number,
  now: number,
): boolean {
  return (
    Number.isInteger(pid) &&
    pid > 0 &&
    pidAlive &&
    Number.isFinite(pidStartMs) &&
    Number.isFinite(now) &&
    now - pidStartMs >= LEASE_MIN_AGE_MS
  );
}

/**
 * Decides whether a lease should be reaped from the registry.
 *
 * The current daemon only reaps when the recorded process is no longer alive.
 * The lease and timestamp are accepted for forward-compatible callers that
 * already have those facts at the reap site.
 */
export function shouldReap(lease: DaemonLease, pidAlive: boolean, now: number): boolean {
  void lease;
  void now;
  return !pidAlive;
}

/**
 * Filters persisted registry hints through fresh validation facts.
 *
 * A hint is adopted only when its PID is alive and its journal is readable.
 * Missing facts are treated as failed validation.
 */
export function adoptHints(
  entries: DaemonRegistryEntry[],
  pidAliveByPid: ReadonlyMap<number, boolean>,
  journalReadableByPath: ReadonlyMap<string, boolean>,
): DaemonRegistryEntry[] {
  return entries.filter(
    (entry) =>
      pidAliveByPid.get(entry.pid) === true &&
      journalReadableByPath.get(entry.journalPath) === true,
  );
}

/**
 * Computes the version hash reported by daemon health checks.
 *
 * Callers pass source bytes that they have already read. The hash is a pure
 * function of that input and performs no filesystem access.
 */
export function computeVersionHash(sourceText: string): string {
  return createHash("sha256").update(sourceText).digest("hex");
}

/**
 * Plans how to ensure a compatible dashboard daemon is running.
 *
 * A missing daemon is spawned, a healthy same-version daemon is reused, a
 * healthy old-version daemon is replaced, and a wrong application signature
 * becomes a foreign port error.
 */
export function planEnsure(healthzResult: HealthzResult, localHash: string): EnsureDecision {
  if (healthzResult.kind === "absent") {
    return { action: "spawn" };
  }
  if (healthzResult.kind === "foreign") {
    return { action: "foreign-port-error", app: healthzResult.app };
  }
  if (healthzResult.app !== DAEMON_APP_SIGNATURE) {
    return { action: "foreign-port-error", app: healthzResult.app };
  }
  if (healthzResult.versionHash === localHash) {
    return { action: "reuse", pid: healthzResult.pid };
  }
  return {
    action: "shutdown-and-spawn",
    pid: healthzResult.pid,
    remoteHash: healthzResult.versionHash,
  };
}

/**
 * Encodes the registry hint file with deterministic key ordering.
 *
 * The returned text is suitable for the shared registry at
 * ~/.claude/task-orchestrator/registry.json.
 */
export function encodeRegistry(registry: DaemonRegistry): string {
  const sorted: DaemonRegistry = {};
  for (const key of Object.keys(registry).toSorted()) sorted[key] = registry[key];
  return JSON.stringify(sorted, null, 2) + "\n";
}

/**
 * Decodes registry hint file text into a validated registry map.
 *
 * Missing, empty, malformed, or corrupt content returns an empty registry
 * instead of throwing. Invalid entries are discarded individually.
 */
export function decodeRegistry(text: string | null | undefined): DaemonRegistry {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed)) return {};

    const registry: DaemonRegistry = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRegistryEntry(value)) continue;
      if (key !== value.journalPath) continue;
      registry[key] = value;
    }
    return registry;
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegistryEntry(value: unknown): value is DaemonRegistryEntry {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.journalPath === "string" &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.repo === "string" &&
    typeof value.registeredAt === "string"
  );
}
