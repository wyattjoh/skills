#!/usr/bin/env bun
/**
 * Splits .claude/references/devenv-full.md into per-topic reference files
 * under .claude/skills/devenv/references/<area>/<slug>.md.
 *
 * Re-run after refreshing the scrape:  bun scripts/split-corpus.ts
 */
import { rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = new URL("../../../..", import.meta.url).pathname;
const SRC = join(ROOT, ".claude/references/devenv-full.md");
const OUT = join(ROOT, ".claude/skills/devenv/references");

/** Ordered area boundaries: a section starting at line >= from and < to. */
const AREAS: { from: number; to: number; area: string }[] = [
  { from: 0, to: 448, area: "guides" },
  { from: 448, to: 3972, area: "history" },
  { from: 3972, to: 4640, area: "guides" },
  { from: 4640, to: 4677, area: "editors" },
  { from: 4677, to: 6700, area: "guides" },
  { from: 6700, to: 8439, area: "integrations" },
  { from: 8439, to: 16048, area: "languages" },
  { from: 16048, to: 17507, area: "concepts" },
  { from: 17507, to: 17834, area: "patterns" },
  { from: 17834, to: 18595, area: "concepts" },
  { from: 18595, to: 26947, area: "services" },
  { from: 26947, to: 27809, area: "process-managers" },
  { from: 27809, to: Infinity, area: "concepts" },
];

/** Headings that are a preamble for the section that follows; the next title wins. */
const MERGE_FORWARD = new Set(["Overview", "Using devenv in GitHub Actions"]);
/** Headings wrongly promoted to H1 inside blog posts; fold into the previous section. */
const MERGE_BACK = new Set(["Highlights", "Bug fixes"]);
/** Area overview pages get a sorting-friendly name. */
const OVERVIEW_SLUG: Record<string, string> = {
  Languages: "_overview",
  Services: "_overview",
  "Alternative process managers": "_overview",
};

const areaOf = (line: number) =>
  AREAS.find((a) => line >= a.from && line < a.to)!.area;

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);

type Head = { line: number; title: string };

/** Fence-aware H1 scan: `#` inside ``` or ~~~ blocks is a code comment, not a heading. */
function headings(lines: string[]): Head[] {
  const out: Head[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const ch = f[1][0];
      if (fence === null) fence = ch;
      else if (ch === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = l.match(/^#\s+(.+?)\s*$/);
    if (h) out.push({ line: i + 1, title: h[1] });
  });
  return out;
}

/** Drop scrape artifacts and collapse blank runs, but never inside code fences. */
function clean(body: string[]): string {
  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;
  for (const l of body) {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const ch = f[1][0];
      if (fence === null) fence = ch;
      else if (ch === fence) fence = null;
      out.push(l);
      blanks = 0;
      continue;
    }
    if (fence !== null) {
      out.push(l);
      continue;
    }
    if (/^\[Section titled [“"]/.test(l)) continue;
    if (l.trim() === "") {
      if (++blanks > 1) continue;
      out.push("");
      continue;
    }
    blanks = 0;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const src = await Bun.file(SRC).text();
const lines = src.split("\n");
const heads = headings(lines);

// Fold merge-forward / merge-back headings into their owning section.
type Sec = { title: string; start: number; end: number; preamble?: [number, number] };
const secs: Sec[] = [];
let pending: Head | null = null;
for (let i = 0; i < heads.length; i++) {
  const h = heads[i];
  if (MERGE_BACK.has(h.title) && secs.length) continue;
  if (MERGE_FORWARD.has(h.title) && heads[i + 1]) {
    pending = h; // prose between this heading and the next belongs to the next section
    continue;
  }
  secs.push({
    title: h.title,
    start: h.line,
    end: 0,
    preamble: pending ? [pending.line + 1, h.line - 1] : undefined,
  });
  pending = null;
}
// A section runs to the start of the next *kept* heading, walking back over folded ones.
const keptStarts = new Set(secs.map((s) => s.start));
secs.forEach((s, i) => {
  const next = secs[i + 1];
  if (!next) return void (s.end = lines.length);
  // include any folded preamble heading immediately before the next section
  const prior = heads.filter((h) => h.line < next.start && h.line > s.start);
  const fwd = prior.filter((h) => MERGE_FORWARD.has(h.title) && !keptStarts.has(h.line));
  s.end = (fwd.length ? fwd[0].line : next.start) - 1;
});

await rm(OUT, { recursive: true, force: true });

const manifest: any[] = [];
const seen = new Set<string>();
for (const s of secs) {
  const area = areaOf(s.start);
  const slug = OVERVIEW_SLUG[s.title] ?? slugify(s.title);
  const rel = join(area, `${slug}.md`);
  if (seen.has(rel)) throw new Error(`slug collision: ${rel} (${s.title})`);
  seen.add(rel);

  const pre = s.preamble ? lines.slice(s.preamble[0] - 1, s.preamble[1]) : [];
  const body = clean([lines[s.start - 1], ...pre, ...lines.slice(s.start, s.end)]);
  const from = s.preamble ? s.preamble[0] - 1 : s.start;
  const header = `<!-- source: .claude/references/devenv-full.md lines ${from}-${s.end} -->\n\n`;
  const path = join(OUT, rel);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, header + body);

  manifest.push({
    title: s.title, area, slug, path: `references/${rel}`,
    srcLines: [from, s.end],
    lines: body.split("\n").length,
    bytes: Buffer.byteLength(body),
  });
}

await Bun.write(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const byArea = new Map<string, { n: number; bytes: number }>();
for (const m of manifest) {
  const a = byArea.get(m.area) ?? { n: 0, bytes: 0 };
  a.n++; a.bytes += m.bytes; byArea.set(m.area, a);
}
const srcBytes = Buffer.byteLength(src);
let total = 0;
console.log(`${manifest.length} files from ${(srcBytes / 1024).toFixed(0)} KB source\n`);
console.log("area".padEnd(18) + "files".padStart(6) + "total KB".padStart(10) + "avg lines".padStart(11) + "max lines".padStart(11));
for (const [a, v] of [...byArea].sort((x, y) => y[1].bytes - x[1].bytes)) {
  const ms = manifest.filter((m) => m.area === a);
  const avg = Math.round(ms.reduce((t, m) => t + m.lines, 0) / ms.length);
  const max = Math.max(...ms.map((m) => m.lines));
  total += v.bytes;
  console.log(a.padEnd(18) + String(v.n).padStart(6) + (v.bytes / 1024).toFixed(0).padStart(10) + String(avg).padStart(11) + String(max).padStart(11));
}
console.log("-".repeat(56));
console.log("TOTAL".padEnd(18) + String(manifest.length).padStart(6) + (total / 1024).toFixed(0).padStart(10));
console.log(`\nnoise removed: ${((1 - total / srcBytes) * 100).toFixed(1)}%`);
console.log("\n10 largest:");
for (const m of [...manifest].sort((a, b) => b.lines - a.lines).slice(0, 10))
  console.log(`  ${String(m.lines).padStart(5)} ln  ${m.path}`);
