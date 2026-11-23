import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { readDocument } from "./backlog-doc.ts";
import type { Config } from "./config.ts";
import { endedRecordMachines, remoteMachineOf } from "./delegate-capacity.ts";
import { type EndedRecord, readEnded, removeEnded } from "./fleet.ts";
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
import {
  type Held,
  ownedBy,
  type ProcessTable,
  type PsRow,
  remoteHost,
  scanProcesses,
  type StopOptions,
  stopProcesses,
} from "./processes.ts";
import { Proc } from "./proc.ts";
import { branchState, repoPullRequests, type RepoPrs } from "./prs.ts";
import { copyScratch } from "./remote-fetch.ts";
import { remoteFolderExists, remoteProc } from "./remote-launch.ts";

/**
 * SAFE: remove now. CLOSE: finished but a session still runs there. ASK: work would be lost.
 * KEEP: in use. INFO: nothing to remove, worth knowing.
 */
export type Verdict = "SAFE" | "CLOSE" | "ASK" | "KEEP" | "INFO";

/**
 * One line of the sweep report.
 */
export type Row = {
  verdict: Verdict;
  text: string;
  /**
   * The row's folder; on another machine, qualified as `machine:/path`.
   */
  path: string | undefined;
  /**
   * Processes of an ended delegate that `sweep remove` stops; empty for most rows.
   */
  stop: readonly PsRow[];
};

/**
 * A checkout of a domain repo on another Herdr machine, as its Boundary records it.
 */
export type RemoteCheckout = { repo: string; machine: string; checkout: string };

/**
 * A remote checkout as sweep reads it: git there runs through `proc`, and `down` says why the
 * machine did not answer.
 */
export type RemotePlace = RemoteCheckout & {
  proc: Proc["Service"];
  bases: string[];
  down: string | undefined;
  table: ProcessTable | undefined;
  tableError: string | undefined;
};

const ORDER: Record<Verdict, number> = { SAFE: 0, CLOSE: 1, ASK: 2, KEEP: 3, INFO: 4 };
const SELF_EXITING = new Set(["caffeinate"]);
const SCRATCH_STALE_DAYS = 7;

/**
 * A live agent session, by the folder it runs in.
 */
export type Session = {
  name: string;
  where: string;
  cwd: string;
  machine: string | undefined;
};

/**
 * What every verdict reads: sessions, processes, and per repo its bases and PRs.
 */
export type SweepContext = {
  sessions: Session[];
  processes: Held[];
  table: ProcessTable;
  repos: Map<string, { bases: string[]; prs: RepoPrs }>;
  keep: string[];
  ended: Set<string>;
  creationBases: Map<string, string>;
  remotes: RemotePlace[];
};

/**
 * A folder's sweep identity: its path here, or `machine:/path` on another machine.
 * @param machine Herdr machine, undefined for this one.
 * @param path Folder.
 * @returns The key.
 */
export const placeKey = (machine: string | undefined, path: string): string =>
  machine === undefined ? path : `${machine}:${path}`;

/**
 * Split a `machine:/path` worktree argument.
 * @param target A command-line worktree.
 * @returns Machine and path, or undefined for a path on this machine.
 */
export const remoteTarget = (target: string): { machine: string; path: string } | undefined => {
  const match = /^([A-Za-z0-9_.-]+):(\/.*)$/.exec(target);
  return match
    ? { machine: match[1] ?? "", path: (match[2] ?? "").replace(/\/+$/, "") }
    : undefined;
};

/**
 * The remote checkouts the domain's Boundary records for these repos.
 * @param config Config.
 * @param domain Domain, or undefined for none.
 * @param repos Main checkouts on this machine; undefined takes every one recorded.
 * @returns Remote checkouts.
 */
export const remoteCheckouts = Effect.fn("remoteCheckouts")(function* (
  config: Config,
  domain: string | undefined,
  repos: readonly string[] | undefined,
) {
  if (domain === undefined) return [];
  const { backlog } = yield* readDocument(config, domain);
  const found: RemoteCheckout[] = [];
  for (const [owned, byMachine] of Object.entries(backlog.boundary.checkouts ?? {})) {
    const repo = (yield* mainCheckout(owned)) ?? owned;
    if (repos !== undefined && !repos.includes(repo)) continue;
    for (const [machine, checkout] of Object.entries(byMachine))
      found.push({ repo, machine, checkout: checkout.replace(/\/+$/, "") });
  }
  return found;
});

