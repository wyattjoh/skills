import { describe, expect, test } from "bun:test";
import { advanceAnswerFlow, startAnswerFlow, storedFlowVariation } from "./answer-flow.ts";

describe("answer flow", () => {
  test("starts at the selected question and preserves domain order", () => {
    const flow = startAnswerFlow("demo", ["i1", "i2", "i3"], "i2");

    expect(flow).toEqual({
      domain: "demo",
      ids: ["i1", "i2", "i3"],
      current: 1,
      answered: [],
      skipped: [],
    });
  });

  test("advances past answered and skipped questions, then reaches done", () => {
    const started = startAnswerFlow("demo", ["i1", "i2"], "i1");
    const answeredFirst = advanceAnswerFlow(started, "answered");
    const skippedSecond = advanceAnswerFlow(answeredFirst, "skipped");

    expect(answeredFirst.current).toBe(1);
    expect(answeredFirst.answered).toEqual(["i1"]);
    expect(skippedSecond.current).toBe(2);
    expect(skippedSecond.skipped).toEqual(["i2"]);
  });

  test("wraps to an unanswered question when navigation jumped ahead", () => {
    const started = startAnswerFlow("demo", ["i1", "i2", "i3"], "i1");
    const selectedThird = { ...started, current: 2 };
    const advanced = advanceAnswerFlow(selectedThird, "answered");

    expect(advanced.current).toBe(0);
    expect(advanced.answered).toEqual(["i3"]);
  });

  test("falls back to the first variation for an invalid persisted preference", () => {
    expect(storedFlowVariation(undefined)).toBe("queue");
    expect(storedFlowVariation("focus")).toBe("focus");
    expect(storedFlowVariation("unsupported")).toBe("queue");
  });

  test("returns the same flow when its current question no longer exists", () => {
    const flow = { ...startAnswerFlow("demo", ["i1"], "i1"), current: 3 };

    expect(advanceAnswerFlow(flow, "answered")).toBe(flow);
  });
});
