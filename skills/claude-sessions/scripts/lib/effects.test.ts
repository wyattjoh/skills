import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import type { Fetch } from "@typesafe-ai/sdk";
import { Effect, Result } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { syncEffect } from "./ingest.ts";
import { SessionIOError } from "./io.ts";
import { readJsonlEffect } from "./jsonl.ts";
import { judgeRowsEffect } from "./judge/client.ts";
import { readJudgeFile } from "./judge/state.ts";
import { buildDocumentWithJudge, renderDocumentWithJudge } from "./output.ts";

const roots: string[] = [];
const originalDb = process.env.CLAUDE_SESSIONS_DB;
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sessions-effect-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  mock.restore();
  if (originalDb === undefined) delete process.env.CLAUDE_SESSIONS_DB;
  else process.env.CLAUDE_SESSIONS_DB = originalDb;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("composed session I/O", () => {
  it("preserves the public Promise-based definition and output helpers", async () => {
    const definition = {
      questions: { relevant: { type: "noul" as const } },
      state_fields: ["value"],
    };
    expect(await readJudgeFile(JSON.stringify(definition))).toEqual(definition);
    const db = openDb(":memory:");
    try {
      const rows = [{ value: "fixture" }];
      const expected = { command: "fixture", count: 1, rows };
      expect(JSON.stringify(await buildDocumentWithJudge("fixture", rows, {}, db, []))).toBe(
        JSON.stringify(expected),
      );
      expect(JSON.parse(await renderDocumentWithJudge("fixture", rows, {}, db, []))).toEqual(
        expected,
      );
    } finally {
      db.close();
    }
  });

  it("defers JSONL reads and acquires a fresh reader on each run", async () => {
    const path = join(fixture(), "session.jsonl");
    const program = readJsonlEffect(path);
    writeFileSync(path, '{"value":"first"}\n');
    const first = await Effect.runPromise(program);
    expect(first.lines.map((line) => line.value)).toEqual([{ value: "first" }]);
    writeFileSync(path, '{"value":"second"}\n');
    const second = await Effect.runPromise(program);
    expect(second.lines.map((line) => line.value)).toEqual([{ value: "second" }]);
  });

  it("cancels and releases the reader after a typed read failure", async () => {
    const failure = new Error("fixture read failed");
    const reader = {
      read: mock(async () => {
        throw failure;
      }),
      cancel: mock(async () => undefined),
      releaseLock: mock(() => undefined),
    };
    spyOn(Bun, "file").mockImplementation(
      () =>
        ({
          stream: () => ({ getReader: () => reader }),
        }) as unknown as ReturnType<typeof Bun.file>,
    );
    const result = await Effect.runPromise(Effect.result(readJsonlEffect("fixture.jsonl")));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected read failure");
    expect(result.failure instanceof SessionIOError).toBe(true);
    expect(result.failure.cause).toBe(failure);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("closes an owned index when corpus discovery fails", async () => {
    const root = fixture();
    process.env.CLAUDE_SESSIONS_DB = join(root, "index.db");
    const close = spyOn(Database.prototype, "close");
    const result = await Effect.runPromise(
      Effect.result(syncEffect({ root: join(root, "missing") })),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves a borrowed index open after the same failure", async () => {
    const db = openDb(":memory:");
    const close = spyOn(db, "close");
    try {
      const result = await Effect.runPromise(
        Effect.result(syncEffect({ root: join(fixture(), "missing"), db })),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(close).toHaveBeenCalledTimes(0);
      expect(db.query("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
    } finally {
      db.close();
    }
  });

  it("bounds requests, propagates cancellation and closes the owned cache", async () => {
    process.env.CLAUDE_SESSIONS_DB = join(fixture(), "judgments.db");
    const close = spyOn(Database.prototype, "close");
    const signals: AbortSignal[] = [];
    const fetch: Fetch = async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error("Expected request abort signal");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), {
          once: true,
        });
      });
    };
    const rows = Array.from({ length: 12 }, (_, index) => ({
      kind: "interrupt",
      user_text_after: `fixture ${index}`,
    }));
    const result = await Effect.runPromise(
      Effect.result(
        judgeRowsEffect(rows, "steering", {
          apiKey: "fixture-key",
          fetch,
          diagnostic: () => undefined,
        }).pipe(Effect.timeout(100)),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(signals.length).toBe(8);
    expect(signals.map((signal) => signal.aborted)).toEqual(Array.from({ length: 8 }, () => true));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
