#!/usr/bin/env bun
/**
 * Deterministically (re)builds the devenv skill's reference corpus.
 *
 *   bun scripts/build-skill.ts              # fetch upstream, rebuild
 *   bun scripts/build-skill.ts --check      # rebuild in memory, exit 1 if stale
 *   bun scripts/build-skill.ts --offline    # use cached source + tree
 *
 * Sources
 *   content : https://devenv.sh/llms-full.txt      (the whole docs site, one file)
 *   layout  : cachix/devenv docs/src/content/docs  (git tree, via GitHub API)
 *
 * Why both: llms-full.txt carries the prose but no section/area metadata. The
 * upstream docs tree carries the taxonomy (languages/, services/, blog/, ...)
 * but not the rendered text. They align 1:1 and in order, so joining them
 * yields area + slug for every section without hardcoding line numbers.
 *
 * Ownership: this script owns `references/<area>/<slug>.md` and `manifest.json`.
 * It never touches SKILL.md or any INDEX.md -- those are hand-authored
 * judgement layers. It reports when they drift out of sync with the corpus.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SKILL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const REFS = join(SKILL, "references");
const CACHE = join(SKILL, ".cache");

const LLMS_URL = "https://devenv.sh/llms-full.txt";
const TREE_URL =
  "https://api.github.com/repos/cachix/devenv/git/trees/main?recursive=1";
const DOCS_PREFIX = "docs/src/content/docs/";
const SITE = "https://devenv.sh";

const argv = new Set(process.argv.slice(2));
const CHECK = argv.has("--check");
const OFFLINE = argv.has("--offline");

/* ------------------------------------------------------------------ taxonomy */

/** Upstream directory -> local area. Directories are far more stable than
 *  line numbers; an unknown directory falls back to its own name and warns. */
const DIR_AREA: Record<string, string> = {
  languages: "languages",
  services: "services",
  integrations: "integrations",
  "supported-process-managers": "process-managers",
  "editor-support": "editors",
  recipes: "patterns",
  reference: "concepts",
  guides: "guides",
  community: "guides",
  blog: "history",
};

/** Upstream ships 27 loose top-level pages. Splitting them into task-oriented
 *  "guides" vs option-reference "concepts" is the one editorial call here.
 *  Unlisted root pages default to `guides` and are reported as new. */
const ROOT_AREA: Record<string, string> = {
  "ad-hoc-developer-environments": "guides",
  "auto-activation": "guides",
  basics: "guides",
  "binary-caching": "guides",
  cloud: "guides",
  "composing-using-imports": "guides",
  containers: "guides",
  "creating-files": "guides",
  examples: "guides",
  extending: "guides",
  "files-and-variables": "guides",
  "garbage-collection": "guides",
  "getting-started": "guides",
  "git-hooks": "guides",
  inputs: "guides",
  lsp: "concepts",
  mcp: "concepts",
  outputs: "concepts",
  overlays: "concepts",
  packages: "concepts",
  pinning: "concepts",
  processes: "concepts",
  profiles: "concepts",
  repl: "concepts",
  scripts: "concepts",
  tasks: "concepts",
  tests: "concepts",
};

/** Upstream slug -> local filename, where we prefer a clearer name. */
const SLUG_ALIAS: Record<string, string> = {
  "creating-files": "declarative-files",
  extending: "extending-devenv",
  lsp: "language-server",
  mcp: "mcp-server",
  "yaml-options": "devenv-yaml",
  monorepo: "monorepo-with-shared-configurations",
  polyrepo: "polyrepos",
  "migrating-to-2.0": "migrating-to-devenv-2-0",
  "using-with-flakes": "using-devenv-with-nix-flakes",
  "using-with-flake-parts": "using-devenv-with-flake-parts",
};

/** Blog-post H1s that are really H2s inside their parent post. */
const SUBHEADINGS = new Set(["Highlights", "Bug fixes"]);

/* -------------------------------------------------------------------- source */

