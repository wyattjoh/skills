import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import {
  addBoundary,
  addCheckout,
  addFinding,
  addItem,
  addPolicy,
  type BoundaryList,
  closeFinding,
  promoteFinding,
  closeItem,
  clearEdits,
  editDecision,
  editFinding,
  editItem,
  emptyBacklog,
  fileDelegate,
  idleDelegated,
  type ItemUpdate,
  type OpResult,
  recordEdit,
  removeBoundary,
  removeCheckout,
  removePolicy,
  replaceBoundary,
  replacePolicy,
  requestStart,
  RETAINED_CLOSED,
  retain,
  setFocus,
  unfileable,
  unfileDelegate,
  updateItem,
} from "./backlog-store/ops.ts";
import { archivePath } from "./backlog-store/paths.ts";
import { policyCitation, renderBacklog } from "./backlog-store/render.ts";
import {
  type Backlog,
  type DelegateRef,
  FINDING_DETAIL_SHAPE,
  type Finding,
  type Item,
  type Policy,
  proseSource,
  type RecordEdit,
  validateBacklog,
} from "./backlog-store/schema.ts";

const policyBodyOf = (policy: Policy): string => proseSource(policy.text, policy.markdown);
import { absolutePath, type Config } from "./config.ts";
import { canonicalMachine, localMachine } from "./delegate-capacity.ts";
import { backlogPath, members, Refused } from "./fleet.ts";
import { machineNames } from "./herdr.ts";
import { stateStore } from "./state.ts";
import {
  BacklogError,
  keys,
  optionUnlessOffline,
  runCommand,
  type CommandStep,
  type StateStore,
  type StoreOffline,
  type StoreUnreadable,
} from "./state-store.ts";

export { BacklogError };

const storeOf = (config: Config): StateStore => stateStore(config.stateDir);

const unreadable = (error: StoreUnreadable): BacklogError =>
  new BacklogError({
    path: error.location,
    message:
      error.stage === "parse" ? `${error.location} is not JSON: ${error.detail}` : error.message,
  });

const decode = (path: string, value: unknown): Effect.Effect<Backlog, BacklogError> => {
  const checked = validateBacklog(value);
  return checked.ok
    ? Effect.succeed(checked.backlog)
    : Effect.fail(
        new BacklogError({ path, message: `${path} is invalid: ${checked.errors.join("; ")}` }),
      );
};

export { archivePath };

const missing = (location: string, domain: string) =>
  new Refused({
    message: `no backlog for ${domain} at ${location}; run coordinate start ${domain}`,
  });

/**
 * Run a backlog command through the store, reporting an unreadable document as a `BacklogError`.
 */
const command = <A>(
  config: Config,
  domain: string,
  step: (
    current: unknown,
    path: string,
  ) => Effect.Effect<CommandStep<A>, BacklogError | Refused | StoreOffline>,
): Effect.Effect<A, BacklogError | Refused | StoreOffline> => {
  const store = storeOf(config);
  const key = keys.backlog(domain);
  const path = store.location(key);
  const refusal = store.refusal(key);
  if (refusal !== undefined) return Effect.fail(new Refused({ message: refusal }));
  return runCommand(store, key, (current) => step(current.value, path)).pipe(
    Effect.mapError((error) => (error._tag === "StoreUnreadable" ? unreadable(error) : error)),
  );
};

/**
 * What a refusable backlog command returns from inside the store: a reason, or its value.
 */
type Outcome<A> = { ok: false; reason: string } | { ok: true; value: A };

/**
 * Whether the domain has a backlog document. One that exists but cannot be read still counts.
 * @param config Config.
 * @param domain Domain.
 * @returns True when present.
 */
export const documentExists = (
  config: Config,
  domain: string,
): Effect.Effect<boolean, StoreOffline> =>
  storeOf(config)
    .read(keys.backlog(domain))
    .pipe(
      Effect.map((stored) => stored.value !== null),
      Effect.catchTag("StoreUnreadable", () => Effect.succeed(true)),
    );

/**
 * The domains with a backlog document, in name order.
 * @param config Config.
 * @returns Domain names.
 */
export const listDomains = (config: Config): Effect.Effect<string[], StoreOffline> =>
  storeOf(config)
    .list("backlog")
    .pipe(
      Effect.map((domains) => [...domains].toSorted()),
      Effect.catchTag("StoreUnreadable", () => Effect.succeed([] as string[])),
    );

