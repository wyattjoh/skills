import { describe, expect, test } from "bun:test";
import {
  advanceAnswerFlow,
  dropClearedQuestions,
  layoutAnswerFlowCards,
  startAnswerFlow,
} from "./answer-flow.ts";
import type { FlowAskState } from "./answer-flow.ts";

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

  test("returns the same flow when its current question no longer exists", () => {
    const flow = { ...startAnswerFlow("demo", ["i1"], "i1"), current: 3 };

    expect(advanceAnswerFlow(flow, "answered")).toBe(flow);
  });

  test("lays out every card around a fixed focus center with a continuous vertical gap", () => {
    const cards = [
      { id: "i1", compactHeight: 72, expandedHeight: 100 },
      { id: "i2", compactHeight: 80, expandedHeight: 120 },
      { id: "i3", compactHeight: 88, expandedHeight: 140 },
      { id: "i4", compactHeight: 96, expandedHeight: 160 },
      { id: "i5", compactHeight: 104, expandedHeight: 180 },
      { id: "done", compactHeight: 72, expandedHeight: 100 },
    ];
    const options = {
      activeIndex: 2,
      viewportWidth: 360,
      viewportHeight: 600,
      gap: 10,
      compactWidthRatio: 0.9,
      compactNeighborInset: 12,
      neighborOpacity: 0.58,
      distanceOpacityFalloff: 0.12,
    };
    const current = layoutAnswerFlowCards(cards, options);
    const next = layoutAnswerFlowCards(cards, { ...options, activeIndex: 3 });

    expect(current.map(({ id }) => id)).toEqual(["i1", "i2", "i3", "i4", "i5", "done"]);
    expect(current.map(({ top }) => top)).toEqual([58, 140, 230, 380, 486, 600]);
    expect(current[2]).toMatchObject({ top: 230, left: 18, width: 324, height: 140, opacity: 1 });
    expect(current[1]).toMatchObject({ left: 30, width: 300, height: 80, opacity: 0.58 });
    expect(current.map(({ left, width }, index) => ({ left, width, index }))).toEqual(
      cards.map((_card, index) => ({
        index,
        left: index === 2 ? 18 : 30,
        width: index === 2 ? 324 : 300,
      })),
    );
    expect(current[0]?.opacity).toBeCloseTo(0.5104);
    expect(current[3]?.opacity).toBe(0.58);
    expect(current[4]?.opacity).toBeCloseTo(0.5104);
    expect(current[5]?.opacity).toBe(0);
    expect(next.map(({ top }) => top)).toEqual([-50, 32, 122, 220, 390, 504]);
    expect(next[3]).toMatchObject({ left: 18, width: 324, height: 160, expanded: true });
    expect(next[2]).toMatchObject({ left: 30, width: 300 });
    expect(next[0]?.opacity).toBeCloseTo(0.58 * 0.76 * (22 / 72));
    expect(next[1]?.opacity).toBeCloseTo(0.5104);
    expect(next[5]?.opacity).toBeCloseTo(0.5104);
    expect(next.filter(({ opacity }) => opacity > 0).map(({ id }) => id)).toEqual([
      "i1",
      "i2",
      "i3",
      "i4",
      "i5",
      "done",
    ]);
    expect(
      next.map(({ top }, index) => ({
        index,
        moved: top !== current[index]?.top,
      })),
    ).toEqual(cards.map((_card, index) => ({ index, moved: true })));

    for (const placements of [current, next]) {
      const active = placements.find((placement) => placement.expanded);
      expect(active?.top + active!.height / 2).toBe(300);
      expect(
        placements
          .slice(0, -1)
          .map((placement, index) => placements[index + 1]!.top - placement.top - placement.height),
      ).toEqual([10, 10, 10, 10, 10]);
    }
  });

  test("centers narrower neighbor cards around the focus at narrow and wide widths", () => {
    const cards = Array.from({ length: 4 }, (_, index) => ({
      id: `i${index}`,
      compactHeight: 72,
      expandedHeight: 160,
    }));
    for (const viewportWidth of [280, 720]) {
      const focusWidth = viewportWidth * 0.9;
      const previewWidth = focusWidth - 24;
      for (const activeIndex of [1, 2, 1]) {
        const placements = layoutAnswerFlowCards(cards, {
          activeIndex,
          viewportWidth,
          viewportHeight: 600,
          gap: 10,
          compactWidthRatio: 0.9,
          compactNeighborInset: 12,
          neighborOpacity: 0.58,
          distanceOpacityFalloff: 0.12,
        });
        const focus = placements[activeIndex]!;
        const neighbors = [placements[activeIndex - 1]!, placements[activeIndex + 1]!];

        expect(focus).toMatchObject({
          left: (viewportWidth - focusWidth) / 2,
          width: focusWidth,
          expanded: true,
        });
        expect(neighbors.map(({ left, width }) => ({ left, width }))).toEqual([
          { left: (viewportWidth - previewWidth) / 2, width: previewWidth },
          { left: (viewportWidth - previewWidth) / 2, width: previewWidth },
        ]);
        expect(neighbors.map(({ left, width }) => left + width / 2)).toEqual([
          viewportWidth / 2,
          viewportWidth / 2,
        ]);
      }
    }
  });

  test("shows every compact card that fits the measured viewport and fades cards at its edges", () => {
    const cards = Array.from({ length: 13 }, (_, index) => ({
      id: `i${index}`,
      compactHeight: 72,
      expandedHeight: 200,
    }));
    const options = {
      activeIndex: 6,
      viewportWidth: 360,
      gap: 10,
      compactWidthRatio: 0.9,
      compactNeighborInset: 12,
      neighborOpacity: 0.58,
      distanceOpacityFalloff: 0.12,
    };
    const short = layoutAnswerFlowCards(cards, { ...options, viewportHeight: 360 });
    const tall = layoutAnswerFlowCards(cards, { ...options, viewportHeight: 960 });

    expect(short.filter(({ opacity }) => opacity > 0).map(({ id }) => id)).toEqual([
      "i5",
      "i6",
      "i7",
    ]);
    expect(short.find(({ id }) => id === "i5")?.opacity).toBeCloseTo(0.58 * (70 / 72));
    expect(short.find(({ id }) => id === "i7")?.opacity).toBeCloseTo(0.58 * (70 / 72));
    expect(tall.filter(({ opacity }) => opacity > 0).map(({ id }) => id)).toEqual(
      cards.slice(1, 12).map(({ id }) => id),
    );
    const active = tall.find(({ id }) => id === "i6");
    expect(active === undefined ? undefined : active.top + active.height / 2).toBe(480);
  });

  test("fades and compacts the stack when leaving the flow", () => {
    const placements = layoutAnswerFlowCards(
      [
        { id: "i1", compactHeight: 72, expandedHeight: 120 },
        { id: "i2", compactHeight: 80, expandedHeight: 160 },
        { id: "done", compactHeight: 72, expandedHeight: 100 },
      ],
      {
        activeIndex: 1,
        viewportWidth: 360,
        viewportHeight: 600,
        gap: 10,
        compactWidthRatio: 0.9,
        compactNeighborInset: 12,
        neighborOpacity: 0.58,
        distanceOpacityFalloff: 0.12,
        exiting: true,
      },
    );

    expect(placements.map(({ opacity }) => opacity)).toEqual([0, 0, 0]);
    expect(placements.map(({ expanded }) => expanded)).toEqual([false, false, false]);
    expect(placements[1]).toMatchObject({ top: 260, height: 80, left: 30, width: 300 });
  });
});

