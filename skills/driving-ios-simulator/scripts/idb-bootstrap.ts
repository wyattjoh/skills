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
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIMKIT_SUBPATH = "Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework";
const IDB_DIR = "/tmp/idb";

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
export function cleanupUdidResources(
  udid: string,
  idbDir: string,
  deps: {
    readFile?: (p: string) => string | null;
    getCmdline?: (pid: number) => string | null;
    killProcess?: (pid: number) => void;
    deleteFile?: (p: string) => void;
  } = {},
): void {
  const {
    readFile,
    getCmdline,
    killProcess = (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process already gone
      }
    },
    deleteFile = (p) => {
      try {
        unlinkSync(p);
      } catch {
        // best effort
      }
    },
  } = deps;

  const pidPath = companionPidPath(idbDir, udid);
  const sockPath = companionSocketPath(idbDir, udid);

  const pid = readStoredPid(pidPath, readFile);
  if (pid !== null && isCompanionForUdid(pid, udid, getCmdline)) {
    killProcess(pid);
  }

  deleteFile(pidPath);
  deleteFile(sockPath);
}

// ─── Shell helper ────────────────────────────────────────────

function pathEnv(): Record<string, string> {
  return {
    ...process.env,
    PATH: `${homedir()}/.local/bin:${process.env.PATH ?? ""}`,
  } as Record<string, string>;
}

async function run(cmd: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(cmd, { env: pathEnv(), stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Find a Developer dir whose Xcode ships SimulatorKit.framework.
  const active = await run(["xcode-select", "-p"]);
  const candidates = [
    xcodeAppFromDeveloperDir(active.stdout.trim()),
    "/Applications/Xcode.app",
    "/Applications/Xcode-beta.app",
  ];
  const devDir = findDeveloperDir(candidates);
  if (!devDir) {
    console.error("FATAL: no installed Xcode has SimulatorKit.framework; HID actions impossible.");
    process.exit(1);
  }

  // 2. Resolve the target simulator (first booted device unless a UDID is given).
  let udid = Bun.argv[2];
  if (!udid) {
    const booted = await run(["xcrun", "simctl", "list", "devices", "booted"]);
    udid = extractUdid(booted.stdout) ?? "";
  }
  if (!udid) {
    console.error("FATAL: no booted simulator. Boot one: xcrun simctl boot <UDID>");
    process.exit(1);
  }
  if (!isValidUdid(udid)) {
    console.error(`FATAL: invalid UDID: ${udid}`);
    process.exit(1);
  }

  // 3. Kill the stale companion and socket for this UDID only (stale sockets
  //    cause "Failed to describe CompanionInfo ... removing it" and a dead
  //    connection). Resources owned by other UDIDs are not touched.
  mkdirSync(IDB_DIR, { recursive: true });
  cleanupUdidResources(udid, IDB_DIR);
  await Bun.sleep(500);

  // 4. Respawn the companion with the GOOD Developer dir and connect.
  const logFd = openSync(join(IDB_DIR, "companion.log"), "a");
  const companion = Bun.spawn(
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
  );

  // Persist the PID so a future run can scope cleanup to this UDID.
  writeFileSync(companionPidPath(IDB_DIR, udid), String(companion.pid), "utf8");
  companion.unref();

  await Bun.sleep(3000);
  await run(["idb", "connect", udid]).catch(() => {});

  console.log("companion up");
  console.log(`  UDID=${udid}`);
  console.log(`  DEVELOPER_DIR=${devDir}`);
  console.log(`Verify HID with a real tap, e.g.:  idb ui tap --udid ${udid} 220 420`);
}

if (import.meta.main) {
  main();
}
