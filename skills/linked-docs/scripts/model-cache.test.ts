import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelCache } from "./model-cache.ts";

const endpoint = "https://api.typesafe.ai/v1/systemone";
const dirs: string[] = [];
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "linked-docs-model-cache-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const body = {
  model: "jev-test",
  state: { question: "secret-input" },
  questions: {
    result: { type: "choice", instructions: "Choose the answer", criteria: { a: "A", b: "B" } },
  },
};
const request = (value: unknown = body): RequestInit => ({
  method: "POST",
  body: JSON.stringify(value),
  headers: { Authorization: "Bearer secret-credential" },
});
const answer = {
  answers: { result: { type: "choice", probabilities: { a: 0.7, b: 0.3 } } },
  usage: { input_tokens: 10, output_tokens: 2 },
};
const fake = mock(async () => Response.json(answer));

describe("persistent Jev cache", () => {
  test("reuses exact inputs across separate adapters without storing inputs or headers", async () => {
    fake.mockClear();
    const dir = await directory();
    const first = createModelCache(dir, fake);
    expect(await (await first.fetcher(endpoint, request())).json()).toEqual(answer);
    const second = createModelCache(dir, fake);
    expect(
      await (
        await second.fetcher(endpoint, {
          ...request(),
          headers: { Authorization: "Bearer rotated-credential" },
        })
      ).json(),
    ).toEqual(answer);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(second.metrics).toEqual({
      requests: 1,
      choiceRequests: 1,
      verifyRequests: 0,
      hits: 1,
      inputTokens: 10,
      outputTokens: 2,
      usageResponses: 1,
    });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(/^[a-f0-9]{64}\.json$/.test(files[0])).toBe(true);
    const content = await readFile(join(dir, files[0]), "utf8");
    expect(content.includes("secret-input")).toBe(false);
    expect(content.includes("secret-credential")).toBe(false);
    expect(Object.keys(JSON.parse(content)).toSorted()).toEqual([
      "requestHash",
      "response",
      "version",
    ]);
  });
  test("changes in model, state, instructions or criteria produce distinct inputs", async () => {
    const fresh = mock(async () => Response.json(answer));
    const cache = createModelCache(await directory(), fresh);
    for (const value of [
      body,
      { ...body, model: "another-model" },
      { ...body, state: { question: "another-question" } },
      {
        ...body,
        questions: { result: { ...body.questions.result, instructions: "Another instruction" } },
      },
      {
        ...body,
        questions: { result: { ...body.questions.result, criteria: { a: "Another A", b: "B" } } },
      },
    ])
      await cache.fetcher(endpoint, request(value));
    expect(fresh).toHaveBeenCalledTimes(5);
    expect(cache.metrics.hits).toBe(0);
  });
  test("coalesces concurrent identical inputs but returns independent response bodies", async () => {
    const fresh = mock(async () => Response.json(answer));
    const cache = createModelCache(await directory(), fresh);
    const responses = await Promise.all([
      cache.fetcher(endpoint, request()),
      cache.fetcher(endpoint, request()),
    ]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      answer,
      answer,
    ]);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(cache.metrics.requests).toBe(2);
    expect(cache.metrics.hits).toBe(1);
  });
  test("invalid distributions and HTTP errors are never persisted", async () => {
    const dir = await directory();
    const invalid = mock(async () =>
      Response.json({
        answers: { result: { type: "choice", probabilities: { a: 1.1, b: -0.1 } } },
      }),
    );
    const cache = createModelCache(dir, invalid);
    await cache.fetcher(endpoint, request());
    await cache.fetcher(endpoint, request());
    expect(invalid).toHaveBeenCalledTimes(2);
    expect(await readdir(dir)).toEqual([]);
    const denied = mock(async () => new Response("secret server error", { status: 401 }));
    const errors = createModelCache(dir, denied);
    expect((await errors.fetcher(endpoint, request())).status).toBe(401);
    expect((await errors.fetcher(endpoint, request())).status).toBe(401);
    expect(denied).toHaveBeenCalledTimes(2);
    expect(await readdir(dir)).toEqual([]);
  });
  test("corrupt or mismatched cache entries are misses, not fabricated judgments", async () => {
    const dir = await directory();
    const fresh = mock(async () => Response.json(answer));
    await createModelCache(dir, fresh).fetcher(endpoint, request());
    const file = join(dir, (await readdir(dir))[0]);
    await writeFile(file, "invalid json");
    await createModelCache(dir, fresh).fetcher(endpoint, request());
    const entry = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...entry, requestHash: "wrong-input" }));
    await createModelCache(dir, fresh).fetcher(endpoint, request());
    const clean = JSON.parse(await readFile(file, "utf8"));
    const invalid = { answers: { result: { type: "choice", probabilities: { a: 1.1, b: -0.1 } } } };
    await writeFile(file, JSON.stringify({ ...clean, response: JSON.stringify(invalid) }));
    const replay = createModelCache(dir, fresh);
    expect(await (await replay.fetcher(endpoint, request())).json()).toEqual(answer);
    expect(replay.metrics.hits).toBe(0);
    expect(fresh).toHaveBeenCalledTimes(4);
  });
  test("validates Noul and batched answers and drops unneeded server metadata", async () => {
    const dir = await directory();
    const fresh = mock(async () =>
      Response.json({
        ...answer,
        answers: { result: answer.answers.result, verify: { type: "noul", noul: 0.9 } },
        echoed_state: "secret-input",
      }),
    );
    const value = {
      ...body,
      questions: { ...body.questions, verify: { type: "noul", instructions: "Is this useful?" } },
    };
    await createModelCache(dir, fresh).fetcher(endpoint, request(value));
    const replay = createModelCache(dir, fresh);
    const output = await (await replay.fetcher(endpoint, request(value))).json();
    expect(Object.keys(output).toSorted()).toEqual(["answers", "usage"]);
    expect(output.answers.verify).toEqual({ type: "noul", noul: 0.9 });
    expect(replay.metrics.verifyRequests).toBe(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  test("invalid Noul probabilities are not cached and missing usage stays unknown", async () => {
    const invalidDir = await directory();
    const value = { ...body, questions: { result: { type: "noul", instructions: "Useful?" } } };
    const invalid = createModelCache(invalidDir, async () =>
      Response.json({ answers: { result: { type: "noul", noul: 2 } } }),
    );
    await invalid.fetcher(endpoint, request(value));
    expect(await readdir(invalidDir)).toEqual([]);
    const dir = await directory();
    const fresh = mock(async () => Response.json({ answers: answer.answers }));
    await createModelCache(dir, fresh).fetcher(endpoint, request());
    const replay = createModelCache(dir, fresh);
    await replay.fetcher(endpoint, request());
    expect(replay.metrics.hits).toBe(1);
    expect(replay.metrics.usageResponses).toBe(0);
    expect(replay.metrics.inputTokens).toBe(0);
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  test("bounds model response bodies before persisting them", async () => {
    const dir = await directory();
    const cache = createModelCache(dir, async () => new Response("x".repeat(100_001)));
    await expect(cache.fetcher(endpoint, request())).rejects.toThrow("100000-byte budget");
    expect(await readdir(dir)).toEqual([]);
  });
  test("cache read failures fail closed before spending a request", async () => {
    const dir = await directory();
    const file = join(dir, "a-file");
    await writeFile(file, "file not directory");
    const fresh = mock(async () => Response.json(answer));
    await expect(createModelCache(file, fresh).fetcher(endpoint, request())).rejects.toThrow(
      "Cannot read Jev response cache",
    );
    expect(fresh).toHaveBeenCalledTimes(0);
  });
});
