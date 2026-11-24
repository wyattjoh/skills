import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { Effect, Option, Schema } from "effect";
import { type Harness, harnessOf } from "./harness.ts";
import { OUTSIDE_TERMINAL_STATUSES, type ItemStatus } from "./backlog-store/schema.ts";
import * as hc from "./herdr.ts";
import { stateStore } from "./state.ts";
import { keys, runCommand } from "./state-store.ts";

/**
 * Labels this skill reads and writes on herdr-core terminals.
 */
export const L = {
  role: "fleet.role",
  domain: "fleet.domain",
  task: "fleet.task",
  session: "fleet.session",
  harness: "fleet.harness",
  model: "fleet.model",
  effort: "fleet.effort",
  worktree: "fleet.worktree",
  branch: "fleet.branch",
  base: "fleet.base",
  space: "fleet.space",
  queue: "fleet.queue",
  machine: "fleet.machine",
} as const;

/**
 * A refusal the agent should act on (exit 1), as opposed to a failed check (exit 2).
 */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

/**
 * Refuse a name that cannot be a domain: it names files under the state folder and Herdr labels.
 * @param domain Candidate name.
 */
export const checkDomainName = Effect.fn("checkDomainName")(function* (domain: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(domain))
    return yield* new Refused({
      message: `${domain} is not a domain name: lowercase letters, digits, . _ -`,
    });
});

/**
 * Fit a domain into a terminal name: `.` becomes `-`, and a domain longer than `room` keeps its
 * first `keep` characters and a hash of the whole, so every name `checkDomainName` accepts fits.
 * @param domain Domain.
 * @param room The most characters the name has for the domain.
 * @param keep Characters kept before the hash when the domain does not fit; at most `room - 9`.
 * @returns The domain part of the terminal name.
 */
export const domainNamePart = (domain: string, room: number, keep: number): string => {
  const safe = domain.replaceAll(".", "-");
  if (safe.length <= room) return safe;
  const hash = createHash("sha256").update(domain).digest("hex").slice(0, 8);
  return `${safe.slice(0, keep)}-${hash}`;
};

/**
 * One delegate: a live agent terminal the domain owns.
 */
export type Delegate = {
  address: string;
  name: string;
  status: string | undefined;
  statusMs: number | undefined;
  cwd: string;
  session: string;
  harness: Harness | undefined;
  task: string;
  labels: Record<string, string>;
  /**
   * True when the terminal carries the domain label; false when only an item's delegate ref names its session.
   */
  byLabel: boolean;
};

/**
 * The session id a terminal runs: its label, else the `--session-id`/`--resume` argument.
 * @param terminal Terminal from `hc get`.
 * @returns Session id, or "".
 */
export const sessionOf = (terminal: hc.Terminal): string => {
  const labelled = terminal.labels[L.session];
  if (labelled) return labelled;
  for (const flag of ["--session-id", "--resume"]) {
    const index = terminal.argv.indexOf(flag);
    if (index !== -1 && terminal.argv[index + 1]) return terminal.argv[index + 1] ?? "";
  }
  return "";
};

const toDelegate = (terminal: hc.Terminal, byLabel: boolean): Delegate => ({
  address: terminal.address,
  name: terminal.name ?? terminal.address,
  status: terminal.status,
  statusMs: terminal.statusMs,
  cwd: terminal.cwd,
  session: sessionOf(terminal),
  harness: harnessOf(terminal.labels[L.harness] ?? terminal.app),
  task: terminal.labels[L.task] ?? terminal.name ?? terminal.address,
  labels: terminal.labels,
  byLabel,
});

/**
 * The live coordinators of a domain.
 * @param domain Domain.
 * @returns Listed terminals.
 */
export const coordinators = Effect.fn("coordinators")(function* (domain: string) {
  return yield* hc.list([`${L.role}=coordinator`, `${L.domain}=${domain}`]);
});

/**
 * The coordinator's own terminal and its domain, from `HC_TERMINAL_ID`.
 * @param env Environment.
 * @returns Terminal and domain.
 */
export const ownCoordinator = Effect.fn("ownCoordinator")(function* (
  env: Record<string, string | undefined> = process.env,
) {
  const address = env.HC_TERMINAL_ID;
  if (!address)
    return yield* new Refused({
      message: "HC_TERMINAL_ID is unset: run this inside a Herdr terminal",
    });
  const terminal = yield* hc.get(address);
  const domain = terminal?.labels[L.role] === "coordinator" ? terminal.labels[L.domain] : undefined;
  if (!terminal || !domain)
    return yield* new Refused({
      message: `terminal ${address} is not labelled as a coordinator; run \`coordinate start <domain>\` first, or pass --domain`,
    });
  return { terminal, domain };
});

/**
 * The caller's role could not be checked (exit 2), as opposed to a caller found to be no coordinator.
 */
export class Unchecked extends Schema.TaggedError<Unchecked>()("Unchecked", {
  message: Schema.String,
}) {}

/**
 * Who runs the command: the domain's coordinator, or any other terminal (a delegate, or one herdr-core
 * does not know).
 */
