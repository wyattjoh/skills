import { Effect, Option, Schema } from "effect";
import type { ForgeKind } from "./config.ts";
import { Proc } from "./proc.ts";

/**
 * A repository on a forge, from its remote URL.
 */
export type RepoRef = { host: string; slug: string };

/**
 * The remote's host is neither configured nor recognized. Never guessed as GitHub.
 */
export class UnknownForge extends Schema.TaggedError<UnknownForge>()("UnknownForge", {
  host: Schema.String,
  message: Schema.String,
}) {}

/**
 * The forge CLI failed or printed something unreadable.
 */
export class ForgeError extends Schema.TaggedError<ForgeError>()("ForgeError", {
  repo: Schema.String,
  message: Schema.String,
}) {}

/**
 * A pull request normalized across GitHub and Forgejo.
 */
export type PullRequest = {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  /**
   * Head branch name; undefined for Forgejo AGit PRs, whose head is `refs/pull/<n>/head`.
   */
  headRef: string | undefined;
  headSha: string;
  base: string;
  checks: "pass" | "fail" | "pending" | "none" | "unknown";
  review: "approved" | "changes_requested" | "none";
};

/**
 * Parse a Git remote URL into host and `owner/name`.
 * @param url `git@host:o/n.git`, `ssh://user@host:port/o/n.git` or `https://host/o/n`.
 * @returns The repo, or undefined when the URL has no owner/name path.
 */
export const parseRemote = (url: string): RepoRef | undefined => {
  const trimmed = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(trimmed);
  const full = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  const match = trimmed.includes("://") ? full : scp;
  if (!match) return undefined;
  const [, host, path] = match;
  if (!host || !path || !/^[^/]+\/[^/]+$/.test(path)) return undefined;
  return { host: host.toLowerCase(), slug: path };
};

/**
 * Which CLI owns a host: the config, else a Forgejo host the `forgejo` CLI has credentials for.
 * @param host Remote host.
 * @param forges Configured host map.
 * @returns The forge kind.
 */
export const forgeKind = Effect.fn("forgeKind")(function* (
  host: string,
  forges: Readonly<Record<string, ForgeKind>>,
) {
  const configured = forges[host];
  if (configured) return configured;
  const proc = yield* Proc;
  const status = yield* proc
    .run(["forgejo", "--agent", "auth", "status", "--host", host], {
      timeoutMs: 20_000,
      env: { ...process.env } as Record<string, string>,
    })
    .pipe(Effect.option);
  if (
    Option.isSome(status) &&
    status.value.exitCode === 0 &&
    /"status":"success"/.test(status.value.stdout)
  )
    return "forgejo" satisfies ForgeKind;
  return yield* new UnknownForge({
    host,
    message: `no forge known for ${host}: add it to "forges" in the coordinator config ({"${host}": "github" | "forgejo"})`,
  });
});

const GhCheck = Schema.Struct({
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const GhPr = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optionalKey(Schema.NullOr(Schema.Array(GhCheck))),
});

const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

const ghChecks = (
  rollup: ReadonlyArray<typeof GhCheck.Type> | null | undefined,
): PullRequest["checks"] => {
  if (!rollup || rollup.length === 0) return "none";
  const results = rollup.map((check) => (check.conclusion || check.state || "").toUpperCase());
  if (results.some((result) => FAILED.has(result))) return "fail";
  if (
    rollup.some(
      (check) =>
        (check.status ?? "COMPLETED").toUpperCase() !== "COMPLETED" ||
        results.some((r) => r === "PENDING" || r === ""),
    )
  )
    return "pending";
  return "pass";
};

/**
 * Normalize `gh pr list --json` output.
 * @param text JSON text.
 * @returns Pull requests.
 */
export const parseGhPrs = (text: string): PullRequest[] =>
  Schema.decodeUnknownSync(Schema.Array(GhPr))(JSON.parse(text)).map((pr) => ({
    number: pr.number,
    url: pr.url,
    state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    base: pr.baseRefName,
    checks: ghChecks(pr.statusCheckRollup),
    review:
      pr.reviewDecision === "APPROVED"
        ? "approved"
        : pr.reviewDecision === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "none",
  }));

const FjPr = Schema.Struct({
  index: Schema.Number,
  web_url: Schema.String,
  state: Schema.String,
  merged: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  head: Schema.String,
  head_sha: Schema.String,
  base: Schema.String,
});

const FjEnvelope = Schema.Struct({
  status: Schema.String,
  result: Schema.NullOr(Schema.Struct({ items: Schema.Array(FjPr) })),
  error: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  ),
});

/**
 * Normalize `forgejo --agent pr list` output. Forgejo lists carry no check or review state.
 * @param text JSON envelope.
 * @returns Pull requests, or an error message from the envelope.
 */
export const parseForgejoPrs = (text: string): PullRequest[] | { error: string } => {
  const envelope = Schema.decodeUnknownSync(FjEnvelope)(JSON.parse(text));
  if (envelope.status !== "success" || envelope.result === null)
    return {
      error: envelope.error ? `${envelope.error.code}: ${envelope.error.message}` : envelope.status,
    };
  return envelope.result.items.map((pr) => ({
    number: pr.index,
    url: pr.web_url,
    state: pr.state === "open" ? "open" : pr.merged ? "merged" : "closed",
    headRef: pr.head.startsWith("refs/pull/") ? undefined : pr.head,
    headSha: pr.head_sha,
    base: pr.base,
    checks: "unknown",
    review: "none",
  }));
};

