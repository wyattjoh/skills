#!/usr/bin/env bun
/**
 * beam-me-up: move a Claude Code session to another machine over SSH.
 *
 *   bun beam.ts inspect <session-id>
 *   bun beam.ts beam <session-id> <ssh-target> [--include <path>]... [--dry-run] [--force] [--allow-live] [--herdr]
 */

import { homedir } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type ExecResult, runProcess, runProcessOk, stdoutText } from "./exec.ts";
import {
  EXTRACT_SCRIPT,
  HERDR_SCRIPT,
  HOME_SCRIPT,
  PREPARE_SCRIPT,
  RECEIVE_SCRIPT,
  SEED_SCRIPT,
  Remote,
  STATE_SCRIPT,
  WRITE_MANIFEST_SCRIPT,
  type Shell,
  makeLocalShell,
} from "./remote.ts";
import {
  type SessionInfo,
  agentNameFor,
  diffSections,
  encodeProjectDir,
  formatManifest,
  hashSections,
  includeConflicts,
  inspectSession,
  mapToRemoteHome,
  parseManifest,
  parseSections,
  transcriptRelation,
} from "./session.ts";

/**
 * Raised when the move cannot proceed safely; the message says why and what to do.
 */
export class BeamError extends Schema.TaggedError<BeamError>()("BeamError", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new BeamError({ message }));

// ─── Herdr ───────────────────────────────────────────────────

const HerdrSession = Schema.NullOr(Schema.Struct({ value: Schema.String }));

const HerdrPanes = Schema.Struct({
  result: Schema.Struct({
    panes: Schema.Array(
      Schema.Struct({
        pane_id: Schema.String,
        workspace_id: Schema.String,
        cwd: Schema.optional(Schema.NullOr(Schema.String)),
        agent: Schema.optional(Schema.NullOr(Schema.String)),
        agent_session: Schema.optional(HerdrSession),
      }),
    ),
  }),
});

const HerdrWorkspaces = Schema.Struct({
  result: Schema.Struct({
    workspaces: Schema.Array(Schema.Struct({ workspace_id: Schema.String, label: Schema.String })),
  }),
});

const HerdrAgents = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  }),
});

