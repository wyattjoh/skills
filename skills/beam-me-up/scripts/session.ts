/**
 * Pure helpers and local inspection for a Claude Code session: where its
 * transcript lives, which worktree it ran in, and the Git state that has to
 * travel with it.
 */

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { runProcess, stdoutText } from "./exec.ts";

/**
 * Raised when the session or its worktree cannot be inspected.
 */
export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", {
  message: Schema.String,
}) {}

// ─── Pure helpers ────────────────────────────────────────────

/**
 * Encodes a directory the way Claude Code names its `~/.claude/projects/` folders:
 * every character that is not an ASCII letter or digit becomes `-`.
 */
export const encodeProjectDir = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Picks the directory a transcript is filed under out of every `cwd` it records:
 * the one that encodes to its `~/.claude/projects/` folder name. Neither first
 * nor shortest works, since a session can start in a repository and move into a
 * worktree (Claude Code then refiles it), or `cd` into subdirectories.
 */
export const launchDirFor = (
  cwds: ReadonlyArray<string>,
  projectFolder: string,
): string | undefined => cwds.find((cwd) => encodeProjectDir(cwd) === projectFolder);

/**
 * Extracts the PID from a Git worktree `locked` file written by Claude Code,
 * such as `claude session main (pid 24013 start ...)`.
 */
export const parseLockPid = (text: string): number | undefined => {
  const match = /\bpid (\d+)\b/.exec(text);
  if (!match?.[1]) return undefined;
  const pid = Number.parseInt(match[1], 10);
  return pid > 0 ? pid : undefined;
};

/**
 * Rewrites a path under the local home directory to the same path under the
 * remote home directory. Returns `undefined` for paths outside the local home.
 */
export const mapToRemoteHome = (
  path: string,
  localHome: string,
  remoteHome: string,
): string | undefined => {
  if (path === localHome) return remoteHome;
  if (!path.startsWith(`${localHome}/`)) return undefined;
  return `${remoteHome}${path.slice(localHome.length)}`;
};

/**
 * Herdr agent names must match this pattern and be unique among live agents.
 */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Turns a workspace label into a valid Herdr agent name that is not in `taken`,
 * appending `-2`, `-3`, ... when the base name is already live.
 */
export const agentNameFor = (label: string, taken: ReadonlySet<string>): string => {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  const base = slug || "session";
  const fit = (suffix: string) =>
    `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
  if (!taken.has(fit(""))) return fit("");
  for (let n = 2; ; n++) {
    const candidate = fit(`-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Hex-encoded sha256 of a byte array.
 */
export const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Parses the length-prefixed sections printed by the shared state script: each
 * section is `<name>\n<byte length>\n<bytes>\n`, and a length of `-1` marks a
 * section whose command failed (recorded as `undefined`).
 */
export const parseSections = (bytes: Uint8Array): Map<string, Uint8Array | undefined> => {
  const sections = new Map<string, Uint8Array | undefined>();
  const decoder = new TextDecoder();
  let offset = 0;
  const readLine = (): string => {
    const end = bytes.indexOf(10, offset);
    if (end === -1) throw new Error(`Truncated section header at byte ${offset}`);
    const line = decoder.decode(bytes.subarray(offset, end));
    offset = end + 1;
    return line;
  };
  while (offset < bytes.length) {
    const name = readLine();
    const length = Number.parseInt(readLine(), 10);
    if (Number.isNaN(length)) throw new Error(`Section "${name}" has no byte length`);
    if (length < 0) {
      sections.set(name, undefined);
      offset += 1;
      continue;
    }
    if (offset + length > bytes.length) throw new Error(`Section "${name}" is truncated`);
    sections.set(name, bytes.slice(offset, offset + length));
    offset += length + 1;
  }
  return sections;
};

/**
 * Hashes every section so two machines' states can be compared without
 * shipping the bytes around twice. Failed sections hash to `undefined`.
 */
export const hashSections = (
  sections: Map<string, Uint8Array | undefined>,
): Record<string, string | undefined> =>
  Object.fromEntries([...sections].map(([name, bytes]) => [name, bytes && sha256(bytes)]));

/**
 * Names every source section under `prefixes` whose hash differs on the target
 * (including ones the target lacks), sorted for stable output. Sections only the
 * target has are ignored: a move adds and replaces files, it never deletes them.
 */
export const diffSections = (
  source: Record<string, string | undefined>,
  target: Record<string, string | undefined>,
  prefixes: ReadonlyArray<string>,
): Array<string> =>
  Object.keys(source)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .filter((name) => source[name] !== target[name])
    .toSorted();

/**
 * Formats include checksums as the manifest stored on the target after a move:
 * one `<sha256> <path>` line per file.
 */
export const formatManifest = (hashes: Record<string, string | undefined>): string =>
  Object.entries(hashes)
    .filter(([name, hash]) => name.startsWith("include:") && hash)
    .map(([name, hash]) => `${hash} ${name.slice("include:".length)}\n`)
    .toSorted()
    .join("");

/**
 * Parses a manifest written by {@link formatManifest} into path → sha256.
 */
export const parseManifest = (text: string | undefined): Map<string, string> =>
  new Map(
    (text ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(65), line.slice(0, 64)] as const),
  );

