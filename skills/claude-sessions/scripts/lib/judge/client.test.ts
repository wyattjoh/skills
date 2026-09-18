import { afterEach, describe, expect, it } from "bun:test";
import type { Fetch } from "@typesafe-ai/sdk";
import { openDb } from "../db.ts";
import { judgeRows } from "./client.ts";
import { validateJudgeFile, truncateState } from "./state.ts";

const diagnostic = (): void => undefined;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function goodAnswer(state: string): unknown {
  const isSecond = state.includes("second");
  return {
    model: "test-model",
    answers: {
      kind: {
        type: "choice",
        choice: isSecond ? "clarification" : "correction",
        confidence: 0.8,
        probabilities: {
          correction: isSecond ? 0.1 : 0.8,
          clarification: isSecond ? 0.8 : 0.1,
          new_task: 0.03,
          approval: 0.02,
          abort: 0.05,
        },
      },
      wrong_way: { type: "noul", noul: 0.5 },
    },
    usage: { input_tokens: 10, output_tokens: 3 },
  };
}

function makeDb() {
  return openDb(":memory:");
}

const connectionFetch: Fetch = async () => {
  throw new TypeError("offline");
};

afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
});

describe("judgeRows", () => {
  it("sends redacted state and annotates each primitive's uncertainty", async () => {
    const db = makeDb();
    const bodies: string[] = [];
    const fetch: Fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return response(goodAnswer(String(init?.body)));
    };

    try {
      const result = await judgeRows(
        [
          {
            kind: "interrupt",
            user_text_after: "TOKEN=abcd1234efgh",
            secret: "sk-ant-abcdefghijklmnopqrstuvwxyz",
          },
        ],
        "steering",
        {
          db,
          apiKey: "test-key",
          fetch,
          diagnostic,
          now: new Date("2026-01-01T00:00:00.000Z"),
        },
      );

      expect(result.status).toBe("ok");
      expect(result.rows_judged).toBe(1);
      expect(result.rows_cached).toBe(0);
      expect(result.rows[0]?.judge).toEqual({
        status: "ok",
        reason: null,
        error_class: null,
        answers: {
          kind: {
            type: "choice",
            choice: "correction",
            confidence: 0.8,
            probabilities: {
              correction: 0.8,
              clarification: 0.1,
              new_task: 0.03,
              approval: 0.02,
              abort: 0.05,
            },
            uncertain: false,
          },
          wrong_way: { type: "noul", noul: 0.5, uncertain: true },
        },
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.includes("abcd1234efgh")).toBe(false);
      expect(bodies[0]?.includes("sk-ant-abcdefghijklmnopqrstuvwxyz")).toBe(false);
      expect(bodies[0]?.includes("[redacted:env-secret]")).toBe(true);
      expect(bodies[0]?.includes("[redacted:anthropic-key]")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("skips every row without constructing a client when the key is missing", async () => {
    const db = makeDb();
    let calls = 0;
    const fetch: Fetch = async () => {
      calls += 1;
      return response(goodAnswer(""));
    };

    try {
      const result = await judgeRows([{ value: "row" }], "steering", { db, fetch, diagnostic });
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("no_api_key");
      expect(result.error_class).toBe(null);
      expect(result.rows_judged).toBe(0);
      expect(result.rows[0]?.judge.reason).toBe("no_api_key");
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it("maps connection and rate-limit failures without dropping rows", async () => {
    const connectionDb = makeDb();
    try {
      const connection = await judgeRows([{ value: "row" }], "steering", {
        db: connectionDb,
        apiKey: "test-key",
        fetch: connectionFetch,
        retry: { maxRetries: 0 },
        diagnostic,
      });
      expect(connection.status).toBe("skipped");
      expect(connection.reason).toBe("connection");
      expect(connection.rows).toHaveLength(1);
      expect(connection.rows[0]?.judge.error_class).toBe("APIConnectionError");
    } finally {
      connectionDb.close();
    }

    const rateDb = makeDb();
    let rateCalls = 0;
    const rateFetch: Fetch = async () => {
      rateCalls += 1;
      return response({ error: "slow down" }, 429);
    };
    try {
      const rate = await judgeRows([{ value: "row" }], "steering", {
        db: rateDb,
        apiKey: "test-key",
        fetch: rateFetch,
        retry: { maxRetries: 2, backoffInitialMs: 0, backoffMaxMs: 0, backoffJitter: 0 },
        diagnostic,
      });
      expect(rate.status).toBe("skipped");
      expect(rate.reason).toBe("rate_limit");
      expect(rate.rows[0]?.judge.error_class).toBe("RateLimitError");
      expect(rateCalls).toBe(3);
    } finally {
      rateDb.close();
    }
  });

  it("reports malformed answers as bad_answer and partial batches", async () => {
    const db = makeDb();
    const fetch: Fetch = async (_input, init) => {
      const body = String(init?.body);
      return body.includes("bad") ? response({ answers: {} }) : response(goodAnswer(body));
    };

    try {
      const result = await judgeRows([{ value: "good" }, { value: "bad" }], "steering", {
        db,
        apiKey: "test-key",
        fetch,
        retry: { maxRetries: 0 },
        diagnostic,
      });
      expect(result.status).toBe("partial");
      expect(result.reason).toBe(null);
      expect(result.rows_judged).toBe(1);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[1]?.judge).toEqual({
        status: "skipped",
        reason: "bad_answer",
        error_class: null,
        answers: undefined,
      });
    } finally {
      db.close();
    }
  });

  it("rejects score answers with an incomplete legend", async () => {
    const db = makeDb();
    const fetch: Fetch = async () =>
      response({
        answers: {
          score: {
            type: "score",
            score: 1,
            confidence: 0.8,
            legend: {},
            probabilities: { "0": 0.2, "1": 0.8 },
          },
        },
      });

    try {
      const result = await judgeRows(
        [{ value: "row" }],
        {
          name: "score-test",
          questions: {
            score: {
              type: "score",
              criteria: ["poor", "good"],
            },
          },
          buildState: (row) => row,
        },
        { db, apiKey: "test-key", fetch, retry: { maxRetries: 0 }, diagnostic },
      );
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("bad_answer");
      expect(result.rows[0]?.judge.reason).toBe("bad_answer");
    } finally {
      db.close();
    }
  });

  it("uses the sqlite cache and bypasses it with no-cache", async () => {
    const db = makeDb();
    let calls = 0;
    const fetch: Fetch = async (_input, init) => {
      calls += 1;
      return response(goodAnswer(String(init?.body)));
    };
    const options = {
      db,
      apiKey: "test-key",
      fetch,
      diagnostic,
      now: new Date("2026-01-01T00:00:00.000Z"),
    };

    try {
      const first = await judgeRows([{ value: "cached" }], "steering", options);
      const second = await judgeRows([{ value: "cached" }], "steering", options);
      const third = await judgeRows([{ value: "cached" }], "steering", {
        ...options,
        minConfidence: 0.9,
      });
      const fourth = await judgeRows([{ value: "cached" }], "steering", {
        ...options,
        noCache: true,
      });

      expect(first.rows_judged).toBe(1);
      expect(first.rows_cached).toBe(0);
      expect(second.rows_judged).toBe(0);
      expect(second.rows_cached).toBe(1);
      expect(third.rows_judged).toBe(0);
      expect(third.rows_cached).toBe(1);
      expect(third.rows[0]?.judge.answers?.kind).toEqual({
        type: "choice",
        choice: "correction",
        confidence: 0.8,
        probabilities: {
          correction: 0.8,
          clarification: 0.1,
          new_task: 0.03,
          approval: 0.02,
          abort: 0.05,
        },
        uncertain: true,
      });
      expect(fourth.rows_judged).toBe(1);
      expect(fourth.rows_cached).toBe(0);
      expect(calls).toBe(2);
    } finally {
      db.close();
    }
  });

  it("caps requests at max-judge-rows and leaves later rows marked", async () => {
    const db = makeDb();
    let calls = 0;
    const fetch: Fetch = async (_input, init) => {
      calls += 1;
      return response(goodAnswer(String(init?.body)));
    };

    try {
      const result = await judgeRows([{ value: "first" }, { value: "second" }], "steering", {
        db,
        apiKey: "test-key",
        fetch,
        maxRows: 1,
        diagnostic,
      });
      expect(result.status).toBe("partial");
      expect(result.rows_judged).toBe(1);
      expect(result.rows[1]?.judge).toEqual({
        status: "skipped",
        reason: "max_rows",
        error_class: null,
        answers: undefined,
      });
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("judge state", () => {
  it("keeps a deterministic head and tail with a truncation marker", () => {
    const state = `HEAD-${"x".repeat(200)}-TAIL`;
    const truncated = truncateState(state, 80);
    expect(truncated.length).toBeLessThanOrEqual(80);
    expect(truncated.startsWith("HEAD-")).toBe(true);
    expect(truncated.endsWith("-TAIL")).toBe(true);
    expect(truncated.includes("[truncated ")).toBe(true);
  });

  it("validates judge-file questions and state fields", () => {
    expect(() => validateJudgeFile({ questions: {}, state_fields: [] })).toThrow(
      "Judge file questions must be a non-empty object.",
    );
    expect(
      validateJudgeFile({
        questions: {
          relevant: { type: "noul", instructions: "Is this relevant?" },
        },
        state_fields: ["text", "nested.value"],
      }),
    ).toEqual({
      questions: {
        relevant: { type: "noul", instructions: "Is this relevant?" },
      },
      state_fields: ["text", "nested.value"],
    });
  });
});
