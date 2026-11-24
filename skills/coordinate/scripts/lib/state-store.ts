import { Effect, Schema } from "effect";
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
 */
export class StoreUnreadable extends Schema.TaggedError<StoreUnreadable>()("StoreUnreadable", {
  location: Schema.String,
  stage: Schema.Literals(["read", "parse"]),
  message: Schema.String,
  detail: Schema.String,
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
 * A capacity claim is held by another live retry, or could not be taken.
 */
export class ClaimBusy extends Schema.TaggedError<ClaimBusy>()("ClaimBusy", {
  message: Schema.String,
}) {}

/**
 * A held capacity claim, returned to `release`.
 */
export type StoreClaim = { readonly location: string; readonly token: string };

/**
 * Reads and writes available inside `exclusive`, where the backend already holds whatever it
 * needs for the keys it was given.
 */
export type StoreSession = {
  read: (key: StateKey) => Effect.Effect<Stored, StoreUnreadable>;
  write: (
    key: StateKey,
    value: unknown,
    expected: Version,
  ) => Effect.Effect<Version, StoreConflict | BacklogError>;
};

/**
 * Where coordinate keeps its shared documents: domain backlogs, the harness policy, capacity
 * queues and their claims, ended records, session state and the wiki lint clock. Archives and
 * per-machine watcher snapshots and pids are not documents and stay outside it.
 *
 * Extension points for later backends: offline refusal (an unreachable home) joins the error
 * channels of `read`, `write` and `list`; coordinator leases are fields of the backlog document
 * written with `runCommand`.
 */
export type StateStore = {
  /**
   * Which backend this is.
   */
  readonly backend: "files";
  /**
   * A human-readable location for messages: the file path, or the document's address.
   */
  location: (key: StateKey) => string;
  /**
   * Read a document with its version.
   */
  read: (key: StateKey) => Effect.Effect<Stored, StoreUnreadable>;
  /**
   * Write a document only when its version is still `expected`; null deletes it. Fails with
   * `StoreConflict` when the document changed since that version.
   */
  write: (
    key: StateKey,
    value: unknown,
    expected: Version,
  ) => Effect.Effect<Version, StoreConflict | BacklogError>;
  /**
   * The names of every present document of a kind (domains, or ended sessions), in the
   * backend's stable order.
   */
  list: (kind: ListedKind) => Effect.Effect<readonly string[], StoreUnreadable>;
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
  claim: (domain: string, item: string) => Effect.Effect<StoreClaim, ClaimBusy>;
  /**
   * Release a claim; one replaced or removed meanwhile is left to its new owner.
   */
  release: (claim: StoreClaim) => Effect.Effect<void>;
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
 * @param also Further keys the command needs exclusive access to (files: their locks).
 * @returns The command's value.
 */
export const runCommand = <A, E, R>(
  store: StateStore,
  key: StateKey,
  command: (current: Stored) => Effect.Effect<CommandStep<A>, E, R>,
  also: readonly StateKey[] = [],
): Effect.Effect<A, E | Refused | StoreUnreadable | BacklogError, R> =>
  store.exclusive([key, ...also], (session) => {
    const attempt = (
      left: number,
    ): Effect.Effect<A, E | Refused | StoreUnreadable | BacklogError, R> =>
      Effect.gen(function* () {
        const current = yield* session.read(key);
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