/**
 * Run a git helper where a worktree lives: through the remote's `Proc` on another machine, else
 * through this one's.
 * @param remote The remote checkout, or undefined for this machine.
 * @param effect The helper.
 * @returns The helper, its `Proc` provided.
 */
const onPlace = <A, E, R>(remote: RemotePlace | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const proc = remote?.proc ?? (yield* Proc);
    return yield* effect.pipe(Effect.provideService(Proc, proc));
  });

/**
 * Read one remote checkout: whether its machine answers, its bases and its process table.
 * @param remote The checkout.
 * @param extraBases Extra base refs.
 * @returns The place.
 */
const readRemote = Effect.fn("readRemote")(function* (
  remote: RemoteCheckout,
  extraBases: readonly string[],
) {
  const proc = remoteProc(remote.machine, yield* Proc);
  const down = yield* hc.execOn(remote.machine, "true", 15).pipe(
    Effect.map(() => undefined),
    Effect.catch((error) => Effect.succeed(error.message)),
  );
  const place: RemotePlace = {
    ...remote,
    proc,
    bases: [],
    down,
    table: undefined,
    tableError: "not read",
  };
  if (down !== undefined) return place;
  place.bases = yield* onPlace(place, defaultBases(remote.checkout, extraBases));
  const scanned = yield* remoteHost(remote.machine)
    .scan()
    .pipe(
      Effect.map((table) => ({ table, error: undefined })),
      Effect.catch((error) => Effect.succeed({ table: undefined, error: error.message })),
    );
  place.table = scanned.table;
  place.tableError = scanned.error;
  return place;
});

const ENV = (): Record<string, string> => ({ ...process.env }) as Record<string, string>;

/**
 * A folder's real path, or for a folder that is gone, its real parent joined with its name.
 * @param path Folder.
 * @returns The path.
 */
const canonical = (path: string): string =>
  existsSync(path) ? real(path) : join(real(dirname(path)), basename(path));

/**
 * Live agent sessions and every process's folders, Herdr core's own left out. Fails rather than
 * guessing when either cannot be read.
 * @returns Sessions, processes and the full process table.
 */
export const observe = Effect.fn("observe")(function* () {
  const listed = yield* hc.list();
  const sessions = listed
    .filter((terminal) => terminal.live && hc.isAgent(terminal))
    .map((terminal) => {
      // A terminal on another machine runs in a folder there, never one to resolve here.
      const machine = remoteMachineOf(terminal.address);
      return {
        name: terminal.name ?? terminal.address,
        where: terminal.where || "no tab",
        cwd: terminal.cwd ? (machine === undefined ? real(terminal.cwd) : terminal.cwd) : "",
        machine,
      };
    });
  const table = yield* scanProcesses();
  return {
    sessions,
    processes: table.held.filter((entry) => !table.core.has(entry.pid)),
    table,
  };
});

/**
 * Bases and PRs for each repo, plus the ended-record folders that mark work to resume.
 * @param config Config.
 * @param repos Main checkouts.
 * @param extraBases Extra base refs.
 * @param keep Folders never removed.
 * @param remotes Checkouts of these repos on other machines.
 * @returns The sweep context.
 */
export const context = Effect.fn("sweepContext")(function* (
  config: Config,
  repos: readonly string[],
  extraBases: readonly string[],
  keep: readonly string[],
  remotes: readonly RemoteCheckout[] = [],
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
  const machineOf = yield* endedRecordMachines(endedRecords);
  const keyOf = (record: EndedRecord): string => {
    const machine = machineOf(record);
    return machine === undefined || machine === "unknown"
      ? canonical(record.cwd)
      : placeKey(machine, record.cwd);
  };
  const ended = new Set(endedRecords.map((entry) => keyOf(entry.record)));
  const creationBases = new Map(
    endedRecords
      .filter((entry) => entry.record.base_sha)
      .map((entry) => [keyOf(entry.record), entry.record.base_sha ?? ""]),
  );
  const places: RemotePlace[] = [];
  for (const remote of remotes) places.push(yield* readRemote(remote, extraBases));
  return {
    ...seen,
    repos: map,
    keep: keep.map(real),
    ended,
    creationBases,
    remotes: places,
  } satisfies SweepContext;
});