/**
 * Lists include files on the target that a move would clobber or leave
 * inconsistent: ones edited or created there since the last move. A target file
 * is safe when it already matches the source, or still matches the checksum the
 * last move recorded in the manifest.
 */
export const includeConflicts = (
  source: Record<string, string | undefined>,
  target: Record<string, string | undefined>,
  manifest: ReadonlyMap<string, string>,
): Array<string> =>
  Object.keys(target)
    .filter((name) => name.startsWith("include:"))
    .filter((name) => {
      const hash = target[name];
      return hash !== source[name] && hash !== manifest.get(name.slice("include:".length));
    })
    .map((name) => name.slice("include:".length))
    .toSorted();

/**
 * How the target's transcript relates to the source's. Transcripts are
 * append-only, so a target copy that is a byte prefix of the source is an
 * earlier version (`behind`) and safe to replace; one the source is a prefix of
 * gained turns on the target (`ahead`); anything else has `diverged`.
 */
export type TranscriptRelation = "missing" | "same" | "behind" | "ahead" | "diverged";

const isPrefix = (prefix: Uint8Array, bytes: Uint8Array): boolean =>
  prefix.length <= bytes.length &&
  Buffer.from(bytes.buffer, bytes.byteOffset, prefix.length).equals(prefix);

/**
 * Classifies the target transcript against the source transcript.
 */
export const transcriptRelation = (
  source: Uint8Array,
  target: Uint8Array | undefined,
): TranscriptRelation => {
  if (target === undefined) return "missing";
  if (source.length === target.length) return isPrefix(target, source) ? "same" : "diverged";
  if (isPrefix(target, source)) return "behind";
  if (isPrefix(source, target)) return "ahead";
  return "diverged";
};

// ─── Transcript parsing ──────────────────────────────────────

const TranscriptLine = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.String),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptLine));

/**
 * Collects every `cwd` and `gitBranch` recorded in a JSONL transcript, skipping
 * lines that are not JSON objects.
 */
export const transcriptContext = (
  jsonl: string,
): { cwds: Array<string>; branches: Array<string> } => {
  const cwds: Array<string> = [];
  const branches: Array<string> = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    const decoded = decodeLine(line);
    if (Option.isNone(decoded)) continue;
    if (decoded.value.cwd) cwds.push(decoded.value.cwd);
    if (decoded.value.gitBranch) branches.push(decoded.value.gitBranch);
  }
  return { cwds, branches };
};

// ─── Local inspection ────────────────────────────────────────

const fail = (message: string) => Effect.fail(new SessionError({ message }));

/**
 * Everything known locally about a session before it moves.
 */
export interface SessionInfo {
  readonly sessionId: string;
  readonly home: string;
  readonly projectsDir: string;
  readonly transcript: { readonly path: string; readonly bytes: number };
  readonly sidecar: { readonly path: string; readonly bytes: number } | undefined;
  readonly launchDir: string;
  readonly worktree: string;
  readonly repo: string;
  /**
   * Branch checked out in the repository's main worktree; seeds a target that has no clone.
   */
  readonly repoBranch: string | undefined;
  readonly isLinkedWorktree: boolean;
  readonly branch: string;
  readonly head: string;
  readonly upstream: string | undefined;
  readonly originUrl: string | undefined;
  readonly base: string | undefined;
  readonly ahead: number | undefined;
  readonly behind: number | undefined;
  readonly dirty: { readonly staged: number; readonly unstaged: number };
  readonly untracked: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  readonly lockPid: number | undefined;
  readonly lockPidAlive: boolean;
}

/**
 * Runs a command in `cwd` and returns trimmed stdout, or `undefined` when it
 * exits non-zero.
 */
const tryCommand = Effect.fn("session.tryCommand")(function* (
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const result = yield* runProcess(cmd, args, { cwd, timeout: "30 seconds" });
  return result.exitCode === 0 ? stdoutText(result) : undefined;
});

const command = Effect.fn("session.command")(function* (
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const result = yield* runProcess(cmd, args, { cwd, timeout: "30 seconds" });
  if (result.exitCode !== 0) {
    return yield* new SessionError({
      message: `\`${cmd} ${args.join(" ")}\` failed in ${cwd}: ${result.stderr.trim()}`,
    });
  }
  return stdoutText(result);
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const directoryBytes = Effect.fn("session.directoryBytes")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs.stat(dir);
  if (info.type !== "Directory") return Number(info.size);
  const entries = yield* fs.readDirectory(dir, { recursive: true });
  let total = 0;
  for (const entry of entries) {
    const stat = yield* fs.stat(path.join(dir, entry));
    if (stat.type === "File") total += Number(stat.size);
  }
  return total;
});

/**
 * Finds a session's transcript under `~/.claude/projects/` and inspects the
 * worktree it ran in. Read-only.
 */
