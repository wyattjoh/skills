import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("normal CLI searches reuse Jev responses across separate processes", () => {
  const dir = mkdtempSync(join(tmpdir(), "linked-docs-cli-"));
  try {
    const preload = join(dir, "fetch.ts");
    const counter = join(dir, "count");
    writeFileSync(counter, "0");
    writeFileSync(
      preload,
      `import { readFileSync, writeFileSync } from "node:fs";
      globalThis.fetch = async (url, init) => {
        if (String(url) !== "https://api.typesafe.ai/v1/systemone") return new Response(String(url).endsWith("llms.txt") ? "# Docs\\n- [Settings](settings.md)" : "Opening\\n\\n# Settings\\nbinary path arguments");
        const file = process.env.MODEL_COUNTER;
        writeFileSync(file, String(Number(readFileSync(file, "utf8")) + 1));
        const body = JSON.parse(String(init.body));
        const q = body.questions.result;
        const keys = Object.keys(q.criteria ?? {});
        const answer = q.type === "choice" ? { type: "choice", probabilities: Object.fromEntries(keys.map(k => [k, 1 / keys.length])) } : { type: "noul", noul: body.state.excerpt.includes("binary") ? 0.95 : 0.01 };
        return Response.json({ answers: { result: answer }, usage: { input_tokens: 10, output_tokens: 2 } });
      };`,
    );
    const args = [
      process.execPath,
      "--preload",
      preload,
      script,
      "https://docs.example.com/llms.txt",
      "Binary path and arguments?",
      "--cache",
      join(dir, "cache"),
    ];
    const env = { ...process.env, TYPESAFE_API_KEY: "test-key", MODEL_COUNTER: counter };
    const cold = Bun.spawnSync(args, { env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    expect(cold.exitCode).toBe(0);
    expect(cold.stderr.toString()).toBe("");
    const first = JSON.parse(cold.stdout.toString());
    expect(first.metrics.calls).toBe(3);
    expect(first.passages[0].verified).toBe(true);
    const warm = Bun.spawnSync(args, { env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    expect(warm.exitCode).toBe(0);
    const replay = JSON.parse(warm.stdout.toString());
    expect(replay.metrics.calls).toBe(0);
    expect(replay.metrics.logicalCalls).toBe(3);
    expect(replay.metrics.modelCacheHits).toBe(3);
    expect(replay.metrics.inputTokens).toBe(0);
    expect(replay.passages).toEqual(first.passages);
    expect(readFileSync(counter, "utf8")).toBe("3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid options have actionable help", () => {
  const result = run(["--unknown"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Invalid arguments.");
});
