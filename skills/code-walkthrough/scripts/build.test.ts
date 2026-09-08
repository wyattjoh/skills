import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUILD = resolve(import.meta.dir, "build.ts");
const TEMPLATE = resolve(import.meta.dir, "../assets/template.html");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function build(def: unknown, src: Record<string, string>, args: string[] = []) {
  for (const [name, body] of Object.entries(src)) writeFileSync(join(dir, name), body);
  const defPath = join(dir, "wt.json");
  writeFileSync(defPath, JSON.stringify(def));
  const r = spawnSync("bun", [BUILD, defPath, ...args], { encoding: "utf8" });
  const outPath = join(dir, "wt.html");
  return {
    ...r,
    html: r.status === 0 ? readFileSync(outPath, "utf8") : "",
  };
}

const SRC = `package main

// Greet says hello.
func Greet(name string) string {
\tif name == "" {
\t\treturn "hello, stranger"
\t}
\treturn "hello, " + name
}`;

const baseDef = {
  title: "T",
  files: [{ path: "greet.go" }],
  beats: [{ id: "a", from: 1, to: 9, title: "All of it", body: "<p>x</p>" }],
};

// ---------------------------------------------------------------- rendering

test("every rendered row round-trips back to its source line", () => {
  const r = build(baseDef, { "greet.go": SRC });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("rows rendered    9/9, all matching source");

  const lines = SRC.split("\n");
  const re =
    /<span class="row" data-f="0" data-n="(\d+)"><span class="ln">\d+<\/span><span class="lc">([\s\S]*?)<\/span><\/span>/g;
  let m: RegExpExecArray | null,
    seen = 0;
  while ((m = re.exec(r.html))) {
    seen++;
    const got = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(got === " " ? "" : got).toBe(lines[+m[1] - 1]);
  }
  expect(seen).toBe(lines.length);
});

test("REGRESSION: no newline characters inside <pre> — they render as blank lines", () => {
  // Rows are display:block; a newline between them inside <pre> is preserved
  // whitespace and produces a phantom blank line under every line of code.
  const r = build(baseDef, { "greet.go": SRC });
  const blocks = [...r.html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)];
  expect(blocks.length).toBeGreaterThan(0);
  for (const b of blocks) expect(b[1]).not.toContain("\n");
});

test("blank source lines survive as blank rows", () => {
  const r = build(baseDef, { "greet.go": SRC });
  // line 2 of SRC is empty
  expect(r.html).toContain('data-n="2"><span class="ln">2</span><span class="lc"> </span>');
});

test("HTML metacharacters in source are escaped, not interpreted", () => {
  const src = "if (a < b && c > d) { /* <script>alert(1)</script> */ }";
  const r = build(
    {
      ...baseDef,
      files: [{ path: "x.ts" }],
      beats: [{ id: "a", from: 1, to: 1, title: "t", body: "<p>x</p>" }],
    },
    { "x.ts": src },
  );
  expect(r.status).toBe(0);
  expect(r.html).toContain("&lt;script&gt;");
  expect(r.html).not.toContain("<script>alert(1)</script>");
});

// ---------------------------------------------------------------- scope

test("scope: explicit ranges mean only those lines owe an explanation", () => {
  const r = build(
    {
      ...baseDef,
      files: [{ path: "greet.go", scope: { ranges: [[5, 7]] }, foldContextAfter: 2 }],
      beats: [{ id: "g", from: 5, to: 7, title: "guard", body: "<p>x</p>" }],
    },
    { "greet.go": SRC },
  );
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("in scope         3 line(s)");
  expect(r.stdout).toContain("every in-scope non-blank line has a beat");
  // the whole file is still rendered as context
  expect(r.stdout).toContain("rows rendered    9/9");
});

test("scope: long runs of unexplained context collapse into a fold", () => {
  const long = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join("\n");
  const r = build(
    {
      ...baseDef,
      files: [{ path: "big.go", scope: { ranges: [[20, 21]] }, foldContextAfter: 5 }],
      beats: [{ id: "e", from: 20, to: 21, title: "edit", body: "<p>x</p>" }],
    },
    { "big.go": long },
  );
  expect(r.status).toBe(0);
  expect(r.html).toContain('<span class="fold">19 unchanged lines</span>');
  expect(r.html).toContain('<span class="fold">19 unchanged lines</span>');
  expect(r.stdout).toContain("rows rendered    40/40");
});