/**
 * Create the domain's document when it is missing. An existing document is left untouched.
 * @param config Config.
 * @param domain Domain.
 * @returns The path, whether it was created, and the legacy Markdown path recorded.
 */
export const createDocument = Effect.fn("createDocument")(function* (
  config: Config,
  domain: string,
) {
  const markdown = backlogPath(config.backlogDir, domain);
  return yield* command<{ path: string; created: boolean; legacy: string | null }>(
    config,
    domain,
    (current, path) =>
      Effect.sync(() => {
        if (current !== null)
          return { write: false as const, value: { path, created: false, legacy: null } };
        const legacy = existsSync(markdown) ? markdown : null;
        return {
          write: true as const,
          next: emptyBacklog(domain, legacy),
          value: { path, created: true, legacy },
        };
      }),
  );
});

/**
 * Seed the backlog of a coordinator about to start, in one write under the lock: create the
 * document when missing, add the folder to the owned Boundary when absent, and add each title as an
 * open item unless an item not yet closed already has it, so a retry adds nothing twice. A refused
 * step writes nothing, and an unchanged document is not rewritten.
 * @param config Config.
 * @param domain Domain.
 * @param input The owned folder, the item titles, and the time as an ISO string.
 * @returns The path, whether the document was created, whether the folder was added, the items
 *   added, and the items already present.
 */
export const seedDocument = Effect.fn("seedDocument")(function* (
  config: Config,
  domain: string,
  input: { owned: string; titles: readonly string[]; now: string },
) {
  const markdown = backlogPath(config.backlogDir, domain);
  type Seeded = {
    path: string;
    created: boolean;
    added: boolean;
    items: Item[];
    present: Item[];
  };
  const result = yield* command<Outcome<Seeded>>(config, domain, (stored, path) =>
    Effect.gen(function* () {
      const created = stored === null;
      const current = created
        ? emptyBacklog(domain, existsSync(markdown) ? markdown : null)
        : yield* decode(path, stored);
      const refused = (reason: string): CommandStep<Outcome<Seeded>> => ({
        write: false,
        value: { ok: false, reason },
      });
      const bounded = addBoundary(current, { path: input.owned, list: "owned" });
      if (!bounded.ok) return refused(bounded.reason);
      const seeded = input.titles.reduce<OpResult<{ items: Item[]; present: Item[] }>>(
        (previous, title) => {
          if (!previous.ok) return previous;
          const present = previous.backlog.items.find(
            (item) =>
              item.title === title.trim() && item.status !== "done" && item.status !== "dismissed",
          );
          if (present)
            return {
              ...previous,
              value: { ...previous.value, present: [...previous.value.present, present] },
            };
          const added = addItem(previous.backlog, { title, now: input.now });
          if (!added.ok) return { ok: false, reason: `--item: ${added.reason}` };
          return {
            ok: true,
            backlog: added.backlog,
            value: { ...previous.value, items: [...previous.value.items, added.value] },
          };
        },
        { ok: true, backlog: bounded.backlog, value: { items: [], present: [] } },
      );
      if (!seeded.ok) return refused(seeded.reason);
      const value: Outcome<Seeded> = {
        ok: true,
        value: { path, created, added: bounded.value.added, ...seeded.value },
      };
      if (!created && !bounded.value.added && seeded.value.items.length === 0)
        return { write: false as const, value };
      const checked = validateBacklog(seeded.backlog);
      if (!checked.ok) return refused(checked.errors.join("; "));
      return { write: true as const, next: checked.backlog, value };
    }),
  );
  if (!result.ok) return yield* new Refused({ message: result.reason });
  return result.value;
});

/**
 * Read and validate the domain's document.
 * @param config Config.
 * @param domain Domain.
 * @returns The document and its path; refused when missing, a `BacklogError` when unreadable.
 */
export const readDocument = Effect.fn("readDocument")(function* (config: Config, domain: string) {
  const store = storeOf(config);
  const key = keys.backlog(domain);
  const path = store.location(key);
  const stored = yield* store
    .read(key)
    .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.fail(unreadable(error))));
  if (stored.value === null) return yield* missing(path, domain);
  const backlog = yield* decode(path, stored.value);
  return { path, backlog };
});

/**
 * Apply a pure operation under the lock: read, apply, validate, archive closed records beyond the
 * newest `RETAINED_CLOSED`, write. A refused operation or an invalid result writes nothing.
 * @param config Config.
 * @param domain Domain.
 * @param operation Pure operation.
 * @returns The operation's value.
 */
