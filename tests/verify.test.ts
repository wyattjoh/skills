import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedLines,
  changedFiles,
  emDashLines,
  formatTable,
  herdrPlan,
  type GitContext,
  newWarnings,
  parseAddedLines,
  parseOxlintWarnings,
  resolveBase,
  type Warning,
} from "../scripts/verify.ts";

const EM_DASH = String.fromCodePoint(0x2014);

// Fixtures never inherit a hook's repository location (.claude/rules/testing.md).
const GIT_ENV_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
]);

const cleanEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !GIT_ENV_KEYS.has(entry[0]) &&
        !entry[0].startsWith("GIT_CONFIG_"),
    ),
  );

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): GitContext & { git: (...args: string[]) => void } => {
  const cwd = mkdtempSync(join(tmpdir(), "verify-fixture-"));
  roots.push(cwd);
  const env = cleanEnv();
  const git = (...args: string[]) => {
    const ran = Bun.spawnSync(
      [
        "git",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-C",
        cwd,
        ...args,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(ran.exitCode).toBe(0);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "kept.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "gone.ts"), "export const b = 2;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return { cwd, env, git };
};

describe("parseAddedLines", () => {
  it("numbers added lines in the new file and skips deletions", () => {
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -2,0 +3,2 @@",
      "+one",
      "+two",
      "@@ -9 +10 @@",
      "-old",
      "+new",
      "diff --git a/y.md b/y.md",
      "--- a/y.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    expect(parseAddedLines(diff)).toEqual([
      { file: "x.md", line: 3, text: "one" },
      { file: "x.md", line: 4, text: "two" },
      { file: "x.md", line: 10, text: "new" },
    ]);
  });
});

describe("emDashLines", () => {
  it("names each added line holding an em dash as file:line", () => {
    const lines = [
      { file: "a.md", line: 1, text: `plain - dash` },
      { file: "a.md", line: 2, text: `an ${EM_DASH} dash` },
    ];
    expect(emDashLines(lines)).toEqual(["a.md:2"]);
  });
});

const warning = (file: string, rule: string, line: number): Warning => ({
  file,
  rule,
  message: `${rule} message`,
  line,
});

describe("newWarnings", () => {
  it("allows existing warnings that moved and names only the added ones", () => {
    const base = [warning("a.ts", "no-shadow", 3), warning("a.ts", "no-shadow", 9)];
    const head = [
      warning("a.ts", "no-shadow", 5),
      warning("a.ts", "no-shadow", 11),
      warning("a.ts", "no-shadow", 20),
      warning("b.ts", "eqeqeq", 1),
    ];
    expect(newWarnings(base, head)).toEqual([
      warning("a.ts", "no-shadow", 20),
      warning("b.ts", "eqeqeq", 1),
    ]);
  });

  it("returns nothing when warnings only went away", () => {
    expect(newWarnings([warning("a.ts", "no-shadow", 3)], [])).toEqual([]);
  });
});

describe("parseOxlintWarnings", () => {
  it("keeps warnings with their first label's line and drops errors", () => {
    const report = JSON.stringify({
      diagnostics: [
        {
          filename: "a.ts",
          code: "eslint(no-shadow)",
          message: "m",
          severity: "warning",
          labels: [{ span: { line: 4 } }],
        },
        {
          filename: "a.ts",
          code: "eslint(no-debugger)",
          message: "e",
          severity: "error",
          labels: [],
        },
      ],
    });
    expect(parseOxlintWarnings(report)).toEqual([
      { file: "a.ts", rule: "eslint(no-shadow)", message: "m", line: 4 },
    ]);
  });
});

describe("formatTable", () => {
  it("shows pass, FAIL and skip rows", () => {
    expect(
      formatTable([
        { name: "lint", ok: true, seconds: 1.25, output: "" },
        { name: "test", ok: false, seconds: 3, output: "" },
        { name: "install", ok: true, skipped: "present", seconds: 0, output: "" },
      ]),
    ).toBe(
      [
        "step     result",
        "lint     pass  1.3s",
        "test     FAIL  3.0s",
        "install  skip  present",
      ].join("\n"),
    );
  });
});

describe("git range", () => {
  it("falls back from an unresolvable or all-zero override to main", () => {
    const repo = fixture();
    expect(resolveBase(repo, "0000000000000000000000000000000000000000")).toBe("main");
    expect(resolveBase(repo, "no-such-ref")).toBe("main");
    expect(resolveBase(repo, "HEAD")).toBe("HEAD");
  });

  it("collects committed, uncommitted and untracked additions since the base", () => {
    const repo = fixture();
    repo.git("checkout", "-q", "-b", "work");
    writeFileSync(join(repo.cwd, "kept.ts"), `export const a = 1;\n// committed ${EM_DASH}\n`);
    repo.git("rm", "-q", "gone.ts");
    repo.git("commit", "-q", "-am", "work");
    writeFileSync(
      join(repo.cwd, "kept.ts"),
      `export const a = 1;\n// committed ${EM_DASH}\n// edited\n`,
    );
    writeFileSync(join(repo.cwd, "new.md"), `fresh\nline ${EM_DASH}\n`);

    expect(addedLines(repo, "main")).toEqual([
      { file: "kept.ts", line: 2, text: `// committed ${EM_DASH}` },
      { file: "kept.ts", line: 3, text: "// edited" },
      { file: "new.md", line: 1, text: "fresh" },
      { file: "new.md", line: 2, text: `line ${EM_DASH}` },
      { file: "new.md", line: 3, text: "" },
    ]);
    expect(emDashLines(addedLines(repo, "main"))).toEqual(["kept.ts:2", "new.md:2"]);
    expect(changedFiles(repo, "main")).toEqual(["kept.ts", "new.md"]);
  });
});

describe("herdrPlan", () => {
  it("runs just check off CI and wherever Herdr is installed", () => {
    expect(herdrPlan(false, false).map((planned) => planned.name)).toEqual(["herdr just check"]);
    expect(herdrPlan(true, true).map((planned) => planned.name)).toEqual(["herdr just check"]);
  });

  it("on CI without Herdr runs commands that exist in the Herdr folder's install", () => {
    const plan = herdrPlan(true, false);
    expect(plan.map((planned) => planned.name)).toEqual([
      "herdr test",
      "herdr render-sync",
      "herdr typecheck+build",
    ]);
    const executables = plan.flatMap((planned) => ("argv" in planned ? [planned.argv[0]] : []));
    expect(executables.map((path) => path === "bun" || existsSync(path ?? ""))).toEqual([
      true,
      true,
    ]);
  });
});