test("scope: a line a beat explains is never folded away", () => {
  const long = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join("\n");
  const r = build(
    {
      ...baseDef,
      files: [{ path: "big.go", scope: { ranges: [[20, 20]] }, foldContextAfter: 3 }],
      beats: [
        { id: "e", from: 20, to: 20, title: "edit", body: "<p>x</p>" },
        { id: "ctx", from: 35, to: 35, title: "out-of-scope but explained", body: "<p>x</p>" },
      ],
    },
    { "big.go": long },
  );
  expect(r.status).toBe(0);
  const foldedBodies = [...r.html.matchAll(/<div class="folded" hidden>([\s\S]*?)<\/div>/g)].map(
    (m) => m[1],
  );
  for (const body of foldedBodies) expect(body).not.toContain('data-n="35"');
});

// ---------------------------------------------------------------- validation

test("--require-full-coverage fails on an in-scope gap", () => {
  const r = build(
    { ...baseDef, beats: [{ id: "a", from: 1, to: 4, title: "part", body: "<p>x</p>" }] },
    { "greet.go": SRC },
    ["--require-full-coverage"],
  );
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("have no beat");
});

test("without the flag, an in-scope gap is a warning and the page still builds", () => {
  const r = build(
    { ...baseDef, beats: [{ id: "a", from: 1, to: 4, title: "part", body: "<p>x</p>" }] },
    { "greet.go": SRC },
  );
  expect(r.status).toBe(0);
  expect(r.stderr + r.stdout).toContain("uncovered");
});

test("a beat range past the end of the file is a hard error", () => {
  const r = build(
    { ...baseDef, beats: [{ id: "a", from: 1, to: 999, title: "t", body: "<p>x</p>" }] },
    { "greet.go": SRC },
  );
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("out of bounds");
});

test("a missing source file names the path it looked for", () => {
  const r = build({ ...baseDef, files: [{ path: "nope.go" }] }, { "greet.go": SRC });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("source file not found");
});

test("overlapping beats warn but do not fail", () => {
  const r = build(
    {
      ...baseDef,
      beats: [
        { id: "a", from: 1, to: 5, title: "t", body: "<p>x</p>" },
        { id: "b", from: 4, to: 9, title: "t", body: "<p>x</p>" },
      ],
    },
    { "greet.go": SRC },
  );
  expect(r.status).toBe(0);
  expect(r.stderr + r.stdout).toContain("overlapping");
});

test("no placeholder survives into the output", () => {
  const r = build(baseDef, { "greet.go": SRC });
  expect(r.html).not.toMatch(/\{\{[A-Z]+\}\}/);
});

// ---------------------------------------------------------------- theme

/**
 * Contrast is asserted against the template itself, so editing a token cannot
 * silently drop a pair below AA. Catppuccin aims for a comfortable middle
 * contrast, not automatic compliance - these pairs were chosen by measurement.
 */