const change = <A>(config: Config, domain: string, operation: (backlog: Backlog) => OpResult<A>) =>
  Effect.gen(function* () {
    // Checked before the lock too, so a missing domain is refused without touching the state dir.
    if (!(yield* documentExists(config, domain)))
      return yield* missing(storeOf(config).location(keys.backlog(domain)), domain);
    const result = yield* command<Outcome<A>>(config, domain, (stored, path) =>
      Effect.gen(function* () {
        if (stored === null) return yield* missing(path, domain);
        const applied = operation(yield* decode(path, stored));
        if (!applied.ok)
          return { write: false as const, value: { ok: false as const, reason: applied.reason } };
        const checked = validateBacklog(applied.backlog);
        if (!checked.ok)
          return {
            write: false as const,
            value: { ok: false as const, reason: checked.errors.join("; ") },
          };
        const kept = retain(checked.backlog, RETAINED_CLOSED);
        // Before the write, so a crash between the two repeats a line rather than losing one.
        yield* storeOf(config).appendArchive(
          domain,
          kept.archived.map((record) => JSON.stringify(record)),
        );
        return {
          write: true as const,
          next: kept.backlog,
          value: { ok: true as const, value: applied.value },
        };
      }),
    );
    if (!result.ok) return yield* new Refused({ message: result.reason });
    return result.value;
  });

const json = (value: unknown): string[] => [JSON.stringify(value, null, 2)];

/**
 * An applied operation with the user's change recorded beside it, when `editedAt` is set (the
 * caller is outside every Herdr terminal) and the text really changed. The coordinator's own
 * edits pass no time and record nothing: it made them.
 */
const withEdit = <A>(
  applied: OpResult<A>,
  editedAt: string | undefined,
  edit: (value: A) => Omit<RecordEdit, "id" | "at">,
): OpResult<A> => {
  if (!applied.ok || editedAt === undefined) return applied;
  const changed = edit(applied.value);
  if (changed.old === changed.new) return applied;
  return { ...applied, backlog: recordEdit(applied.backlog, { ...changed, at: editedAt }) };
};

/**
 * `coordinate backlog show`: the document rendered as Markdown, or printed as JSON.
 * @param config Config.
 * @param domain Domain.
 * @param asJson Print the document instead.
 * @param live Session ids of the live delegates when the caller already has them; otherwise
 * they are read, only when an item is delegated. Unreadable liveness marks nothing.
 * @param showDone Include closed items in text output; JSON output is unchanged.
 * @param verbose Render full context, options and recommendations for answered asks.
 * @returns Lines to print.
 */