const HerdrCreated = Schema.Struct({
  result: Schema.Struct({
    workspace: Schema.Struct({ workspace_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
  }),
});

type Herdr = (args: ReadonlyArray<string>) => Effect.Effect<ExecResult, BeamError>;

const herdrJson = <S extends Schema.Top>(herdr: Herdr, schema: S, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* herdr(args);
    if (result.exitCode !== 0) {
      return yield* fail(`herdr ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
      stdoutText(result),
    ).pipe(
      Effect.mapError(
        (error) => new BeamError({ message: `Unexpected herdr ${args[0]} output: ${error}` }),
      ),
    );
  });

const shellHerdr =
  (shell: Shell): Herdr =>
  (args) =>
    shell
      .run(HERDR_SCRIPT, args, { timeout: "2 minutes" })
      .pipe(Effect.mapError((error) => new BeamError({ message: error.message })));

/**
 * The local Herdr pane hosting this session and its workspace label, when this
 * process runs inside Herdr.
 */
const localHerdrPane = Effect.fn("localHerdrPane")(function* (sessionId: string) {
  if (process.env["HERDR_ENV"] !== "1") return undefined;
  const local = yield* makeLocalShell(undefined);
  const herdr = shellHerdr(local);
  const panes = yield* herdrJson(herdr, HerdrPanes, ["pane", "list"]);
  const pane = panes.result.panes.find((p) => p.agent_session?.value === sessionId);
  if (!pane) return undefined;
  const workspaces = yield* herdrJson(herdr, HerdrWorkspaces, ["workspace", "list"]);
  const label = workspaces.result.workspaces.find(
    (w) => w.workspace_id === pane.workspace_id,
  )?.label;
  return { paneId: pane.pane_id, label };
});

/**
 * Opens (or reuses) a workspace on the target at the worktree and resumes the
 * session there as a Herdr-recognized Claude agent.
 */
const herdrResume = Effect.fn("herdrResume")(function* (
  remote: Shell,
  label: string,
  worktree: string,
  sessionId: string,
) {
  const herdr = shellHerdr(remote);
  const panes = (yield* herdrJson(herdr, HerdrPanes, ["pane", "list"])).result.panes;
  const workspaces = (yield* herdrJson(herdr, HerdrWorkspaces, ["workspace", "list"])).result
    .workspaces;
  const inOurWorkspace = (p: (typeof panes)[number]) =>
    p.cwd === worktree &&
    workspaces.some((w) => w.workspace_id === p.workspace_id && w.label === label);
  // Claude reports its session ID only once past start-up prompts, so a Claude agent
  // in our workspace and worktree also counts as an earlier run's resume.
  const hosting = panes.find(
    (p) => p.agent_session?.value === sessionId || (p.agent === "claude" && inOurWorkspace(p)),
  );
  if (hosting) {
    return { workspaceId: hosting.workspace_id, paneId: hosting.pane_id, agent: "already-running" };
  }

  const free = panes.find((p) => !p.agent && inOurWorkspace(p));
  const target = free
    ? { workspaceId: free.workspace_id, paneId: free.pane_id }
    : yield* herdrJson(herdr, HerdrCreated, [
        "workspace",
        "create",
        "--cwd",
        worktree,
        "--label",
        label,
        "--no-focus",
      ]).pipe(
        Effect.map((created) => ({
          workspaceId: created.result.workspace.workspace_id,
          paneId: created.result.root_pane.pane_id,
        })),
      );

  const agents = (yield* herdrJson(herdr, HerdrAgents, ["agent", "list"])).result.agents;
  const name = agentNameFor(label, new Set(agents.flatMap((a) => (a.name ? [a.name] : []))));
  // 60s: claude start-up plus session load comfortably fits; Herdr's own default is 30s.
  const started = yield* herdr([
    "agent",
    "start",
    name,
    "--kind",
    "claude",
    "--pane",
    target.paneId,
    "--timeout",
    "60000",
    "--",
    "--resume",
    sessionId,
  ]);
  if (started.exitCode === 0) return { ...target, agent: name, status: "ready" };
  if (started.stderr.includes("agent_not_ready")) {
    const screen = yield* herdr([
      "agent",
      "read",
      name,
      "--source",
      "recent-unwrapped",
      "--lines",
      "40",
    ]);
    return { ...target, agent: name, status: "blocked", screen: stdoutText(screen) };
  }
  return yield* fail(`herdr agent start failed: ${started.stderr.trim()}`);
});

// ─── Planning ────────────────────────────────────────────────

/**
 * Options accepted by {@link beam}.
 */
export interface BeamOptions {
  readonly sessionId: string;
  readonly includes: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly allowLive: boolean;
  readonly herdr: boolean;
  readonly home: string;
}

const text = (sections: Map<string, Uint8Array | undefined>, name: string) => {
  const bytes = sections.get(name);
  return bytes && new TextDecoder().decode(bytes).trim();
};

const readState = Effect.fn("readState")(function* (shell: Shell, args: ReadonlyArray<string>) {
  const result = yield* shell.run(STATE_SCRIPT, args, { timeout: "5 minutes" });
  if (result.exitCode !== 0) {
    return yield* fail(`State check on ${shell.label} failed: ${result.stderr.trim()}`);
  }
  const sections = yield* Effect.try({
    try: () => parseSections(result.stdout),
    catch: (cause) => new BeamError({ message: `Unreadable state from ${shell.label}: ${cause}` }),
  });
  return { sections, hashes: hashSections(sections) };
});

const validateIncludes = Effect.fn("validateIncludes")(function* (
  info: SessionInfo,
  includes: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalized: Array<string> = [];
  for (const include of includes) {
    const rel = path.normalize(include).replace(/\/$/, "");
    if (path.isAbsolute(rel) || rel === "." || rel.startsWith("..")) {
      return yield* fail(`--include ${include} must be a path inside the worktree`);
    }
    const exists = yield* fs
      .exists(path.join(info.worktree, rel))
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return yield* fail(`--include ${include} does not exist in ${info.worktree}`);
    normalized.push(rel);
  }
  return normalized;
});

/**
 * A `tar` of `paths` under `dir`, streamed to the target's {@link EXTRACT_SCRIPT}.
 * `--no-xattrs` keeps macOS metadata out of archives a Linux tar would warn on.
 */
const sendTar = Effect.fn("sendTar")(function* (
  remote: Shell,
  dir: string,
  paths: ReadonlyArray<string>,
  destination: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const tar = yield* spawner.spawn(
        ChildProcess.make("tar", ["--no-xattrs", "-cf", "-", "-C", dir, ...paths], {
          env: { COPYFILE_DISABLE: "1" },
          extendEnv: true,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      const received = yield* remote.run(EXTRACT_SCRIPT, [destination], {
        stdin: tar.stdout,
        timeout: "10 minutes",
      });
      const tarExit = yield* tar.exitCode;
      if (tarExit !== 0) return yield* fail(`Local tar of ${paths.join(", ")} exited ${tarExit}`);
      if (received.exitCode !== 0) {
        return yield* fail(
          `Extracting into ${destination} on ${remote.label} failed: ${received.stderr.trim()}`,
        );
      }
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) => fail(`Could not run local tar: ${error.message}`)),
  );
});

/**
 * Creates the repository on a target that has no clone and nothing to clone
 * from, using a full bundle of every local branch.
 */
const sendSeed = Effect.fn("sendSeed")(function* (remote: Shell, info: SessionInfo, repo: string) {
  const fs = yield* FileSystem.FileSystem;
  const received = yield* Effect.scoped(
    Effect.gen(function* () {
      const bundle = yield* fs.makeTempFileScoped({ prefix: "beam-me-up-", suffix: ".bundle" });
      yield* runProcessOk("git", ["bundle", "create", "-q", bundle, "--branches"], {
        cwd: info.repo,
        timeout: "5 minutes",
      });
      return yield* remote.run(SEED_SCRIPT, [repo, info.repoBranch ?? ""], {
        stdin: fs.stream(bundle),
        timeout: "10 minutes",
      });
    }),
  );
  if (received.exitCode !== 0) {
    return yield* fail(
      `Creating ${repo} on ${remote.label} failed (exit ${received.exitCode}): ${received.stderr.trim()}`,
    );
  }
});

/**
 * Bundles the branch HEAD and a stash commit of uncommitted work, then has the
 * target fetch it and rebuild the worktree. Falls back to a full bundle once
 * when the target lacks the incremental bundle's base.
 */
const sendCode = Effect.fn("sendCode")(function* (
  remote: Shell,
  info: SessionInfo,
  target: { repo: string; worktree: string },
  hasBase: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const git = (...args: Array<string>) =>
    runProcessOk("git", args, { cwd: info.worktree, timeout: "5 minutes" });
  const stash = stdoutText(yield* git("stash", "create"));

  const send = (prerequisites: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* fs.makeTempFileScoped({ prefix: "beam-me-up-", suffix: ".bundle" });
        const refs = ["refs/beam-me-up/head", ...(stash ? ["refs/beam-me-up/stash"] : [])];
        yield* git("bundle", "create", "-q", bundle, ...refs, ...prerequisites);
        return yield* remote.run(
          RECEIVE_SCRIPT,
          [target.repo, target.worktree, info.branch, info.head, stash, info.upstream ?? ""],
          { stdin: fs.stream(bundle), timeout: "10 minutes" },
        );
      }),
    );

  const cleanup = Effect.all([
    runProcess("git", ["update-ref", "-d", "refs/beam-me-up/head"], { cwd: info.worktree }),
    runProcess("git", ["update-ref", "-d", "refs/beam-me-up/stash"], { cwd: info.worktree }),
  ]).pipe(Effect.ignore);

  yield* Effect.gen(function* () {
    yield* git("update-ref", "refs/beam-me-up/head", info.head);
    if (stash) yield* git("update-ref", "refs/beam-me-up/stash", stash);
    const incremental = hasBase && info.base ? [`^${info.base}`] : [];
    let received = yield* send(incremental);
    if (received.exitCode === 3 && incremental.length > 0) received = yield* send([]);
    if (received.exitCode !== 0) {
      return yield* fail(
        `Rebuilding ${target.worktree} on ${remote.label} failed (exit ${received.exitCode}): ${received.stderr.trim()}`,
      );
    }
  }).pipe(Effect.ensuring(cleanup));
  return stash ? "branch and uncommitted changes" : "branch";
});

/**
 * Moves a session to the {@link Remote} target: worktree, `--include` files and
 * transcript, then verifies both sides match and optionally resumes in Herdr.
 */
export const beam = Effect.fn("beam")(function* (options: BeamOptions) {
  const remote = yield* Remote;
  const path = yield* Path.Path;
  const local = yield* makeLocalShell(undefined);
  const { sessionId } = options;

  const info = yield* inspectSession(sessionId, options.home);
  const pane = yield* localHerdrPane(sessionId);
  if ((info.lockPidAlive || pane) && !options.allowLive) {
    const where = [
      info.lockPidAlive ? `pid ${info.lockPid}` : undefined,
      pane ? `Herdr pane ${pane.paneId}` : undefined,
    ].filter(Boolean);
    return yield* fail(
      `Session ${sessionId} looks live (${where.join(", ")}). Exit it first so the copy is complete, or pass --allow-live.`,
    );
  }
  const includes = yield* validateIncludes(info, options.includes);

  const tools = ["git", "tar", ...(options.herdr ? ["herdr", "claude"] : [])];
  const probe = yield* remote.run(HOME_SCRIPT, tools, { timeout: "30 seconds" });
  if (probe.exitCode !== 0) {
    return yield* fail(
      `Cannot reach ${remote.label} (exit ${probe.exitCode}): ${probe.stderr.trim()}. If SSH is refused on a Mac, turn on System Settings > General > Sharing > Remote Login.`,
    );
  }
  const [remoteHome = "", ...rest] = stdoutText(probe).split("\n");
  const missing = rest.filter((l) => l.startsWith("missing ")).map((l) => l.slice(8));
  if (missing.length > 0) {
    return yield* fail(
      `${remote.label} has no ${missing.join(", ")} on PATH for non-interactive SSH. Add its directory to PATH in the target's non-interactive shell startup (for zsh, ~/.zshenv).`,
    );
  }

  const toRemote = (p: string) => mapToRemoteHome(p, options.home, remoteHome);
  const mapped = {
    repo: toRemote(info.repo),
    worktree: toRemote(info.worktree),
    launchDir: toRemote(info.launchDir),
  };
  if (!mapped.repo || !mapped.worktree || !mapped.launchDir) {
    return yield* fail(`${info.worktree} is outside ${options.home}, so it has no remote mapping`);
  }
  const target = {
    repo: mapped.repo,
    worktree: mapped.worktree,
    launchDir: mapped.launchDir,
    projectsDir: path.join(remoteHome, ".claude", "projects", encodeProjectDir(mapped.launchDir)),
  };

  const stateArgs = (t: { worktree: string; repo: string; projectsDir: string }) => [
    t.worktree,
    t.repo,
    info.branch,
    info.base ?? "",
    t.projectsDir,
    sessionId,
    ...includes,
  ];
  const source = yield* readState(local, stateArgs(info));
  const before = yield* readState(remote, stateArgs(target));

  // Decide what the code needs.
  let code: "create" | "apply" | "in-sync";
  if (text(before.sections, "probe:wt_dir") === "1") {
    const head = text(before.sections, "code:head");
    const branch = text(before.sections, "code:branch");
    if (!head)
      return yield* fail(`${target.worktree} exists on ${remote.label} but is not a Git worktree`);
    if (head !== info.head || branch !== info.branch) {
      return yield* fail(
        `${target.worktree} on ${remote.label} is ${branch ?? "detached"} at ${head.slice(0, 12)}, not ${info.branch} at ${info.head.slice(0, 12)}. Move or remove it first.`,
      );
    }
    const headTree = text(before.sections, "probe:head_tree");
    const clean =
      text(before.sections, "code:worktree_tree") === headTree &&
      text(before.sections, "code:index_tree") === headTree;
    if (diffSections(source.hashes, before.hashes, ["code:"]).length === 0) code = "in-sync";
    else if (clean) code = "apply";
    else {
      return yield* fail(
        `${target.worktree} on ${remote.label} has different uncommitted changes. Commit, stash or discard them there first.`,
      );
    }
  } else {
    const branchSha = text(before.sections, "probe:branch_sha");
    if (branchSha && branchSha !== info.head) {
      return yield* fail(
        `Branch ${info.branch} already exists on ${remote.label} at ${branchSha.slice(0, 12)}, not ${info.head.slice(0, 12)}`,
      );
    }
    code = "create";
  }

  // Decide what the transcript needs.
  const transcriptKey = `session:${sessionId}.jsonl`;
  const sessionDiff = diffSections(source.hashes, before.hashes, ["session:"]);
  const sourceTranscript = source.sections.get(transcriptKey);
  if (!sourceTranscript) return yield* fail(`Could not read ${info.transcript.path}`);
  const transcript = transcriptRelation(sourceTranscript, before.sections.get(transcriptKey));
  if ((transcript === "ahead" || transcript === "diverged") && !options.force) {
    const why =
      transcript === "ahead"
        ? "has turns this machine does not (it was resumed there)"
        : "has diverged from this machine's copy";
    return yield* fail(
      `${remote.label}'s transcript for ${sessionId} ${why}. Pass --force to overwrite it and lose those turns.`,
    );
  }
  const session = sessionDiff.length === 0 ? "in-sync" : "copy";

  // Included files edited or created on the target since the last move would be clobbered.
  const conflicts = includeConflicts(
    source.hashes,
    before.hashes,
    parseManifest(text(before.sections, "probe:manifest")),
  );
  if (conflicts.length > 0 && !options.force) {
    return yield* fail(
      `These included files changed on ${remote.label} since the last move: ${conflicts.join(", ")}. Copy them back first, drop the --include, or pass --force to overwrite them.`,
    );
  }

  const repoAction =
    text(before.sections, "probe:repo") === "1" ? "present" : info.originUrl ? "clone" : "seed";
  if (repoAction === "seed" && !info.repoBranch) {
    return yield* fail(
      `${info.repo} has no origin to clone from and a detached main checkout, so there is no branch to seed ${remote.label} with`,
    );
  }

  const plan = {
    sessionId,
    target: remote.label,
    source: {
      worktree: info.worktree,
      branch: info.branch,
      head: info.head,
      projectsDir: info.projectsDir,
    },
    destination: target,
    actions: { repo: repoAction, code, includes, session, transcript, includeConflicts: conflicts },
  };
  if (options.dryRun) return { dryRun: true, ...plan };

  const prepared = yield* remote.run(
    PREPARE_SCRIPT,
    [target.repo, info.originUrl ?? "", info.base ?? "", target.projectsDir],
    { timeout: "10 minutes" },
  );
  if (prepared.exitCode !== 0) {
    return yield* fail(
      `Preparing ${target.repo} on ${remote.label} failed: ${prepared.stderr.trim()}`,
    );
  }
  const seeded = stdoutText(prepared).endsWith("needs-seed");
  if (seeded) yield* sendSeed(remote, info, target.repo);
  // A seed carries every local branch, so the base is there whenever one exists.
  const hasBase = seeded || stdoutText(prepared).endsWith("has-base");

  const codeMoved = code === "in-sync" ? "nothing" : yield* sendCode(remote, info, target, hasBase);
  if (includes.length > 0) yield* sendTar(remote, info.worktree, includes, target.worktree);
  if (session === "copy") {
    const entries = [`${sessionId}.jsonl`, ...(info.sidecar ? [sessionId] : [])];
    yield* sendTar(remote, info.projectsDir, entries, target.projectsDir);
  }

  const after = yield* readState(remote, stateArgs(target));
  const mismatches = diffSections(source.hashes, after.hashes, ["code:", "include:", "session:"]);
  if (mismatches.length > 0) {
    return yield* fail(
      `Verification failed on ${remote.label}; these differ from the source: ${mismatches.join(", ")}`,
    );
  }
  const verified = Object.keys(source.hashes).filter((n) => !n.startsWith("probe:")).length;

  const manifest = yield* remote.run(WRITE_MANIFEST_SCRIPT, [target.worktree], {
    stdin: Stream.make(new TextEncoder().encode(formatManifest(after.hashes))),
    timeout: "30 seconds",
  });
  if (manifest.exitCode !== 0) {
    return yield* fail(
      `Recording include checksums on ${remote.label} failed: ${manifest.stderr.trim()}`,
    );
  }

  const label = pane?.label ?? path.basename(info.worktree);
  const herdr = options.herdr
    ? yield* herdrResume(remote, label, target.worktree, sessionId)
    : undefined;

  return {
    ...plan,
    moved: { code: codeMoved, includes, session },
    verified: `${verified} items match`,
    herdr,
    resume: herdr
      ? undefined
      : `cd ${JSON.stringify(target.launchDir)} && claude --resume ${sessionId}`,
  };
});

// ─── CLI ─────────────────────────────────────────────────────

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const reportFailure = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Console.error(`beam-me-up: ${error.message}`).pipe(
        Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
  );

const sessionIdArgument = Argument.String("session-id").pipe(
  Argument.withDescription("Claude Code session ID (UUID)"),
);

const inspect = Command.make(
  "inspect",
  { sessionId: sessionIdArgument },
  Effect.fn(function* ({ sessionId }) {
    yield* reportFailure(
      Effect.gen(function* () {
        const info = yield* inspectSession(sessionId, homedir());
        const herdrPane = yield* localHerdrPane(sessionId);
        yield* printJson({ ...info, herdrPane });
      }),
    );
  }),
).pipe(Command.withDescription("Report where a session lives and what would move with it"));

const beamCommand = Command.make(
  "beam",
  {
    sessionId: sessionIdArgument,
    target: Argument.String("ssh-target").pipe(
      Argument.withDescription("SSH destination, such as user@host"),
    ),
    includes: Flag.String("include").pipe(
      Flag.withDescription("Untracked or ignored path in the worktree to copy (repeatable)"),
      Flag.atLeast(0),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the plan without changing anything"),
      Flag.withDefault(false),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Overwrite a different transcript already on the target"),
      Flag.withDefault(false),
    ),
    allowLive: Flag.Boolean("allow-live").pipe(
      Flag.withDescription("Copy even if the session still appears to be running"),
      Flag.withDefault(false),
    ),
    herdr: Flag.Boolean("herdr").pipe(
      Flag.withDescription("Open a matching Herdr workspace on the target and resume there"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ target, ...flags }) {
    yield* reportFailure(
      beam({ ...flags, home: homedir() }).pipe(
        Effect.flatMap(printJson),
        Effect.provide(Remote.ssh(target)),
      ),
    );
  }),
).pipe(Command.withDescription("Move a session, its worktree and transcript to an SSH target"));

const cli = Command.make("beam-me-up").pipe(
  Command.withDescription("Move a Claude Code session to another machine over SSH"),
  Command.withSubcommands([inspect, beamCommand]),
);

if (import.meta.main) {
  cli.pipe(
    Command.run({ version: "1.0.0" }),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain,
  );
}
