#!/usr/bin/env bun
import { Command } from "commander";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolves everything the coordinator needs before it spawns anything: which
// herdr workspace it lives in, what name peers must address it by, and whether
// the repo and tooling are in a state where a batch can safely start.
//
// This exists as a script rather than a sequence of ad-hoc shell calls because
// getting the coordinator's own peer name wrong is silent: workers would send
// their completion reports into the void and the batch would appear to hang.

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused?: boolean;
  cwd?: string;
  // Present on panes herdr detected an agent in. For claude, `value` is the
  // session id, which is what lets a pane be tied to a specific session.
  agent_session?: { agent?: string; kind?: string; value?: string };
}

// One entry of ~/.claude/sessions/<pid>.json. Claude Code and cc-peer-enabled
// pi sessions both register here; `name` is what SendMessage/ListAgents resolve.
export interface SessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status?: string;
  messagingSocketPath?: string;
}

export class PreflightError extends Error {}

// Finds the coordinator's own pane, whose workspace is where worker tabs get
// created.
//
// Matching is on the pane's detected agent session id, never on focus. Focus
// follows the user: the moment they click into another workspace to watch a
// worker, a focus-based lookup starts reporting a workspace the coordinator
// does not live in, and the next worker tab is created somewhere else entirely.
export function paneForSession(panes: readonly Pane[], sessionId: string): Pane {
  const matches = panes.filter((p) => p.agent_session?.value === sessionId);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new PreflightError(
      `${matches.length} panes claim session ${sessionId}; cannot pick a workspace`,
    );
  }
  throw new PreflightError(
    `no herdr pane is running session ${sessionId} — herdr may not have detected this agent yet`,
  );
}

// Peer name lookup is by sessionId, never by cwd: several sessions routinely
// share a working directory, and addressing the wrong one sends a worker's
// report to an unrelated agent.
export function peerNameForSession(entries: readonly SessionEntry[], sessionId: string): string {
  const match = entries.filter((e) => e.sessionId === sessionId);
  if (match.length === 1) return match[0]!.name;
  throw new PreflightError(
    `expected exactly 1 session registry entry for ${sessionId}, found ${match.length}`,
  );
}

// A name is free when no live session already advertises it. herdr and the peer
// registry both key on name, so a collision would make `agent prompt` and
// SendMessage ambiguous for the whole run.
export function isNameTaken(entries: readonly SessionEntry[], name: string): boolean {
  return entries.some((e) => e.name === name);
}

// Worker peer names must survive being typed into `herdr agent start` and used
// as a SendMessage recipient, so restrict them to the character class both
// accept: cc-peer rewrites anything outside [A-Za-z0-9_-].
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function workerPeerName(batch: string, ticketId: string): string {
  const name = `herd-${slug(batch)}-${slug(ticketId)}`;
  if (name.length > 64) return name.slice(0, 64).replace(/-+$/, "");
  return name;
}

export function readSessionRegistry(dir: string): SessionEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: SessionEntry[] = [];
  for (const file of files) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (typeof raw !== "object" || raw === null) continue;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.sessionId !== "string" || typeof obj.name !== "string") continue;
      entries.push({
        pid: typeof obj.pid === "number" ? obj.pid : 0,
        sessionId: obj.sessionId,
        cwd: typeof obj.cwd === "string" ? obj.cwd : "",
        name: obj.name,
        status: typeof obj.status === "string" ? obj.status : undefined,
        messagingSocketPath:
          typeof obj.messagingSocketPath === "string" ? obj.messagingSocketPath : undefined,
      });
    } catch {
      // A session mid-write leaves a truncated file; skipping it is correct.
    }
  }
  return entries;
}

// Git resolves its repository from these variables in preference to the
// working directory, and it exports them into hook environments. Preflight run
// from inside a hook would otherwise report the hook's repository (or a linked
// worktree's gitdir) rather than the one the coordinator is sitting in.
//
// Duplicated from the workspaces skill's `lib/git-env.ts` on purpose: skills are
// installed independently, so importing across skill directories would break
// this one when it ships alone.
const GIT_ENV_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
]);

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !GIT_ENV_KEYS.has(entry[0]),
    ),
  );
}

function sh(command: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync([command, ...args], { stderr: "pipe", env: cleanEnv() });
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() };
}

function which(binary: string): string | null {
  const result = sh("sh", ["-c", `command -v ${binary}`]);
  return result.ok && result.out ? result.out : null;
}

// pando is installed as a zsh function wrapping a cargo binary, so `command -v
// pando` fails inside a non-interactive subprocess. Resolve the binary directly
// or the coordinator will wrongly conclude pando is unavailable.
export function resolvePando(home: string): string | null {
  const cargo = join(home, ".cargo", "bin", "pando");
  if (Bun.file(cargo).size >= 0) {
    const probe = sh(cargo, ["--version"]);
    if (probe.ok) return cargo;
  }
  return which("pando");
}

if (import.meta.main) {
  const program = new Command()
    .name("preflight")
    .description("Resolve herd run context and verify the environment is ready")
    .requiredOption("--session-id <uuid>", "coordinator's own Claude Code session id")
    .option("--sessions-dir <dir>", "session registry directory")
    .parse();

  const opts = program.opts<{ sessionId: string; sessionsDir?: string }>();
  const home = homedir();
  const sessionsDir = opts.sessionsDir ?? join(home, ".claude", "sessions");
  const problems: string[] = [];

  if (process.env.HERDR_ENV !== "1") {
    problems.push("HERDR_ENV is not 1 — this skill only runs inside a herdr pane");
  }

  const paneList = sh("herdr", ["pane", "list"]);
  let pane: Pane | null = null;
  if (!paneList.ok) {
    problems.push("`herdr pane list` failed — the herdr server is not reachable");
  } else {
    try {
      const parsed = JSON.parse(paneList.out) as { result?: { panes?: Pane[] } };
      pane = paneForSession(parsed.result?.panes ?? [], opts.sessionId);
    } catch (error) {
      problems.push(`could not resolve this session's pane: ${(error as Error).message}`);
    }
  }

  const entries = readSessionRegistry(sessionsDir);
  let peerName: string | null = null;
  try {
    peerName = peerNameForSession(entries, opts.sessionId);
  } catch (error) {
    problems.push(`${(error as Error).message} — workers would have no address to report back to`);
  }

  const root = sh("git", ["rev-parse", "--show-toplevel"]);
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = sh("git", ["status", "--porcelain"]);
  if (!root.ok) problems.push("not inside a git repository");

  const pando = resolvePando(home);
  if (!pando) problems.push("pando not found — worktree creation is unavailable");

  const report = {
    ok: problems.length === 0,
    problems,
    herdr: pane
      ? { workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id }
      : null,
    coordinator: { sessionId: opts.sessionId, peerName },
    repo: root.ok ? { root: root.out, branch: branch.out, dirty: dirty.out.length > 0 } : null,
    tools: { pando, claude: which("claude"), pi: which("pi") },
    livePeers: entries.map((e) => ({ name: e.name, cwd: e.cwd, status: e.status ?? null })),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
