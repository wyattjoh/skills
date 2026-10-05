#!/usr/bin/env bun
/**
 * idb-bootstrap.ts [UDID]
 *
 * Bring up a WORKING idb companion for a booted iOS Simulator.
 *
 * Fixes the #1 failure mode: HID actions (tap/swipe/text) die with
 *   "SimulatorKit is required for HID interactions ... <Xcode>/.../SimulatorKit.framework
 *    ... does not exist"
 * when the ACTIVE Xcode (often an Xcode-beta) ships without SimulatorKit.framework.
 * Accessibility QUERIES (describe-all/describe-point) keep working even then, which
 * makes the failure sneaky: you can read the screen but every tap silently no-ops.
 *
 * The fix is to spawn idb_companion against an Xcode that actually HAS SimulatorKit,
 * regardless of what `xcode-select -p` points at.
 *
 * Usage:
 *   bun scripts/idb-bootstrap.ts [UDID]
 */

import { homedir } from "node:os";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";

const SIMKIT_SUBPATH = "Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework";
const IDB_DIR = "/tmp/idb";

export class BootstrapError extends Schema.TaggedError<BootstrapError>()("BootstrapError", {
  detail: Schema.String,
}) {}

// ─── Pure helpers (unit-tested) ──────────────────────────────

/** Strip the trailing `/Contents/Developer` from an `xcode-select -p` path. */
export function xcodeAppFromDeveloperDir(developerPath: string): string {
  return developerPath.replace(/\/Contents\/Developer\/?$/, "");
}

/** Extract the first booted-simulator UDID from `simctl list devices booted`. */
export function extractUdid(output: string): string | null {
  const match = output.match(/[0-9A-Fa-f-]{36}/);
  return match ? match[0] : null;
}

/**
 * Find a Developer dir whose Xcode ships SimulatorKit.framework (HID needs it).
 * `exists` is injectable for testing.
 */
export function findDeveloperDir(
  candidateApps: string[],
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const app of candidateApps) {
    if (!app) continue;
    if (exists(join(app, SIMKIT_SUBPATH))) {
      return join(app, "Contents", "Developer");
    }
  }
  return null;
}

/** Validate that a string matches the standard simulator UDID format. */
export function isValidUdid(udid: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(udid);
}

/** Return the socket path owned by a specific UDID. */
export function companionSocketPath(idbDir: string, udid: string): string {
  return join(idbDir, `${udid}_companion.sock`);
}

/** Return the PID record path owned by a specific UDID. */
export function companionPidPath(idbDir: string, udid: string): string {
  return join(idbDir, `${udid}.pid`);
}

/**
 * Read and parse the stored PID for a UDID.
 * Returns null when the record is absent or contains a non-positive integer.
 * `readFile` is injectable for testing.
 */
export function readStoredPid(
  pidPath: string,
  readFile: (p: string) => string | null = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
): number | null {
  const text = readFile(pidPath);
  if (!text) return null;
  const n = parseInt(text.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function defaultGetCmdline(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.stdout || result.exitCode !== 0) return null;
    const text = new TextDecoder().decode(result.stdout).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Return true when the running process with the given PID is an idb_companion
 * for the given UDID. `getCmdline` is injectable for testing.
 */
export function isCompanionForUdid(
  pid: number,
  udid: string,
  getCmdline: (pid: number) => string | null = defaultGetCmdline,
): boolean {
  const cmdline = getCmdline(pid);
  if (!cmdline) return false;
  return cmdline.includes("idb_companion") && cmdline.includes(udid);
}

/**
 * Clean up the PID record and socket owned by exactly one UDID.
 *
 * Sends SIGTERM only to the process confirmed to be an idb_companion for that
 * UDID. Never reads or touches resources belonging to any other UDID.
 * All side-effecting operations are injectable for testing.
 */
export interface CleanupDependencies {
  readFile?: (path: string) => string | null;
  getCmdline?: (pid: number) => string | null;
  killProcess?: (pid: number) => void;
  deleteFile?: (path: string) => void;
}

const defaultKillProcess = (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // process already gone
  }
};

const defaultDeleteFile = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    // best effort
  }
};

export const cleanupUdidResourcesEffect = Effect.fn("idbBootstrap.cleanupUdidResources")(function* (
  udid: string,
  idbDir: string,
  deps: CleanupDependencies = {},
) {
  const pidPath = companionPidPath(idbDir, udid);
  const sockPath = companionSocketPath(idbDir, udid);
  const pid = yield* Effect.sync(() => readStoredPid(pidPath, deps.readFile));
  const matches =
    pid !== null && (yield* Effect.sync(() => isCompanionForUdid(pid, udid, deps.getCmdline)));
  if (matches) yield* Effect.sync(() => (deps.killProcess ?? defaultKillProcess)(pid));
  yield* Effect.sync(() => (deps.deleteFile ?? defaultDeleteFile)(pidPath));
  yield* Effect.sync(() => (deps.deleteFile ?? defaultDeleteFile)(sockPath));
});

