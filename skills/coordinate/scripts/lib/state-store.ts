import { Effect, Option, Schema } from "effect";
import type { StateBackend } from "./config.ts";
import { Refused } from "./fleet.ts";

/**
 * One shared document, named by what it holds rather than where it lives. A backend maps each key
 * to its own location (a file path, a document name) and owns any naming limits that come with it.
 */
export type StateKey =
  | { kind: "backlog"; domain: string }
  | { kind: "policy" }
  | { kind: "queue"; domain: string }
  | { kind: "ended"; session: string }
  | { kind: "session"; session: string }
  | { kind: "lint"; domain: string };

/**
 * The kinds of document a backend can enumerate.
 */
export type ListedKind = "backlog" | "ended";

/**
 * Key constructors, so call sites never spell a key's shape by hand.
 */
export const keys = {
  backlog: (domain: string): StateKey => ({ kind: "backlog", domain }),
  policy: (): StateKey => ({ kind: "policy" }),
  queue: (domain: string): StateKey => ({ kind: "queue", domain }),
  ended: (session: string): StateKey => ({ kind: "ended", session }),
  session: (session: string): StateKey => ({ kind: "session", session }),
  lint: (domain: string): StateKey => ({ kind: "lint", domain }),
};

/**
 * An opaque version token. Only a version returned by `read` or `write` may be passed back to
 * `write`; callers never build or compare one.
 */
export type Version = string & { readonly __stateVersion: unique symbol };

/**
 * A document as read: its JSON value (null when it does not exist or was deleted) and its version.
 */
export type Stored = { value: unknown; version: Version };

/**
 * The document changed since the version the writer read (`write` refuses to overwrite it).
 */
export class StoreConflict extends Schema.TaggedError<StoreConflict>()("StoreConflict", {
  location: Schema.String,
}) {}

/**
 * A document could not be read (`stage: "read"`) or is not JSON (`stage: "parse"`). `message` is
 * the cause's message and `detail` its full text, so each caller can keep its own error wording.
 * `version` is the unreadable document's version when the backend knows it (a parse failure on
 * files), so a command that replaces the document whole can still overwrite it.
 */
export class StoreUnreadable extends Schema.TaggedError<StoreUnreadable>()("StoreUnreadable", {
  location: Schema.String,
  stage: Schema.Literals(["read", "parse"]),
  message: Schema.String,
  detail: Schema.String,
  version: Schema.NullOr(Schema.String),
}) {}

/**
 * A document or its lock could not be written (exit 2, not a refusal). The tag is the one the
 * backlog has always reported, so CLI output stays the same.
 */
export class BacklogError extends Schema.TaggedError<BacklogError>()("BacklogError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * The home that holds the shared documents cannot be reached (herdr-doc backend). Every read and
 * write refuses rather than act on a stale copy or queue a write; the CLI exits 2 naming the home.
 */
export class StoreOffline extends Schema.TaggedError<StoreOffline>()("StoreOffline", {
  home: Schema.String,
  message: Schema.String,
}) {}

/**
 * Whether a failure is an unreachable home.
 * @param error Any failure.
 * @returns True for `StoreOffline`.
 */
export const isOffline = (error: unknown): error is StoreOffline => error instanceof StoreOffline;

/**
 * Pass an expected read failure through as none, but never an unreachable home: a caller that
 * treats a missing or unreadable document as absent must still refuse when it cannot know.
 * @param effect A read.
 * @returns Its value as an option; `StoreOffline` still fails.
 */
export const optionUnlessOffline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, Extract<E, StoreOffline>, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      isOffline(error)
        ? Effect.fail(error as Extract<E, StoreOffline>)
        : Effect.succeed(Option.none<A>()),
    ),
  );

/**
 * A capacity claim is held by another live retry, or could not be taken.
 */
export class ClaimBusy extends Schema.TaggedError<ClaimBusy>()("ClaimBusy", {
  message: Schema.String,
}) {}

/**
 * Who holds a capacity claim: the host and pid of the retry that took it, and when the claim
 * lapses for readers on other hosts (undefined when the backend sets no expiry).
 */
