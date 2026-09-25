import { describe, expect, it } from "bun:test";
import { Effect, Result } from "effect";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLogPath, openEventLog, readEventsSince } from "./lib/event-log.ts";

const fixedClock = () => new Date("2026-09-25T12:00:00.000Z");

const runDir = (): string => mkdtempSync(join(tmpdir(), "coordinate-events-"));

describe("engine event log", () => {
  it("assigns monotonic sequence numbers and reads after a cursor", async () => {
    const run = runDir();
    const log = await Effect.runPromise(openEventLog(run, fixedClock));
    await Effect.runPromise(
      log.append({ type: "engine.started", ticket: null, attention: false, data: {} }),
    );
    await Effect.runPromise(
      log.append({
        type: "attention.question",
        ticket: "02",
        attention: true,
        data: { id: "02-question-1-1" },
      }),
    );

    const page = await Effect.runPromise(readEventsSince(run, 1));

    expect(page).toEqual({
      events: [
        {
          seq: 2,
          at: "2026-09-25T12:00:00Z",
          type: "attention.question",
          ticket: "02",
          attention: true,
          data: { id: "02-question-1-1" },
        },
      ],
      next_cursor: 2,
    });
  });

  it("continues the sequence after reopening", async () => {
    const run = runDir();
    const first = await Effect.runPromise(openEventLog(run, fixedClock));
    await Effect.runPromise(first.append({ type: "a", ticket: null, attention: false, data: {} }));

    const second = await Effect.runPromise(openEventLog(run, fixedClock));
    const event = await Effect.runPromise(
      second.append({ type: "b", ticket: null, attention: false, data: {} }),
    );

    expect(event.seq).toBe(2);
  });

  it("truncates a torn trailing line when the writer reopens", async () => {
    const run = runDir();
    const first = await Effect.runPromise(openEventLog(run, fixedClock));
    await Effect.runPromise(first.append({ type: "a", ticket: null, attention: false, data: {} }));
    appendFileSync(eventLogPath(run), '{"seq":2,"type":"b"');

    const readerPage = await Effect.runPromise(readEventsSince(run, 0));
    const reopened = await Effect.runPromise(openEventLog(run, fixedClock));
    const next = await Effect.runPromise(
      reopened.append({ type: "c", ticket: null, attention: false, data: {} }),
    );

    expect(readerPage.next_cursor).toBe(1);
    expect(next.seq).toBe(2);
    expect(readFileSync(eventLogPath(run), "utf8").split("\n").length).toBe(3);
  });

  it("returns an empty page for a run without events", async () => {
    const page = await Effect.runPromise(readEventsSince(runDir(), 0));

    expect(page).toEqual({ events: [], next_cursor: 0 });
  });

  it("rejects a cursor ahead of the log", async () => {
    const outcome = await Effect.runPromise(Effect.result(readEventsSince(runDir(), 3)));

    expect(Result.isFailure(outcome) ? outcome.failure.issue.code : "ok").toBe(
      "event_log.cursor_ahead",
    );
  });

  it("rejects an out-of-order entry as corruption", async () => {
    const run = runDir();
    appendFileSync(
      eventLogPath(run),
      '{"seq":1,"at":"x","type":"a"}\n{"seq":3,"at":"x","type":"b"}\n',
    );

    const outcome = await Effect.runPromise(Effect.result(readEventsSince(run, 0)));

    expect(Result.isFailure(outcome) ? outcome.failure.issue.code : "ok").toBe("event_log.corrupt");
  });
});
