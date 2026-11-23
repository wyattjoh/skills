import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { readDocument } from "./backlog-doc.ts";
import type { Config } from "./config.ts";
import { canonicalMachine, localMachine, remoteMachineOf } from "./delegate-capacity.ts";
import { findTerminal, L, readEnded, Refused } from "./fleet.ts";
import { cleanGitEnv, shellWord as word, UNSET_GIT } from "./git-env.ts";
import { excludeScratch, git, mainCheckout } from "./git.ts";
import * as hc from "./herdr.ts";
import { Proc } from "./proc.ts";

// Pulling a remote delegate's files and branch to this Mac. Remotes never reach the Mac, and Herdr
// reads text only, so each artifact is built on the remote in a temporary folder, base64 encoded
// there in fixed-width lines, read back in line chunks (under hc's 8 MB read cap), checked against
// its sha256, and decoded here. Besides git, the remote needs only tar, gzip, base64, fold, mktemp
// and sha256sum or shasum, which Linux and macOS both ship.

// Base64 lines of 76 characters plus a newline: 80 000 of them stay well under 8 MB.
const CHUNK_LINES = 80_000;

const ioError = (command: string) => (cause: unknown) =>
  new hc.HerdrError({ command, kind: "io", message: String(cause) });

/**
 * Run a script on a machine that writes one artifact to `"$artifact"` (inside a fresh temporary
 * folder), then read that artifact to this Mac byte for byte. The script's own output lines come
 * back too; when it writes no artifact, only they do. The temporary folder is removed either way.
 * @param machine Herdr machine name.
 * @param script Shell script; `$artifact` names the file to write.
 * @param timeoutS Remote timeout for the script, in seconds.
 * @returns The script's lines, and the artifact's bytes when it wrote one.
 */
const pullArtifact = Effect.fn("pullArtifact")(function* (
  machine: string,
  script: string,
  timeoutS: number,
) {
  const out = yield* hc.execOn(
    machine,
    [
      UNSET_GIT,
      "tmp=$(mktemp -d) || exit 3",
      'artifact="$tmp/artifact"',
      'echo "tmp $tmp"',
      `( ${script}
) || { rm -rf "$tmp"; exit 4; }`,
      'if [ -f "$artifact" ]; then',
      '  base64 < "$artifact" | fold -w 76 > "$tmp/artifact.b64"',
      '  echo "lines $(wc -l < "$tmp/artifact.b64" | tr -d " ")"',
      '  echo "sha $({ sha256sum "$artifact" 2>/dev/null || shasum -a 256 "$artifact"; } | cut -d " " -f 1)"',
      'else rm -rf "$tmp"; fi',
    ].join("\n"),
    timeoutS,
  );
  const lines = out.split("\n");
  const value = (key: string) =>
    lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
  const tmp = value("tmp") ?? "";
  const count = Number(value("lines"));
  const sha = value("sha");
  if (sha === undefined || !Number.isSafeInteger(count)) return { lines, bytes: undefined };
  const read = Effect.gen(function* () {
    const parts: string[] = [];
    for (let offset = 1; offset <= count; offset += CHUNK_LINES)
      parts.push(
        yield* hc.herdr(
          [
            "hc",
            "file",
            "read",
            "--on",
            machine,
            `${tmp}/artifact.b64`,
            "--offset",
            String(offset),
            "--limit",
            String(CHUNK_LINES),
          ],
          120_000,
        ),
      );
    const bytes = Buffer.from(parts.join("").replace(/\s+/gu, ""), "base64");
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha)
      return yield* new hc.HerdrError({
        command: "hc file read",
        kind: "io",
        message: `the copy read from ${machine} does not match its sha256 there (${sha}, read ${got})`,
      });
    return bytes;
  });
  const bytes = yield* read.pipe(
    Effect.ensuring(hc.execOn(machine, `rm -rf ${word(tmp)}`, 30).pipe(Effect.ignore)),
  );
  return { lines, bytes };
});

/**
 * Where a remote worktree's repo lives on this Mac: the owned Boundary path whose checkout on that
 * machine holds the worktree, resolved to its main checkout.
 * @param config Coordinate config.
 * @param domain The delegate's domain.
 * @param machine Herdr machine name.
 * @param worktree The worktree path on that machine.
 * @returns The repo's main checkout on this Mac.
 */
const localRepoOf = Effect.fn("localRepoOf")(function* (
  config: Config,
  domain: string,
  machine: string,
  worktree: string,
) {
  const { backlog } = yield* readDocument(config, domain);
  const owned = Object.entries(backlog.boundary.checkouts ?? {}).find(([, byMachine]) => {
    const checkout = byMachine[machine];
    return checkout !== undefined && (worktree === checkout || worktree.startsWith(`${checkout}/`));
  })?.[0];
  if (owned === undefined)
    return yield* new Refused({
      message: `${worktree} on ${machine} is in no checkout the ${domain} Boundary records; record one with coordinate backlog boundary add <repo> --machine ${machine} --checkout <path>`,
    });
  return (yield* mainCheckout(owned).pipe(Effect.catch(() => Effect.succeed(undefined)))) ?? owned;
});

