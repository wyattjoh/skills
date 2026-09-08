#!/usr/bin/env bun
/**
 * Builds a code-walkthrough page from a walkthrough definition file.
 *
 *   bun build.ts <walkthrough.json> [--out page.html] [--open]
 *                [--require-full-coverage]
 *
 * Source code is injected from the paths named in the definition and is never
 * hand-copied into it, so the pane cannot drift from the files it documents.
 * Every rendered row is read back out of the finished HTML and diffed against
 * its source line before the file is written.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";

// ---------------------------------------------------------------- types

type Tag = [cls: string, label: string];

type Scope =
  | { ranges: [number, number][] }
  | { diff: string } // a git revision range, e.g. "main...HEAD" or "HEAD~1"
  | undefined;

interface FileSpec {
  path: string;
  label?: string;
  sub?: string;
  lang?: string;
  scope?: Scope;
  /** Collapse runs of unexplained out-of-scope lines longer than this. 0 disables. */
  foldContextAfter?: number;
}

interface Beat {
  id: string;
  file?: number; // index into files[], default 0
  from: number;
  to: number;
  section?: string;
  sectionSub?: string;
  tags?: Tag[];
  title: string;
  body: string; // raw HTML
}

interface Band {
  heading?: string;
  sub?: string;
  html: string;
}

interface Walkthrough {
  pageTitle?: string;
  title: string;
  titleAccent?: string;
  eyebrow?: string;
  lede?: string;
  facts?: { label: string; value: string }[];
  intro?: Band[];
  outro?: Band[];
  footer?: string;
  files: FileSpec[];
  beats: Beat[];
}

// ---------------------------------------------------------------- languages
// Deliberately modest: this is a documentation page, not an editor. A language
// that isn't listed falls back to `plain`, which still renders correctly - it
// just isn't coloured.

const LANGS: Record<string, unknown> = {
  sql: {
    line: "--",
    block: ["/*", "*/"],
    strings: ["'"],
    idents: ['"'],
    ci: true,
    directive: "^--\\s*\\+",
    keywords:
      "CREATE TABLE INDEX UNIQUE PRIMARY KEY NOT NULL DEFAULT REFERENCES ON DELETE CASCADE UPDATE RESTRICT CHECK CONSTRAINT FOREIGN WHERE WITH SET DROP IF EXISTS GRANT REVOKE SELECT INSERT INTO VALUES ALTER ADD COLUMN TO FROM AND OR IN IS AS COLLATE ORDER BY LIMIT GROUP HAVING JOIN LEFT INNER OUTER UNION BEGIN COMMIT ROLLBACK".split(
        " ",
      ),
    types:
      "VARCHAR TEXT JSONB JSON INT INTEGER BIGINT SMALLINT BOOLEAN TIMESTAMP TIMESTAMPTZ WITHOUT TIME ZONE DATE NUMERIC DECIMAL UUID BYTEA SERIAL".split(
        " ",
      ),
    funcs:
      "octet_length char_length length current_timestamp now coalesce lower upper count sum max min".split(
        " ",
      ),
  },
  go: {
    line: "//",
    block: ["/*", "*/"],
    strings: ['"', "`"],
    keywords:
      "package import func return if else for range switch case default break continue go defer chan select var const type struct interface map make new nil goto fallthrough".split(
        " ",
      ),
    types:
      "string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 bool byte rune error any complex64 complex128 uintptr".split(
        " ",
      ),
    funcs: "append cap close copy delete len panic print println recover".split(" "),
  },
  ts: {
    line: "//",
    block: ["/*", "*/"],
    strings: ['"', "'", "`"],
    keywords:
      "import export from as default const let var function return if else for while do switch case break continue class extends implements interface type enum new delete typeof instanceof in of async await yield try catch finally throw this super static public private protected readonly abstract satisfies keyof infer declare namespace module get set".split(
        " ",
      ),
    types:
      "string number boolean object symbol bigint void never unknown any null undefined Array Promise Record Partial Readonly Pick Omit Map Set Date RegExp Error".split(
        " ",
      ),
    funcs: "console require setTimeout setInterval fetch structuredClone".split(" "),
  },
  python: {
    line: "#",
    strings: ['"', "'"],
    keywords:
      "def class return if elif else for while break continue pass import from as with try except finally raise lambda yield global nonlocal assert del async await in is not and or None True False match case".split(
        " ",
      ),
    types:
      "int float str bool bytes list dict set tuple frozenset complex object type Any Optional Union".split(
        " ",
      ),
    funcs:
      "print len range enumerate zip map filter sorted sum min max abs open isinstance getattr setattr super".split(
        " ",
      ),
  },
  rust: {
    line: "//",
    block: ["/*", "*/"],
    strings: ['"'],
    keywords:
      "fn let mut const static struct enum impl trait for while loop if else match return use mod pub crate self super as where move ref dyn async await unsafe extern type in break continue".split(
        " ",
      ),
    types:
      "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet".split(
        " ",
      ),
    funcs: "println print format vec panic assert unwrap expect".split(" "),
  },
  json: { strings: ['"'], keywords: "true false null".split(" ") },
  yaml: { line: "#", strings: ['"', "'"], keywords: "true false null yes no on off".split(" ") },
  sh: {
    line: "#",
    strings: ['"', "'"],
    keywords:
      "if then else elif fi for while do done case esac function return local export readonly declare set unset shift source exit trap in".split(
        " ",
      ),
    funcs: "echo printf cd ls cat grep sed awk find git curl mkdir rm cp mv test".split(" "),
  },
  css: { block: ["/*", "*/"], strings: ['"', "'"] },
  html: { block: ["<!--", "-->"], strings: ['"', "'"] },
  plain: {},
};