const label = (entries: readonly Held[]): string[] =>
  [...new Set(entries.map((held) => `${held.pid} ${held.command}`))].toSorted();

/**
 * Judge one linked worktree.
 * @param repo Main checkout.
 * @param worktree The worktree.
 * @param ctx Sweep context.
 * @param remote The checkout on another machine it belongs to; its git and processes are read there.
 * @returns Its row.
 */
export const worktreeRow = Effect.fn("worktreeRow")(function* (
  repo: string,
  worktree: Worktree,
  ctx: SweepContext,
  remote: RemotePlace | undefined = undefined,
) {
  const local = ctx.repos.get(remote?.repo ?? repo);
  const info =
    remote === undefined
      ? (local ?? { bases: [], prs: { ok: false, repo, error: "not read" } satisfies RepoPrs })
      : {
          bases: remote.bases,
          prs: local?.prs ?? ({ ok: false, repo, error: "not read" } satisfies RepoPrs),
        };
  const machine = remote?.machine;
  const path = remote === undefined ? real(worktree.path) : worktree.path.replace(/\/+$/, "");
  const key = placeKey(machine, path);
  const there = remote !== undefined || existsSync(path);
  const branch = worktree.branch;
  const prs = info.prs.ok ? info.prs.prs : [];
  const state = branch
    ? yield* onPlace(remote, branchState(repo, branch, info.bases, prs, ctx.creationBases.get(key)))
    : undefined;
  const dirty = there ? yield* onPlace(remote, statusLines(path)) : undefined;
  const unsaved = there ? yield* onPlace(remote, unsavedCommits(path, info.bases)) : undefined;
  const gitFailed = dirty === undefined || unsaved === undefined;
  const here = ctx.sessions.filter(
    (session) => session.machine === machine && session.cwd !== "" && inside(session.cwd, path),
  );
  const table = remote === undefined ? ctx.table : remote.table;
  // A machine whose processes could not be read may hold the worktree: never SAFE.
  const processesUnknown = table === undefined;
  const processes =
    remote === undefined
      ? ctx.processes
      : (table?.held ?? []).filter((held) => !(table?.core.has(held.pid) ?? false));
  const holding = processes.filter(
    (held) => inside(held.path, path) && !SELF_EXITING.has(held.command),
  );
  // Processes an ended delegate provably left in a worktree coordinate made for it (its record has a
  // creation base) are stopped by remove; only the rest need an ask.
  const owned =
    table !== undefined && ctx.creationBases.has(key) ? ownedBy(table, path) : new Set<string>();
  const allPids = label(holding);
  const pids = label(holding.filter((held) => !owned.has(held.pid)));
  const ownedPids = label(holding.filter((held) => owned.has(held.pid)));
  const stop = (table?.ps ?? []).filter((row) => owned.has(row.pid));
  const baseNames = new Set(info.bases.map((base) => base.split("/").at(-1)));
  const onBase = branch !== undefined && (PROTECTED_BRANCHES.has(branch) || baseNames.has(branch));
  const noOwnCommits = state?.hasCommits === false;
  const endedNoCommits = noOwnCommits && ctx.ended.has(key);
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
  else if (!branch || gitFailed || processesUnknown) verdict = here.length > 0 ? "KEEP" : "ASK";
  else if (here.length > 0 && ((dirty?.length ?? 0) > 0 || lost > 0)) verdict = "KEEP";
  else if ((dirty?.length ?? 0) > 0 || lost > 0) verdict = "ASK";
  else if (endedNoCommits && (here.length > 0 || allPids.length > 0)) verdict = "KEEP";
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
  if (gitFailed) notes.push(`git status or git log failed ${machine ? `on ${machine}` : "here"}`);
  if (processesUnknown)
    notes.push(`processes on ${machine ?? "this machine"} unreadable: ${remote?.tableError ?? ""}`);
  if (dirty && dirty.length > 0) notes.push(`${dirty.length} uncommitted`);
  if (lost > 0) notes.push(`${lost} ${lost === 1 ? "commit" : "commits"} on no remote or base`);
  for (const session of here) notes.push(`session ${session.name} in "${session.where}"`);
  if (pids.length > 0 && here.length === 0) notes.push(`processes: ${pids.slice(0, 4).join("; ")}`);
  if (ownedPids.length > 0 && here.length === 0)
    notes.push(
      `ended delegate's processes, sweep remove stops them: ${ownedPids.slice(0, 4).join("; ")}`,
    );
  if (ctx.ended.has(key)) notes.push("ended delegate record");
  return {
    verdict,
    path: key,
    text: `worktree ${key} [${branch ?? "detached"}] ${notes.join(" · ")}`,
    stop,
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
          stop: [],
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
 * @param remotes Checkouts of these repos on other machines, judged by git there.
 * @returns Rows, most actionable first.
 */
export const report = Effect.fn("sweepReport")(function* (
  config: Config,
  repos: readonly string[],
  options: { bases: readonly string[]; keep: readonly string[]; sizes: boolean; nowMs: number },
  remotes: readonly RemoteCheckout[] = [],
) {
  const ctx = yield* context(config, repos, options.bases, options.keep, remotes);
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
        stop: [],
        text: `${landed.length} landed branches in ${repo} · list them: coordinate sweep prune-branches ${repo} --list`,
      });
    rows.push(...scratchRows(repo, options.nowMs));
    const ahead = yield* aheadOfUpstream(repo);
    if (ahead && ahead.ahead > 0)
      rows.push({
        verdict: "INFO",
        path: repo,
        stop: [],
        text: `base ${repo} [${ahead.branch}] is ${ahead.ahead} commits ahead of ${ahead.upstream}`,
      });
    const prs = ctx.repos.get(repo)?.prs;
    if (prs && !prs.ok)
      rows.push({
        verdict: "INFO",
        path: repo,
        text: `PRs for ${repo} unknown: ${prs.error}`,
        stop: [],
      });
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
    for (const [folder, pids] of byFolder) {
      const owned = ctx.creationBases.has(folder) ? ownedBy(ctx.table, folder) : new Set<string>();
      rows.push({
        verdict: "SAFE",
        path: undefined,
        text:
          `processes in deleted folder ${folder}: ${[...pids].map(([pid, command]) => `${pid} ${command}`).join(", ")} · stop them: kill ${[...pids.keys()].join(" ")}` +
          (owned.size > 0 ? " · an ended delegate's: sweep remove --all-safe stops them" : ""),
        stop: ctx.table.ps.filter((row) => owned.has(row.pid)),
      });
    }
    for (const remote of ctx.remotes.filter((candidate) => candidate.repo === repo))
      rows.push(...(yield* remoteRows(remote, ctx)));
  }
  return rows.toSorted((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
});

const infoRow = (text: string): Row[] => [{ verdict: "INFO", path: undefined, stop: [], text }];

/**
 * The rows of one checkout on another machine: each linked worktree, judged by git there.
 * @param remote The checkout.
 * @param ctx Sweep context.
 * @returns Rows, or one INFO row when the machine or git there did not answer.
 */
const remoteRows = Effect.fn("remoteRows")(function* (remote: RemotePlace, ctx: SweepContext) {
  if (remote.down !== undefined)
    return infoRow(
      `${remote.machine} did not answer, so worktrees of ${placeKey(remote.machine, remote.checkout)} were not judged: ${remote.down}`,
    );
  const listed = yield* onPlace(remote, worktrees(remote.checkout)).pipe(
    Effect.catch((error) => Effect.succeed(error.message)),
  );
  if (typeof listed === "string")
    return infoRow(
      `git worktree list failed in ${placeKey(remote.machine, remote.checkout)}: ${listed}`,
    );
  const rows: Row[] = [];
  for (const worktree of listed.slice(1))
    rows.push(yield* worktreeRow(remote.checkout, worktree, ctx, remote));
  return rows;
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
 * @param options How an ended delegate's processes are stopped.
 * @returns Removed or kept, with lines.
 */
export const removeOne = Effect.fn("removeOne")(function* (
  config: Config,
  worktreePath: string,
  ctx: SweepContext,
  options: StopOptions,
) {
  const target = remoteTarget(worktreePath);
  if (target !== undefined) return yield* removeRemote(config, target, ctx, options);
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
  const stopped = yield* stopProcesses(row.stop, options);
  if (stopped.survivors.length > 0)
    return {
      removed: false,
      lines: [
        `kept ${path}: ${stopped.survivors.length} of its ended delegate's processes still run`,
        ...stopped.lines.map((line) => `  ${line}`),
      ],
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
  const lines = [`removed worktree ${path}`, ...stopped.lines.map((line) => `  ${line}`)];
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
 * Remove one worktree on another machine, with git there, but only when its recomputed verdict is
 * SAFE and it is a linked worktree of a checkout the Boundary records on that machine. Its
 * `.scratch` is copied to this Mac's parked folder first, and the branch is deleted with
 * `git branch -d` there.
 * @param config Config.
 * @param target Machine and worktree path there.
 * @param ctx Sweep context (must include its checkout).
 * @param options How an ended delegate's processes are stopped.
 * @returns Removed or kept, with lines.
 */
const removeRemote = Effect.fn("removeRemote")(function* (
  config: Config,
  target: { machine: string; path: string },
  ctx: SweepContext,
  options: StopOptions,
) {
  const { machine, path } = target;
  const key = placeKey(machine, path);
  const kept = (why: string) => ({ removed: false, lines: [`kept ${key}: ${why}`] });
  const remote = ctx.remotes.find(
    (candidate) => candidate.machine === machine && inside(path, candidate.checkout),
  );
  if (remote === undefined) return kept(`in no checkout the Boundary records on ${machine}`);
  if (remote.down !== undefined) return kept(`${machine} did not answer: ${remote.down}`);
  if (path === remote.checkout) return kept("it is the main checkout");
  const found = yield* onPlace(remote, worktrees(remote.checkout)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const worktree = found?.slice(1).find((candidate) => candidate.path.replace(/\/+$/, "") === path);
  if (!worktree)
    return kept(`git does not list it as a worktree of ${remote.checkout} on ${machine}`);
  const row = yield* worktreeRow(remote.checkout, worktree, ctx, remote);
  if (row.verdict !== "SAFE")
    return kept(`${row.verdict}, ${row.text.replace(/^worktree \S+ /, "")}`);
  const stopped = yield* remoteHost(machine).stop(row.stop, options);
  if (stopped.survivors.length > 0)
    return {
      removed: false,
      lines: [
        `kept ${key}: ${stopped.survivors.length} of its ended delegate's processes still run`,
        ...stopped.lines.map((line) => `  ${line}`),
      ],
    };
  const ignored = yield* onPlace(remote, ignoredFiles(path, config.buildOutput));
  if (!ignored) return kept("git ls-files failed, so its ignored files are unknown");
  // Removing the worktree deletes its ignored .scratch there: keep a copy on this Mac first.
  const parked =
    ignored.park.length === 0
      ? []
      : yield* copyScratch(remote.repo, { name: basename(path), machine, worktree: path }).pipe(
          Effect.catch((error) => Effect.succeed(error.message)),
        );
  if (typeof parked === "string") return kept(`its .scratch could not be copied here: ${parked}`);
  const removal = yield* onPlace(remote, git(remote.checkout, ["worktree", "remove", path]));
  if (removal.exitCode !== 0)
    return kept(`git worktree remove failed: ${(removal.stderr || removal.stdout).trim()}`);
  const lines = [
    `removed worktree ${key}`,
    ...stopped.lines.map((line) => `  ${line}`),
    ...parked.map((line) => `  ${line}`),
  ];
  if (ignored.drop.length > 0) lines.push(`  dropped build output: ${listed(ignored.drop)}`);
  if (ignored.discard.length > 0)
    lines.push(`  discarded ignored files: ${listed(ignored.discard)}`);
  const branch = worktree.branch;
  if (branch && !PROTECTED_BRANCHES.has(branch)) {
    const sha =
      (yield* onPlace(remote, gitTry(remote.checkout, ["rev-parse", "--short", branch]))) ?? "";
    const refusal = yield* onPlace(remote, deleteBranch(remote.checkout, branch));
    if (refusal === undefined) lines.push(`  deleted branch ${branch} ${sha}`);
    else
      lines.push(
        `  kept branch ${branch} ${sha}: git branch -d refused (${refusal.split("\n")[0]}). Its work is on a base by squash or rebase; to delete it, the user runs on ${machine}: cd ${remote.checkout} && git branch -D ${branch}`,
      );
  }
  const spaces = yield* hc.appSpaces().pipe(Effect.catch(() => Effect.succeed([])));
  for (const space of spaces.filter(
    (candidate) =>
      candidate.id.startsWith(`${machine}/`) &&
      candidate.folder &&
      inside(candidate.folder.replace(/\/+$/, ""), path),
  )) {
    yield* hc.closeSpace(space.id).pipe(Effect.ignore);
    lines.push(`  closed space ${space.name ?? space.id}`);
  }
  const { records } = yield* readEnded(config.stateDir);
  const machineOf = yield* endedRecordMachines(records);
  for (const entry of records.filter(
    (candidate) =>
      machineOf(candidate.record) === machine && candidate.record.cwd.replace(/\/+$/, "") === path,
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
 * @param options How an ended delegate's processes are stopped.
 * @returns Lines, ending with "removed N of M".
 */
export const removeMany = Effect.fn("removeMany")(function* (
  config: Config,
  paths: readonly string[],
  ctx: SweepContext,
  options: StopOptions,
) {
  const lines: string[] = [];
  const kept: string[] = [];
  let removed = 0;
  for (const path of paths) {
    const result = yield* removeOne(config, path, ctx, options);
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
 * Stop the ended delegates' processes the report found in deleted worktree folders.
 * @param rows Report rows.
 * @param options Stop options.
 * @returns Lines, one block per folder.
 */
export const stopDeletedFolders = Effect.fn("stopDeletedFolders")(function* (
  rows: readonly Row[],
  options: StopOptions,
) {
  const lines: string[] = [];
  for (const row of rows) {
    if (!row.text.startsWith("processes in deleted folder ") || row.stop.length === 0) continue;
    const folder = row.text.slice("processes in deleted folder ".length).split(":")[0] ?? "";
    const stopped = yield* stopProcesses(row.stop, options);
    lines.push(`ended delegate's processes in deleted folder ${folder}:`);
    lines.push(...stopped.lines.map((line) => `  ${line}`));
  }
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
  const machineOf = yield* endedRecordMachines(records);
  const gone: typeof records = [];
  const unknown: string[] = [];
  const down = new Map<string, string>();
  for (const entry of records) {
    const machine = machineOf(entry.record);
    if (machine === undefined) {
      if (!existsSync(entry.record.cwd)) gone.push(entry);
      continue;
    }
    // A record of another machine is judged by its folder there, never by this Mac's disk.
    if (machine === "unknown") {
      if (!existsSync(entry.record.cwd))
        unknown.push(`${entry.record.name} (this machine's Herdr name is unreadable)`);
      continue;
    }
    const failed = down.get(machine);
    const exists =
      failed === undefined
        ? yield* remoteFolderExists(machine, entry.record.cwd).pipe(
            Effect.catch((error) => Effect.succeed(error.message)),
          )
        : failed;
    if (typeof exists === "string") {
      down.set(machine, exists);
      unknown.push(`${entry.record.name} (${machine} did not answer)`);
    } else if (!exists) gone.push(entry);
  }
  for (const entry of gone) yield* removeEnded(entry.path);
  const lines = [`pruned ${gone.length} of ${records.length} ended records whose folder is gone`];
  if (gone.length > 0)
    lines.push(
      `  ${listed(
        gone.map((entry) => entry.record.name),
        12,
      )}`,
    );
  if (unknown.length > 0) lines.push(`  folder unknown, left in place: ${listed(unknown, 12)}`);
  if (skipped.length > 0) lines.push(`  unreadable, left in place: ${listed(skipped)}`);
  return lines;
});