/**
 * A delegate that runs (or ran) on another machine, as fetch and copy-back need it.
 */
type RemoteDelegate = {
  name: string;
  domain: string;
  machine: string;
  worktree: string;
  branch: string | undefined;
  base: string | undefined;
};

/**
 * A remote delegate as its terminal's labels describe it.
 * @param terminal The delegate's terminal (`machine/tN`).
 * @param machine Its Herdr machine.
 * @param domain Its domain.
 * @returns The delegate.
 */
const remoteDelegateOf = (
  terminal: hc.Terminal,
  machine: string,
  domain: string,
): RemoteDelegate => ({
  name: terminal.name ?? terminal.address,
  domain,
  machine,
  worktree: terminal.labels[L.worktree] ?? terminal.cwd,
  branch: terminal.labels[L.branch],
  base: terminal.labels[L.base],
});

/**
 * Copy a remote delegate's `.scratch` folder into its repo's parked folder on this Mac,
 * `<repo>/.scratch/parked/<name>/.scratch/`, refreshing what an earlier copy left.
 * @param repo The repo's main checkout on this Mac.
 * @param delegate The remote delegate.
 * @returns Lines to print.
 */
export const copyScratch = Effect.fn("copyScratch")(function* (
  repo: string,
  delegate: Pick<RemoteDelegate, "name" | "machine" | "worktree">,
) {
  const pulled = yield* pullArtifact(
    delegate.machine,
    [
      `cd ${word(delegate.worktree)} || { echo gone; exit 0; }`,
      'if [ -d .scratch ]; then tar -czf "$artifact" .scratch; else echo empty; fi',
    ].join("\n"),
    120,
  );
  if (pulled.lines.includes("gone"))
    return [`no .scratch copied: ${delegate.worktree} is gone on ${delegate.machine}`];
  if (pulled.bytes === undefined)
    return [`no .scratch copied: ${delegate.worktree} on ${delegate.machine} has none`];
  yield* excludeScratch(repo).pipe(Effect.ignore);
  const destination = join(repo, ".scratch", "parked", delegate.name);
  const archive = join(repo, ".scratch", "parked", `.${delegate.name}.tgz`);
  const bytes = pulled.bytes;
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(destination, { recursive: true });
      await writeFile(archive, bytes);
    },
    catch: ioError("copy-back"),
  });
  const proc = yield* Proc;
  const untar = yield* proc
    .run(["tar", "-xzf", archive, "-C", destination], {
      cwd: undefined,
      env: cleanGitEnv(process.env),
      timeoutMs: 60_000,
      stdin: undefined,
    })
    .pipe(Effect.ensuring(Effect.promise(() => rm(archive, { force: true }))));
  if (untar.exitCode !== 0)
    return yield* new hc.HerdrError({
      command: "tar",
      kind: "io",
      message: untar.stderr.trim().slice(0, 300),
    });
  yield* Effect.tryPromise({
    try: () => writeFile(join(destination, ".parked-at"), `${new Date().toISOString()}\n`),
    catch: ioError("copy-back"),
  });
  return [`copied .scratch of ${delegate.name} from ${delegate.machine} to ${destination}`];
});

/**
 * At settle: copy a remote delegate's `.scratch` (its REPORT.md and the rest) into its repo's
 * parked folder on this Mac, so the evidence outlives the remote worktree.
 * @param config Coordinate config.
 * @param domain The watcher's domain.
 * @param terminal The settled terminal (`machine/tN`).
 * @returns Lines describing the copy.
 */
export const copyBackSettled = Effect.fn("copyBackSettled")(function* (
  config: Config,
  domain: string,
  terminal: hc.Terminal,
) {
  const machine = remoteMachineOf(terminal.address) ?? "";
  const delegate = remoteDelegateOf(terminal, machine, domain);
  const repo = yield* localRepoOf(config, domain, machine, delegate.worktree);
  return yield* copyScratch(repo, delegate);
});

/**
 * Find a delegate on another machine by name (or `machine/tN` address): a live terminal first,
 * else its latest ended record.
 * @param config Coordinate config.
 * @param target Name or address.
 * @param only When set, the delegate must belong to this domain.
 * @returns The delegate.
 */
