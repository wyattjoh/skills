import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { choiceProbabilities, noulProbability, readBody } from "./retrieve.ts";

const endpoint = "https://api.typesafe.ai/v1/systemone";
const entrySchema = Schema.Struct({
  version: Schema.Literal(1),
  requestHash: Schema.String,
  response: Schema.String,
});
const requestSchema = Schema.Struct({
  questions: Schema.Record({
    key: Schema.String,
    value: Schema.Union(
      Schema.Struct({
        type: Schema.Literal("choice"),
        criteria: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      }),
      Schema.Struct({ type: Schema.Literal("noul") }),
    ),
  }),
});
const responseSchema = Schema.Struct({
  answers: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  usage: Schema.optional(Schema.Unknown),
});
const usageSchema = Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number });

/**
 * Validate complete API-reported token usage; return undefined when unavailable.
 */
export function modelUsage(value: unknown) {
  try {
    const usage = Schema.decodeUnknownSync(usageSchema)(value);
    if (Object.values(usage).every((n) => Number.isFinite(n) && n >= 0)) return usage;
  } catch {
    /* Missing/invalid usage remains distinguishable from a measured zero. */
  }
  return undefined;
}

const validResponse = (body: string, text: string): string | undefined => {
  try {
    const request = Schema.decodeUnknownSync(requestSchema)(JSON.parse(body));
    const response = Schema.decodeUnknownSync(responseSchema)(JSON.parse(text));
    if (!Object.keys(request.questions).length) return undefined;
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        question.type === "choice"
          ? {
              type: "choice",
              probabilities: choiceProbabilities(
                response.answers[id],
                Object.keys(question.criteria),
              ),
            }
          : { type: "noul", noul: noulProbability(response.answers[id]) },
      ]),
    );
    // Persist only validated answers and usage, not echoed states or HTTP metadata.
    return JSON.stringify({ answers, usage: modelUsage(response.usage) });
  } catch {
    return undefined;
  }
};

type Packet = { text: string; status: number; fromDisk: boolean };

/**
 * Cache validated Choice/Noul answers by endpoint and exact serialized input (including
 * model, state, instructions, criteria and question IDs). Headers are never persisted.
 * Shares in-flight identical calls; writes are atomic and reusable by later processes.
 * Invalid responses/errors are not persisted; corrupt entries are explicit cache misses.
 * Returns a fetch-compatible adapter, reuse metrics, and a drain for cancelled runs.
 */
export function createModelCache(
  directory: string,
  implementation: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const metrics = {
    requests: 0,
    choiceRequests: 0,
    verifyRequests: 0,
    hits: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageResponses: 0,
  };
  const pending = new Map<string, Promise<Packet>>();
  const load = async (
    requestHash: string,
    url: string,
    init: RequestInit,
    body: string,
  ): Promise<Packet> => {
    const file = join(directory, `${requestHash}.json`);
    try {
      if ((await stat(file)).size <= 256_000) {
        const cached = Schema.decodeUnknownSync(entrySchema)(
          JSON.parse(await readFile(file, "utf8")),
        );
        if (cached.requestHash === requestHash && Buffer.byteLength(cached.response) <= 100_000) {
          const text = validResponse(body, cached.response);
          if (text) return { text, status: 200, fromDisk: true };
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT")
        throw new Error("Cannot read Jev response cache", { cause: error });
    }
    const response = await implementation(url, init);
    if (!response.ok) {
      await response.body?.cancel();
      return { text: "", status: response.status, fromDisk: false };
    }
    const text = await readBody(response, 100_000);
    const clean = validResponse(body, text);
    if (clean) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `${requestHash}.${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify({ version: 1, requestHash, response: clean }), {
          mode: 0o600,
        });
        await rename(temporary, file);
      } catch (error) {
        throw new Error("Cannot persist Jev response cache", { cause: error });
      }
    }
    return { text, status: response.status, fromDisk: false };
  };
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== endpoint || init.method !== "POST" || typeof init.body !== "string")
      return implementation(url, init);
    init.signal?.throwIfAborted();
    const body = init.body;
    const requestHash = createHash("sha256").update(`jev-cache-v1\n${url}\n${body}`).digest("hex");
    metrics.requests++;
    const questions = (JSON.parse(body).questions ?? {}) as Record<string, { type: string }>;
    const types = Object.values(questions).map((question) => question.type);
    if (types.includes("choice")) metrics.choiceRequests++;
    if (types.includes("noul")) metrics.verifyRequests++;
    const shared = pending.get(requestHash);
    const job = shared ?? load(requestHash, url, init, body);
    if (!shared) pending.set(requestHash, job);
    try {
      const packet = await job;
      init.signal?.throwIfAborted();
      if (shared || packet.fromDisk) {
        metrics.hits++;
        try {
          const usage = modelUsage(JSON.parse(packet.text).usage);
          if (usage) {
            metrics.inputTokens += usage.input_tokens;
            metrics.outputTokens += usage.output_tokens;
            metrics.usageResponses++;
          }
        } catch {
          /* Invalid in-flight responses may be shared but never persisted. */
        }
      }
      return new Response([204, 205, 304].includes(packet.status) ? null : packet.text, {
        status: packet.status,
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      if (!shared) pending.delete(requestHash);
    }
  };
  return { fetcher, metrics, drain: () => Promise.allSettled(pending.values()) };
}