export const inspectSession = Effect.fn("session.inspect")(function* (
  sessionId: string,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mapFs = Effect.mapError((cause: unknown) => new SessionError({ message: String(cause) }));

  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return yield* fail(`"${sessionId}" is not a session ID (expected a UUID)`);
  }

  const projectsRoot = path.join(home, ".claude", "projects");
  const projects = yield* fs.readDirectory(projectsRoot).pipe(mapFs);
  let projectsDir: string | undefined;
  for (const project of projects) {
    // Entries such as .DS_Store are files, and checking a path beneath one errors.
    const candidate = path.join(projectsRoot, project, `${sessionId}.jsonl`);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      projectsDir = path.join(projectsRoot, project);
      break;
    }
  }
  if (!projectsDir) return yield* fail(`No transcript for ${sessionId} under ${projectsRoot}`);

  const transcriptPath = path.join(projectsDir, `${sessionId}.jsonl`);
  const jsonl = yield* fs.readFileString(transcriptPath).pipe(mapFs);
  const { cwds, branches } = transcriptContext(jsonl);
  const launchDir = launchDirFor(cwds, path.basename(projectsDir));
  if (!launchDir) {
    return yield* fail(
      `None of the directories ${transcriptPath} records (${[...new Set(cwds)].join(", ") || "none"}) encodes to its folder name`,
    );
  }
  if (!(yield* fs.exists(launchDir).pipe(mapFs))) {
    return yield* fail(`The session's directory ${launchDir} no longer exists`);
  }

  const sidecarPath = path.join(projectsDir, sessionId);
  const sidecar = (yield* fs.exists(sidecarPath).pipe(mapFs))
    ? { path: sidecarPath, bytes: yield* directoryBytes(sidecarPath).pipe(mapFs) }
    : undefined;

  const git = (...args: Array<string>) => command("git", args, launchDir);
  const tryGit = (...args: Array<string>) => tryCommand("git", args, launchDir);

  const worktree = yield* git("rev-parse", "--show-toplevel");
  const commonDir = path.resolve(launchDir, yield* git("rev-parse", "--git-common-dir"));
  const gitDir = path.resolve(launchDir, yield* git("rev-parse", "--git-dir"));
  const repo = path.dirname(commonDir);
  const branch = yield* tryGit("symbolic-ref", "--short", "HEAD");
  if (!branch) {
    return yield* fail(
      `${worktree} has a detached HEAD (transcript last saw ${branches.at(-1) ?? "no branch"}); check out a branch first`,
    );
  }
  const head = yield* git("rev-parse", "HEAD");
  const upstream = yield* tryGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const originUrl = yield* tryGit("remote", "get-url", "origin");
  const defaultRef = yield* tryGit("rev-parse", "--abbrev-ref", "origin/HEAD");
  const base = defaultRef ? yield* tryGit("merge-base", "HEAD", defaultRef) : undefined;
  const counts = upstream
    ? yield* tryGit("rev-list", "--left-right", "--count", `HEAD...${upstream}`)
    : undefined;
  const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [undefined, undefined];

  const porcelain = (yield* git("status", "--porcelain=v1", "-z", "--untracked-files=all"))
    .split("\0")
    .filter(Boolean);
  const untracked = porcelain.filter((l) => l.startsWith("?? ")).map((l) => l.slice(3));
  const tracked = porcelain.filter((l) => !l.startsWith("?? "));
  const dirty = {
    staged: tracked.filter((l) => l[0] !== " ").length,
    unstaged: tracked.filter((l) => l[1] !== " ").length,
  };

  // Run from the worktree root so paths are worktree-relative even when the
  // session launched in a subdirectory.
  const listed = (yield* command(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    worktree,
  ))
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/\/$/, ""));
  // A nested .gitignore can list entries inside an already-listed directory.
  const ignoredPaths = listed.filter((p) => !listed.some((q) => p.startsWith(`${q}/`)));
  const repoBranch = yield* tryCommand("git", ["symbolic-ref", "-q", "--short", "HEAD"], repo);
  const ignored: Array<{ path: string; bytes: number }> = [];
  for (const p of ignoredPaths) {
    ignored.push({ path: p, bytes: yield* directoryBytes(path.join(worktree, p)).pipe(mapFs) });
  }

  const lockText = yield* fs
    .readFileString(path.join(gitDir, "locked"))
    .pipe(Effect.orElseSucceed(() => ""));
  const lockPid = parseLockPid(lockText);

  return {
    sessionId,
    home,
    projectsDir,
    transcript: { path: transcriptPath, bytes: new TextEncoder().encode(jsonl).length },
    sidecar,
    launchDir,
    worktree,
    repo,
    repoBranch,
    isLinkedWorktree: gitDir !== commonDir,
    branch,
    head,
    upstream,
    originUrl,
    base,
    ahead,
    behind,
    dirty,
    untracked,
    ignored,
    lockPid,
    lockPidAlive: lockPid !== undefined && isAlive(lockPid),
  } satisfies SessionInfo;
});
