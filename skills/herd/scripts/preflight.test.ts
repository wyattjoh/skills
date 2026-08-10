import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isNameTaken,
  type Pane,
  paneForSession,
  peerNameForSession,
  PreflightError,
  readSessionRegistry,
  type SessionEntry,
  workerPeerName,
} from "./preflight.ts";

const pane = (
  id: string,
  options: { sessionId?: string; focused?: boolean; workspace?: string } = {},
): Pane => ({
  pane_id: id,
  tab_id: `${id}-tab`,
  workspace_id: options.workspace ?? "wJE",
  focused: options.focused ?? false,
  ...(options.sessionId
    ? { agent_session: { agent: "claude", kind: "id", value: options.sessionId } }
    : {}),
});

const session = (sessionId: string, name: string, cwd = "/repo"): SessionEntry => ({
  pid: 1,
  sessionId,
  cwd,
  name,
});

describe("paneForSession", () => {
  it("returns the pane running the given session", () => {
    const found = paneForSession(
      [pane("wJE:p1", { sessionId: "aaa" }), pane("wJE:p2", { sessionId: "bbb" })],
      "bbb",
    );
    expect(found.pane_id).toBe("wJE:p2");
  });

  it("ignores focus, so a user viewing another workspace cannot misdirect tabs", () => {
    const found = paneForSession(
      [
        pane("wHY:p3", { focused: true, workspace: "wHY" }),
        pane("wJE:p1", { sessionId: "aaa", workspace: "wJE" }),
      ],
      "aaa",
    );
    expect(found.workspace_id).toBe("wJE");
  });

  it("throws when no pane is running the session", () => {
    expect(() => paneForSession([pane("wJE:p1", { sessionId: "aaa" })], "zzz")).toThrow(
      PreflightError,
    );
  });

  it("throws when panes without a detected agent are the only candidates", () => {
    expect(() => paneForSession([pane("wJE:p1"), pane("wJE:p2")], "aaa")).toThrow(PreflightError);
  });

  it("throws on an empty pane list", () => {
    expect(() => paneForSession([], "aaa")).toThrow(PreflightError);
  });
});

describe("peerNameForSession", () => {
  it("resolves the name for a matching session id", () => {
    const entries = [session("aaa", "skills-1d"), session("bbb", "luxel-6c")];
    expect(peerNameForSession(entries, "bbb")).toBe("luxel-6c");
  });

  it("throws when the session id is absent", () => {
    expect(() => peerNameForSession([session("aaa", "skills-1d")], "zzz")).toThrow(PreflightError);
  });

  it("matches on session id rather than working directory", () => {
    const entries = [session("aaa", "skills-1d", "/repo"), session("bbb", "skills-7c", "/repo")];
    expect(peerNameForSession(entries, "aaa")).toBe("skills-1d");
  });
});

describe("isNameTaken", () => {
  it("reports true for a name a live session advertises", () => {
    expect(isNameTaken([session("aaa", "herd-fix-01")], "herd-fix-01")).toBe(true);
  });

  it("reports false for an unused name", () => {
    expect(isNameTaken([session("aaa", "herd-fix-01")], "herd-fix-02")).toBe(false);
  });
});

describe("workerPeerName", () => {
  it("builds a peer name from the batch and ticket id", () => {
    expect(workerPeerName("defects", "01-preserve-codes")).toBe("herd-defects-01-preserve-codes");
  });

  it("collapses characters outside the peer-name class", () => {
    expect(workerPeerName("Fix/Batch 2", "PR #7: merge")).toBe("herd-fix-batch-2-pr-7-merge");
  });

  it("caps the name at 64 characters with no trailing separator", () => {
    const name = workerPeerName("a".repeat(40), "b".repeat(40));
    expect(name.length).toBe(64);
    expect(name.endsWith("-")).toBe(false);
  });
});

describe("readSessionRegistry", () => {
  it("reads well-formed entries and skips unparseable ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "herd-sessions-"));
    writeFileSync(
      join(dir, "1.json"),
      JSON.stringify({ pid: 1, sessionId: "aaa", cwd: "/repo", name: "skills-1d" }),
    );
    writeFileSync(join(dir, "2.json"), "{ truncated");
    writeFileSync(join(dir, "3.json"), JSON.stringify({ pid: 3, cwd: "/repo" }));
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const entries = readSessionRegistry(dir);
    expect(entries).toEqual([
      {
        pid: 1,
        sessionId: "aaa",
        cwd: "/repo",
        name: "skills-1d",
        status: undefined,
        messagingSocketPath: undefined,
      },
    ]);
  });

  it("returns an empty list when the directory is absent", () => {
    expect(readSessionRegistry(join(tmpdir(), "herd-missing-registry"))).toEqual([]);
  });
});
