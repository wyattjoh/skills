import { describe, expect, it } from "bun:test";
import {
  cleanupUdidResources,
  companionPidPath,
  companionSocketPath,
  extractUdid,
  findDeveloperDir,
  isCompanionForUdid,
  isValidUdid,
  readStoredPid,
  xcodeAppFromDeveloperDir,
} from "./idb-bootstrap.ts";

const UDID_A = "11111111-1111-1111-1111-111111111111";
const UDID_B = "22222222-2222-2222-2222-222222222222";

describe("xcodeAppFromDeveloperDir", () => {
  it("strips the trailing Contents/Developer", () => {
    expect(xcodeAppFromDeveloperDir("/Applications/Xcode-beta.app/Contents/Developer")).toBe(
      "/Applications/Xcode-beta.app",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(xcodeAppFromDeveloperDir("/Applications/Xcode.app/Contents/Developer/")).toBe(
      "/Applications/Xcode.app",
    );
  });

  it("leaves unrelated paths untouched", () => {
    expect(xcodeAppFromDeveloperDir("")).toBe("");
  });
});

describe("extractUdid", () => {
  it("pulls the booted UDID", () => {
    const out = "iPhone 16 (11111111-2222-3333-4444-555555555555) (Booted)";
    expect(extractUdid(out)).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("returns null when nothing is booted", () => {
    expect(extractUdid("")).toBeNull();
  });
});

const hasSimKit = (path: string) => path.startsWith("/Applications/Xcode.app/");

describe("findDeveloperDir", () => {
  it("picks the first candidate that has SimulatorKit.framework", () => {
    const result = findDeveloperDir(
      ["/Applications/Xcode-beta.app", "/Applications/Xcode.app"],
      hasSimKit,
    );
    expect(result).toBe("/Applications/Xcode.app/Contents/Developer");
  });

  it("skips empty candidates", () => {
    expect(findDeveloperDir(["", "/Applications/Xcode.app"], hasSimKit)).toBe(
      "/Applications/Xcode.app/Contents/Developer",
    );
  });

  it("returns null when no candidate has the framework", () => {
    expect(findDeveloperDir(["/Applications/Xcode-beta.app"], () => false)).toBeNull();
  });
});

describe("isValidUdid", () => {
  it("accepts a well-formed UDID", () => {
    expect(isValidUdid(UDID_A)).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidUdid("")).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(isValidUdid("11111111-1111-1111-1111-11111111111")).toBe(false);
  });

  it("rejects a string that is too long", () => {
    expect(isValidUdid("11111111-1111-1111-1111-1111111111111")).toBe(false);
  });

  it("rejects a UDID with non-hex characters", () => {
    expect(isValidUdid("GGGGGGGG-GGGG-GGGG-GGGG-GGGGGGGGGGGG")).toBe(false);
  });
});

describe("companionSocketPath", () => {
  it("returns a UDID-specific socket path for UDID_A", () => {
    expect(companionSocketPath("/tmp/idb", UDID_A)).toBe(`/tmp/idb/${UDID_A}_companion.sock`);
  });

  it("returns a distinct socket path for UDID_B", () => {
    expect(companionSocketPath("/tmp/idb", UDID_B)).toBe(`/tmp/idb/${UDID_B}_companion.sock`);
  });
});

describe("companionPidPath", () => {
  it("returns a UDID-specific PID record path for UDID_A", () => {
    expect(companionPidPath("/tmp/idb", UDID_A)).toBe(`/tmp/idb/${UDID_A}.pid`);
  });

  it("returns a distinct PID record path for UDID_B", () => {
    expect(companionPidPath("/tmp/idb", UDID_B)).toBe(`/tmp/idb/${UDID_B}.pid`);
  });
});

describe("readStoredPid", () => {
  it("parses a valid PID from file content", () => {
    expect(readStoredPid("/fake/path", () => "12345")).toBe(12345);
  });

  it("strips surrounding whitespace before parsing", () => {
    expect(readStoredPid("/fake/path", () => "  9999\n")).toBe(9999);
  });

  it("returns null when the file is absent", () => {
    expect(readStoredPid("/fake/path", () => null)).toBeNull();
  });

  it("returns null when content is not a number", () => {
    expect(readStoredPid("/fake/path", () => "not-a-number")).toBeNull();
  });

  it("returns null when PID is zero", () => {
    expect(readStoredPid("/fake/path", () => "0")).toBeNull();
  });

  it("returns null when PID is negative", () => {
    expect(readStoredPid("/fake/path", () => "-1")).toBeNull();
  });
});

describe("isCompanionForUdid", () => {
  it("returns true when the cmdline contains idb_companion and the UDID", () => {
    const cmdline = `idb_companion --udid ${UDID_A} --only simulator`;
    expect(isCompanionForUdid(100, UDID_A, () => cmdline)).toBe(true);
  });

  it("returns false when the cmdline matches a different UDID", () => {
    const cmdline = `idb_companion --udid ${UDID_B} --only simulator`;
    expect(isCompanionForUdid(100, UDID_A, () => cmdline)).toBe(false);
  });

  it("returns false when the process is not idb_companion", () => {
    const cmdline = `some-other-process --udid ${UDID_A}`;
    expect(isCompanionForUdid(100, UDID_A, () => cmdline)).toBe(false);
  });

  it("returns false when the process is not running", () => {
    expect(isCompanionForUdid(100, UDID_A, () => null)).toBe(false);
  });
});

describe("cleanupUdidResources", () => {
  it("kills the matching companion and deletes its PID record and socket", () => {
    const killed: number[] = [];
    const deleted: string[] = [];

    cleanupUdidResources(UDID_A, "/tmp/idb", {
      readFile: (p) => (p.includes(UDID_A) ? "100" : null),
      getCmdline: (pid) => (pid === 100 ? `idb_companion --udid ${UDID_A}` : null),
      killProcess: (pid) => killed.push(pid),
      deleteFile: (p) => deleted.push(p),
    });

    expect(killed).toEqual([100]);
    expect(deleted).toEqual([`/tmp/idb/${UDID_A}.pid`, `/tmp/idb/${UDID_A}_companion.sock`]);
  });

  it("does not kill a process whose UDID does not match", () => {
    const killed: number[] = [];
    const deleted: string[] = [];

    cleanupUdidResources(UDID_A, "/tmp/idb", {
      readFile: (p) => (p.includes(UDID_A) ? "200" : null),
      getCmdline: (pid) => (pid === 200 ? `idb_companion --udid ${UDID_B}` : null),
      killProcess: (pid) => killed.push(pid),
      deleteFile: (p) => deleted.push(p),
    });

    expect(killed).toEqual([]);
    expect(deleted).toEqual([`/tmp/idb/${UDID_A}.pid`, `/tmp/idb/${UDID_A}_companion.sock`]);
  });

  it("does not kill anything when the PID record is absent", () => {
    const killed: number[] = [];

    cleanupUdidResources(UDID_A, "/tmp/idb", {
      readFile: () => null,
      getCmdline: () => null,
      killProcess: (pid) => killed.push(pid),
      deleteFile: () => {},
    });

    expect(killed).toEqual([]);
  });

  it("does not kill anything when the PID record is stale (process gone)", () => {
    const killed: number[] = [];

    cleanupUdidResources(UDID_A, "/tmp/idb", {
      readFile: (p) => (p.includes(UDID_A) ? "999" : null),
      getCmdline: () => null,
      killProcess: (pid) => killed.push(pid),
      deleteFile: () => {},
    });

    expect(killed).toEqual([]);
  });

  it("cleans only UDID_A resources when two UDIDs coexist", () => {
    const killed: number[] = [];
    const deleted: string[] = [];

    cleanupUdidResources(UDID_A, "/tmp/idb", {
      readFile: (p) => {
        if (p.includes(UDID_A)) return "101";
        if (p.includes(UDID_B)) return "202";
        return null;
      },
      getCmdline: (pid) => {
        if (pid === 101) return `idb_companion --udid ${UDID_A}`;
        if (pid === 202) return `idb_companion --udid ${UDID_B}`;
        return null;
      },
      killProcess: (pid) => killed.push(pid),
      deleteFile: (p) => deleted.push(p),
    });

    // Only UDID_A's process and files are affected; UDID_B's resources are untouched.
    expect(killed).toEqual([101]);
    expect(deleted).toEqual([`/tmp/idb/${UDID_A}.pid`, `/tmp/idb/${UDID_A}_companion.sock`]);
  });
});
