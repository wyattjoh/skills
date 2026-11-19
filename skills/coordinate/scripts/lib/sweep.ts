import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import type { Config } from "./config.ts";
import { readEnded, removeEnded } from "./fleet.ts";
import {
  aheadOfUpstream,
  defaultBases,
  deleteBranch,
  git,
  gitTry,
  inside,
  mainCheckout,
  PROTECTED_BRANCHES,
  real,
  statusLines,
  unsavedCommits,
  type Worktree,
  worktrees,
} from "./git.ts";
import * as hc from "./herdr.ts";
import { Proc } from "./proc.ts";
import { branchState, repoPullRequests, type RepoPrs } from "./prs.ts";

/**
 * SAFE: remove now. CLOSE: finished but a session still runs there. ASK: work would be lost.
 * KEEP: in use. INFO: nothing to remove, worth knowing.
 */
export type Verdict = "SAFE" | "CLOSE" | "ASK" | "KEEP" | "INFO";

/**
 * One line of the sweep report.
 */
export type Row = { verdict: Verdict; text: string; path: string | undefined };

const ORDER: Record<Verdict, number> = { SAFE: 0, CLOSE: 1, ASK: 2, KEEP: 3, INFO: 4 };
const SELF_EXITING = new Set(["caffeinate"]);
const SCRATCH_STALE_DAYS = 7;

/**
 * A live agent session, by the folder it runs in.
 */
export type Session = { name: string; where: string; cwd: string };

/**
 * A process and a folder it holds (cwd or executable).
 */
export type Held = { pid: string; command: string; path: string };

/**
 * What every verdict reads: sessions, processes, and per repo its bases and PRs.
 */
export type SweepContext = {
  sessions: Session[];
  processes: Held[];
  repos: Map<string, { bases: string[]; prs: RepoPrs }>;
  keep: string[];
  ended: Set<string>;
  creationBases: Map<string, string>;
};

/**
 * Parse `lsof -d cwd,txt -Fpcn`.
 * @param text lsof output.
 * @returns Held folders.
 */
export const parseLsof = (text: string): Held[] => {
  const rows: Held[] = [];
  let pid = "";
  let command = "";
  for (const line of text.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") pid = value;
    else if (tag === "c") command = value;
    else if (tag === "n") rows.push({ pid, command, path: value });
  }
  return rows;
};

const ENV = (): Record<string, string> => ({ ...process.env }) as Record<string, string>;

/**
 * Live agent sessions and every process's folders. Fails rather than guessing when either cannot be read.
 * @returns Sessions and processes.
 */
export const observe = Effect.fn("observe")(function* () {
  const listed = yield* hc.list();
  const sessions = listed
    .filter((terminal) => terminal.live && hc.isAgent(terminal))
    .map((terminal) => ({
      name: terminal.name ?? terminal.address,
      where: terminal.where || "no tab",
      cwd: terminal.cwd ? real(terminal.cwd) : "",
    }));
  const proc = yield* Proc;
  const lsof = yield* proc.run(["lsof", "-d", "cwd,txt", "-Fpcn"], {
    timeoutMs: 30_000,
    env: ENV(),
  });
  // lsof exits 1 when some processes could not be read; its output is still complete for ours.
  if (lsof.exitCode > 1 || lsof.stdout === "")
    return yield* new hc.HerdrError({
      command: "lsof",
      kind: "command_failed",
      message: lsof.stderr.slice(0, 200),
    });
  return { sessions, processes: parseLsof(lsof.stdout) };
});

/**
 * Bases and PRs for each repo, plus the ended-record folders that mark work to resume.
 * @param config Config.
 * @param repos Main checkouts.
 * @param extraBases Extra base refs.
 * @param keep Folders never removed.
 * @returns The sweep context.
 */
