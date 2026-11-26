import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import { failureOf, runWith, tempDir } from "./fixture.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";
import { verifyDelegate } from "./sessions.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});
const config = () => {
  const state = tempDir("coordinate-sessions-");
  dirs.push(state);
  return Effect.runPromise(
    resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"),
  );
};
const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const delegate = (address: string, session: string) => ({
  address,
  name: "rem-a",
  state: "live",
  status: { state: "idle" },
  labels: { "fleet.domain": "app", "fleet.session": session },
});

/**
 * Answers for hc as herdr-core gives them for another machine's terminals: `hc get` knows each
 * `machine/tN` address in `remote` but not the name, which only `hc ls` lists.
 */
const answers =
  (remote: Record<string, ReturnType<typeof delegate>>) =>
  (argv: readonly string[]): RunOutput => {
    if (argv[1] === "ls")
      return ok(
        JSON.stringify({
          terminals: Object.values(remote).map(({ address, name, state }) => ({
            address,
            name,
            state,
          })),
        }),
      );
    const known = argv[1] === "get" ? remote[argv[2] ?? ""] : undefined;
    if (known) return ok(JSON.stringify(known));
    if (argv[1] === "get")
      return { exitCode: 3, stdout: "", stderr: '{"error":{"kind":"not_found","message":"no"}}' };
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };

describe("verify a live delegate on another machine", () => {
  it("records a verdict by its name, resolved through hc ls", async () => {
    const cfg = await config();
    const fake = fakeProc(answers({ "strix/t5": delegate("strix/t5", "s-9") }));
    const lines = await runWith(verifyDelegate(cfg, "rem-a", { result: "ok" }, false), fake.layer);
    expect(lines).toEqual(["recorded ok for rem-a (session s-9)"]);
    expect(fake.calls.map((call) => call.argv)).toEqual([
      ["hc", "get", "rem-a", "--json"],
      ["hc", "ls", "--json"],
      ["hc", "get", "strix/t5", "--json"],
    ]);
  });

  it("records a verdict by its machine/tN address", async () => {
    const cfg = await config();
    const fake = fakeProc(answers({ "strix/t5": delegate("strix/t5", "s-9") }));
    const lines = await runWith(
      verifyDelegate(cfg, "strix/t5", { result: "problem", reason: "pushed" }, false),
      fake.layer,
    );
    expect(lines).toEqual(["recorded problem for rem-a (session s-9): pushed"]);
    expect(fake.calls.map((call) => call.argv)).toEqual([["hc", "get", "strix/t5", "--json"]]);
  });

  it("refuses a name two live terminals share, naming their addresses", async () => {
    const cfg = await config();
    const fake = fakeProc(
      answers({
        "strix/t5": delegate("strix/t5", "s-9"),
        "mini/t2": delegate("mini/t2", "s-8"),
      }),
    );
    expect(
      messageOf(await failureOf(verifyDelegate(cfg, "rem-a", { result: "ok" }, false), fake.layer)),
    ).toBe("2 live terminals are named rem-a (strix/t5, mini/t2); give its address");
  });
});
