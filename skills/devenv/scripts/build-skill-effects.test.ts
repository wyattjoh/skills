import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Effect, Fiber, Result } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildError, readText, fetchText } from "./build-skill.ts";

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("devenv build boundaries", () => {
  it("reads lazily and repeats without retaining file contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "devenv-effect-"));
    roots.push(root);
    const path = join(root, "source.md");
    const program = readText(path);
    writeFileSync(path, "first");
    expect(await Effect.runPromise(program)).toBe("first");
    writeFileSync(path, "second");
    expect(await Effect.runPromise(program)).toBe("second");
  });

  it("reports missing source files through a typed failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "devenv-effect-"));
    roots.push(root);
    const path = join(root, "missing.md");
    const result = await Effect.runPromise(Effect.result(readText(path)));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected missing-file failure");
    expect(result.failure instanceof BuildError).toBe(true);
    expect(result.failure.operation).toBe(`read ${path}`);
    expect((result.failure.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("reports HTTP errors before writing any cache artifacts", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, statusText: "Too Many Requests" }),
    );
    const result = await Effect.runPromise(
      Effect.result(fetchText("https://example.invalid/docs", "fixture.txt")),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected HTTP failure");
    expect(result.failure.operation).toBe("build");
    expect(result.failure.cause).toBe("GET https://example.invalid/docs -> 429 Too Many Requests");
  });

  it("keeps cancellation active after response headers arrive", async () => {
    const body = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const fakeFetch = Object.assign(
      async (...[_input, init]: Parameters<typeof fetch>) => {
        const active = init?.signal;
        if (active === undefined || active === null) throw new Error("Expected abort signal");
        signal = active;
        active.addEventListener(
          "abort",
          () => body.reject(new DOMException("Canceled", "AbortError")),
          { once: true },
        );
        return {
          ok: true,
          text: () => {
            started.resolve();
            return body.promise;
          },
        } as unknown as Response;
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          fetchText("https://example.invalid/docs", "fixture.txt"),
        );
        yield* Effect.tryPromise(() => started.promise);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.timeout(5000)),
    );
    expect(signal?.aborted).toBe(true);
  });

  it("propagates fiber cancellation to the upstream request", async () => {
    let signal: AbortSignal | undefined;
    const fakeFetch = Object.assign(
      async (...[_input, init]: Parameters<typeof fetch>) => {
        const activeSignal = init?.signal;
        if (activeSignal === undefined || activeSignal === null)
          throw new Error("Expected abort signal");
        signal = activeSignal;
        return new Promise<Response>((_resolve, reject) => {
          activeSignal.addEventListener(
            "abort",
            () => reject(new DOMException("Canceled", "AbortError")),
            { once: true },
          );
        });
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    const result = await Effect.runPromise(
      Effect.result(
        fetchText("https://example.invalid/docs", "fixture.txt").pipe(Effect.timeout(100)),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
