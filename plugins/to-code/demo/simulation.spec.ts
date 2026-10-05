import { expect, test } from "bun:test";

import { createSimulation } from "./simulation.ts";

const reviewing = () => {
  const s = createSimulation();
  s.dispatch("start");
  s.dispatch("complete");
  s.dispatch("review");
  return s;
};
const approve = (s: ReturnType<typeof createSimulation>) => {
  s.dispatch("submit", "reviewer", s.template("approved"));
  s.dispatch("forward");
};

test("browser fake operations use actual production guard and approved landing snapshots", () => {
  const s = createSimulation();
  s.dispatch("start");
  s.dispatch("stop");
  s.dispatch("stop");
  expect(s.getState().workers.implementor?.value.reprompts).toBe(2);
  expect(s.getState().notice).toContain("Assignment open");
  s.dispatch("complete");
  s.dispatch("review");
  approve(s);
  s.dispatch("land");
  expect(s.getState().error).toBe(true);
  expect(s.getState().ticket?.state.path).toBe("ReadyToLand");
  s.configure({ merged: true });
  s.dispatch("land");
  expect(s.getState().ticket?.state.path).toBe("Landed");
  expect(s.getState().workers.reviewer?.state.path).toBe("Retired");
});

test("invalid/stale Markdown cannot clear review; refreshed review retains the worker", () => {
  const s = reviewing();
  s.dispatch("submit", "reviewer", "# Review");
  expect(s.getState().workers.reviewer?.state.path).toBe("Active");
  const stale = s.template("approved");
  s.dispatch("head");
  s.dispatch("submit", "reviewer", stale);
  expect(s.getState().error).toBe(true);
  s.dispatch("refresh");
  s.dispatch("complete");
  s.dispatch("review");
  expect(s.getState().workers.reviewer?.value.workerId).toBe("r-1");
  approve(s);
  expect(s.getState().ticket?.state.path).toBe("ReadyToLand");
});

test("findings route to implementor, fixes rearm retained reviewer, questions rebind", () => {
  const s = reviewing();
  s.dispatch("question", "reviewer");
  s.dispatch("answer", "reviewer");
  s.dispatch("submit", "reviewer", s.template("changes_requested"));
  expect(s.getState().ticket?.state.path).toBe("Fixing");
  s.dispatch("head");
  s.dispatch("rereview");
  expect(s.getState().ticket?.state.path).toBe("Reviewing");
  approve(s);
  expect(s.getState().ticket?.state.path).toBe("ReadyToLand");
});

test("actual Machine codecs restore offline callbacks and recorded fault waiting", () => {
  const s = createSimulation();
  s.configure({ online: false });
  s.dispatch("start");
  s.dispatch("complete");
  s.dispatch("save");
  s.dispatch("restore");
  expect(s.getState().error).toBe(false);
  expect(s.getState().callbacks.filter((c) => c.delivered === false).length).toBe(1);
  s.dispatch("recover");
  expect(s.getState().callbacks.filter((c) => c.delivered === false).length).toBe(0);
  const fault = createSimulation();
  fault.dispatch("start");
  fault.dispatch("fault");
  fault.dispatch("stop");
  expect(fault.getState().workers.implementor?.state.path).toBe("Lost");
  expect(fault.getState().error).toBe(false);
  fault.dispatch("refresh");
  expect(fault.getState().ticket?.state.path).toBe("Implementing");
});

test("durable landing precedes retryable foreign-occupant cleanup refusal", () => {
  const s = reviewing();
  approve(s);
  s.configure({ merged: true, foreignPane: true });
  s.dispatch("land");
  expect(s.getState().ticket?.state.path).toBe("Landed");
  expect(s.getState().workers.implementor?.state.path).toBe("Reported");
  s.configure({ foreignPane: false });
  s.dispatch("land");
  expect(s.getState().workers.implementor?.state.path).toBe("Retired");
});
