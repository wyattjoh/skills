import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { openDb } from "./db.ts";
import { sessionKey, sync } from "./ingest.ts";

const FIXTURES_ROOT = join(
  dirname(import.meta.url.replace("file://", "")),
  "..",
  "testdata",
  "corpus",
);
const PROJECT_DIR = "-Users-testuser-Code-sample-project";
const key = (rawSessionId: string) => sessionKey(PROJECT_DIR, rawSessionId);

async function syncFixtures(): Promise<{
  db: Database;
  summary: Awaited<ReturnType<typeof sync>>;
}> {
  const db = openDb(":memory:");
  const summary = await sync({ root: FIXTURES_ROOT, db });
  return { db, summary };
}

describe("sync against generated fixtures", () => {
  it("scans every fixture file with zero malformed... except the deliberately corrupted one", async () => {
    const { db, summary } = await syncFixtures();
    expect(summary.scanned).toBe(12);
    expect(summary.malformedLines).toBe(1);
    db.close();
  });

  it("indexes both string-content and block-content user/assistant records", async () => {
    const { db } = await syncFixtures();
    const count = db
      .query("SELECT COUNT(*) as n FROM messages WHERE session_id IN (?, ?) AND text != ''")
      .get(key("session-string-content"), key("session-block-content")) as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it("links the subagent fixture to its parent session and agent name", async () => {
    const { db } = await syncFixtures();
    const session = db
      .query("SELECT parent_session_id, agent_name FROM sessions WHERE parent_session_id = ?")
      .get(key("sample-parent-session")) as {
      parent_session_id: string;
      agent_name: string;
    } | null;
    expect(session).toEqual({
      parent_session_id: key("sample-parent-session"),
      agent_name: "general-purpose",
    });
    db.close();
  });

  it("flags the injected fixture's message as injected", async () => {
    const { db } = await syncFixtures();
    const row = db
      .query("SELECT is_injected FROM messages WHERE session_id = ?")
      .get(key("session-injected")) as { is_injected: number };
    expect(row.is_injected).toBe(1);
    db.close();
  });

  it("flags the interrupt fixture's message as an interrupt marker", async () => {
    const { db } = await syncFixtures();
    const row = db
      .query("SELECT is_interrupt_marker FROM messages WHERE session_id = ?")
      .get(key("session-interrupt")) as { is_interrupt_marker: number };
    expect(row.is_interrupt_marker).toBe(1);
    db.close();
  });

  it("pairs the tool-error fixture's tool_use with its errored tool_result", async () => {
    const { db } = await syncFixtures();
    const row = db
      .query("SELECT is_error FROM tool_calls WHERE session_id = ? AND result_text IS NOT NULL")
      .get(key("session-tool-error")) as { is_error: number } | null;
    expect(row?.is_error).toBe(1);
    db.close();
  });

  it("indexes message-bearing metadata and skips attachment noise", async () => {
    const { db } = await syncFixtures();
    const types = db
      .query("SELECT DISTINCT type FROM messages WHERE session_id IN (?, ?, ?, ?)")
      .all(
        key("session-queue-operation"),
        key("session-summary"),
        key("session-ai-title"),
        key("session-attachment"),
      )
      .map((r) => (r as { type: string }).type)
      .toSorted();
    expect(types).toEqual(["ai-title", "queue-operation", "summary"]);

    const attachmentCount = db
      .query("SELECT COUNT(*) as n FROM messages WHERE session_id = ?")
      .get(key("session-attachment")) as { n: number };
    expect(attachmentCount.n).toBe(0);
    db.close();
  });

  it("reports zero changed files on a second sync of the fixtures", async () => {
    const db = openDb(":memory:");
    await sync({ root: FIXTURES_ROOT, db });
    const second = await sync({ root: FIXTURES_ROOT, db });
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    db.close();
  });

  it("creates a project row for the fixture project directory", async () => {
    const { db } = await syncFixtures();
    const project = db.query("SELECT dir FROM projects WHERE dir = ?").get(PROJECT_DIR) as {
      dir: string;
    } | null;
    expect(project).toEqual({ dir: PROJECT_DIR });
    db.close();
  });
});