const EXT_LANG: Record<string, string> = {
  sql: "sql",
  go: "go",
  ts: "ts",
  tsx: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "python",
  rs: "rust",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  xml: "html",
};

// ---------------------------------------------------------------- helpers

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function die(msg: string): never {
  console.error(`\x1b[31merror\x1b[0m  ${msg}`);
  process.exit(1);
}

/** Line ranges touched by a git revision range, per file. */
function changedRanges(filePath: string, rev: string): [number, number][] {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const cwd = dirname(filePath);
  const r = spawnSync("git", ["diff", "--unified=0", rev, "--", filePath], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    die(`git diff failed for ${filePath} against "${rev}":\n${r.stderr?.trim() || "(no stderr)"}`);
  }
  const ranges: [number, number][] = [];
  for (const line of r.stdout.split("\n")) {
    // @@ -old,cnt +new,cnt @@
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = +m[1];
    const count = m[2] === undefined ? 1 : +m[2];
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  if (!ranges.length) {
    console.warn(
      `\x1b[33mwarn\x1b[0m   no changed lines for ${basename(filePath)} against "${rev}" — scoping to the whole file`,
    );
  }
  return ranges;
}

function inScopeSet(spec: FileSpec, lineCount: number, base: string): Set<number> {
  const s = new Set<number>();
  const add = (ranges: [number, number][]) => {
    for (const [a, b] of ranges)
      for (let n = a; n <= b; n++) if (n >= 1 && n <= lineCount) s.add(n);
  };
  if (!spec.scope) {
    for (let n = 1; n <= lineCount; n++) s.add(n);
    return s;
  }
  if ("ranges" in spec.scope) add(spec.scope.ranges);
  else if ("diff" in spec.scope) {
    const r = changedRanges(resolve(base, spec.path), spec.scope.diff);
    if (!r.length) {
      for (let n = 1; n <= lineCount; n++) s.add(n);
      return s;
    }
    add(r);
  }
  return s;
}

// ---------------------------------------------------------------- render

function renderPane(
  files: FileSpec[],
  contents: string[][],
  claimed: Set<string>,
  scopes: Set<number>[],
): string {
  return files
    .map((spec, fi) => {
      const lines = contents[fi];
      const fold = spec.foldContextAfter ?? 12;
      const scope = scopes[fi];

      // A line is foldable only if it is both out of scope and unexplained -
      // a beat that deliberately reaches into context must stay visible.
      const foldable = (n: number) => fold > 0 && !scope.has(n) && !claimed.has(`${fi}:${n}`);

      const row = (n: number) =>
        `<span class="row" data-f="${fi}" data-n="${n}">` +
        `<span class="ln">${n}</span>` +
        `<span class="lc">${esc(lines[n - 1]) || " "}</span></span>`;

      const out: string[] = [];
      let n = 1;
      while (n <= lines.length) {
        if (!foldable(n)) {
          out.push(row(n));
          n++;
          continue;
        }
        let end = n;
        while (end + 1 <= lines.length && foldable(end + 1)) end++;
        const count = end - n + 1;
        if (count > fold) {
          out.push(
            `<span class="fold">${count} unchanged lines</span>` +
              `<div class="folded" hidden>${Array.from({ length: count }, (_, k) => row(n + k)).join("")}</div>`,
          );
        } else {
          for (let k = n; k <= end; k++) out.push(row(k));
        }
        n = end + 1;
      }

      const label = spec.label ?? basename(spec.path);
      const sub = spec.sub ?? `${lines.length} lines`;
      return (
        `<section class="codefile" data-file="${fi}" data-lang="${spec.lang}">` +
        `<header class="codefile-head"><span class="codefile-name">${esc(label)}</span>` +
        `<span class="codefile-sub">${sub}</span></header>` +
        // rows joined with "" on purpose: see the .row comment in the template
        `<pre><code>${out.join("")}</code></pre></section>`
      );
    })
    .join("");
}

function renderNarrative(beats: Beat[], files: FileSpec[]): string {
  return beats
    .map((b, i) => {
      const fi = b.file ?? 0;
      const head = b.section
        ? `<div class="sect"><h2 id="s-${b.id}">${b.section}</h2>` +
          (b.sectionSub ? `<p class="sect-sub">${b.sectionSub}</p>` : "") +
          `</div>`
        : "";
      const tags = b.tags?.length
        ? `<div class="tags">${b.tags.map(([c, t]) => `<span class="tag ${c}">${t}</span>`).join("")}</div>`
        : "";
      const range = b.from === b.to ? `L${b.from}` : `L${b.from}–${b.to}`;
      const fileTag =
        files.length > 1
          ? `<span class="beat-file">${esc(files[fi].label ?? basename(files[fi].path))}</span>`
          : "";
      return (
        `${head}<article class="beat" id="b-${b.id}" data-file="${fi}" ` +
        `data-from="${b.from}" data-to="${b.to}" data-i="${i}">` +
        `<div class="beat-meta"><span class="beat-range">${range}</span>${fileTag}</div>` +
        `${tags}<h3>${b.title}</h3>${b.body}</article>`
      );
    })
    .join("\n");
}

const renderBands = (bands: Band[] | undefined) =>
  !bands?.length
    ? ""
    : bands
        .map(
          (b) =>
            `<div class="rule"><i></i></div>\n<section class="band"><div class="band-inner">` +
            (b.heading ? `<h2>${b.heading}</h2>` : "") +
            (b.sub ? `<p class="band-sub">${b.sub}</p>` : "") +
            b.html +
            `</div></section>`,
        )
        .join("\n");

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const outFlagIdx = argv.indexOf("--out");
const defPath = positional[0];

if (!defPath)
  die(
    "usage: bun build.ts <walkthrough.json> [--out page.html] [--open] [--require-full-coverage]",
  );
if (!existsSync(defPath)) die(`walkthrough file not found: ${defPath}`);

let wt: Walkthrough;
try {
  wt = JSON.parse(readFileSync(defPath, "utf8"));
} catch (e) {
  die(`walkthrough file is not valid JSON: ${(e as Error).message}`);
}

const base = dirname(resolve(defPath));
if (!wt.files?.length) die("walkthrough has no `files`");
if (!wt.beats?.length) die("walkthrough has no `beats`");

// resolve languages + read sources
for (const f of wt.files) {
  if (!f.lang) f.lang = EXT_LANG[f.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plain";
  else if (!(f.lang in LANGS)) {
    console.warn(
      `\x1b[33mwarn\x1b[0m   unknown lang "${f.lang}" for ${f.path} — falling back to plain`,
    );
    f.lang = "plain";
  }
}
const contents = wt.files.map((f) => {
  const p = resolve(base, f.path);
  if (!existsSync(p))
    die(`source file not found: ${p}\n         (paths are resolved relative to ${base})`);
  return readFileSync(p, "utf8").replace(/\n$/, "").split("\n");
});

// validate beat ranges before anything else uses them
wt.beats.forEach((b, i) => {
  const fi = b.file ?? 0;
  if (!contents[fi])
    die(
      `beat "${b.id}" (#${i}) names file index ${fi}, but only ${wt.files.length} file(s) are defined`,
    );
  if (b.from < 1 || b.to > contents[fi].length || b.from > b.to) {
    die(
      `beat "${b.id}" range ${b.from}-${b.to} is out of bounds for ${wt.files[fi].path} (${contents[fi].length} lines)`,
    );
  }
});

const claimed = new Set<string>();
const overlaps: string[] = [];
for (const b of wt.beats) {
  const fi = b.file ?? 0;
  for (let n = b.from; n <= b.to; n++) {
    const key = `${fi}:${n}`;
    if (claimed.has(key)) overlaps.push(`${wt.files[fi].path}:${n}`);
    claimed.add(key);
  }
}

const scopes = wt.files.map((f, i) => inScopeSet(f, contents[i].length, base));

// ---- assemble
const tplPath = resolve(import.meta.dir, "../assets/template.html");
if (!existsSync(tplPath)) die(`template missing at ${tplPath}`);
let html = readFileSync(tplPath, "utf8");

const titleHtml = wt.titleAccent
  ? esc(wt.title).replace(esc(wt.titleAccent), `<em>${esc(wt.titleAccent)}</em>`)
  : esc(wt.title);

const facts = wt.facts?.length
  ? `<dl class="facts">${wt.facts
      .map((f) => `<div class="fact"><dt>${esc(f.label)}</dt><dd>${f.value}</dd></div>`)
      .join("")}</dl>`
  : "";

const rail = wt.beats
  .filter((b) => b.section)
  .map((b) => `<a href="#b-${b.id}" data-beat="b-${b.id}">${esc(b.section!)}</a>`)
  .join("");

const fileNames = Object.fromEntries(
  wt.files.map((f, i) => [String(i), f.label ?? basename(f.path)]),
);

const subst: Record<string, string> = {
  PAGETITLE: esc(wt.pageTitle ?? wt.title),
  TITLE: titleHtml,
  EYEBROW: wt.eyebrow ?? "",
  LEDE: wt.lede ?? "",
  FACTS: facts,
  INTRO: renderBands(wt.intro),
  OUTRO: renderBands(wt.outro),
  FOOTER: wt.footer ?? "",
  RAIL: rail,
  PANE: renderPane(wt.files, contents, claimed, scopes),
  NARRATIVE: renderNarrative(wt.beats, wt.files),
  FIRSTFILE: esc(wt.files[0].label ?? basename(wt.files[0].path)),
  LANGS: JSON.stringify(LANGS),
  FILENAMES: JSON.stringify(fileNames),
};
for (const [k, v] of Object.entries(subst)) html = html.split(`{{${k}}}`).join(v);

const leftover = html.match(/\{\{[A-Z]+\}\}/g);
if (leftover) die(`template has unreplaced placeholders: ${[...new Set(leftover)].join(", ")}`);

// ---- self-check: read every row back out of the finished HTML
const rowRe =
  /<span class="row" data-f="(\d+)" data-n="(\d+)"><span class="ln">\d+<\/span><span class="lc">([\s\S]*?)<\/span><\/span>/g;
let rendered = 0,
  mismatched = 0,
  m: RegExpExecArray | null;
while ((m = rowRe.exec(html))) {
  rendered++;
  const got = unesc(m[3]) === " " ? "" : unesc(m[3]);
  const want = contents[+m[1]][+m[2] - 1];
  if (got !== want) {
    mismatched++;
    if (mismatched <= 5) {
      console.error(
        `\x1b[31mrow mismatch\x1b[0m ${wt.files[+m[1]].path}:${m[2]}\n  rendered ${JSON.stringify(got)}\n  source   ${JSON.stringify(want)}`,
      );
    }
  }
}
const expected = contents.reduce((a, c) => a + c.length, 0);
if (mismatched) die(`${mismatched} rendered row(s) do not match their source line`);
if (rendered !== expected) die(`rendered ${rendered} rows but the sources have ${expected} lines`);

// ---- self-check: coverage, measured against scope, never the whole file
const gaps: string[] = [];
contents.forEach((lines, fi) => {
  lines.forEach((l, k) => {
    const n = k + 1;
    if (l.trim() && scopes[fi].has(n) && !claimed.has(`${fi}:${n}`))
      gaps.push(`${wt.files[fi].path}:${n}`);
  });
});

// ---- report
const scopedTotal = scopes.reduce((a, s) => a + s.size, 0);
console.log(`\x1b[36mwalkthrough\x1b[0m ${resolve(defPath)}`);
console.log(`  beats            ${wt.beats.length} across ${wt.files.length} file(s)`);
console.log(`  chapters         ${wt.beats.filter((b) => b.section).length}`);
console.log(`  rows rendered    ${rendered}/${expected}, all matching source`);
console.log(
  `  in scope         ${scopedTotal} line(s)${scopedTotal === expected ? " (whole file)" : ""}`,
);
if (overlaps.length) {
  console.warn(
    `\x1b[33m  overlapping\x1b[0m    ${overlaps.length} line(s) claimed by more than one beat (first beat wins for click-through): ${overlaps.slice(0, 5).join(", ")}${overlaps.length > 5 ? ", …" : ""}`,
  );
}
if (gaps.length) {
  const msg = `${gaps.length} in-scope non-blank line(s) have no beat: ${gaps.slice(0, 12).join(", ")}${gaps.length > 12 ? ", …" : ""}`;
  if (flags.has("--require-full-coverage")) die(msg);
  console.warn(`\x1b[33m  uncovered\x1b[0m      ${msg}`);
} else {
  console.log(`  coverage         every in-scope non-blank line has a beat`);
}

const outPath = resolve(
  base,
  outFlagIdx >= 0 ? argv[outFlagIdx + 1] : defPath.replace(/\.json$/, "") + ".html",
);
writeFileSync(outPath, html);
console.log(`\x1b[32mpage\x1b[0m   ${outPath}`);

if (flags.has("--open")) {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [outPath], { stdio: "ignore" });
}