const remoteDelegate = Effect.fn("remoteDelegate")(function* (
  config: Config,
  target: string,
  only: string | undefined,
) {
  const core = yield* localMachine();
  const found = yield* findTerminal(target);
  const terminal = found?.live === true ? found : undefined;
  if (terminal !== undefined) {
    const machine = remoteMachineOf(terminal.address);
    const domain = terminal.labels[L.domain];
    if (machine === undefined)
      return yield* new Refused({
        message: `${target} runs on this machine; its branch is already in its repo here`,
      });
    if (domain === undefined || terminal.labels[L.role] === "coordinator")
      return yield* new Refused({ message: `${target} is not a delegate` });
    if (only !== undefined && domain !== only)
      return yield* new Refused({ message: `${target} is a delegate of ${domain}, not ${only}` });
    return remoteDelegateOf(terminal, machine, domain);
  }
  const ended = (yield* readEnded(config.stateDir)).records
    .filter(
      (entry) =>
        entry.record.name === target && (only === undefined || entry.record.domain === only),
    )
    .toSorted((a, b) => b.record.ended_at.localeCompare(a.record.ended_at))[0]?.record;
  if (ended === undefined)
    return yield* new Refused({
      message: `no delegate ${target}: no live terminal or ended record has that name`,
    });
  const machine = ended.machine ? canonicalMachine(ended.machine, core) : core;
  if (machine === core)
    return yield* new Refused({
      message: `${target} ran on this machine; its branch is already in its repo here`,
    });
  return {
    name: ended.name,
    domain: ended.domain,
    machine,
    worktree: ended.cwd,
    branch: ended.branch ?? undefined,
    base: ended.base_sha ?? undefined,
  } satisfies RemoteDelegate;
});

/**
 * Fetch a remote delegate's branch into its repo on this Mac under the same name: git on the
 * remote writes a bundle of the branch past its base, Herdr reads it here, and git fetches the
 * branch from it (fast-forward only). Also refreshes the parked copy of its `.scratch`. Never
 * pushes or calls a forge.
 * @param config Coordinate config.
 * @param target Delegate name or `machine/tN` address, live or ended.
 * @param domain When set, the delegate must belong to this domain.
 * @returns Lines to print.
 */
export const fetchRemoteBranch = Effect.fn("fetchRemoteBranch")(function* (
  config: Config,
  target: string,
  domain: string | undefined,
) {
  const delegate = yield* remoteDelegate(config, target, domain);
  const { branch, base } = delegate;
  if (branch === undefined || base === undefined)
    return yield* new Refused({
      message: `${delegate.name} records no branch and base, so it has no branch to fetch`,
    });
  const repo = yield* localRepoOf(config, delegate.domain, delegate.machine, delegate.worktree);
  const short = base.slice(0, 7);
  const hasBase = yield* git(repo, ["cat-file", "-e", `${base}^{commit}`]);
  if (hasBase.exitCode !== 0)
    return yield* new Refused({
      message: `${repo} lacks ${branch}'s base ${short}; bring it up to date with ${delegate.machine}'s checkout first`,
    });
  const copied = yield* copyScratch(repo, delegate);
  const ref = `refs/heads/${branch}`;
  const pulled = yield* pullArtifact(
    delegate.machine,
    [
      `cd ${word(delegate.worktree)} || { echo gone; exit 0; }`,
      `git rev-parse --verify --quiet ${word(ref)} >/dev/null || { echo no-branch; exit 0; }`,
      `count=$(git rev-list --count ${word(`${base}..${ref}`)}) || exit 5`,
      'echo "count $count"',
      `echo "tip $(git rev-parse ${word(ref)})"`,
      `if [ "$count" -gt 0 ]; then git bundle create -q "$artifact" ${word(ref)} ${word(`^${base}`)} >&2 || exit 6; fi`,
    ].join("\n"),
    300,
  );
  const value = (key: string) =>
    pulled.lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
  if (pulled.lines.includes("gone"))
    return yield* new Refused({
      message: `${delegate.worktree} is gone on ${delegate.machine}, so ${branch} cannot be fetched from it`,
    });
  if (pulled.lines.includes("no-branch"))
    return yield* new Refused({
      message: `${delegate.worktree} on ${delegate.machine} has no branch ${branch}`,
    });
  const count = Number(value("count") ?? "0");
  const tip = value("tip") ?? "";
  if (pulled.bytes === undefined || count === 0)
    return yield* new Refused({
      message: `${branch} has no commits past ${short} on ${delegate.machine}; nothing to fetch`,
    });
  const bundle = join(repo, ".scratch", "bundles", `${delegate.name}.bundle`);
  const bytes = pulled.bytes;
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(join(repo, ".scratch", "bundles"), { recursive: true });
      await writeFile(bundle, bytes);
    },
    catch: ioError("fetch"),
  });
  const fetched = yield* git(repo, ["fetch", "-q", bundle, `${ref}:${ref}`]);
  if (fetched.exitCode !== 0)
    return yield* new Refused({
      message: `git fetch of ${branch} from ${bundle} failed: ${(fetched.stderr || fetched.stdout).trim()}`,
    });
  return [
    ...copied,
    `fetched ${branch} from ${delegate.name} on ${delegate.machine} into ${repo}: ${count} commit${count === 1 ? "" : "s"} past ${short}, tip ${tip.slice(0, 7)}`,
    "land it as a local branch; nothing was pushed",
  ];
});