export type ClaimOwner = { host: string; pid: number; expires: number | undefined };

const ownerIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Whether a capacity claim is still held, the one rule both backends' `claim` and `heldClaims`
 * use. On this host the owner's pid says whether its retry still runs. From another host only an
 * expiry can: the claim is held until it passes, and a claim with none is held only when
 * `foreignWithoutExpiry` says so (files: true, since its claims never expire; herdr-doc: false, so
 * a retry that died on another machine never blocks the slot for good).
 * @param owner The claim's owner.
 * @param here This host, the time now, and what a foreign claim without an expiry means.
 * @returns True while the claim is held.
 */
export const claimHeld = (
  owner: ClaimOwner,
  here: { host: string; now: number; foreignWithoutExpiry: boolean },
): boolean => {
  if (owner.host === here.host) return ownerIsLive(owner.pid);
  return owner.expires === undefined ? here.foreignWithoutExpiry : here.now < owner.expires;
};

/**
 * A held capacity claim, returned to `release`.
 */
export type StoreClaim = { readonly location: string; readonly token: string };

/**
 * Reads and writes available inside `exclusive`, where the backend already holds whatever it
 * needs for the keys it was given.
 */
export type StoreSession = {
  read: (key: StateKey) => Effect.Effect<Stored, StoreUnreadable | StoreOffline>;
  write: (
    key: StateKey,
    value: unknown,
    expected: Version,
  ) => Effect.Effect<Version, StoreConflict | BacklogError | StoreOffline>;
};

/**
 * Where coordinate keeps its shared documents: domain backlogs, the harness policy, capacity
 * queues and their claims, ended records, session state and the wiki lint clock. Archives and
 * per-machine watcher snapshots and pids are not documents and stay outside it.
 *
 * A backend with a home (herdr-doc) fails with `StoreOffline` when the home is unreachable.
 * Coordinator leases are fields of the backlog document written with `runCommand`.
 */
