import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Effect, Result } from "effect";
import { checkBatchEffect, fetchBootstrapEffect } from "./check-domains.ts";
import { type DomainCheckResult, formatJson, formatTable, parseCli } from "./check-domains.ts";

// ── parseCli ─────────────────────────────────────────────────────────────────

describe("parseCli", () => {
  it("single name with default TLD", () => {
    const result = parseCli(["example"]);
    expect(result.names).toEqual(["example"]);
    expect(result.tlds).toEqual(["com"]);
    expect(result.json).toBe(false);
    expect(result.help).toBe(false);
  });

  it("multiple names", () => {
    const result = parseCli(["foo", "bar", "baz"]);
    expect(result.names).toEqual(["foo", "bar", "baz"]);
  });

  it("custom TLDs", () => {
    const result = parseCli(["--tlds=com,dev,io", "example"]);
    expect(result.tlds).toEqual(["com", "dev", "io"]);
  });

  it("json flag", () => {
    const result = parseCli(["--json", "example"]);
    expect(result.json).toBe(true);
  });

  it("help flag", () => {
    const result = parseCli(["--help"]);
    expect(result.help).toBe(true);
  });

  it("names are lowercased", () => {
    const result = parseCli(["MyProject", "ANOTHER"]);
    expect(result.names).toEqual(["myproject", "another"]);
  });

  it("TLDs are trimmed and lowercased", () => {
    const result = parseCli(["--tlds= COM , Dev ,IO ", "test"]);
    expect(result.tlds).toEqual(["com", "dev", "io"]);
  });

  it("no args gives empty names", () => {
    const result = parseCli([]);
    expect(result.names).toEqual([]);
    expect(result.tlds).toEqual(["com"]);
  });
});

// ── formatJson ───────────────────────────────────────────────────────────────

describe("formatJson", () => {
  it("available domain", () => {
    const results: DomainCheckResult[] = [{ domain: "example.com", status: "available" }];
    const output = JSON.parse(formatJson(results));
    expect(output.results.length).toBe(1);
    expect(output.results[0].domain).toBe("example.com");
    expect(output.results[0].available).toBe(true);
    expect(output.results[0].error).toBeUndefined();
  });

  it("registered domain", () => {
    const results: DomainCheckResult[] = [{ domain: "google.com", status: "registered" }];
    const output = JSON.parse(formatJson(results));
    expect(output.results[0].available).toBe(false);
  });

  it("unknown with error", () => {
    const results: DomainCheckResult[] = [
      { domain: "test.xyz", status: "unknown", error: "No RDAP server for .xyz" },
    ];
    const output = JSON.parse(formatJson(results));
    expect(output.results[0].available).toBe(false);
    expect(output.results[0].error).toBe("No RDAP server for .xyz");
  });

  it("multiple results", () => {
    const results: DomainCheckResult[] = [
      { domain: "foo.com", status: "available" },
      { domain: "foo.dev", status: "registered" },
      { domain: "foo.io", status: "unknown", error: "Timeout" },
    ];
    const output = JSON.parse(formatJson(results));
    expect(output.results.length).toBe(3);
  });
});

// ── formatTable ──────────────────────────────────────────────────────────────

describe("formatTable", () => {
  it("contains header and separator", () => {
    const results: DomainCheckResult[] = [{ domain: "test.com", status: "available" }];
    const table = formatTable(results);
    const lines = table.split("\n");
    expect(lines[0]).toBe("Domain              Status");
    expect(lines[1]).toBe("─".repeat(35));
  });

  it("available shows checkmark", () => {
    const results: DomainCheckResult[] = [{ domain: "test.com", status: "available" }];
    const table = formatTable(results);
    expect(table.includes("Available ✓")).toBe(true);
  });

  it("registered shows status", () => {
    const results: DomainCheckResult[] = [{ domain: "test.com", status: "registered" }];
    const table = formatTable(results);
    expect(table.includes("Registered")).toBe(true);
  });

  it("unknown with error", () => {
    const results: DomainCheckResult[] = [
      { domain: "test.xyz", status: "unknown", error: "No server" },
    ];
    const table = formatTable(results);
    expect(table.includes("Unknown (No server)")).toBe(true);
  });
});

afterEach(() => mock.restore());

describe("scoped RDAP requests", () => {
  it("aborts the request after a failed bootstrap body read", async () => {
    let signal: AbortSignal | undefined;
    const fakeFetch = Object.assign(
      async (...[_input, init]: Parameters<typeof fetch>) => {
        signal = init?.signal ?? undefined;
        return {
          ok: true,
          json: async () => {
            throw new Error("fixture JSON unreadable");
          },
        } as unknown as Response;
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    const result = await Effect.runPromise(Effect.result(fetchBootstrapEffect()));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected bootstrap failure");
    expect(result.failure.message).toBe("fixture JSON unreadable");
    expect(signal?.aborted).toBe(true);
  });

  it("propagates cancellation while waiting for bootstrap JSON", async () => {
    const body = Promise.withResolvers<unknown>();
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
        return { ok: true, json: () => body.promise } as unknown as Response;
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    const result = await Effect.runPromise(
      Effect.result(fetchBootstrapEffect().pipe(Effect.timeout(100))),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("preserves five concurrent requests per batch and ordered results", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const fakeFetch = Object.assign(
      async (...[input]: Parameters<typeof fetch>) => {
        if (String(input).includes("data.iana.org")) {
          return Response.json({ services: [[["fixture"], ["https://rdap.example.invalid/"]]] });
        }
        active++;
        maximum = Math.max(maximum, active);
        return new Promise<Response>((resolve) => {
          releases.push(() => {
            active--;
            resolve(new Response("", { status: 404 }));
          });
          if (releases.length === 5) for (const release of releases.splice(0)) release();
        });
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    const names = Array.from({ length: 10 }, (_, index) => `fixture${index}`);
    const results = await Effect.runPromise(
      checkBatchEffect(names, ["fixture"]).pipe(Effect.timeout(2000)),
    );
    expect(maximum).toBe(5);
    expect(active).toBe(0);
    expect(results).toEqual(
      names.map((name) => ({ domain: `${name}.fixture`, status: "available" as const })),
    );
  });
});