const FjStatuses = Schema.Struct({
  status: Schema.String,
  result: Schema.NullOr(
    Schema.Struct({ statuses: Schema.Array(Schema.Struct({ state: Schema.String })) }),
  ),
});

/**
 * Summarize `forgejo --agent pr checks` output.
 * @param text JSON envelope.
 * @returns The check summary.
 */
export const parseForgejoChecks = (text: string): PullRequest["checks"] => {
  const envelope = Schema.decodeUnknownSync(FjStatuses)(JSON.parse(text));
  if (envelope.status !== "success" || envelope.result === null) return "unknown";
  const states = envelope.result.statuses.map((status) => status.state);
  if (states.length === 0) return "none";
  if (states.some((state) => state === "failure" || state === "error")) return "fail";
  if (states.some((state) => state !== "success" && state !== "skipped")) return "pending";
  return "pass";
};

const ENV = (): Record<string, string> => ({ ...process.env }) as Record<string, string>;

/**
 * The user's pull requests in a repository, newest first.
 * @param repo Repository.
 * @param kind Forge kind.
 * @param withChecks Also fetch Forgejo check state for open PRs (one call each).
 * @returns Pull requests.
 */
export const listPullRequests = Effect.fn("listPullRequests")(function* (
  repo: RepoRef,
  kind: ForgeKind,
  withChecks = false,
) {
  const proc = yield* Proc;
  const label = `${repo.host}/${repo.slug}`;
  const fail = (message: string) => new ForgeError({ repo: label, message });
  const argv =
    kind === "github"
      ? [
          "gh",
          "pr",
          "list",
          "-R",
          label,
          "--author",
          "@me",
          "--state",
          "all",
          "--limit",
          "200",
          "--json",
          "number,url,state,headRefName,headRefOid,baseRefName,reviewDecision,statusCheckRollup",
        ]
      : [
          "forgejo",
          "--agent",
          "pr",
          "list",
          "--host",
          repo.host,
          "--repo",
          repo.slug,
          "--state",
          "all",
          "--limit",
          "50",
        ];
  const out = yield* proc
    .run(argv, { timeoutMs: 60_000, env: ENV() })
    .pipe(Effect.mapError((error) => fail(error.message)));
  if (kind === "github" && out.exitCode !== 0)
    return yield* fail((out.stderr || out.stdout).trim().slice(0, 300));
  const parsed = yield* Effect.try({
    try: () => (kind === "github" ? parseGhPrs(out.stdout) : parseForgejoPrs(out.stdout)),
    catch: (cause) => fail(`unreadable output: ${String(cause).slice(0, 200)}`),
  });
  if (!Array.isArray(parsed)) return yield* fail(parsed.error);
  if (kind !== "forgejo" || !withChecks) return parsed;
  return yield* Effect.forEach(parsed, (pr) =>
    pr.state !== "open"
      ? Effect.succeed(pr)
      : proc
          .run(
            [
              "forgejo",
              "--agent",
              "pr",
              "checks",
              String(pr.number),
              "--host",
              repo.host,
              "--repo",
              repo.slug,
            ],
            {
              timeoutMs: 30_000,
              env: ENV(),
            },
          )
          .pipe(
            Effect.map((checks) => ({ ...pr, checks: parseForgejoChecks(checks.stdout) })),
            Effect.catch(() => Effect.succeed(pr)),
          ),
  );
});

/**
 * The PRs that speak for a branch. Any PR whose head is the branch tip matches. Otherwise an open PR
 * matches by head name, and a closed or merged one by head name only when the branch holds nothing past
 * the PR's head, so a reused branch name does not inherit it.
 * @param prs The repo's pull requests.
 * @param branch Branch name.
 * @param tip The branch's tip commit.
 * @param tipWithin Whether the tip is an ancestor of (or equal to) a given commit.
 * @returns Matching pull requests.
 */
export const prsForBranch = <E, R>(
  prs: readonly PullRequest[],
  branch: string,
  tip: string,
  tipWithin: (sha: string) => Effect.Effect<boolean, E, R>,
): Effect.Effect<PullRequest[], E, R> =>
  Effect.filter(prs, (pr) => {
    const named = pr.headRef === branch;
    if (pr.headSha === tip) return Effect.succeed(true);
    if (pr.state === "open") return Effect.succeed(named);
    // An AGit PR (no head name) speaks for a branch only at its exact head: older branches are
    // ancestors of every later PR head, so ancestry would match them all.
    if (!named) return Effect.succeed(false);
    return tipWithin(pr.headSha);
  });

/**
 * One state for a set of PRs: open wins, then merged, then closed.
 * @param prs Matching PRs.
 * @returns The summary state and a label such as "#12 merged".
 */
export const prSummary = (
  prs: readonly PullRequest[],
): { state: PullRequest["state"] | undefined; label: string } => {
  if (prs.length === 0) return { state: undefined, label: "" };
  const states = new Set(prs.map((pr) => pr.state));
  const state = states.has("open") ? "open" : states.has("merged") ? "merged" : "closed";
  return { state, label: prs.map((pr) => `#${pr.number} ${pr.state}`).join(",") };
};
