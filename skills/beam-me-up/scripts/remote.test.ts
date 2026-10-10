import { describe, expect, it } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { makeLocalShell, shellQuote } from "./remote.ts";

describe("shellQuote", () => {
  it("wraps a word in single quotes and escapes embedded ones", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("delivers awkward arguments to a script byte-for-byte", async () => {
    const args = ["plain", "with space", "it's", "$HOME", "`date`", "a\nb", "", "wyattjoh+x"];
    const result = await Effect.gen(function* () {
      const shell = yield* makeLocalShell(undefined);
      return yield* shell.run(`printf '%s\\0' "$@"`, args);
    }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).split("\0").slice(0, -1)).toEqual(args);
  });
});