export const context = Effect.fn("sweepContext")(function* (
  config: Config,
  repos: readonly string[],
  extraBases: readonly string[],
  keep: readonly string[],
) {
  const seen = yield* observe();
  const map = new Map<string, { bases: string[]; prs: RepoPrs }>();
  for (const repo of repos) {
    map.set(repo, {
      bases: yield* defaultBases(repo, extraBases),
      prs: yield* repoPullRequests(config, repo),
    });
  }
  const endedRecords = (yield* readEnded(config.stateDir)).records;
  const ended = new Set(endedRecords.map((entry) => real(entry.record.cwd)));
  const creationBases = new Map(
    endedRecords
      .filter((entry) => entry.record.base_sha)
      .map((entry) => [real(entry.record.cwd), entry.record.base_sha ?? ""]),
  );
  return { ...seen, repos: map, keep: keep.map(real), ended, creationBases } satisfies SweepContext;
});

/**
 * Judge one linked worktree.
 * @param repo Main checkout.
 * @param worktree The worktree.
 * @param ctx Sweep context.
 * @returns Its row.
 */
export const worktreeRow = Effect.fn("worktreeRow")(function* (
  repo: string,
  worktree: Worktree,
  ctx: SweepContext,
) {
  const info = ctx.repos.get(repo) ?? {
    bases: [],
    prs: { ok: false, repo, error: "not read" } satisfies RepoPrs,
  };
  const path = real(worktree.path);
  const branch = worktree.branch;
  const prs = info.prs.ok ? info.prs.prs : [];
  const state = branch
    ? yield* branchState(repo, branch, info.bases, prs, ctx.creationBases.get(path))
    : undefined;
  const dirty = existsSync(path) ? yield* statusLines(path) : undefined;
  const unsaved = existsSync(path) ? yield* unsavedCommits(path, info.bases) : undefined;
  const gitFailed = dirty === undefined || unsaved === undefined;
  const here = ctx.sessions.filter((session) => session.cwd !== "" && inside(session.cwd, path));
  const pids = [
    ...new Set(
      ctx.processes
        .filter((held) => inside(held.path, path) && !SELF_EXITING.has(held.command))
        .map((held) => `${held.pid} ${held.command}`),
    ),
  ].toSorted();
  const baseNames = new Set(info.bases.map((base) => base.split("/").at(-1)));
  const onBase = branch !== undefined && (PROTECTED_BRANCHES.has(branch) || baseNames.has(branch));
  const noOwnCommits = state?.hasCommits === false;
  const endedNoCommits = noOwnCommits && ctx.ended.has(path);
  const landed = state?.landed;
  const finished =
    !onBase &&
    (landed !== undefined ||
      (state?.hasCommits !== false && state?.prState === "closed") ||
      endedNoCommits);
  // Squash and rebase merges leave the branch's own commits off every base; the base holds the work.
  const lost = landed === undefined ? (unsaved ?? 0) : 0;
  const openPr = state?.prState === "open";

  let verdict: Verdict;
  if (onBase || ctx.keep.some((folder) => inside(path, folder))) verdict = "KEEP";
  else if (!branch || gitFailed) verdict = here.length > 0 ? "KEEP" : "ASK";
  else if (here.length > 0 && ((dirty?.length ?? 0) > 0 || lost > 0)) verdict = "KEEP";
  else if ((dirty?.length ?? 0) > 0 || lost > 0) verdict = "ASK";
  else if (endedNoCommits && (here.length > 0 || pids.length > 0)) verdict = "KEEP";
  else if (here.length > 0) verdict = finished ? "CLOSE" : "KEEP";
  else if (pids.length > 0) verdict = "ASK";
  else if (openPr) verdict = "KEEP";
  else if (finished) verdict = "SAFE";
  else verdict = "KEEP";

  const notes: string[] = [
    state?.prLabel ||
      (!branch
        ? "detached"
        : onBase
          ? "base branch"
          : info.prs.ok
            ? "no PR"
            : `PRs unknown: ${info.prs.error}`),
  ];
  if (landed && landed !== "pr-merged") notes.push(`on base (${landed})`);
  if (noOwnCommits) notes.push(endedNoCommits ? "no commits (nothing to land)" : "no commits yet");
  if (gitFailed) notes.push("git status or git log failed here");
  if (dirty && dirty.length > 0) notes.push(`${dirty.length} uncommitted`);
  if (lost > 0) notes.push(`${lost} ${lost === 1 ? "commit" : "commits"} on no remote or base`);
  for (const session of here) notes.push(`session ${session.name} in "${session.where}"`);
  if (pids.length > 0 && here.length === 0) notes.push(`processes: ${pids.slice(0, 4).join("; ")}`);
  if (ctx.ended.has(path)) notes.push("ended delegate record");
  return {
    verdict,
    path,
    text: `worktree ${path} [${branch ?? "detached"}] ${notes.join(" · ")}`,
  } satisfies Row;
});