async function fetchText(url: string, cacheFile: string): Promise<string> {
  const cached = join(CACHE, cacheFile);
  if (OFFLINE) {
    if (!existsSync(cached)) die(`--offline but no cache at ${cached}`);
    return Bun.file(cached).text();
  }
  const res = await fetch(url, {
    headers: { "user-agent": "devenv-skill-builder" },
  });
  if (!res.ok) die(`GET ${url} -> ${res.status} ${res.statusText}`);
  const text = await res.text();
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, text);
  return text;
}

function die(msg: string): never {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
}

/** Ordered upstream doc paths. llms-full.txt emits them lexicographically by
 *  path, except `index.md` comes first within its directory. */
function orderedDocPaths(treeJson: string): string[] {
  const tree = JSON.parse(treeJson) as { tree?: { path: string }[] };
  if (!tree.tree) die("unexpected git tree response (no .tree)");
  const key = (p: string) => p.replace(/(^|\/)index\.mdx?$/, "$1");
  return tree.tree
    .map((n) => n.path)
    .filter((p) => p.startsWith(DOCS_PREFIX) && /\.mdx?$/.test(p))
    .map((p) => p.slice(DOCS_PREFIX.length))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/* --------------------------------------------------------------------- parse */

type Head = { line: number; title: string };

/** H1 scan that ignores `#` inside ``` / ~~~ fences (shell comments abound). */
function scanHeadings(lines: string[]): Head[] {
  const out: Head[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const ch = f[1][0];
      fence = fence === null ? ch : ch === fence ? null : fence;
      return;
    }
    if (fence !== null) return;
    const h = l.match(/^#\s+(.+?)\s*$/);
    if (h) out.push({ line: i + 1, title: h[1] });
  });
  return out;
}

type Sec = { title: string; start: number; end: number };

/**
 * Fold the raw H1 stream into one section per upstream page.
 *
 * Two structural quirks, both derived rather than hardcoded to line numbers:
 *  - A page's frontmatter title renders as an H1 followed only by an optional
 *    `>` description before the body's own H1 ("Overview" / "Using devenv in
 *    GitHub Actions"). Such a stub merges *forward*.
 *  - Old blog posts use H1 for "Highlights"/"Bug fixes"; those merge *back*.
 * Both are guarded by the 1:1 count assertion against the upstream tree.
 */
function buildSections(lines: string[], heads: Head[]): Sec[] {
  const isStub = (h: Head, next?: Head) => {
    if (!next) return false;
    const body = lines.slice(h.line, next.line - 1)
      .filter((l) => l.trim() !== "");
    return body.every((l) => l.trimStart().startsWith(">"));
  };

  const secs: Sec[] = [];
  let carried: Head | null = null;
  heads.forEach((h, i) => {
    // A carried stub followed by a sub-heading means the stub *was* the page
    // (a blog post whose body opens with an H1-styled "Highlights"); emit it.
    if (carried && SUBHEADINGS.has(h.title)) {
      secs.push({ title: carried.title, start: carried.line, end: 0 });
      carried = null;
      return;
    }
    if (SUBHEADINGS.has(h.title) && secs.length) return;
    if (isStub(h, heads[i + 1])) { carried ??= h; return; }
    secs.push({
      title: h.title,
      start: carried ? carried.line : h.line,
      end: 0,
    });
    carried = null;
  });

  secs.forEach((s, i) => {
    s.end = i + 1 < secs.length ? secs[i + 1].start - 1 : lines.length;
  });
  return secs;
}

