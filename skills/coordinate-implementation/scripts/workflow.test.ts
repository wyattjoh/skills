import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine } from "./lib/engine.ts";
import { readEventsSince } from "./lib/event-log.ts";
import {
  computeWaves,
  WorkflowError,
  type TicketInfo,
  type TicketOps,
} from "./lib/workflow-runtime.ts";
import { standardTicket, workflow, type Run } from "./workflow.ts";

const GRAPH = [
  { number: "01", blocked_by: [] },
  { number: "02", blocked_by: ["01"] },
  { number: "03", blocked_by: ["01"] },
  { number: "04", blocked_by: ["02", "03"] },
  { number: "05", blocked_by: [] },
];

const row = (number: string, status: string) =>
  `| ${number}  | pi | m | high | 0 | - | ${status} | - |`;

const makeRun = (statuses: Record<string, string> = {}, cap = 2): string => {
  const runPath = mkdtempSync(join(tmpdir(), "coordinate-workflow-"));
  writeFileSync(
    join(runPath, "snapshot.json"),
    JSON.stringify({
      tickets: GRAPH.map((ticket) => ({ ...ticket, path: `issues/${ticket.number}-x.md` })),
    }),
  );
  writeFileSync(
    join(runPath, "RESUME.md"),
    [
      "# Run",
      "",
      "Schema version: 2",
      "Mode:            parallel",
      `Parallel cap:    ${cap}`,
      "",
      "## Tickets",
      "",
      "| NN  | harness | model | effort | rounds | esc | status | sha |",
      "| --- | ------- | ----- | ------ | ------ | --- | ------ | --- |",
      ...GRAPH.map((ticket) => row(ticket.number, statuses[ticket.number] ?? "queued")),
      "",
    ].join("\n"),
  );
  return runPath;
};

const setStatus = (runPath: string, number: string, status: string): void => {
  const path = join(runPath, "RESUME.md");
  const text = readFileSync(path, "utf8").replace(
    new RegExp(`^\\| ${number} .*$`, "mu"),
    row(number, status),
  );
  writeFileSync(path, text);
};

type Trace = { calls: string[]; active: number; peak: number };

const fakeOps = (
  runPath: string,
  trace: Trace,
  behavior: Partial<Record<string, Partial<Record<keyof TicketOps, unknown[]>>>> = {},
): TicketOps => {
  const next = (ticket: TicketInfo, op: keyof TicketOps, fallback: unknown) => {
    const queue = behavior[ticket.number]?.[op];
    return queue !== undefined && queue.length > 0 ? queue.shift() : fallback;
  };
  const record = <A>(ticket: TicketInfo, op: keyof TicketOps, value: A) =>
    Effect.gen(function* () {
      trace.calls.push(`${ticket.number}:${op}`);
      if (value instanceof WorkflowError) return yield* Effect.fail(value);
      return value;
    });
  return {
    implement: (ticket) =>
      Effect.gen(function* () {
        trace.active += 1;
        trace.peak = Math.max(trace.peak, trace.active);
        setStatus(runPath, ticket.number, "working");
        yield* Effect.sleep(5);
        yield* record(ticket, "implement", next(ticket, "implement", undefined));
      }),
    rebase: (ticket) => record(ticket, "rebase", next(ticket, "rebase", "up_to_date")) as never,
    gates: (ticket) =>
      record(
        ticket,
        "gates",
        next(ticket, "gates", { passed: true, failed: [], readyToLand: false }),
      ) as never,
    selfReview: (ticket) => record(ticket, "selfReview", undefined) as never,
    review: (ticket, axis) => record(ticket, `review` as const, axis).pipe(Effect.asVoid),
    finalizeRound: (ticket) =>
      record(
        ticket,
        "finalizeRound",
        next(ticket, "finalizeRound", { action: "land", fixRequestPath: null }),
      ) as never,
    fix: (ticket, request) => record(ticket, "fix", request).pipe(Effect.asVoid),
    beforeLaunch: () => Effect.void,
    finish: () => Effect.void,
    land: (ticket) =>
      Effect.gen(function* () {
        const outcome = (yield* record(ticket, "land", next(ticket, "land", "landed"))) as string;
        if (outcome === "landed") {
          setStatus(runPath, ticket.number, "landed");
          trace.active -= 1;
        }
        return outcome as "landed" | "rebase_required";
      }),
  };
};

const runWorkflow = async (runPath: string, ops: TicketOps, body: (run: Run) => Promise<void>) => {
  const module = workflow(body, { ops: () => ops });
  return Effect.runPromise(
    runEngine({
      statePath: join(runPath, "RESUME.md"),
      expectedGeneration: 0,
      scriptSha256: "sha",
      pid: process.pid,
      host: "host-a",
      pane: null,
      heartbeatMs: 1_000,
      now: () => new Date("2026-09-25T12:00:00Z"),
      workflow: module.run,
    }),
  );
};

