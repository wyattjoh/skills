import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./search.ts", import.meta.url));
const run = (args: string[]) => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return Bun.spawnSync([process.execPath, script, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
};

test("help is usable without credentials", () => {
  const result = run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("--inspect-index");
  expect(result.stderr.toString()).toBe("");
});

test("missing credentials fail before document fetching", () => {
  const result = run(["https://docs.example.com/llms.txt", "Question"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(
    "Set TYPESAFE_API_KEY in the environment, never in arguments. Use --inspect-index to test parsing without a key.\n",
  );
});

test("invalid options have actionable help", () => {
  const result = run(["--unknown"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Invalid arguments.");
});
