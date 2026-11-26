// The repository's one gate: local runs, the lefthook pre-push hook and CI all run
// `bun run verify`. Every step runs, even after a failure, and the script prints a
// pass/fail table and exits non-zero when any step failed. Each step's output goes to
// .scratch/verify/<step>.log.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

type Run = { exitCode: number; output: string };

/**
 * Where a git command runs and with which environment. Verify inherits the caller's
 * environment so a hook's GIT_DIR still names the right repository; tests pass a
 * sanitized one.
 */
export type GitContext = { cwd: string; env: Env };

const EM_DASH = String.fromCodePoint(0x2014);

const LINT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|astro|svelte)$/;

/**
 * Variables that tell git which repository to use. Child test suites never see them,
 * so a fixture that shells out to git cannot reach this repository (see
 * .claude/rules/testing.md).
 */
const GIT_LOCATION_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
]);

const withoutGitLocation = (env: Env): Env =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_LOCATION_KEYS.has(key)));

const runSync = (argv: string[], cwd: string, env: Env): Run => {
  const result = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
};

const runAsync = async (argv: string[], cwd: string, env: Env): Promise<Run> => {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr };
};

const git = (context: GitContext, args: string[]): Run =>
  runSync(["git", ...args], context.cwd, context.env);

const gitLines = (context: GitContext, args: string[]): string[] => {
  const ran = git(context, args);
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.output.trim()}`);
  return ran.output.split("\n").filter((line) => line !== "");
};

const resolves = (context: GitContext, ref: string): boolean =>
  git(context, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).exitCode === 0;

/**
 * The ref changed lines are measured from: VERIFY_BASE when it names a commit (CI sets
 * it to the PR base or the pushed range's start), else origin/main, else main.
 * @returns The ref, or null when none resolves.
 */
export const resolveBase = (context: GitContext, override: string | undefined): string | null => {
  const candidates = [override, "origin/main", "main"].filter(
    (ref): ref is string => ref !== undefined && ref !== "" && !/^0+$/.test(ref),
  );
  return candidates.find((ref) => resolves(context, ref)) ?? null;
};

export type AddedLine = { file: string; line: number; text: string };

/**
 * The added lines of a zero-context unified diff, numbered in the new file.
 */
export const parseAddedLines = (diff: string): AddedLine[] => {
  const added: AddedLine[] = [];
  let file: string | null = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4);
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (file === null || !raw.startsWith("+")) continue;
    added.push({ file, line: next, text: raw.slice(1) });
    next += 1;
  }
  return added;
};

const untrackedFiles = (context: GitContext): string[] =>
  gitLines(context, ["ls-files", "--others", "--exclude-standard"]);

const readText = (path: string): string | null => {
  const bytes = readFileSync(path);
  return bytes.includes(0) ? null : bytes.toString("utf8");
};

const DIFF_ARGS = ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames"];

/**
 * Lines added since `base`: the committed range `base...HEAD`, uncommitted changes to
 * tracked files, and every line of untracked files.
 */
export const addedLines = (context: GitContext, base: string): AddedLine[] => {
  const committed = gitLines(context, [...DIFF_ARGS, `${base}...HEAD`]).join("\n");
  const uncommitted = gitLines(context, [...DIFF_ARGS, "HEAD"]).join("\n");
  const untracked = untrackedFiles(context).flatMap((file) => {
    const text = readText(join(context.cwd, file));
    if (text === null) return [];
    return text.split("\n").map((line, index) => ({ file, line: index + 1, text: line }));
  });
  const all = [...parseAddedLines(committed), ...parseAddedLines(uncommitted), ...untracked];
  const byKey = new Map(all.map((entry) => [`${entry.file}:${entry.line}:${entry.text}`, entry]));
  return [...byKey.values()];
};

/**
 * Added lines that contain an em dash, as file:line.
 */
export const emDashLines = (lines: AddedLine[]): string[] =>
  lines
    .filter((entry) => entry.text.includes(EM_DASH))
    .map((entry) => `${entry.file}:${entry.line}`);

/**
 * Files changed since `base` that still exist: committed, uncommitted or untracked.
 */
export const changedFiles = (context: GitContext, base: string): string[] => {
  const names = ["diff", "--name-only", "--no-renames", "--diff-filter=d"];
  const committed = gitLines(context, [...names, `${base}...HEAD`]);
  const uncommitted = gitLines(context, [...names, "HEAD"]);
  return [...new Set([...committed, ...uncommitted, ...untrackedFiles(context)])].toSorted();
};

export type Warning = { file: string; rule: string; message: string; line: number };

type OxlintReport = {
  diagnostics: {
    filename: string;
    code: string;
    message: string;
    severity: string;
    labels?: { span: { line: number } }[];
  }[];
};

/**
 * The warnings in oxlint's JSON report.
 */
export const parseOxlintWarnings = (json: string): Warning[] =>
  (JSON.parse(json) as OxlintReport).diagnostics
    .filter((entry) => entry.severity === "warning")
    .map((entry) => ({
      file: entry.filename,
      rule: entry.code,
      message: entry.message,
      line: entry.labels?.[0]?.span.line ?? 0,
    }));

const warningKey = (warning: Warning): string =>
  JSON.stringify([warning.file, warning.rule, warning.message]);

/**
 * The HEAD warnings beyond what the base had: for each file, rule and message, every
 * occurrence above the base's count is new. Line numbers are ignored, since edits
 * move them.
 */
export const newWarnings = (base: Warning[], head: Warning[]): Warning[] => {
  const remaining = new Map<string, number>();
  for (const warning of base) {
    remaining.set(warningKey(warning), (remaining.get(warningKey(warning)) ?? 0) + 1);
  }
  return head.filter((warning) => {
    const left = remaining.get(warningKey(warning)) ?? 0;
    if (left === 0) return true;
    remaining.set(warningKey(warning), left - 1);
    return false;
  });
};

export type StepResult = {
  name: string;
  ok: boolean;
  skipped?: string;
  seconds: number;
  output: string;
};

/**
 * The summary table, one row per step.
 */
export const formatTable = (results: StepResult[]): string => {
  const width = Math.max(4, ...results.map((result) => result.name.length));
  const rows = results.map((result) => {
    if (result.skipped !== undefined)
      return `${result.name.padEnd(width)}  skip  ${result.skipped}`;
    const status = result.ok ? "pass" : "FAIL";
    return `${result.name.padEnd(width)}  ${status}  ${result.seconds.toFixed(1)}s`;
  });
  return [`${"step".padEnd(width)}  result`, ...rows].join("\n");
};

const root = resolve(import.meta.dir, "..");
const herdrRoot = join(root, "plugins/coordinate/herdr");
const bin = (name: string): string => join(root, "node_modules/.bin", name);
const context: GitContext = { cwd: root, env: process.env };

type Outcome = Omit<StepResult, "name" | "seconds">;
type Step = { name: string; run: () => Promise<Outcome> };

const command =
  (argv: string[], cwd = root, env: Env = process.env): Step["run"] =>
  async () => {
    const ran = await runAsync(argv, cwd, env);
    return { ok: ran.exitCode === 0, output: ran.output };
  };

const install =
  (cwd: string): Step["run"] =>
  async () => {
    if (existsSync(join(cwd, "node_modules"))) {
      return { ok: true, skipped: "node_modules present", output: "" };
    }
    return command(["bun", "install", "--frozen-lockfile"], cwd)();
  };

const NO_BASE: Outcome = {
  ok: false,
  output: "No base ref: set VERIFY_BASE or fetch origin/main\n",
};

const emDashStep: Step["run"] = async () => {
  const base = resolveBase(context, process.env.VERIFY_BASE);
  if (base === null) return NO_BASE;
  const hits = emDashLines(addedLines(context, base));
  const header = `Base: ${base}\n`;
  if (hits.length === 0) return { ok: true, output: header };
  const listed = hits.map((hit) => `  ${hit}`).join("\n");
  return { ok: false, output: `${header}Added lines with an em dash (U+2014):\n${listed}\n` };
};

const oxlintWarnings = (files: string[], cwd: string, config: string): Warning[] => {
  if (files.length === 0) return [];
  const ignore = ["--ignore-pattern", ".claude/references/**"];
  const ran = runSync(
    [bin("oxlint"), "-c", config, ...ignore, "--format", "json", ...files],
    cwd,
    process.env,
  );
  return parseOxlintWarnings(ran.output.slice(ran.output.indexOf("{")));
};

/**
 * Lints the changed files at the merge base (copied into a temporary folder with the
 * repository's config) and as they stand, and fails on any warning the change adds.
 * Existing warnings stay allowed.
 */
const lintWarningsStep: Step["run"] = async () => {
  const base = resolveBase(context, process.env.VERIFY_BASE);
  if (base === null) return NO_BASE;
  const mergeBase = gitLines(context, ["merge-base", base, "HEAD"])[0] ?? base;
  const files = changedFiles(context, base).filter((file) => LINT_EXTENSIONS.test(file));
  const config = join(root, ".oxlintrc.json");
  const head = oxlintWarnings(files, root, config);
  const scratch = mkdtempSync(join(tmpdir(), "verify-lint-base-"));
  try {
    const scratchConfig = join(scratch, ".oxlintrc.json");
    writeFileSync(scratchConfig, readFileSync(config));
    const atBase = files.filter((file) => {
      const shown = git(context, ["show", `${mergeBase}:${file}`]);
      if (shown.exitCode !== 0) return false;
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), shown.output);
      return true;
    });
    const before = oxlintWarnings(atBase, scratch, scratchConfig);
    const added = newWarnings(before, head);
    const header = `Base: ${base} (${mergeBase.slice(0, 12)}), ${files.length} changed files, warnings ${before.length} -> ${head.length}\n`;
    if (added.length === 0) return { ok: true, output: header };
    const named = added.map((w) => `  ${w.file}:${w.line} ${w.rule}: ${w.message}`);
    return { ok: false, output: `${header}New lint warnings:\n${named.join("\n")}\n` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const hasHerdrDeclarations = (): boolean => {
  const home =
    process.env.HERDR_TYPES_DIR ??
    process.env.HERDR_APP_HOME ??
    join(homedir(), ".config/herdr-app");
  return ["herdr.d.ts", "gpui-kit.d.ts"].every((name) => existsSync(join(resolve(home), name)));
};

export type PlannedCommand =
  | { name: string; argv: string[]; cwd: string }
  | { name: string; skipped: string };

/**
 * The Herdr mod suite, `just check` in its folder. CI runners have no Herdr, whose
 * declarations its typecheck and staged build need, so there it runs the parts that need
 * only npm packages: the tests and render-sync, from the Herdr folder's own install.
 * Elsewhere a missing Herdr fails the step.
 * @param ci Whether this is a CI run.
 * @param declarations Whether Herdr's host declarations are installed.
 */
export const herdrPlan = (ci: boolean, declarations: boolean): PlannedCommand[] => {
  if (!ci || declarations) {
    return [{ name: "herdr just check", argv: ["just", "check"], cwd: herdrRoot }];
  }
  return [
    { name: "herdr test", argv: ["bun", "run", "test"], cwd: herdrRoot },
    {
      name: "herdr render-sync",
      argv: [join(herdrRoot, "node_modules/.bin/herdr-render-sync"), "src/mods"],
      cwd: herdrRoot,
    },
    { name: "herdr typecheck+build", skipped: "CI has no Herdr declarations" },
  ];
};

const herdrSteps = (): Step[] => {
  const env = withoutGitLocation(process.env);
  return herdrPlan(process.env.CI !== undefined, hasHerdrDeclarations()).map((planned) => {
    if ("skipped" in planned) {
      const outcome: Outcome = { ok: true, skipped: planned.skipped, output: "" };
      return { name: planned.name, run: async () => outcome };
    }
    return { name: planned.name, run: command(planned.argv, planned.cwd, env) };
  });
};

const timed = async (step: Step): Promise<StepResult> => {
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  try {
    return { name: step.name, ...(await step.run()), seconds: seconds() };
  } catch (error) {
    const output = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { name: step.name, ok: false, output, seconds: seconds() };
  }
};

const main = async (): Promise<number> => {
  // Installs run first and in order: every later step needs them.
  const results = [
    await timed({ name: "install root", run: install(root) }),
    await timed({ name: "install herdr", run: install(herdrRoot) }),
  ];
  // The quick checks run together; the heavy suites then run one at a time so they do
  // not compete for cores under the test timeout.
  const quick: Step[] = [
    { name: "format:check", run: command(["bun", "run", "format:check"]) },
    { name: "lint", run: command(["bun", "run", "lint"]) },
    { name: "lint new warnings", run: lintWarningsStep },
    { name: "knip", run: command(["bun", "run", "knip"]) },
    { name: "check", run: command(["bun", "run", "check"]) },
    { name: "em dash", run: emDashStep },
  ];
  results.push(...(await Promise.all(quick.map(timed))));
  const heavy: Step[] = [
    { name: "test", run: command(["bun", "run", "test"], root, withoutGitLocation(process.env)) },
    ...herdrSteps(),
  ];
  for (const step of heavy) results.push(await timed(step));

  const logs = join(root, ".scratch/verify");
  mkdirSync(logs, { recursive: true });
  for (const result of results) {
    writeFileSync(join(logs, `${result.name.replaceAll(/[^a-z0-9]+/gi, "-")}.log`), result.output);
  }
  // CI keeps no .scratch logs, so there a failing step prints its whole output.
  const shown = process.env.CI === undefined ? 40 : Infinity;
  for (const result of results.filter((entry) => !entry.ok)) {
    const lines = result.output.trimEnd().split("\n");
    const label = lines.length > shown ? `last ${shown} lines` : "output";
    console.error(`\n--- ${result.name} (${label}) ---\n${lines.slice(-shown).join("\n")}`);
  }
  console.log(`\n${formatTable(results)}\n\nLogs: ${logs}`);
  return results.every((result) => result.ok) ? 0 : 1;
};

if (import.meta.main) process.exit(await main());
