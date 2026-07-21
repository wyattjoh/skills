import { describe, expect, it } from "bun:test";
import {
  adoptHints,
  computeVersionHash,
  decodeRegistry,
  encodeRegistry,
  isPlausibleLeasePid,
  LEASE_MIN_AGE_MS,
  planEnsure,
  repoFromJournalPath,
  shouldReap,
  type DaemonRegistryEntry,
  type HealthzResult,
} from "./daemon.ts";

const journalPath = "/Users/dev/repo/.claude/task-orchestrator/batch-one/state.json";

function entry(overrides: Partial<DaemonRegistryEntry> = {}): DaemonRegistryEntry {
  return {
    journalPath,
    pid: 12345,
    repo: "/Users/dev/repo",
    registeredAt: "2026-07-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("repoFromJournalPath", () => {
  it("derives the repo label from an absolute task journal path", () => {
    expect(repoFromJournalPath(journalPath)).toBe("/Users/dev/repo");
  });

  it("handles a path missing the task journal suffix without throwing", () => {
    expect(repoFromJournalPath("/Users/dev/repo/state.json")).toBe("/Users/dev/repo/state.json");
  });
});

describe("lease decisions", () => {
  it("accepts a live PID only after the minimum lease age", () => {
    const now = 10_000;
    expect(isPlausibleLeasePid(12345, true, now - LEASE_MIN_AGE_MS, now)).toBe(true);
    expect(isPlausibleLeasePid(12345, true, now - LEASE_MIN_AGE_MS + 1, now)).toBe(false);
    expect(isPlausibleLeasePid(12345, false, now - LEASE_MIN_AGE_MS, now)).toBe(false);
  });

  it("rejects nonpositive PIDs", () => {
    expect(isPlausibleLeasePid(0, true, 0, LEASE_MIN_AGE_MS)).toBe(false);
    expect(isPlausibleLeasePid(-1, true, 0, LEASE_MIN_AGE_MS)).toBe(false);
  });

  it("reaps a lease exactly when the PID is not alive", () => {
    expect(shouldReap(entry(), true, Date.now())).toBe(false);
    expect(shouldReap(entry(), false, Date.now())).toBe(true);
  });
});

describe("adoptHints", () => {
  it("keeps only hints with live PIDs and readable journals", () => {
    const liveReadable = entry({
      journalPath: "/repo/a/.claude/task-orchestrator/one/state.json",
      pid: 1,
    });
    const dead = entry({ journalPath: "/repo/b/.claude/task-orchestrator/two/state.json", pid: 2 });
    const unreadable = entry({
      journalPath: "/repo/c/.claude/task-orchestrator/three/state.json",
      pid: 3,
    });

    expect(
      adoptHints(
        [liveReadable, dead, unreadable],
        new Map([
          [1, true],
          [2, false],
          [3, true],
        ]),
        new Map([
          [liveReadable.journalPath, true],
          [dead.journalPath, true],
          [unreadable.journalPath, false],
        ]),
      ),
    ).toEqual([liveReadable]);
  });
});

describe("version hashing", () => {
  it("is deterministic for the daemon source text", () => {
    const hashes = [
      computeVersionHash("daemon source"),
      computeVersionHash("daemon source"),
      computeVersionHash("changed daemon source"),
    ];

    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set(hashes).size).toBe(2);
  });
});

describe("planEnsure", () => {
  it("spawns when no daemon is listening", () => {
    expect(planEnsure({ kind: "absent" }, "abc123")).toEqual({ action: "spawn" });
  });

  it("reuses a healthy same-version task orchestrator daemon", () => {
    const healthz: HealthzResult = {
      kind: "healthy",
      app: "task-orchestrator-dashboard-daemon",
      versionHash: "abc123",
      pid: 12345,
    };

    expect(planEnsure(healthz, "abc123")).toEqual({ action: "reuse", pid: 12345 });
  });

  it("shuts down and respawns a healthy daemon with a version mismatch", () => {
    const healthz: HealthzResult = {
      kind: "healthy",
      app: "task-orchestrator-dashboard-daemon",
      versionHash: "old",
      pid: 12345,
    };

    expect(planEnsure(healthz, "new")).toEqual({
      action: "shutdown-and-spawn",
      pid: 12345,
      remoteHash: "old",
    });
  });

  it("reports a foreign process answering the daemon port", () => {
    expect(planEnsure({ kind: "foreign", app: "other-app" }, "abc123")).toEqual({
      action: "foreign-port-error",
      app: "other-app",
    });
  });

  it("reports a wrong app signature from a health response as a foreign port", () => {
    expect(
      planEnsure(
        {
          kind: "healthy",
          app: "other-app",
          versionHash: "abc123",
          pid: 12345,
        },
        "abc123",
      ),
    ).toEqual({
      action: "foreign-port-error",
      app: "other-app",
    });
  });
});

describe("registry codec", () => {
  it("roundtrips registry entries keyed by journal path", () => {
    const registry = {
      [journalPath]: entry(),
    };

    expect(decodeRegistry(encodeRegistry(registry))).toEqual(registry);
  });

  it("returns an empty registry for missing or corrupt content", () => {
    expect(decodeRegistry(undefined)).toEqual({});
    expect(decodeRegistry("not json")).toEqual({});
  });

  it("discards malformed entries without throwing", () => {
    expect(decodeRegistry(JSON.stringify({ [journalPath]: { pid: "bad" } }))).toEqual({});
  });
});