export type Caller =
  | { kind: "coordinator"; address: string; terminal: hc.Terminal; domain: string }
  | { kind: "other"; address: string; terminal: hc.Terminal | undefined };

/**
 * The calling terminal's role, from `HC_TERMINAL_ID`. Fails closed: with no terminal id, or when
 * `hc get` fails other than `not_found`, the role is unknown and the check fails rather than
 * reading the caller as a delegate.
 * @param env Environment.
 * @returns The caller.
 */
export const callerRole = Effect.fn("callerRole")(function* (
  env: Record<string, string | undefined> = process.env,
) {
  const address = env.HC_TERMINAL_ID;
  if (!address)
    return yield* new Unchecked({
      message:
        "HC_TERMINAL_ID is unset, so this terminal's role cannot be checked: run this inside a Herdr terminal",
    });
  const terminal = yield* hc.get(address);
  const domain = terminal?.labels[L.role] === "coordinator" ? terminal.labels[L.domain] : undefined;
  return terminal && domain
    ? ({ kind: "coordinator", address, terminal, domain } satisfies Caller)
    : ({ kind: "other", address, terminal } satisfies Caller);
});

/**
 * The domain for a backlog mutation, which only a coordinator may run: `--domain` when given (a
 * coordinator routes an item into another domain's backlog that way), else the caller's own domain.
 * Any other terminal is refused.
 * @param flag `--domain` value.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Domain.
 */
export const coordinatorDomain = Effect.fn("coordinatorDomain")(function* (
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  const caller = yield* callerRole(env);
  if (caller.kind === "other")
    return yield* new Refused({
      message: `only a coordinator changes the backlog, and terminal ${caller.address} is not labelled as one; a delegate records what it notices with coordinate finding add`,
    });
  return flag ?? caller.domain;
});

/**
 * The domain for recording an answer, closing an item or finding, changing only an item's status,
 * or editing a Boundary. A coordinator does each as it changes anything else. A caller outside
 * every Herdr terminal (`HC_TERMINAL_ID` unset, such as the Backlog panel's `exec`) may do these,
 * and must name the domain with `--domain`. Any terminal not labelled coordinator, delegates included, is still refused.
 * @param flag `--domain` value.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Domain.
 */
export const answerDomain = Effect.fn("answerDomain")(function* (
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.HC_TERMINAL_ID) return yield* coordinatorDomain(flag, env);
  if (!flag)
    return yield* new Refused({
      message: "a backlog change from outside a Herdr terminal names its domain: pass --domain",
    });
  return flag;
});

/**
 * The domain for an `item update` that changes only the status. Inside a Herdr terminal only a
 * coordinator may run it, as `coordinatorDomain` decides. Outside every terminal it goes as
 * `answerDomain` does, for a status in `OUTSIDE_TERMINAL_STATUSES` only.
 * @param flag `--domain` value.
 * @param status The `--status` value.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Domain.
 */
export const statusDomain = Effect.fn("statusDomain")(function* (
  flag: string | undefined,
  status: ItemStatus,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.HC_TERMINAL_ID) return yield* coordinatorDomain(flag, env);
  if (!OUTSIDE_TERMINAL_STATUSES.some((allowed) => allowed === status))
    return yield* new Refused({
      message: `from outside a Herdr terminal, item update sets only --status ${OUTSIDE_TERMINAL_STATUSES.join(", ")}; close an item with item close`,
    });
  return yield* answerDomain(flag, env);
});

/**
 * Resolve the domain: the flag when given, else the coordinator terminal's label.
 * @param flag `--domain` value.
 * @returns Domain.
 */
export const resolveDomain = Effect.fn("resolveDomain")(function* (flag: string | undefined) {
  if (flag) return flag;
  return (yield* ownCoordinator()).domain;
});

/**
 * Resolve the domain for a command delegates may run: the flag when given, else the
 * `fleet.domain` label of the calling terminal, whether coordinator or delegate.
 * @param flag `--domain` value.
 * @param env Environment (`HC_TERMINAL_ID`).
 * @returns Domain.
 */
export const domainOfCaller = Effect.fn("domainOfCaller")(function* (
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  if (flag) return flag;
  const address = env.HC_TERMINAL_ID;
  if (!address)
    return yield* new Refused({
      message: "HC_TERMINAL_ID is unset: run this inside a Herdr terminal, or pass --domain",
    });
  const domain = (yield* hc.get(address))?.labels[L.domain];
  if (!domain)
    return yield* new Refused({
      message: `terminal ${address} carries no ${L.domain} label; pass --domain`,
    });
  return domain;
});

/**
 * The domain's live delegates: terminals labelled with the domain (one `hc ls --label` call plus a
 * `hc get` per member), and unlabelled agents whose session an item's delegate ref names exactly.
 * @param domain Domain.
 * @param refSessions Session ids from the backlog's delegate refs; undefined or empty skips that scan.
 * @returns Delegates.
 */
