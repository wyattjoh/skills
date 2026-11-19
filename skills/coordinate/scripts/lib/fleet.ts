import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import { type Harness, harnessOf } from "./harness.ts";
import * as hc from "./herdr.ts";

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
 * The domain for recording an answer or editing a Boundary. A coordinator does either as it
 * changes anything else. A caller outside every Herdr terminal (`HC_TERMINAL_ID` unset, such as
 * the Backlog panel's `exec`) may record an answer or edit a Boundary, and must name the domain
 * with `--domain`. Any terminal not labelled coordinator, delegates included, is still refused.
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
});

/**
 * An ended delegate: what resuming it needs. Same file format as upstream coordinator, so
 * existing records read; `program` is `pi`, `claude` (or upstream's `codex`, which cannot resume here).
 */
export type EndedRecord = typeof EndedRecordSchema.Type;

/**
 * Folder of ended records.
 * @param stateDir State dir.
 * @returns Path.
 */
export const endedDir = (stateDir: string): string => join(stateDir, "ended");

/**
 * Every readable ended record, with its file path. Unreadable files are skipped and reported.
 * @param stateDir State dir.
 * @returns Records and skipped file names.
 */
export const readEnded = Effect.fn("readEnded")(function* (stateDir: string) {
  const dir = endedDir(stateDir);
  const names = yield* Effect.promise(() => readdir(dir).catch((): string[] => []));
  const records: Array<{ path: string; record: EndedRecord }> = [];
  const skipped: string[] = [];
  for (const name of names.filter((file) => file.endsWith(".json")).toSorted()) {
    const path = join(dir, name);
    const decoded = yield* Effect.tryPromise(() => Bun.file(path).json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(EndedRecordSchema)),
      Effect.option,
    );
    if (Option.isSome(decoded)) records.push({ path, record: decoded.value });
    else skipped.push(name);
  }
  return { records, skipped };
});

/**
 * Write an ended record as `<state>/ended/<session>.json`.
 * @param stateDir State dir.
 * @param record Record.
 * @returns Its path.
 */
export const writeEnded = Effect.fn("writeEnded")(function* (
  stateDir: string,
  record: EndedRecord,
) {
  const dir = endedDir(stateDir);
  const path = join(dir, `${record.session}.json`);
  yield* Effect.promise(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 1)}\n`);
  });
  return path;
});

/**
 * Delete one ended record.
 * @param path Record file.
 */
export const removeEnded = Effect.fn("removeEnded")(function* (path: string) {
  yield* Effect.promise(() => rm(path, { force: true }));
});

/**
 * The backlog file of a domain.
 * @param backlogDir Backlog dir.
 * @param domain Domain.
 * @returns Path.
 */
export const backlogPath = (backlogDir: string, domain: string): string =>
  join(backlogDir, `${domain}-backlog.md`);