/**
 * Local branches whose work is on a base or whose PR merged, not checked out and with no open PR.
 * @param repo Main checkout.
 * @param ctx Sweep context.
 * @returns Branch, short sha and how it landed.
 */
export const landedBranches = Effect.fn("landedBranches")(function* (
  repo: string,
  ctx: SweepContext,
) {
  const info = ctx.repos.get(repo);
  const bases = info?.bases ?? [];
  const prs = info?.prs.ok ? info.prs.prs : [];
  const checkedOut = new Set((yield* worktrees(repo)).map((worktree) => worktree.branch));
  const baseNames = new Set(bases.map((base) => base.split("/").at(-1)));
  const refs =
    (yield* gitTry(repo, [
      "for-each-ref",
      "--format=%(refname:short) %(objectname:short)",
      "refs/heads",
    ])) ?? "";
  const found: Array<{ branch: string; sha: string; how: string }> = [];
  for (const line of refs.split("\n").filter(Boolean)) {
    const [branch = "", sha = ""] = line.split(" ");
    if (checkedOut.has(branch) || baseNames.has(branch) || PROTECTED_BRANCHES.has(branch)) continue;
    const state = yield* branchState(repo, branch, bases, prs);
    if (state.prState === "open" || state.landed === undefined) continue;
    found.push({
      branch,
      sha,
      how:
        state.landed === "pr-merged" ? `PR merged (${state.prLabel})` : `on base (${state.landed})`,
    });
  }
  return found;
});

const sizeMb = Effect.fn("sizeMb")(function* (path: string) {
  const proc = yield* Proc;
  const out = yield* proc
    .run(["du", "-sk", path], { timeoutMs: 30_000, env: ENV() })
    .pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
  return Math.floor(Number(out.stdout.split(/\s/)[0] ?? "0") / 1024);
});

const scratchRows = (repo: string, nowMs: number): Row[] => {
  const scratch = join(repo, ".scratch");
  if (!existsSync(scratch)) return [];
  const stale = readdirSync(scratch).filter(
    (name) =>
      name !== "parked" &&
      nowMs - lstatSync(join(scratch, name)).mtimeMs >= SCRATCH_STALE_DAYS * 86_400_000,
  );
  return stale.length === 0
    ? []
    : [
        {
          verdict: "ASK",
          path: scratch,
          text: `scratch ${scratch}: ${stale.length} entries untouched ${SCRATCH_STALE_DAYS}+ days: ${stale.slice(0, 6).join(", ")}`,
        },
      ];
};

/**
 * The whole report: every linked worktree (`.claude/worktrees` included), landed branches, processes in
 * deleted worktree folders, stale scratch, and each base checkout's lead over its remote.
 * @param config Config.
 * @param repos Main checkouts.
 * @param options Bases, keep list, sizes.
 * @returns Rows, most actionable first.
 */