function paletteFromTemplate() {
  const tpl = readFileSync(TEMPLATE, "utf8");
  const ctp: Record<string, string> = {};
  for (const m of tpl.matchAll(/--ctp-([a-z0-9]+):\s*(#[0-9a-f]{6})/gi)) ctp[m[1]] = m[2];
  const ui: Record<string, string> = {};
  for (const m of tpl.matchAll(/--(ui|syn)-([a-z-]+):\s*var\(--ctp-([a-z0-9]+)\)/gi)) {
    ui[`${m[1]}-${m[2]}`] = ctp[m[3]];
  }
  return { ctp, ui };
}

const luminance = (hex: string) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the template's palette layers are both present and fully wired", () => {
  const { ctp, ui } = paletteFromTemplate();
  expect(Object.keys(ctp).length).toBeGreaterThanOrEqual(26); // all Mocha labels
  for (const key of ["ui-text", "ui-action", "ui-danger", "syn-keyword", "syn-comment"]) {
    expect(ui[key]).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("every text pair used by the page clears WCAG AA", () => {
  const { ctp, ui } = paletteFromTemplate();
  const pairs: [string, string, string, number][] = [
    ["body text", ui["ui-text"], ctp.base, 4.5],
    ["secondary prose", ui["ui-text-secondary"], ctp.base, 4.5],
    ["muted prose and notes", ui["ui-text-muted"], ctp.base, 4.5],
    ["faint chips and footer", ui["ui-text-faint"], ctp.base, 4.5],
    ["links and active state", ui["ui-action"], ctp.base, 4.5],
    ["panel body text", ui["ui-text-muted"], ctp.mantle, 4.5],
    ["panel labels", ui["ui-text-faint"], ctp.mantle, 4.5],
    ["code comments", ui["syn-comment"], ctp.crust, 4.5],
    ["code keywords", ui["syn-keyword"], ctp.crust, 4.5],
    ["code types", ui["syn-type"], ctp.crust, 4.5],
    ["code functions", ui["syn-func"], ctp.crust, 4.5],
    ["code strings", ui["syn-string"], ctp.crust, 4.5],
    ["code identifiers", ui["syn-ident"], ctp.crust, 4.5],
    ["code numbers", ui["syn-number"], ctp.crust, 4.5],
    ["code punctuation", ui["syn-punct"], ctp.crust, 4.5],
    ["line numbers", ctp.overlay1, ctp.crust, 4.5],
    ["info badge", ui["ui-info"], ctp.base, 4.5],
    ["caution badge", ui["ui-caution"], ctp.base, 4.5],
    ["danger badge", ui["ui-danger"], ctp.base, 4.5],
    ["accent badge", ui["ui-quiet-accent"], ctp.base, 4.5],
    ["success badge", ui["ui-success"], ctp.base, 4.5],
    ["inline code", ctp.lavender, ctp.surface0, 4.5],
    ["focus ring", ui["ui-focus"], ctp.base, 3.0],
  ];
  const failures: string[] = [];
  for (const [name, fg, bg, target] of pairs) {
    const ratio = contrast(fg, bg);
    if (ratio < target)
      failures.push(`${name}: ${ratio.toFixed(2)}:1 < ${target}:1 (${fg} on ${bg})`);
  }
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------- hover linking

test("the active spotlight outranks the hover preview", () => {
  // .row.hov and .row.on have identical specificity, so source order decides
  // which wins on a row that is both hovered and active. Active must win.
  const tpl = readFileSync(TEMPLATE, "utf8");
  const hov = tpl.indexOf(".row.hov,");
  const on = tpl.indexOf(".row.on,");
  expect(hov).toBeGreaterThan(-1);
  expect(on).toBeGreaterThan(-1);
  expect(hov).toBeLessThan(on);

  const hovLn = tpl.indexOf(".row.hov .ln");
  const onLn = tpl.indexOf(".row.on .ln");
  expect(hovLn).toBeGreaterThan(-1);
  expect(hovLn).toBeLessThan(onLn);

  const beatHov = tpl.indexOf(".beat.hov::before");
  const beatOn = tpl.indexOf(".beat.on::before");
  expect(beatHov).toBeGreaterThan(-1);
  expect(beatHov).toBeLessThan(beatOn);
});

test("hover preview uses the focus token, not the action token", () => {
  // Mauve means "you are here". If hover were also mauve, pointing at a block
  // would be indistinguishable from having scrolled to it.
  const tpl = readFileSync(TEMPLATE, "utf8");
  const hovRule = /\.row\.hov,[^}]+\}/.exec(tpl)?.[0] ?? "";
  expect(hovRule).toContain("--ui-focus");
  expect(hovRule).not.toContain("--ui-action");
});

test("hover linking is pointer-gated so it cannot stick on touch", () => {
  const tpl = readFileSync(TEMPLATE, "utf8");
  expect(tpl).toContain('matchMedia("(hover: hover)")');
  // and the handler must clear state when the pointer leaves the pane
  expect(tpl).toContain('scroller.addEventListener("mouseleave"');
});

test("the beat rail is absolutely positioned so lighting it cannot shift text", () => {
  const tpl = readFileSync(TEMPLATE, "utf8");
  const rail = /\.beat::before\{[^}]+\}/.exec(tpl)?.[0] ?? "";
  expect(rail).toContain("position:absolute");
  expect(rail).toContain("background:transparent");
});

test("hover states clear WCAG AA where they carry text", () => {
  const { ctp, ui } = paletteFromTemplate();
  // hovered line numbers switch to the focus colour against the code pane
  expect(contrast(ui["ui-focus"], ctp.crust)).toBeGreaterThanOrEqual(4.5);
  // hovered beat range chip sits on the page canvas
  expect(contrast(ui["ui-focus"], ctp.base)).toBeGreaterThanOrEqual(4.5);
});

test("mauve is reserved for UI state and never used as a syntax colour", () => {
  // The spotlight, links, and active nav are mauve. If a syntax token were also
  // mauve, "you are here" would stop reading unambiguously inside the code pane.
  const { ctp, ui } = paletteFromTemplate();
  expect(ui["ui-action"]).toBe(ctp.mauve);
  for (const [k, v] of Object.entries(ui)) {
    if (k.startsWith("syn-")) expect(v).not.toBe(ctp.mauve);
  }
});
