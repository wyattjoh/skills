#!/usr/bin/env bun
/**
 * Builds an interactive network-topology page from a topology file.
 *
 *   bun build.ts <topology.json> [--out page.html] [--open]
 *
 * The topology file is the only thing an author writes. This script validates
 * it, resolves every node to a grid cell, and injects it into the shared
 * template, so the page shell never needs hand edits.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";

// ---------------------------------------------------------------- schema

const Html = Schema.String;

const Role = Schema.Struct({ label: Schema.String, color: Schema.String });

const Detail = Schema.Struct({
  heading: Schema.String,
  html: Schema.optional(Html),
  items: Schema.optional(Schema.Array(Html)),
});

const GridIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Node = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  column: GridIndex,
  row: Schema.optional(GridIndex),
  icon: Schema.optional(Schema.String),
  title: Html,
  sub: Schema.optional(Html),
  rows: Schema.optional(Schema.Array(Schema.Tuple([Html, Html]))),
  chips: Schema.optional(Schema.Array(Html)),
  badge: Schema.optional(Html),
  details: Schema.optional(Schema.Array(Detail)),
});

const Edge = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  label: Html,
  state: Schema.optional(Schema.Literals(["allow", "risk", "partial", "block"])),
  side: Schema.optional(Schema.Literals(["left", "right"])),
  offset: Schema.optional(Schema.Number),
  note: Schema.optional(Html),
});

const Group = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  members: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  color: Schema.String,
  pad: Schema.optional(Schema.Number),
  labelPosition: Schema.optional(Schema.Literals(["top", "bottom"])),
  legend: Schema.optional(Schema.String),
});

const Topology = Schema.Struct({
  title: Html,
  pageTitle: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  accent: Schema.optional(Schema.String),
  summary: Schema.optional(Html),
  layout: Schema.optional(
    Schema.Struct({
      columnGap: Schema.optional(Schema.Number),
      rowGap: Schema.optional(Schema.Number),
    }),
  ),
  roles: Schema.Record(Schema.String, Role),
  nodes: Schema.Array(Node).check(Schema.isMinLength(1)),
  edges: Schema.Array(Edge),
  groups: Schema.optional(Schema.Array(Group)),
});

/**
 * A decoded topology file.
 */
export type Topology = typeof Topology.Type;

/**
 * A topology node after its grid row has been resolved.
 */
export type ResolvedNode = Topology["nodes"][number] & { row: number };

// ---------------------------------------------------------------- errors

/**
 * The topology file is malformed or internally inconsistent; every problem is listed.
 */
export class TopologyError extends Schema.TaggedError<TopologyError>()("TopologyError", {
  problems: Schema.Array(Schema.String),
}) {}

/**
 * A file read, write, or preview launch failed.
 */
export class BuildIoError extends Schema.TaggedError<BuildIoError>()("BuildIoError", {
  message: Schema.String,
}) {}

const ioError = (cause: unknown) =>
  new BuildIoError({ message: cause instanceof Error ? cause.message : String(cause) });

// ---------------------------------------------------------------- checks

const duplicates = (ids: readonly string[]) => [
  ...new Set(ids.filter((id, i) => ids.indexOf(id) !== i)),
];

/**
 * Lists every referential problem in a decoded topology: duplicate ids, unknown
 * roles, edges or group members naming missing nodes, and self-loops.
 */
export function integrityProblems(t: Topology): string[] {
  const problems: string[] = [];
  const nodeIds = new Set(t.nodes.map((n) => n.id));
  const known = [...nodeIds].join(", ");
  const roles = Object.keys(t.roles);

  for (const id of duplicates(t.nodes.map((n) => n.id))) problems.push(`duplicate node id "${id}"`);
  for (const id of duplicates(t.edges.map((e) => e.id))) problems.push(`duplicate edge id "${id}"`);
  for (const id of duplicates((t.groups ?? []).map((g) => g.id)))
    problems.push(`duplicate group id "${id}"`);

  for (const n of t.nodes) {
    if (!(n.role in t.roles))
      problems.push(`node "${n.id}" has unknown role "${n.role}" (roles: ${roles.join(", ")})`);
  }
  for (const e of t.edges) {
    for (const end of ["from", "to"] as const) {
      if (!nodeIds.has(e[end]))
        problems.push(`edge "${e.id}" ${end} unknown node "${e[end]}" (nodes: ${known})`);
    }
    if (e.from === e.to) problems.push(`edge "${e.id}" is a self-loop on "${e.from}"`);
  }
  for (const g of t.groups ?? []) {
    for (const m of g.members) {
      if (!nodeIds.has(m))
        problems.push(`group "${g.id}" member unknown node "${m}" (nodes: ${known})`);
    }
    for (const m of duplicates(g.members)) problems.push(`group "${g.id}" lists "${m}" twice`);
  }
  return problems;
}

const cell = (column: number, row: number) => `${column}:${row}`;

/**
 * Assigns every node a grid row. Explicit rows claim their cells first; a node
 * without one takes the lowest free row in its column, in file order.
 */