/** Strip scrape artifacts and collapse blank runs -- never inside fences. */
function clean(body: string[]): string {
  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;
  for (const l of body) {
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const ch = f[1][0];
      fence = fence === null ? ch : ch === fence ? null : fence;
      out.push(l);
      blanks = 0;
      continue;
    }
    if (fence !== null) { out.push(l); continue; }
    if (/^\[Section titled [“"]/.test(l)) continue;
    if (l.trim() === "") { if (++blanks > 1) continue; out.push(""); continue; }
    blanks = 0;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/* --------------------------------------------------------------------- build */

const src = await fetchText(LLMS_URL, "llms-full.txt");
const treeJson = await fetchText(TREE_URL, "tree.json");

const lines = src.split("\n");
const docPaths = orderedDocPaths(treeJson);
const sections = buildSections(lines, scanHeadings(lines));

// --- validation: the two sources must describe the same set of pages --------
if (sections.length !== docPaths.length) {
  console.error(
    `\n  ERROR  alignment failed: ${sections.length} parsed sections vs ` +
      `${docPaths.length} upstream docs.\n` +
      `  Upstream restructured, or a new heading quirk appeared.\n` +
      `  First divergence:`,
  );
  const n = Math.min(sections.length, docPaths.length);
  for (let i = 0; i < n; i++) {
    const want = docPaths[i].replace(/\.mdx?$/, "").split("/").pop();
    const got = sections[i].title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (want!.replace(/[^a-z0-9]/g, "") !== got) {
      console.error(`    #${i}  ${docPaths[i]}  <->  "${sections[i].title}"`);
      break;
    }
  }
  process.exit(1);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const agree = docPaths.filter((p, i) =>
  norm(p.replace(/\.mdx?$/, "").split("/").pop()!) === norm(sections[i].title)
).length;
const ratio = agree / docPaths.length;
if (ratio < 0.85) {
  die(
    `slug agreement ${(ratio * 100).toFixed(1)}% (expected >=85%). ` +
      `Ordering assumption likely broke; refusing to write a scrambled corpus.`,
  );
}

// --- assemble ---------------------------------------------------------------
type Entry = {
  title: string; area: string; slug: string; path: string;
  upstream: string; url: string; srcLines: [number, number];
  lines: number; bytes: number; body: string;
};

const entries: Entry[] = [];
const newRootPages: string[] = [];
const unknownDirs = new Set<string>();

docPaths.forEach((p, i) => {
  const s = sections[i];
  const parts = p.replace(/\.mdx?$/, "").split("/");
  const base = parts.pop()!;
  const dir = parts[0];

  let area: string;
  if (!dir) {
    area = ROOT_AREA[base] ?? "guides";
    if (!(base in ROOT_AREA)) newRootPages.push(base);
  } else if (dir in DIR_AREA) {
    area = DIR_AREA[dir];
  } else {
    area = dir;
    unknownDirs.add(dir);
  }

  const slug = base === "index" ? "_overview" : (SLUG_ALIAS[base] ?? base);
  const body = clean(lines.slice(s.start - 1, s.end));
  const url = `${SITE}/${p.replace(/(^|\/)index\.mdx?$/, "$1").replace(/\.mdx?$/, "")}/`
    .replace(/\/+$/, "/");

  entries.push({
    title: s.title, area, slug, path: `references/${area}/${slug}.md`,
    upstream: DOCS_PREFIX + p, url, srcLines: [s.start, s.end],
    lines: body.split("\n").length, bytes: Buffer.byteLength(body), body,
  });
});

const dupes = entries.map((e) => e.path)
  .filter((p, i, a) => a.indexOf(p) !== i);
if (dupes.length) die(`slug collision: ${[...new Set(dupes)].join(", ")}`);

// --- render -----------------------------------------------------------------
const render = (e: Entry) =>
  `<!-- source: ${e.url}\n     upstream: ${e.upstream}\n` +
  `     llms-full.txt lines ${e.srcLines[0]}-${e.srcLines[1]} -->\n\n${e.body}`;

const manifest = entries.map(({ body, ...m }) => m);
const manifestText = JSON.stringify(manifest, null, 2) + "\n";

if (CHECK) {
  const stale: string[] = [];
  for (const e of entries) {
    const f = join(SKILL, e.path);
    if (!existsSync(f) || (await Bun.file(f).text()) !== render(e)) {
      stale.push(e.path);
    }
  }
  const mf = join(REFS, "manifest.json");
  if (!existsSync(mf) || (await Bun.file(mf).text()) !== manifestText) {
    stale.push("references/manifest.json");
  }
  if (stale.length) {
    console.error(`stale (${stale.length}):\n  ${stale.slice(0, 40).join("\n  ")}`);
    process.exit(1);
  }
  console.log(`up to date: ${entries.length} reference files`);
  process.exit(0);
}

// Remove only generated files; INDEX.md and SKILL.md are hand-authored.
const keep = new Set(entries.map((e) => join(SKILL, e.path)));
if (existsSync(REFS)) {
  for (const area of await readdir(REFS, { withFileTypes: true })) {
    if (!area.isDirectory()) continue;
    for (const f of await readdir(join(REFS, area.name))) {
      const full = join(REFS, area.name, f);
      if (f === "INDEX.md" || keep.has(full)) continue;
      if (f.endsWith(".md")) await rm(full);
    }
  }
}

for (const e of entries) {
  const out = join(SKILL, e.path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, render(e));
}
await writeFile(join(REFS, "manifest.json"), manifestText);

/* -------------------------------------------------------------------- report */

const byArea = new Map<string, number>();
for (const e of entries) byArea.set(e.area, (byArea.get(e.area) ?? 0) + 1);

const srcKB = Buffer.byteLength(src) / 1024;
const outKB = entries.reduce((t, e) => t + e.bytes, 0) / 1024;

console.log(`\n${entries.length} reference files from ${srcKB.toFixed(0)} KB upstream`);
console.log(`slug agreement ${(ratio * 100).toFixed(1)}%  |  noise removed ${((1 - outKB / srcKB) * 100).toFixed(1)}%\n`);
for (const [a, n] of [...byArea].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${a.padEnd(18)}${String(n).padStart(4)}`);
}

// Drift: SKILL.md references a file that no longer exists, or new topics
// exist that SKILL.md never mentions. Reported, never auto-fixed.
const skillPath = join(SKILL, "SKILL.md");
if (existsSync(skillPath)) {
  const skill = await Bun.file(skillPath).text();
  const areas = [...byArea.keys()];
  const broken = [...skill.matchAll(/`([a-z0-9][a-z0-9._-]*\.md)`/g)]
    .map((m) => m[1])
    .filter((f) => !areas.some((a) => existsSync(join(REFS, a, f))));
  const unmentioned = entries.filter(
    (e) => e.slug !== "_overview" && e.area !== "history" &&
      !skill.includes(e.slug),
  );
  if (broken.length) {
    console.log(`\n  SKILL.md references ${broken.length} missing file(s):`);
    console.log(`    ${[...new Set(broken)].join(", ")}`);
  }
  if (unmentioned.length) {
    console.log(`\n  ${unmentioned.length} topic(s) not mentioned in SKILL.md:`);
    console.log(`    ${unmentioned.map((e) => `${e.area}/${e.slug}`).join(", ")}`);
  }
  if (!broken.length && !unmentioned.length) console.log("\n  SKILL.md in sync.");
}

// Hand-authored INDEX.md files link into the generated corpus by relative
// path; a renamed upstream slug silently breaks them. Check every link.
let indexBroken = 0;
for (const area of byArea.keys()) {
  const idx = join(REFS, area, "INDEX.md");
  if (!existsSync(idx)) continue;
  const txt = await Bun.file(idx).text();
  const missing = [...txt.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+?)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((rel) => !existsSync(join(REFS, area, rel)));
  if (missing.length) {
    indexBroken += missing.length;
    console.log(`\n  ${area}/INDEX.md has ${missing.length} broken link(s):`);
    console.log(`    ${[...new Set(missing)].slice(0, 12).join(", ")}`);
  }
}
if (!indexBroken) console.log("  All INDEX.md links resolve.");
if (newRootPages.length) {
  console.log(`\n  New upstream root pages (defaulted to guides/, add to ROOT_AREA):`);
  console.log(`    ${newRootPages.join(", ")}`);
}
if (unknownDirs.size) {
  console.log(`\n  New upstream directories (add to DIR_AREA):`);
  console.log(`    ${[...unknownDirs].join(", ")}`);
}
console.log();