const states =
  (cleared: string[], missing: string[] = []) =>
  (id: string): FlowAskState =>
    cleared.includes(id) ? "cleared" : missing.includes(id) ? "missing" : "open";

describe("dropping questions answered outside the flow", () => {
  test("returns the same flow when nothing cleared", () => {
    const flow = startAnswerFlow("demo", ["i1", "i2", "i3"], "i2");

    expect(dropClearedQuestions(flow, states([]))).toEqual({ flow, dropped: [] });
    expect(dropClearedQuestions(flow, states([])).flow).toBe(flow);
  });

  test("drops a cleared question after the current one and keeps the current question", () => {
    const flow = startAnswerFlow("demo", ["i1", "i2", "i3"], "i1");

    expect(dropClearedQuestions(flow, states(["i2"]))).toEqual({
      flow: { domain: "demo", ids: ["i1", "i3"], current: 0, answered: [], skipped: [] },
      dropped: ["i2"],
    });
  });

  test("keeps the current question's place when an earlier question is dropped", () => {
    const flow = startAnswerFlow("demo", ["i1", "i2", "i3"], "i3");

    const { flow: repaired } = dropClearedQuestions(flow, states(["i1"]));
    expect([repaired.ids, repaired.current]).toEqual([["i2", "i3"], 1]);
  });

  test("moves to the next open question when the current one is dropped", () => {
    const started = startAnswerFlow("demo", ["i1", "i2", "i3", "i4"], "i2");
    const flow = { ...started, answered: ["i1"], skipped: ["i3"] };

    const { flow: repaired, dropped } = dropClearedQuestions(flow, states(["i2"]));
    expect([repaired.ids, repaired.current, dropped]).toEqual([["i1", "i3", "i4"], 2, ["i2"]]);
  });

  test("wraps to the first open question, then to the summary, when none follows", () => {
    const started = startAnswerFlow("demo", ["i1", "i2", "i3"], "i3");
    const flow = { ...started, answered: ["i2"] };

    expect(dropClearedQuestions(flow, states(["i3"])).flow.current).toBe(0);
    expect(
      dropClearedQuestions({ ...flow, answered: ["i1", "i2"] }, states(["i3"])).flow.current,
    ).toBe(2);
  });

  test("keeps questions answered in the flow, missing items and the protected id", () => {
    const started = startAnswerFlow("demo", ["i1", "i2", "i3", "i4"], "i1");
    const flow = { ...started, answered: ["i1"] };

    const { flow: repaired, dropped } = dropClearedQuestions(
      flow,
      states(["i1", "i2", "i3"], ["i4"]),
      "i2",
    );
    expect([repaired.ids, dropped]).toEqual([["i1", "i2", "i4"], ["i3"]]);
  });

  test("forgets dropped questions that were skipped and leaves the summary position", () => {
    const started = startAnswerFlow("demo", ["i1", "i2"], "i1");
    const flow = { ...started, skipped: ["i1"], current: 2 };

    const { flow: repaired } = dropClearedQuestions(flow, states(["i1"]));
    expect([repaired.ids, repaired.skipped, repaired.current]).toEqual([["i2"], [], 1]);
  });
});
