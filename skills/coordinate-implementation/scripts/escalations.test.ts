import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Result } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerEscalation,
  awaitAnswer,
  escalationId,
  listOpenEscalations,
  openEscalation,
  pendingOrNextEscalationId,
  type Escalation,
} from "./lib/escalations.ts";

const runDir = (): string => mkdtempSync(join(tmpdir(), "coordinate-escalations-"));

const question = (id = escalationId("02", "question", 1, 1)): Escalation => ({
  id,
  kind: "question",
  ticket: "02",
  summary: "Should offline edits to deleted notes be dropped?",
  detail: "The ticket says preserve edits; the spec says deleted notes are tombstoned.",
  opened_at: "2026-09-25T12:00:00Z",
});

const code = (outcome: Result.Result<unknown, { issue: { code: string } }>): string =>
  Result.isFailure(outcome) ? outcome.failure.issue.code : "ok";

describe("escalation inbox", () => {
  it("re-parks on a pending id and advances past answered ones", async () => {
    const run = runDir();
    const next = () => Effect.runPromise(pendingOrNextEscalationId(run, "02", "question", 1));

    const empty = await next();
    await Effect.runPromise(openEscalation(run, question()));
    const pending = await next();
    await Effect.runPromise(
      answerEscalation(run, {
        id: question().id,
        answer: "Drop them.",
        answered_by: "user",
        answered_at: "2026-09-25T12:05:00Z",
      }),
    );
    const advanced = await next();

    expect([empty, pending, advanced]).toEqual([
      "02-question-1-1",
      "02-question-1-1",
      "02-question-1-2",
    ]);
  });

  it("opens once and returns the existing record on replay", async () => {
    const run = runDir();

    const first = await Effect.runPromise(openEscalation(run, question()));
    const replay = await Effect.runPromise(
      openEscalation(run, { ...question(), summary: "changed text" }),
    );

    expect(first.created).toBe(true);
    expect(replay).toEqual({ escalation: question(), created: false });
  });

  it("lists only unanswered escalations and releases a waiter on answer", async () => {
    const run = runDir();
    await Effect.runPromise(openEscalation(run, question()));
    await Effect.runPromise(openEscalation(run, question(escalationId("04", "stall_pause", 2, 1))));

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(awaitAnswer(run, "02-question-1-1", 5));
        yield* answerEscalation(run, {
          id: "02-question-1-1",
          answer: "Drop them and log a warning.",
          answered_by: "coordinator",
          answered_at: "2026-09-25T12:01:00Z",
        });
        return yield* Fiber.join(waiting);
      }),
    );
    const open = await Effect.runPromise(listOpenEscalations(run));

    expect(answer.answer).toBe("Drop them and log a warning.");
    expect(open.map((entry) => entry.id)).toEqual(["04-stall_pause-2-1"]);
  });

  it("refuses a second answer and answers for unknown ids", async () => {
    const run = runDir();
    await Effect.runPromise(openEscalation(run, question()));
    const answer = {
      id: "02-question-1-1",
      answer: "Keep them.",
      answered_by: "user" as const,
      answered_at: "2026-09-25T12:01:00Z",
    };
    await Effect.runPromise(answerEscalation(run, answer));

    const again = await Effect.runPromise(Effect.result(answerEscalation(run, answer)));
    const unknown = await Effect.runPromise(
      Effect.result(answerEscalation(run, { ...answer, id: "09-question-1-1" })),
    );

    expect([code(again), code(unknown)]).toEqual([
      "escalation.already_answered",
      "escalation.unknown",
    ]);
  });
});