export function resolveGrid(nodes: Topology["nodes"]): {
  nodes: ResolvedNode[];
  problems: string[];
} {
  const problems: string[] = [];
  const taken = new Map<string, string>();

  for (const n of nodes) {
    if (n.row === undefined) continue;
    const owner = taken.get(cell(n.column, n.row));
    if (owner)
      problems.push(`nodes "${owner}" and "${n.id}" both claim column ${n.column}, row ${n.row}`);
    else taken.set(cell(n.column, n.row), n.id);
  }

  const resolved = nodes.map((n) => {
    if (n.row !== undefined) return { ...n, row: n.row };
    let row = 0;
    while (taken.has(cell(n.column, row))) row++;
    taken.set(cell(n.column, row), n.id);
    return { ...n, row };
  });
  return { nodes: resolved, problems };
}

/**
 * Non-fatal observations: nodes with no edges and details sections with no content.
 */
export function warnings(t: Topology): string[] {
  const out: string[] = [];
  const linked = new Set(t.edges.flatMap((e) => [e.from, e.to]));
  for (const n of t.nodes) {
    if (!linked.has(n.id)) out.push(`node "${n.id}" has no edges`);
    for (const d of n.details ?? []) {
      if (!d.html && !d.items?.length)
        out.push(`node "${n.id}" details "${d.heading}" has neither html nor items`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- render

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Serializes a value for a classic <script> body: `<` is escaped so no string
 * can close the element, and U+2028/2029 so older parsers accept the literal.
 */
export const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/**
 * Validates a raw topology value and renders it into the template.
 *
 * @param raw - The parsed JSON of a topology file.
 * @param template - The contents of assets/template.html.
 * @returns The page HTML and any non-fatal warnings.
 */
export const buildPage = Effect.fn("buildTopologyPage")(function* (
  raw: unknown,
  template: string,
): Effect.fn.Return<{ html: string; warnings: string[] }, TopologyError> {
  const t = yield* Schema.decodeUnknownEffect(Topology)(raw, { errors: "all" }).pipe(
    Effect.mapError((e) => new TopologyError({ problems: e.message.split("\n") })),
  );
  const grid = resolveGrid(t.nodes);
  const problems = [...integrityProblems(t), ...grid.problems];
  if (problems.length) return yield* new TopologyError({ problems });

  const html = template
    .replace("{{PAGETITLE}}", () => esc(t.pageTitle ?? stripTags(t.title)))
    .replace("{{TOPOLOGY}}", () => scriptJson({ ...t, nodes: grid.nodes }));
  const leftover = html.match(/\{\{[A-Z]+\}\}/g);
  if (leftover)
    return yield* new TopologyError({
      problems: [`template has unreplaced placeholders: ${[...new Set(leftover)].join(", ")}`],
    });
  return { html, warnings: warnings(t) };
});

// ---------------------------------------------------------------- cli

const readJson = (path: string) =>
  Effect.try({
    try: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
    catch: (cause) =>
      new BuildIoError({ message: `cannot read ${path}: ${ioError(cause).message}` }),
  });

const openPage = (path: string) =>
  Effect.try({
    try: () => {
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      const result = Bun.spawnSync([opener, path], { stdout: "ignore", stderr: "ignore" });
      if (!result.success) throw new Error(`${opener} exited ${result.exitCode}`);
    },
    catch: ioError,
  });

const usage = "usage: bun build.ts <topology.json> [--out page.html] [--open]";

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  const input = args.find((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));
  if (!input || (outAt >= 0 && !out)) return yield* new BuildIoError({ message: usage });

  const inPath = resolve(input);
  const outPath = out ? resolve(out) : inPath.replace(/\.json$/i, "") + ".html";
  const tplPath = resolve(import.meta.dir, "../assets/template.html");
  if (!existsSync(tplPath))
    return yield* new BuildIoError({ message: `template missing at ${tplPath}` });

  const raw = yield* readJson(inPath);
  const page = yield* buildPage(raw, readFileSync(tplPath, "utf8"));
  for (const w of page.warnings) console.warn(`\x1b[33mwarn\x1b[0m   ${w}`);
  yield* Effect.try({ try: () => writeFileSync(outPath, page.html), catch: ioError });
  console.log(`\x1b[32mpage\x1b[0m   ${outPath}`);
  if (args.includes("--open")) yield* openPage(outPath);
});

if (import.meta.main) {
  Effect.runSync(
    main.pipe(
      Effect.catchTags({
        TopologyError: (e) =>
          Effect.sync(() => {
            console.error(
              `\x1b[31merror\x1b[0m  topology file has ${e.problems.length} problem(s):`,
            );
            for (const p of e.problems) console.error(`  - ${p}`);
            process.exit(1);
          }),
        BuildIoError: (e) =>
          Effect.sync(() => {
            console.error(`\x1b[31merror\x1b[0m  ${e.message}`);
            process.exit(1);
          }),
      }),
    ),
  );
}