export const showBacklog = Effect.fn("showBacklog")(function* (
  config: Config,
  domain: string,
  asJson: boolean,
  live: ReadonlySet<string> | undefined = undefined,
  showDone = false,
  verbose = false,
) {
  const { backlog } = yield* readDocument(config, domain);
  if (asJson) return json(backlog);
  const sessions =
    live ??
    (backlog.items.some((item) => item.status === "delegated")
      ? yield* members(domain, yield* refSessions(config, domain)).pipe(
          Effect.map((found) => new Set(found.map((delegate) => delegate.session))),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      : undefined);
  const idle = sessions ? idleDelegated(backlog, sessions).map((item) => item.id) : [];
  return [renderBacklog(backlog, new Set(idle), showDone, verbose).trimEnd()];
});

/**
 * `coordinate item add`: add an open item.
 * @param config Config.
 * @param domain Domain.
 * @param input Title, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemAdd = Effect.fn("itemAdd")(function* (
  config: Config,
  domain: string,
  input: { title: string; json: boolean; now: string },
) {
  const item = yield* change(config, domain, (backlog) =>
    addItem(backlog, { title: input.title, now: input.now }),
  );
  return input.json ? json(item) : [`added ${item.id}: ${item.title}`];
});

/**
 * `coordinate item close`: close an item as done or dismissed with an outcome.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id, outcome, `--dismissed`, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemClose = Effect.fn("itemClose")(function* (
  config: Config,
  domain: string,
  input: {
    id: string;
    outcome: string;
    outcomeMarkdown?: string | undefined;
    dismissed: boolean;
    json: boolean;
    now: string;
  },
) {
  const item = yield* change(config, domain, (backlog) =>
    closeItem(backlog, {
      id: input.id,
      outcome: input.outcome,
      outcomeMarkdown: input.outcomeMarkdown,
      dismissed: input.dismissed,
      now: input.now,
    }),
  );
  return input.json
    ? json(item)
    : [`${item.status} ${item.id}: ${proseSource(item.outcome, item.outcomeMarkdown)}`];
});

/**
 * `coordinate item start`: record the user's request that the coordinator start an item now. The
 * watcher delivers it as a `start` event. A request already pending is kept as it was.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemStart = Effect.fn("itemStart")(function* (
  config: Config,
  domain: string,
  input: { id: string; json: boolean; now: string },
) {
  const { item, requested } = yield* change(config, domain, (backlog) =>
    requestStart(backlog, { id: input.id, now: input.now }),
  );
  if (input.json) return json(item);
  const at = item.startRequested?.at ?? input.now;
  return [
    requested
      ? `start requested for ${item.id} at ${at}: ${item.title}`
      : `start already requested for ${item.id} at ${at}: ${item.title}`,
  ];
});

/**
 * `coordinate item edit`: change an item's title, a closed item's outcome, or one decision (by
 * its `decisionKey`), or delete that decision. With `editedAt` (outside a terminal) the change is
 * recorded for the watcher's `edited` event.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id, the field and its value (`null` deletes a decision), the decision key,
 * `--json`, and the time to record the user's edit at.
 * @returns Lines to print.
 */
export const itemEdit = Effect.fn("itemEdit")(function* (
  config: Config,
  domain: string,
  input: {
    id: string;
    edit:
      | { field: "title" | "outcome"; value: string }
      | { field: "decision"; key: string; markdown: string | null };
    json: boolean;
    editedAt: string | undefined;
  },
) {
  const { edit } = input;
  const { item } = yield* change(config, domain, (backlog) =>
    withEdit(
      edit.field === "decision"
        ? editDecision(backlog, { id: input.id, key: edit.key, markdown: edit.markdown })
        : editItem(backlog, { id: input.id, field: edit.field, value: edit.value }),
      input.editedAt,
      ({ change: changed }) => ({ record: input.id, field: edit.field, ...changed }),
    ),
  );
  if (input.json) return json(item);
  if (edit.field === "decision")
    return [
      edit.markdown === null
        ? `removed decision ${edit.key} from ${item.id}`
        : `replaced decision ${edit.key} on ${item.id}`,
    ];
  return [`edited ${edit.field} of ${item.id}: ${item.title}`];
});

/**
 * `coordinate finding edit`: change a finding's title, detail, or a closed finding's outcome.
 * With `editedAt` (outside a terminal) the change is recorded for the watcher's `edited` event.
 * @param config Config.
 * @param domain Domain.
 * @param input Finding id, the field and its value, `--json`, and the time to record the user's
 * edit at.
 * @returns Lines to print.
 */
export const findingEdit = Effect.fn("findingEdit")(function* (
  config: Config,
  domain: string,
  input: {
    id: string;
    field: "title" | "detail" | "outcome";
    value: string;
    json: boolean;
    editedAt: string | undefined;
  },
) {
  const { finding } = yield* change(config, domain, (backlog) =>
    withEdit(
      editFinding(backlog, { id: input.id, field: input.field, value: input.value }),
      input.editedAt,
      ({ change: changed }) => ({ record: input.id, field: input.field, ...changed }),
    ),
  );
  return input.json ? json(finding) : [`edited ${input.field} of ${finding.id}: ${finding.title}`];
});

/**
 * Drop the user's edits the watcher has queued for delivery.
 * @param config Config.
 * @param domain Domain.
 * @param ids The delivered edits' ids.
 * @returns How many it dropped.
 */
export const editsClear = Effect.fn("editsClear")(function* (
  config: Config,
  domain: string,
  ids: readonly string[],
) {
  return yield* change(config, domain, (backlog) => clearEdits(backlog, ids));
});

/**
 * `coordinate finding add`: record an open issue or opportunity. Delegates may run it. A new
 * finding needs a detail (`--detail-md`, or the deprecated `--detail`); findings stored without one
 * stay valid.
 * @param config Config.
 * @param domain Domain.
 * @param input Kind, title, detail, path, source item and source reference, and `--json`.
 * @returns Lines to print.
 */
export const findingAdd = Effect.fn("findingAdd")(function* (
  config: Config,
  domain: string,
  input: {
    kind: Finding["kind"];
    title: string;
    detail: string | undefined;
    detailMarkdown?: string | undefined;
    path: string | undefined;
    from: string | undefined;
    source: string | undefined;
    json: boolean;
    now: string | undefined;
  },
) {
  if (input.detail === undefined && input.detailMarkdown === undefined)
    return yield* new Refused({
      message: `a finding needs a detail: pass --detail-md with ${FINDING_DETAIL_SHAPE}`,
    });
  const finding = yield* change(config, domain, (backlog) =>
    addFinding(backlog, {
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      detailMarkdown: input.detailMarkdown,
      path: input.path,
      from: input.from,
      source: input.source,
      now: input.now,
    }),
  );
  return input.json ? json(finding) : [`added ${finding.id}: ${finding.title}`];
});

/**
 * `coordinate finding close`: close a finding as acted on (or dismissed) with an outcome.
 * @param config Config.
 * @param domain Domain.
 * @param input Finding id, outcome, `--dismissed`, `--json`, and the time.
 * @returns Lines to print.
 */
export const findingClose = Effect.fn("findingClose")(function* (
  config: Config,
  domain: string,
  input: {
    id: string;
    outcome: string;
    outcomeMarkdown?: string | undefined;
    dismissed: boolean;
    json: boolean;
    now: string;
  },
) {
  const finding = yield* change(config, domain, (backlog) =>
    closeFinding(backlog, {
      id: input.id,
      outcome: input.outcome,
      outcomeMarkdown: input.outcomeMarkdown,
      dismissed: input.dismissed,
      now: input.now,
    }),
  );
  return input.json
    ? json(finding)
    : [`${finding.status} ${finding.id}: ${proseSource(finding.outcome, finding.outcomeMarkdown)}`];
});

/**
 * `coordinate finding promote`: turn an open finding into an open item in the same domain and
 * close the finding with the outcome "promoted to <item id>", in one locked write.
 * @param config Config.
 * @param domain Domain.
 * @param input Finding id, optional title override, `--json`, and the time.
 * @returns Lines to print.
 */
export const findingPromote = Effect.fn("findingPromote")(function* (
  config: Config,
  domain: string,
  input: { id: string; title: string | undefined; json: boolean; now: string },
) {
  const promoted = yield* change(config, domain, (backlog) =>
    promoteFinding(backlog, { id: input.id, title: input.title, now: input.now }),
  );
  return input.json
    ? json(promoted)
    : [`promoted ${promoted.finding.id} to ${promoted.item.id}: ${promoted.item.title}`];
});

/**
 * `coordinate item update`: change an item's status, touches, due date, decisions or ask.
 * @param config Config.
 * @param domain Domain.
 * @param input The changes, `--json`, and the time.
 * @returns Lines to print.
 */
export const itemUpdate = Effect.fn("itemUpdate")(function* (
  config: Config,
  domain: string,
  input: ItemUpdate & { json: boolean },
) {
  const item = yield* change(config, domain, (backlog) => updateItem(backlog, input));
  return input.json ? json(item) : [`updated ${item.id} [${item.status}] ${item.title}`];
});

/**
 * A Boundary path as stored: `~` expanded, made absolute, trailing slashes dropped.
 * @param path Path as given.
 * @param home Home directory for `~`.
 * @returns The stored form; an empty or multi-line path is returned as given, for the op to refuse.
 */
export const normalizeBoundary = (path: string, home: string = homedir()): string => {
  if (path.trim() === "" || /[\r\n]/.test(path)) return path.trim() === "" ? "" : path;
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const absolute = absolutePath(expanded);
  return absolute === "/" ? absolute : absolute.replace(/\/+$/, "");
};

/**
 * `coordinate backlog boundary add`: add an existing path to the owned (or adjacent) Boundary.
 * @param config Config.
 * @param domain Domain.
 * @param input Path, `--adjacent`, `--json`, and whether the caller is outside a Herdr terminal.
 * @returns Lines to print.
 */
export const boundaryAdd = Effect.fn("boundaryAdd")(function* (
  config: Config,
  domain: string,
  input: { path: string; adjacent: boolean; json: boolean; outsideTerminal: boolean },
) {
  const path = normalizeBoundary(input.path);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  if (path.startsWith("/") && !/[\r\n]/.test(path) && !existsSync(path))
    return yield* new Refused({ message: `${path} does not exist` });
  let boundary: Backlog["boundary"] | undefined;
  const result = yield* change(config, domain, (backlog) => {
    const applied = addBoundary(backlog, { path, list });
    if (!applied.ok) return applied;
    if (input.outsideTerminal && !applied.value.added)
      return { ok: false as const, reason: `${path} is already in the ${list} Boundary` };
    boundary = applied.backlog.boundary;
    return applied;
  });
  if (input.json) return json(boundary);
  return [result.added ? `${list}: added ${path}` : `${list}: ${path} is already listed`];
});

/**
 * `coordinate backlog boundary rm`: remove a path from the owned (or adjacent) Boundary.
 * @param config Config.
 * @param domain Domain.
 * @param input Path, `--adjacent`, `--json`, and whether the caller is outside a Herdr terminal.
 * @returns Lines to print.
 */
export const boundaryRm = Effect.fn("boundaryRm")(function* (
  config: Config,
  domain: string,
  input: {
    path: string;
    adjacent: boolean;
    json: boolean;
    outsideTerminal: boolean;
    editedAt?: string | undefined;
  },
) {
  const path = normalizeBoundary(input.path);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  let boundary: Backlog["boundary"] | undefined;
  yield* change(config, domain, (backlog) => {
    const other: BoundaryList = list === "owned" ? "adjacent" : "owned";
    const selected =
      input.outsideTerminal &&
      !backlog.boundary[list].includes(path) &&
      backlog.boundary[other].includes(path)
        ? other
        : list;
    const applied = withEdit(
      removeBoundary(backlog, { path, list: selected }),
      input.editedAt,
      () => ({ record: "boundary", field: selected, old: path, new: null }),
    );
    if (applied.ok) boundary = applied.backlog.boundary;
    return applied;
  });
  return input.json ? json(boundary) : [`${list}: removed ${path}`];
});

/**
 * `coordinate backlog boundary replace`: list another existing path in place of one, keeping
 * its position and an owned path's checkouts.
 * @param config Config.
 * @param domain Domain.
 * @param input The listed path, the path to list instead, `--adjacent`, `--json`, and the time
 * to record the user's edit at (outside a terminal only).
 * @returns Lines to print.
 */
export const boundaryReplace = Effect.fn("boundaryReplace")(function* (
  config: Config,
  domain: string,
  input: {
    from: string;
    to: string;
    adjacent: boolean;
    json: boolean;
    editedAt: string | undefined;
  },
) {
  const from = normalizeBoundary(input.from);
  const to = normalizeBoundary(input.to);
  const list: BoundaryList = input.adjacent ? "adjacent" : "owned";
  if (to.startsWith("/") && !/[\r\n]/.test(to) && !existsSync(to))
    return yield* new Refused({ message: `${to} does not exist` });
  let boundary: Backlog["boundary"] | undefined;
  yield* change(config, domain, (backlog) => {
    const applied = withEdit(replaceBoundary(backlog, { list, from, to }), input.editedAt, () => ({
      record: "boundary",
      field: list,
      old: from,
      new: to,
    }));
    if (applied.ok) boundary = applied.backlog.boundary;
    return applied;
  });
  return input.json ? json(boundary) : [`${list}: replaced ${from} with ${to}`];
});

const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const machineProblem = (machine: string): string | undefined =>
  MACHINE_NAME.test(machine)
    ? undefined
    : `machine name ${machine} must be letters, digits, . _ or -`;

/**
 * `coordinate backlog boundary add <path> --machine <m> --checkout <p>`: record where an owned
 * path's repo is checked out on another Herdr machine. The machine must be one `hc machine ls`
 * lists; this machine (`local`, its hostname or its Herdr name) is refused, since its checkout is
 * the owned path itself. The checkout path is stored as given (trailing slashes dropped), never
 * checked against this machine's disk.
 * @param config Config.
 * @param domain Domain.
 * @param input Owned path, machine, checkout path, `--json`, and whether the caller is outside a
 * Herdr terminal.
 * @returns Lines to print.
 */
export const checkoutAdd = Effect.fn("checkoutAdd")(function* (
  config: Config,
  domain: string,
  input: {
    path: string;
    machine: string;
    checkout: string;
    json: boolean;
    outsideTerminal: boolean;
  },
) {
  const path = normalizeBoundary(input.path);
  const problem = machineProblem(input.machine);
  if (problem) return yield* new Refused({ message: problem });
  const core = yield* localMachine();
  if (canonicalMachine(input.machine, core) === core)
    return yield* new Refused({
      message: `${input.machine} is this machine (${core}); its checkout is the owned path itself`,
    });
  const known = yield* machineNames();
  if (!known.includes(input.machine))
    return yield* new Refused({
      message: `unknown Herdr machine ${input.machine}; known machines: ${known.length > 0 ? known.join(", ") : "(none)"}`,
    });
  const checkout = input.checkout.length > 1 ? input.checkout.replace(/\/+$/, "") : input.checkout;
  let boundary: Backlog["boundary"] | undefined;
  const result = yield* change(config, domain, (backlog) => {
    const applied = addCheckout(backlog, { path, machine: input.machine, checkout });
    if (!applied.ok) return applied;
    if (input.outsideTerminal && !applied.value.added)
      return {
        ok: false as const,
        reason: `checkout of ${path} on ${input.machine} is already listed`,
      };
    boundary = applied.backlog.boundary;
    return applied;
  });
  if (input.json) return json(boundary);
  return [
    result.added
      ? `owned: added checkout of ${path} on ${input.machine}: ${checkout}`
      : `owned: checkout of ${path} on ${input.machine} is already listed`,
  ];
});

/**
 * `coordinate backlog boundary rm <path> --machine <m>`: remove an owned path's checkout on one
 * machine. The machine need not still be registered with Herdr.
 * @param config Config.
 * @param domain Domain.
 * @param input Owned path, machine and `--json`.
 * @returns Lines to print.
 */
export const checkoutRm = Effect.fn("checkoutRm")(function* (
  config: Config,
  domain: string,
  input: { path: string; machine: string; json: boolean },
) {
  const path = normalizeBoundary(input.path);
  const problem = machineProblem(input.machine);
  if (problem) return yield* new Refused({ message: problem });
  let boundary: Backlog["boundary"] | undefined;
  yield* change(config, domain, (backlog) => {
    const applied = removeCheckout(backlog, { path, machine: input.machine });
    if (applied.ok) boundary = applied.backlog.boundary;
    return applied;
  });
  return input.json ? json(boundary) : [`owned: removed checkout of ${path} on ${input.machine}`];
});

/**
 * `coordinate backlog policy ls`: list policies in document order.
 * @param config Config.
 * @param domain Domain.
 * @param asJson Print the policies as JSON.
 * @returns Lines to print.
 */
export const policyLs = Effect.fn("policyLs")(function* (
  config: Config,
  domain: string,
  asJson: boolean,
) {
  const { backlog } = yield* readDocument(config, domain);
  return asJson
    ? json(backlog.policies)
    : backlog.policies.length === 0
      ? ["(none)"]
      : backlog.policies.map(
          (policy) => `${policy.id} ${policy.at}: ${policyBodyOf(policy)}${policyCitation(policy)}`,
        );
});

/**
 * `coordinate backlog policy add`: add a reusable policy with its date and, with `--wiki`, the
 * wiki page that explains it. The caller checks the page exists first.
 * @param config Config.
 * @param domain Domain.
 * @param input Text, `--at`, `--wiki`, `--json`, and the time.
 * @returns Lines to print.
 */
export const policyAdd = Effect.fn("policyAdd")(function* (
  config: Config,
  domain: string,
  input: {
    text: string | undefined;
    markdown?: string | undefined;
    at: string | undefined;
    wiki: string | undefined;
    json: boolean;
    now: string;
  },
) {
  const policy = yield* change(config, domain, (backlog) =>
    addPolicy(backlog, {
      text: input.text,
      markdown: input.markdown,
      at: input.at ?? input.now.slice(0, 10),
      wiki: input.wiki,
    }),
  );
  return input.json
    ? json(policy)
    : [`added policy ${policy.id}: ${policyBodyOf(policy)}${policyCitation(policy)}`];
});

/**
 * `coordinate backlog policy rm`: remove a policy by id.
 * @param config Config.
 * @param domain Domain.
 * @param input Policy id and `--json`.
 * @returns Lines to print.
 */
export const policyRm = Effect.fn("policyRm")(function* (
  config: Config,
  domain: string,
  input: { id: string; json: boolean; editedAt?: string | undefined },
) {
  const policy = yield* change(config, domain, (backlog) =>
    withEdit(removePolicy(backlog, input.id), input.editedAt, (removed) => ({
      record: removed.id,
      field: "policy",
      old: policyBodyOf(removed),
      new: null,
    })),
  );
  return input.json ? json(policy) : [`removed policy ${policy.id}: ${policyBodyOf(policy)}`];
});

/**
 * `coordinate backlog policy replace`: replace text and date while preserving the id.
 * @param config Config.
 * @param domain Domain.
 * @param input Policy id, text, `--at`, `--wiki` (undefined keeps the citation), `--json`, and
 * the time.
 * @returns Lines to print.
 */
export const policyReplace = Effect.fn("policyReplace")(function* (
  config: Config,
  domain: string,
  input: {
    id: string;
    text: string | undefined;
    markdown?: string | undefined;
    at: string | undefined;
    wiki: string | undefined;
    json: boolean;
    now: string;
    editedAt?: string | undefined;
  },
) {
  const policy = yield* change(config, domain, (backlog) => {
    const before = backlog.policies.find((entry) => entry.id === input.id);
    return withEdit(
      replacePolicy(backlog, {
        id: input.id,
        text: input.text,
        markdown: input.markdown,
        at: input.at ?? input.now.slice(0, 10),
        wiki: input.wiki,
      }),
      input.editedAt,
      (replaced) => ({
        record: replaced.id,
        field: "policy",
        old: before === undefined ? null : policyBodyOf(before),
        new: policyBodyOf(replaced),
      }),
    );
  });
  return input.json
    ? json(policy)
    : [`replaced policy ${policy.id}: ${policyBodyOf(policy)}${policyCitation(policy)}`];
});

/**
 * `coordinate backlog focus`: set the domain's focus line, or clear it with null.
 * @param config Config.
 * @param domain Domain.
 * @param input Focus line or null, `--json`.
 * @returns Lines to print.
 */
export const focusSet = Effect.fn("focusSet")(function* (
  config: Config,
  domain: string,
  input: {
    focus: string | null;
    markdown?: string | undefined;
    json: boolean;
    editedAt?: string | undefined;
  },
) {
  const focus = yield* change(config, domain, (backlog) =>
    withEdit(
      setFocus(backlog, { focus: input.focus, markdown: input.markdown }),
      input.editedAt,
      (after) => ({
        record: "focus",
        field: "focus",
        old: proseSource(backlog.focus, backlog.focusMarkdown) || null,
        new: after,
      }),
    ),
  );
  if (input.json) return json({ focus });
  return [focus === null ? "focus cleared" : `focus: ${focus}`];
});

/**
 * Refuse, before anything is created, an item a delegate cannot be filed under.
 * @param config Config.
 * @param domain Domain.
 * @param id Item id.
 */
export const checkFileable = Effect.fn("checkFileable")(function* (
  config: Config,
  domain: string,
  id: string,
) {
  const { backlog } = yield* readDocument(config, domain);
  const problem = unfileable(backlog, id);
  if (problem) return yield* new Refused({ message: problem });
});

/**
 * Record a delegate ref on an item and set the item to delegated.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id and the delegate ref.
 * @returns The updated item.
 */
export const recordDelegate = Effect.fn("recordDelegate")(function* (
  config: Config,
  domain: string,
  input: { id: string; ref: DelegateRef },
) {
  return yield* change(config, domain, (backlog) => fileDelegate(backlog, input));
});

/**
 * Remove a delegate ref from an item, matched by session id or name; an item left delegated with
 * no delegates goes back to open.
 * @param config Config.
 * @param domain Domain.
 * @param input Item id, and the delegate's session id or name.
 * @returns The updated item and the removed ref.
 */
export const releaseDelegate = Effect.fn("releaseDelegate")(function* (
  config: Config,
  domain: string,
  input: { id: string; key: string },
) {
  return yield* change(config, domain, (backlog) => unfileDelegate(backlog, input));
});

/**
 * The session ids every item's delegate refs name, or an empty set when the domain has no document.
 * @param config Config.
 * @param domain Domain.
 * @returns Session ids.
 */
export const refSessions = Effect.fn("refSessions")(function* (config: Config, domain: string) {
  const read = yield* readDocument(config, domain).pipe(optionUnlessOffline);
  if (Option.isNone(read)) return new Set<string>();
  return new Set(
    read.value.backlog.items.flatMap((item) => item.delegates.map((ref) => ref.session)),
  );
});