export const report = Effect.fn("sweepReport")(function* (
  config: Config,
  repos: readonly string[],
  options: { bases: readonly string[]; keep: readonly string[]; sizes: boolean; nowMs: number },
) {
  const ctx = yield* context(config, repos, options.bases, options.keep);
  const rows: Row[] = [];
  for (const repo of repos) {
    const listed = yield* worktrees(repo);
    for (const worktree of listed.slice(1)) {
      const row = yield* worktreeRow(repo, worktree, ctx);
      if (options.sizes && row.verdict !== "KEEP")
        row.text = `${String(yield* sizeMb(row.path ?? "")).padStart(6)}M ${row.text}`;
      rows.push(row);
    }
    const landed = yield* landedBranches(repo, ctx);
    if (landed.length > 0)
      rows.push({
        verdict: "SAFE",
        path: repo,
        text: `${landed.length} landed branches in ${repo} · list them: coordinate sweep prune-branches ${repo} --list`,
      });
    rows.push(...scratchRows(repo, options.nowMs));
    const ahead = yield* aheadOfUpstream(repo);
    if (ahead && ahead.ahead > 0)
      rows.push({
        verdict: "INFO",
        path: repo,
        text: `base ${repo} [${ahead.branch}] is ${ahead.ahead} commits ahead of ${ahead.upstream}`,
      });
    const prs = ctx.repos.get(repo)?.prs;
    if (prs && !prs.ok)
      rows.push({ verdict: "INFO", path: repo, text: `PRs for ${repo} unknown: ${prs.error}` });
    const root = join(repo, ".claude", "worktrees");
    const realRoot = real(root);
    const byFolder = new Map<string, Map<string, string>>();
    for (const held of ctx.processes) {
      if (!inside(held.path, realRoot) || existsSync(held.path) || SELF_EXITING.has(held.command))
        continue;
      const folder = join(realRoot, held.path.slice(realRoot.length + 1).split("/")[0] ?? "");
      const pids = byFolder.get(folder) ?? new Map<string, string>();
      pids.set(held.pid, held.command);
      byFolder.set(folder, pids);
    }
    for (const [folder, pids] of byFolder)
      rows.push({
        verdict: "SAFE",
        path: undefined,
        text: `processes in deleted folder ${folder}: ${[...pids].map(([pid, command]) => `${pid} ${command}`).join(", ")} · stop them: kill ${[...pids.keys()].join(" ")}`,
      });
  }
  return rows.toSorted((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
});

/**
 * Render rows.
 * @param rows Rows.
 * @returns Lines.
 */
export const renderRows = (rows: readonly Row[]): string[] =>
  rows.length === 0
    ? ["nothing to sweep: no worktrees, landed branches, stale scratch or stray processes"]
    : rows.map((row) => `${row.verdict.padEnd(5)} ${row.text}`);

/**
 * Ignored files of a worktree, split into `.scratch` (parked), build output (dropped) and the rest (discarded).
 * @param path Worktree.
 * @param buildOutput Build-output names.
 * @returns The three lists, relative to the worktree.
 */
export const ignoredFiles = Effect.fn("ignoredFiles")(function* (
  path: string,
  buildOutput: readonly string[],
) {
  const out = yield* git(path, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
  ]);
  if (out.exitCode !== 0) return undefined;
  const names = new Set(buildOutput);
  const park: string[] = [];
  const drop: string[] = [];
  const discard: string[] = [];
  for (const entry of out.stdout.split("\0").filter(Boolean)) {
    const rel = entry.replace(/\/$/, "");
    const parts = rel.split("/");
    if (parts.includes(".scratch")) park.push(rel);
    else if (parts.some((part) => names.has(part)) || /\.(log|tsbuildinfo|pyc)$/.test(rel))
      drop.push(rel);
    else discard.push(rel);
  }
  return { park, drop, discard };
});

const listed = (paths: readonly string[], limit = 6): string =>
  paths.slice(0, limit).join(", ") +
  (paths.length > limit ? ` and ${paths.length - limit} more` : "");

/**
 * Move `.scratch` entries to `<main>/.scratch/parked/<worktree name>`, keeping their relative paths.
 * @param path Worktree.
 * @param repo Main checkout.
 * @param rels Relative paths.
 * @returns Destination and the moves made.
 */
const park = Effect.fn("park")(function* (path: string, repo: string, rels: readonly string[]) {
  return yield* Effect.tryPromise({
    try: async () => {
      let destination = join(repo, ".scratch", "parked", basename(path));
      if (existsSync(destination))
        destination = `${destination}-${new Date().toISOString().replace(/[:.]/g, "")}`;
      const moves: Array<[string, string]> = [];
      try {
        for (const rel of rels) {
          const target = join(destination, rel);
          await mkdir(dirname(target), { recursive: true });
          await rename(join(path, rel), target);
          moves.push([join(path, rel), target]);
        }
        await writeFile(join(destination, ".parked-at"), `${new Date().toISOString()}\n`);
      } catch (error) {
        for (const [source, target] of moves.toReversed()) await rename(target, source);
        throw error;
      }
      return { destination, moves };
    },
    catch: (cause) => new hc.HerdrError({ command: "park", kind: "io", message: String(cause) }),
  });
});

const unpark = (moves: ReadonlyArray<[string, string]>) =>
  Effect.promise(async () => {
    for (const [source, target] of moves.toReversed()) await rename(target, source);
  });

/**
 * Remove one worktree, but only when its recomputed verdict is SAFE.
 * @param config Config.
 * @param worktreePath Worktree.
 * @param ctx Sweep context (must include its repo).
 * @returns Removed or kept, with lines.
 */
export const removeOne = Effect.fn("removeOne")(function* (
  config: Config,
  worktreePath: string,
  ctx: SweepContext,
) {
  const path = real(worktreePath);
  const repo = yield* mainCheckout(path);
  if (!repo) return { removed: false, lines: [`kept ${path}: not a git worktree`] };
  if (real(repo) === path)
    return { removed: false, lines: [`kept ${path}: it is the main checkout`] };
  const worktree = (yield* worktrees(repo)).find((candidate) => real(candidate.path) === path);
  if (!worktree)
    return {
      removed: false,
      lines: [`kept ${path}: git does not list it as a worktree of ${repo}`],
    };
  const row = yield* worktreeRow(repo, worktree, ctx);
  if (row.verdict !== "SAFE")
    return {
      removed: false,
      lines: [`kept ${path}: ${row.verdict}, ${row.text.replace(/^worktree \S+ /, "")}`],
    };

  const ignored = yield* ignoredFiles(path, config.buildOutput);
  if (!ignored)
    return {
      removed: false,
      lines: [`kept ${path}: git ls-files failed, so its ignored files are unknown`],
    };
  const parked = ignored.park.length > 0 ? yield* park(path, repo, ignored.park) : undefined;
  const removal = yield* git(repo, ["worktree", "remove", path]);
  if (removal.exitCode !== 0) {
    if (parked) yield* unpark(parked.moves);
    return {
      removed: false,
      lines: [
        `kept ${path}: git worktree remove failed: ${(removal.stderr || removal.stdout).trim()}`,
      ],
    };
  }
  const lines = [`removed worktree ${path}`];
  if (parked) lines.push(`  parked ${listed(ignored.park)} in ${parked.destination}`);
  if (ignored.drop.length > 0) lines.push(`  dropped build output: ${listed(ignored.drop)}`);
  if (ignored.discard.length > 0)
    lines.push(`  discarded ignored files: ${listed(ignored.discard)}`);

  const branch = worktree.branch;
  if (branch && !PROTECTED_BRANCHES.has(branch)) {
    const sha = (yield* gitTry(repo, ["rev-parse", "--short", branch])) ?? "";
    const refusal = yield* deleteBranch(repo, branch);
    if (refusal === undefined) lines.push(`  deleted branch ${branch} ${sha}`);
    else
      lines.push(
        `  kept branch ${branch} ${sha}: git branch -d refused (${refusal.split("\n")[0]}). Its work is on a base by squash or rebase; to delete it, the user runs: cd ${repo} && git branch -D ${branch}`,
      );
  }
  const spaces = yield* hc.appSpaces().pipe(Effect.catch(() => Effect.succeed([])));
  for (const space of spaces.filter(
    (candidate) => candidate.folder && inside(real(candidate.folder), path),
  )) {
    yield* hc.closeSpace(space.id).pipe(Effect.ignore);
    lines.push(`  closed space ${space.name ?? space.id}`);
  }
  for (const entry of (yield* readEnded(config.stateDir)).records.filter(
    (candidate) => real(candidate.record.cwd) === path,
  )) {
    yield* removeEnded(entry.path);
    lines.push(`  pruned ended record ${entry.record.name}`);
  }
  return { removed: true, lines };
});

/**
 * Remove worktrees, refusing every one whose verdict is not SAFE.
 * @param config Config.
 * @param paths Worktrees.
 * @param ctx Sweep context.
 * @returns Lines, ending with "removed N of M".
 */
export const removeMany = Effect.fn("removeMany")(function* (
  config: Config,
  paths: readonly string[],
  ctx: SweepContext,
) {
  const lines: string[] = [];
  const kept: string[] = [];
  let removed = 0;
  for (const path of paths) {
    const result = yield* removeOne(config, path, ctx);
    lines.push(...result.lines);
    if (result.removed) removed += 1;
    else kept.push(result.lines[0]?.replace(/^kept /, "") ?? path);
  }
  lines.push(
    `removed ${removed} of ${paths.length}` +
      (kept.length > 0 ? `; ${kept.length} kept because: ${kept.join("; ")}` : ""),
  );
  return lines;
});

/**
 * Delete landed branches with `git branch -d`, or list them.
 * @param repo Main checkout.
 * @param branches Branches to delete; empty with `list` lists.
 * @param list List only.
 * @param ctx Sweep context.
 * @returns Lines.
 */
export const pruneBranches = Effect.fn("pruneBranches")(function* (
  repo: string,
  branches: readonly string[],
  list: boolean,
  ctx: SweepContext,
) {
  const landed = yield* landedBranches(repo, ctx);
  if (list)
    return landed.length === 0
      ? [`no landed branches in ${repo}`]
      : landed.map((found) => `${found.branch} ${found.sha} ${found.how}`);
  const lines: string[] = [];
  for (const branch of branches) {
    const found = landed.find((candidate) => candidate.branch === branch);
    if (!found) {
      lines.push(
        `kept ${branch}: not a landed branch (open PR, unlanded work, checked out, or a base)`,
      );
      continue;
    }
    const refusal = yield* deleteBranch(repo, branch);
    lines.push(
      refusal === undefined
        ? `deleted branch ${branch} ${found.sha}`
        : `kept ${branch} ${found.sha}: git branch -d refused (${found.how}); the user runs: cd ${repo} && git branch -D ${branch}`,
    );
  }
  return lines;
});

/**
 * Delete ended records whose worktree folder is gone, PRs or not.
 * @param config Config.
 * @returns Lines.
 */
export const pruneEnded = Effect.fn("pruneEnded")(function* (config: Config) {
  const { records, skipped } = yield* readEnded(config.stateDir);
  const gone = records.filter((entry) => !existsSync(entry.record.cwd));
  for (const entry of gone) yield* removeEnded(entry.path);
  const lines = [`pruned ${gone.length} of ${records.length} ended records whose folder is gone`];
  if (gone.length > 0)
    lines.push(
      `  ${listed(
        gone.map((entry) => entry.record.name),
        12,
      )}`,
    );
  if (skipped.length > 0) lines.push(`  unreadable, left in place: ${listed(skipped)}`);
  return lines;
});