describe("workflow frontier", () => {
  it("lands a diamond graph in dependency order within the parallel cap", async () => {
    const runPath = makeRun();
    const trace: Trace = { calls: [], active: 0, peak: 0 };
    let result: unknown;

    const exit = await runWorkflow(runPath, fakeOps(runPath, trace), async (run) => {
      result = await run.frontier((ticket) => standardTicket(ticket));
    });
    const implemented = trace.calls.filter((call) => call.endsWith(":implement"));

    expect(exit.reason).toBe("completed");
    expect(result).toEqual({ landed: ["01", "02", "03", "04", "05"], blocked: [] });
    expect(trace.peak).toBe(2);
    expect(implemented.indexOf("04:implement")).toBe(4);
    expect(implemented.slice(0, 2)).toEqual(["01:implement", "05:implement"]);
  });

  it("blocks only the failing ticket and its dependents", async () => {
    const runPath = makeRun({}, 3);
    const trace: Trace = { calls: [], active: 0, peak: 0 };
    const failure = new WorkflowError({
      code: "retry.exhausted",
      message: "Implementor launch failed four times.",
      remediation: "Answer the escalation.",
    });
    let result: { landed: string[]; blocked: Array<{ ticket: string }> } | undefined;

    await runWorkflow(
      runPath,
      fakeOps(runPath, trace, { "02": { implement: [failure] } }),
      async (run) => {
        result = await run.frontier((ticket) => standardTicket(ticket));
      },
    );
    const events = await Effect.runPromise(readEventsSince(runPath, 0));

    expect(result?.landed).toEqual(["01", "03", "05"]);
    expect(result?.blocked.map((entry) => entry.ticket)).toEqual(["02"]);
    expect(
      events.events.filter((event) => event.type === "ticket.blocked").map((event) => event.ticket),
    ).toEqual(["02"]);
  });

  it("skips tickets already landed by a previous engine generation", async () => {
    const runPath = makeRun({ "01": "landed", "05": "landed" });
    const trace: Trace = { calls: [], active: 0, peak: 0 };

    await runWorkflow(runPath, fakeOps(runPath, trace), async (run) => {
      await run.frontier((ticket) => standardTicket(ticket));
    });

    expect(trace.calls.filter((call) => call.endsWith(":implement"))).toEqual([
      "02:implement",
      "03:implement",
      "04:implement",
    ]);
  });

  it("loops the standard pipeline through gate fixes, review fixes, and a refused landing", async () => {
    const runPath = makeRun();
    const trace: Trace = { calls: [], active: 0, peak: 0 };

    await runWorkflow(
      runPath,
      fakeOps(runPath, trace, {
        "01": {
          gates: [{ passed: false, failed: ["test"], readyToLand: false }],
          finalizeRound: [{ action: "fix", fixRequestPath: "briefs/fixes-01-round-1.md" }],
          land: ["rebase_required"],
        },
      }),
      async (run) => {
        await run.frontier((ticket) => standardTicket(ticket), { parallel: 1 });
      },
    );

    expect(trace.calls.filter((call) => call.startsWith("01:"))).toEqual([
      "01:implement",
      "01:rebase",
      "01:gates",
      "01:fix",
      "01:rebase",
      "01:gates",
      "01:selfReview",
      "01:review",
      "01:review",
      "01:finalizeRound",
      "01:fix",
      "01:rebase",
      "01:gates",
      "01:selfReview",
      "01:review",
      "01:review",
      "01:finalizeRound",
      "01:land",
      "01:rebase",
      "01:gates",
      "01:selfReview",
      "01:review",
      "01:review",
      "01:finalizeRound",
      "01:land",
    ]);
  });

  it("memoizes custom steps across engine generations", async () => {
    const runPath = makeRun({
      "01": "landed",
      "02": "landed",
      "03": "landed",
      "04": "landed",
      "05": "landed",
    });
    const trace: Trace = { calls: [], active: 0, peak: 0 };
    let executions = 0;
    const body = async (run: Run) => {
      await run.step("choose-order", async () => {
        executions += 1;
        return ["01", "05"];
      });
    };

    await runWorkflow(runPath, fakeOps(runPath, trace), body);
    const second = workflow(body, { ops: () => fakeOps(runPath, trace) });
    await Effect.runPromise(
      runEngine({
        statePath: join(runPath, "RESUME.md"),
        expectedGeneration: 1,
        scriptSha256: "sha",
        pid: process.pid,
        host: "host-a",
        pane: null,
        heartbeatMs: 1_000,
        now: () => new Date("2026-09-25T12:00:00Z"),
        workflow: second.run,
      }),
    );

    expect(executions).toBe(1);
    expect(
      JSON.parse(readFileSync(join(runPath, "steps", "run", "choose-order.json"), "utf8")),
    ).toEqual({ value: ["01", "05"] });
  });

  it("computes reporting waves from the graph", () => {
    const waves = computeWaves(
      GRAPH.map((ticket) => ({ number: ticket.number, path: "", blockedBy: ticket.blocked_by })),
    );

    expect(waves).toEqual([["01", "05"], ["02", "03"], ["04"]]);
  });
});