export const members = Effect.fn("members")(function* (
  domain: string,
  refSessions: ReadonlySet<string> | undefined,
) {
  const labelled = yield* hc.list([`${L.domain}=${domain}`]);
  const found: Delegate[] = [];
  for (const listed of labelled) {
    const terminal = yield* hc.get(listed.address);
    if (!terminal || terminal.labels[L.role] === "coordinator") continue;
    found.push(toDelegate(terminal, true));
  }
  if (refSessions === undefined || refSessions.size === 0) return found;
  const known = new Set(labelled.map((terminal) => terminal.address));
  for (const listed of yield* hc.list()) {
    if (known.has(listed.address) || !hc.isAgent(listed)) continue;
    const terminal = yield* hc.get(listed.address);
    if (!terminal || terminal.labels[L.domain] || terminal.labels[L.role] === "coordinator")
      continue;
    const session = sessionOf(terminal);
    if (refSessions.has(session)) found.push(toDelegate(terminal, false));
  }
  return found;
});

/**
 * A coordinator's verify verdict on a settled delegate: `ok`, or `problem` with why, and when.
 */
export const VerdictSchema = Schema.Struct({
  result: Schema.Literals(["ok", "problem"]),
  reason: Schema.NullOr(Schema.String),
  at: Schema.String,
});

const EndedRecordSchema = Schema.Struct({
  name: Schema.String,
  task: Schema.optionalKey(Schema.NullOr(Schema.String)),
  domain: Schema.String,
  tab_label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  session: Schema.String,
  program: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.String,
  repo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  base_sha: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ended_at: Schema.String,
  quiet_since: Schema.optionalKey(Schema.NullOr(Schema.String)),
  space: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  verdict: Schema.optionalKey(Schema.NullOr(VerdictSchema)),
  resumes: Schema.optionalKey(Schema.Number),
  machine: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * An ended delegate: what resuming it needs. Same file format as upstream coordinator, so
 * existing records read; `program` is `pi`, `claude` (or upstream's `codex`, which cannot resume here).
 */
export type EndedRecord = typeof EndedRecordSchema.Type;

/**
 * Every readable ended record, with its location and the name it is stored under. Unreadable
 * records are skipped and reported by file name.
 * @param stateDir State dir.
 * @returns Records and skipped file names.
 */
export const readEnded = Effect.fn("readEnded")(function* (stateDir: string) {
  const store = stateStore(stateDir);
  const ids = yield* store.list("ended").pipe(Effect.orElseSucceed((): readonly string[] => []));
  const records: Array<{ id: string; path: string; record: EndedRecord }> = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const key = keys.ended(id);
    const path = store.location(key);
    const decoded = yield* store.read(key).pipe(
      Effect.flatMap((stored) => Schema.decodeUnknownEffect(EndedRecordSchema)(stored.value)),
      Effect.option,
    );
    if (Option.isSome(decoded)) records.push({ id, path, record: decoded.value });
    else skipped.push(basename(path));
  }
  return { records, skipped };
});

/**
 * Write an ended record under its session.
 * @param stateDir State dir.
 * @param record Record.
 * @returns Its location.
 */
export const writeEnded = Effect.fn("writeEnded")(function* (
  stateDir: string,
  record: EndedRecord,
) {
  const store = stateStore(stateDir);
  const key = keys.ended(record.session);
  yield* runCommand(store, key, () =>
    Effect.succeed({ write: true as const, next: record, value: undefined }),
  ).pipe(Effect.orDie);
  return store.location(key);
});

/**
 * Delete one ended record.
 * @param stateDir State dir.
 * @param id The name it is stored under (`readEnded`'s `id`, or its session).
 */
export const removeEnded = Effect.fn("removeEnded")(function* (stateDir: string, id: string) {
  yield* runCommand(stateStore(stateDir), keys.ended(id), (current) =>
    Effect.succeed(
      current.value === null
        ? { write: false as const, value: undefined }
        : { write: true as const, next: null, value: undefined },
    ),
  ).pipe(Effect.orDie);
});

/**
 * The backlog file of a domain.
 * @param backlogDir Backlog dir.
 * @param domain Domain.
 * @returns Path.
 */
export const backlogPath = (backlogDir: string, domain: string): string =>
  join(backlogDir, `${domain}-backlog.md`);

/**
 * A terminal by address or name. `hc get` resolves names on this core only, so a name it does not
 * know is looked up among every connected machine's live terminals; two with that name are refused
 * rather than guessed between.
 * @param target Name or address.
 * @returns The terminal, or undefined when none has that address or name.
 */
export const findTerminal = Effect.fn("findTerminal")(function* (target: string) {
  const here = yield* hc.get(target);
  if (here !== undefined || target.includes("/")) return here;
  const named = (yield* hc.list()).filter((listed) => listed.name === target && listed.live);
  if (named.length > 1)
    return yield* new Refused({
      message: `${named.length} live terminals are named ${target} (${named.map((listed) => listed.address).join(", ")}); give its address`,
    });
  const only = named[0];
  return only === undefined ? undefined : yield* hc.get(only.address);
});
