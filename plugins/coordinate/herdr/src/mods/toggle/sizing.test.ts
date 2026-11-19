import { expect, test } from "bun:test";
import {
  fitIdentity,
  fitInset,
  fitRequest,
  fitTarget,
  fitWidth,
  type FitHistory,
  type FitTarget,
} from "./sizing.ts";
import { PILL_SPACING, TOGGLE_END_INSET } from "./look.ts";

const block = (id = "backlog-toggle", px = 100, fields: Record<string, unknown> = {}) => ({
  id,
  type: "block",
  size: { px },
  content: { mod: "coordinate-toggle", props: { block: id } },
  ...fields,
});
const row = (...children: unknown[]) => ({ type: "row", children });
const props = { block: "backlog-toggle" };
const target = (fields: Partial<FitTarget> = {}): FitTarget => ({
  id: "backlog-toggle",
  current: 100,
  min: 1,
  max: Infinity,
  inset: TOGGLE_END_INSET,
  ...fields,
});
const fresh = (): FitHistory => ({ fitted: undefined, requests: [], stopped: false });

test("fit identity comes only from an explicit nonblank block prop", () => {
  for (const value of [undefined, null, {}, { block: 4 }, { block: "" }, { block: " \t" }])
    expect(fitIdentity(value)).toBeUndefined();
  expect(fitIdentity(props)).toBe("backlog-toggle");
});

test("the target is the unique inline row block and uses the inset for its position", () => {
  const before = block("before");
  const current = block();
  expect(fitTarget(row(before, current), props)).toEqual(target());
  expect(fitTarget(row(before, current, block("after")), props)).toEqual(
    target({ inset: PILL_SPACING }),
  );
  expect(fitInset(row(before, current), props)).toBe(TOGGLE_END_INSET);
  expect(fitInset(row(before, current, block("after")), props)).toBe(PILL_SPACING);
});

test("missing, ambiguous, floating, nested and mismatched targets fail closed", () => {
  for (const [tree, candidateProps] of [
    [row(block()), undefined],
    [row(block()), {}],
    [row(block()), { block: "missing" }],
    [row(block(), block()), props],
    [{ type: "column", children: [block()] }, props],
    [{ type: "row", floating: [block()] }, props],
    [row({ type: "column", children: [block()] }), props],
    [row(block("backlog-toggle", 100, { content: { mod: "other", props } })), props],
    [
      row(block("backlog-toggle", 100, { content: { mod: "coordinate-toggle", props: {} } })),
      props,
    ],
  ] as const)
    expect(fitTarget(tree, candidateProps)).toBeUndefined();
});

test("logical measurements add one inset and round up after addition", () => {
  expect(fitWidth(40, TOGGLE_END_INSET)).toBe(50);
  expect(fitWidth(40.25, TOGGLE_END_INSET)).toBe(51);
  expect(fitWidth(40.25, PILL_SPACING)).toBe(44);
  expect(fitWidth(0.1, 0)).toBe(1);
  for (const width of [0, -1, NaN, Infinity, -Infinity])
    expect(fitWidth(width, TOGGLE_END_INSET)).toBeUndefined();
  for (const inset of [-1, NaN, Infinity, -Infinity]) expect(fitWidth(40, inset)).toBeUndefined();
});

test("fit requests clamp, deduplicate, and bound repeated layout feedback", () => {
  const first = fitRequest(fresh(), target(), 51, 0);
  expect(first.request).toEqual({ id: "backlog-toggle", px: 51 });
  expect(first.history).toEqual({
    fitted: { id: "backlog-toggle", px: 51 },
    requests: [0],
    stopped: false,
  });
  expect(fitRequest(first.history, target(), 51, 1).request).toBeUndefined();
  expect(fitRequest(fresh(), target({ min: 55, max: 65 }), 51, 1).request).toEqual({
    id: "backlog-toggle",
    px: 55,
  });

  let history = fresh();
  for (let index = 0; index < 8; index++) {
    const next = fitRequest(history, target(), 60 + index, index);
    expect(next.request?.px).toBe(60 + index);
    history = next.history;
  }
  const stopped = fitRequest(history, target(), 80, 8);
  expect(stopped.request).toBeUndefined();
  expect(stopped.history.stopped).toBe(true);
});
