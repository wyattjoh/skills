import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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
  expect(result.stdout.toString()).toContain("varlock run --path <skill-dir>/ --inject vars");
  expect(result.stderr.toString()).toBe("");
});

test("missing credentials fail before document fetching", () => {
  const result = run(["https://docs.example.com/llms.txt", "Question"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(
    "TYPESAFE_API_KEY is required; run this script through varlock with the skill's .env.schema. Use --inspect-index to test parsing without a key.\n",
  );
});

test("varlock schema pins app authentication and declares a value-free sensitive key", () => {
  const schema = readFileSync(new URL("../.env.schema", import.meta.url), "utf8");
  const decorators = schema.split("\n").filter((line) => line.startsWith("# @"));
  const declarations = schema.split("\n").filter((line) => /^[A-Z][A-Z_]*=/.test(line));
  expect(decorators).toEqual([
    "# @plugin(@varlock/1password-plugin@1.2.0)",
    "# @initOp(allowAppAuth=true)",
    "# @defaultSensitive=false @defaultRequired=true",
    "# @type=string @sensitive",
  ]);
  expect(declarations).toEqual(["TYPESAFE_API_KEY="]);
});

test("invalid options have actionable help", () => {
  const result = run(["--unknown"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Invalid arguments.");
});
