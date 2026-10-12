import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { buildPage, resolveGrid, scriptJson, TopologyError, type Topology } from "./build.ts";

const BUILD = resolve(import.meta.dir, "build.ts");
const TEMPLATE = readFileSync(resolve(import.meta.dir, "../assets/template.html"), "utf8");
const EXAMPLE = resolve(import.meta.dir, "testdata/homelab.topology.json");

const base = {
  title: "T",
  roles: { app: { label: "App", color: "#2563eb" } },
  nodes: [
    { id: "a", role: "app", column: 0, title: "A" },
    { id: "b", role: "app", column: 1, title: "B" },
  ],
  edges: [{ id: "e1", from: "a", to: "b", label: "a → b" }],
};

const run = (raw: unknown) => Effect.runSync(Effect.result(buildPage(raw, TEMPLATE)));

/** Pulls the injected topology back out of a rendered page. */
const injected = (html: string): Topology & { nodes: { id: string; row: number }[] } => {
  const m = /const TOPO = (.*);\n/.exec(html);
  if (!m) throw new Error("no TOPO literal in page");
  return JSON.parse(m[1]);
};

const problemsOf = (raw: unknown) => {
  const r = run(raw);
  if (Result.isSuccess(r)) throw new Error("expected a TopologyError");
  return r.failure instanceof TopologyError ? r.failure.problems : [];
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "topo-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rendering

test("the worked example builds with no warnings", () => {
  const r = run(JSON.parse(readFileSync(EXAMPLE, "utf8")));
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  expect(r.success.warnings).toEqual([]);
  expect(injected(r.success.html).nodes.length).toBe(9);
});

test("page title strips HTML from the title and escapes it", () => {
  const r = run({ ...base, title: "<b>net</b> & co" });
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  expect(r.success.html).toContain("<title>net &amp; co</title>");
});

test("pageTitle overrides the derived title", () => {
  const r = run({ ...base, pageTitle: "Custom" });
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  expect(r.success.html).toContain("<title>Custom</title>");
});

test("a label containing </script> cannot close the script element", () => {
  const label = "</script><script>alert(1)</script>";
  const r = run({ ...base, edges: [{ ...base.edges[0], label }] });
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  expect(r.success.html.split("</script>").length).toBe(2);
  expect(injected(r.success.html).edges[0].label).toBe(label);
});

test("scriptJson escapes line and paragraph separators", () => {
  expect(scriptJson("a\u2028b\u2029c")).toBe('"a\\u2028b\\u2029c"');
});

test("an isolated node and an empty details section are warnings", () => {
  const r = run({
    ...base,
    nodes: [
      ...base.nodes,
      { id: "c", role: "app", column: 2, title: "C", details: [{ heading: "Risks" }] },
    ],
  });
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  expect(r.success.warnings).toEqual([
    'node "c" has no edges',
    'node "c" details "Risks" has neither html nor items',
  ]);
});

// ---------------------------------------------------------------- grid

test("nodes without a row fill the lowest free cell in their column, in file order", () => {
  const { nodes, problems } = resolveGrid([
    { id: "x", role: "app", column: 0, title: "X" },
    { id: "y", role: "app", column: 0, row: 0, title: "Y" },
    { id: "z", role: "app", column: 0, title: "Z" },
    { id: "w", role: "app", column: 1, title: "W" },
  ]);
  expect(problems).toEqual([]);
  expect(nodes.map((n) => [n.id, n.row])).toEqual([
    ["x", 1],
    ["y", 0],
    ["z", 2],
    ["w", 0],
  ]);
});

test("two nodes claiming one cell is a failure", () => {
  expect(
    problemsOf({
      ...base,
      nodes: [
        { id: "a", role: "app", column: 0, row: 2, title: "A" },
        { id: "b", role: "app", column: 0, row: 2, title: "B" },
      ],
    }),
  ).toEqual(['nodes "a" and "b" both claim column 0, row 2']);
});

// ---------------------------------------------------------------- integrity

test("every referential problem is reported at once", () => {
  expect(
    problemsOf({
      ...base,
      nodes: [...base.nodes, { id: "a", role: "db", column: 2, title: "A again" }],
      edges: [
        { id: "e1", from: "a", to: "ghost", label: "x" },
        { id: "e1", from: "b", to: "b", label: "loop" },
      ],
      groups: [{ id: "g", label: "G", members: ["a", "nope", "a"], color: "#000" }],
    }),
  ).toEqual([
    'duplicate node id "a"',
    'duplicate edge id "e1"',
    'node "a" has unknown role "db" (roles: app)',
    'edge "e1" to unknown node "ghost" (nodes: a, b)',
    'edge "e1" is a self-loop on "b"',
    'group "g" member unknown node "nope" (nodes: a, b)',
    'group "g" lists "a" twice',
  ]);
});

test("schema errors name the offending path", () => {
  const problems = problemsOf({ ...base, edges: [{ ...base.edges[0], state: "maybe" }] });
  expect(problems).toEqual([
    'Expected "allow" | "risk" | "partial" | "block"',
    '  at ["edges"][0]["state"]',
  ]);
});

// ---------------------------------------------------------------- cli

const cli = (args: string[]) =>
  Bun.spawnSync(["bun", BUILD, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });

test("the CLI writes next to the input by default", () => {
  const input = join(dir, "net.topology.json");
  writeFileSync(input, JSON.stringify(base));
  const r = cli([input]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe(`\x1b[32mpage\x1b[0m   ${join(dir, "net.topology.html")}\n`);
  expect(injected(readFileSync(join(dir, "net.topology.html"), "utf8")).title).toBe("T");
});

test("the CLI honours --out and exits 1 listing problems", () => {
  const input = join(dir, "bad.json");
  writeFileSync(
    input,
    JSON.stringify({ ...base, edges: [{ id: "e", from: "a", to: "zz", label: "x" }] }),
  );
  const r = cli([input, "--out", join(dir, "bad.html")]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toBe(
    '\x1b[31merror\x1b[0m  topology file has 1 problem(s):\n  - edge "e" to unknown node "zz" (nodes: a, b)\n',
  );
});

test("the CLI prints usage without an input", () => {
  const r = cli([]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toBe(
    "\x1b[31merror\x1b[0m  usage: bun build.ts <topology.json> [--out page.html] [--open]\n",
  );
});