export type StateStore = {
  /**
   * Which backend this is.
   */
  readonly backend: StateBackend;
  /**
   * A human-readable location for messages: the file path, or the document's address.
   */
  location: (key: StateKey) => string;
  /**
   * Why this backend cannot hold a document at all (herdr-doc: its name would pass Herdr's
   * limit), or undefined. Commands that create a document refuse with it.
   */
  refusal: (key: StateKey) => string | undefined;
  /**
   * Read a document with its version.
   */
  read: (key: StateKey) => Effect.Effect<Stored, StoreUnreadable | StoreOffline>;
  /**
   * Read several documents at once (herdr-doc: one round trip). Each entry is what `read` would
   * give for that key, or its `StoreUnreadable`; an unreachable home fails the whole read.
   */
  readMany: (
    keys: readonly StateKey[],
  ) => Effect.Effect<Array<Stored | StoreUnreadable>, StoreOffline>;
  /**
   * Write a document only when its version is still `expected`; null deletes it. Fails with
   * `StoreConflict` when the document changed since that version.
   */
  write: (
    key: StateKey,
    value: unknown,
    expected: Version,
  ) => Effect.Effect<Version, StoreConflict | BacklogError | StoreOffline>;
  /**
   * The names of every present document of a kind (domains, or ended sessions), in the
   * backend's stable order.
   */
  list: (kind: ListedKind) => Effect.Effect<readonly string[], StoreUnreadable | StoreOffline>;
  /**
   * Append lines to a domain's archive of closed records. Archives are append-only files that
   * outgrow any document, so they stay files on the machine that holds the state (herdr-doc: the
   * home).
   */
  appendArchive: (
    domain: string,
    lines: readonly string[],
  ) => Effect.Effect<void, BacklogError | StoreOffline>;
  /**
   * Whether the archives are files on this machine (files: always; herdr-doc: on the home only).
   */
  archivesHere: Effect.Effect<boolean, StoreOffline>;
  /**
   * A domain's whole archive, or undefined when it has none (herdr-doc: read on the home).
   */
  readArchive: (domain: string) => Effect.Effect<string | undefined, BacklogError | StoreOffline>;
  /**
   * Call `onChange` whenever one of `keys` may have changed, without waiting for a poll, or give
   * undefined when this backend cannot (files; herdr-doc with the home on another machine, since
   * Herdr subscriptions reach only this core). Readers still poll; a notice only wakes them early.
   */
  follow?: (
    keys: readonly StateKey[],
    onChange: () => void,
  ) => Effect.Effect<{ close: () => void } | undefined>;
  /**
   * Run `use` with exclusive access to `keys` where the backend needs it (files: today's lock
   * directories, taken in name order; a version-checked backend runs it as is). Writes inside go
   * through the session `use` receives.
   */
  exclusive: <A, E, R>(
    keys: readonly StateKey[],
    use: (session: StoreSession) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | BacklogError, R>;
  /**
   * Claim one queued capacity slot for a retry, refusing while another live retry holds it.
   */
  claim: (domain: string, item: string) => Effect.Effect<StoreClaim, ClaimBusy | StoreOffline>;
  /**
   * Release a claim; one replaced or removed meanwhile is left to its new owner.
   */
  release: (claim: StoreClaim) => Effect.Effect<void>;
  /**
   * The locations of the capacity claims still held, by the same rule `claim` refuses on (files:
   * all but one whose owner died on this host; herdr-doc also lets an expired claim from another
   * host go). herdr-doc reads the claims of `domains`; files reads every claim, since a claim
   * file's name does not split back into its domain.
   */
  heldClaims: (domains: readonly string[]) => Effect.Effect<readonly string[], StoreOffline>;
};

/**
 * What a command decided about the document it read: write `next` (null deletes) and return
 * `value`, or leave the document untouched.
 */
export type CommandStep<A> = { write: true; next: unknown; value: A } | { write: false; value: A };

/**
 * How many times `runCommand` runs a command that keeps losing write races before refusing.
 */
export const COMMAND_ATTEMPTS = 3;

/**
 * Run a command against one document: read it with its version, apply the command, and write the
 * result only when the version is unchanged. A lost race re-runs the command on a fresh read, at
 * most `COMMAND_ATTEMPTS` times, then refuses (exit 1). The command may run more than once, so any
 * side effect it has must tolerate repetition.
 * @param store The store.
 * @param key The document the command changes.
 * @param command Given the current document, what to write and what to return.
 * @param options `also`: further keys the command needs exclusive access to (files: their locks).
 *   `replaceUnreadable`: give the command a document that is not JSON as null at its version, for a
 *   command that writes the document whole and would otherwise be stuck behind a corrupt file.
 * @returns The command's value.
 */
export const runCommand = <A, E, R>(
  store: StateStore,
  key: StateKey,
  command: (current: Stored) => Effect.Effect<CommandStep<A>, E, R>,
  options: { also?: readonly StateKey[]; replaceUnreadable?: boolean } = {},
): Effect.Effect<A, E | Refused | StoreUnreadable | BacklogError | StoreOffline, R> =>
  store.exclusive([key, ...(options.also ?? [])], (session) => {
    const read = options.replaceUnreadable
      ? session
          .read(key)
          .pipe(
            Effect.catchTag("StoreUnreadable", (error) =>
              error.stage === "parse" && error.version !== null
                ? Effect.succeed({ value: null, version: error.version as Version })
                : Effect.fail(error),
            ),
          )
      : session.read(key);
    const attempt = (
      left: number,
    ): Effect.Effect<A, E | Refused | StoreUnreadable | BacklogError | StoreOffline, R> =>
      Effect.gen(function* () {
        const current = yield* read;
        const step = yield* command(current);
        if (!step.write) return step.value;
        yield* session.write(key, step.next, current.version);
        return step.value;
      }).pipe(
        Effect.catchTag("StoreConflict", () =>
          left > 1
            ? attempt(left - 1)
            : Effect.fail(
                new Refused({
                  message: `${store.location(key)} kept changing: ${COMMAND_ATTEMPTS} attempts lost a write race; run the command again`,
                }),
              ),
        ),
      );
    return attempt(COMMAND_ATTEMPTS);
  });