/**
 * Synchronous compatibility bridge for callers that clean up a companion directly.
 */
export function cleanupUdidResources(
  udid: string,
  idbDir: string,
  deps: CleanupDependencies = {},
): void {
  Effect.runSync(cleanupUdidResourcesEffect(udid, idbDir, deps));
}

// ─── Shell helper ────────────────────────────────────────────

function pathEnv(): Record<string, string> {
  return {
    ...process.env,
    PATH: `${homedir()}/.local/bin:${process.env.PATH ?? ""}`,
  } as Record<string, string>;
}

const run = Effect.fn("idbBootstrap.run")(function* (cmd: string[], env = pathEnv()) {
  return yield* Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(proc.stdout).text();
      return { stdout, code: await proc.exited };
    },
    catch: (cause) => new BootstrapError({ detail: String(cause) }),
  });
});

export const bootstrapIdb = Effect.fn("bootstrapIdb")(function* (
  requestedUdid: string | undefined,
) {
  const active = yield* run(["xcode-select", "-p"]);
  const devDir = findDeveloperDir([
    xcodeAppFromDeveloperDir(active.stdout.trim()),
    "/Applications/Xcode.app",
    "/Applications/Xcode-beta.app",
  ]);
  if (!devDir) {
    return yield* new BootstrapError({
      detail: "FATAL: no installed Xcode has SimulatorKit.framework; HID actions impossible.",
    });
  }

  let udid = requestedUdid;
  if (!udid) {
    const booted = yield* run(["xcrun", "simctl", "list", "devices", "booted"]);
    udid = extractUdid(booted.stdout) ?? "";
  }
  if (!udid) {
    return yield* new BootstrapError({
      detail: "FATAL: no booted simulator. Boot one: xcrun simctl boot <UDID>",
    });
  }
  if (!isValidUdid(udid))
    return yield* new BootstrapError({ detail: `FATAL: invalid UDID: ${udid}` });

  yield* Effect.try({
    try: () => mkdirSync(IDB_DIR, { recursive: true }),
    catch: (cause) => new BootstrapError({ detail: String(cause) }),
  });
  yield* cleanupUdidResourcesEffect(udid, IDB_DIR);
  yield* Effect.sleep("500 millis");

  const logFd = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openSync(join(IDB_DIR, "companion.log"), "a"),
      catch: (cause) => new BootstrapError({ detail: String(cause) }),
    }),
    (fd) => Effect.sync(() => closeSync(fd)),
  );
  const companion = yield* Effect.try({
    try: () =>
      Bun.spawn(
        [
          "idb_companion",
          "--udid",
          udid,
          "--only",
          "simulator",
          "--grpc-domain-sock",
          companionSocketPath(IDB_DIR, udid),
        ],
        {
          env: { ...pathEnv(), DEVELOPER_DIR: devDir },
          stdin: "ignore",
          stdout: logFd,
          stderr: logFd,
        },
      ),
    catch: (cause) => new BootstrapError({ detail: String(cause) }),
  });
  yield* Effect.try({
    try: () => {
      writeFileSync(companionPidPath(IDB_DIR, udid), String(companion.pid), "utf8");
      companion.unref();
    },
    catch: (cause) => new BootstrapError({ detail: String(cause) }),
  });

  yield* Effect.sleep("3 seconds");
  yield* run(["idb", "connect", udid]).pipe(Effect.catch(() => Effect.void));
  return { udid, devDir };
});

if (import.meta.main) {
  const exit = await Effect.runPromise(
    Effect.scoped(bootstrapIdb(Bun.argv[2])).pipe(
      Effect.tap(({ udid, devDir }) =>
        Effect.sync(() => {
          console.log("companion up");
          console.log(`  UDID=${udid}`);
          console.log(`  DEVELOPER_DIR=${devDir}`);
          console.log(`Verify HID with a real tap, e.g.:  idb ui tap --udid ${udid} 220 420`);
        }),
      ),
      Effect.as(0),
      Effect.catchTag("BootstrapError", (error) =>
        Effect.sync(() => {
          console.error(error.detail);
          return 1;
        }),
      ),
    ),
  );
  process.exit(exit);
}
