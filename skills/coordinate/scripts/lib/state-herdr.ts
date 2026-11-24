import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Effect } from "effect";
import { archivePath } from "./backlog-store/paths.ts";
import {
  docNameProblem,
  type DocReply,
  type DocRequest,
  type DocSubscriber,
  type DocTransport,
} from "./herdr-docs.ts";
import { appendArchiveFile, filesStore, readArchiveFile } from "./state-files.ts";
import {
  BacklogError,
  ClaimBusy,
  type ListedKind,
  type StateKey,
  type StateStore,
  type StoreClaim,
  StoreConflict,
  StoreOffline,
  type StoreSession,
  type Stored,
  StoreUnreadable,
  type Version,
} from "./state-store.ts";

/**
 * How many documents the ended records are spread over. Session ids are too long to name a
 * document each, and one document would grow toward Herdr's 1 MiB limit.
 */
export const ENDED_SHARDS = 8;

/**
 * The production document prefix on the home core.
 */
export const PRODUCTION_PREFIX = "cs.";

/**
 * How long a capacity claim stays held when its owner is on another machine, where its pid cannot
 * be checked. A queued retry holds its claim only while it launches one delegate.
 */
export const CLAIM_TTL_MS = 15 * 60_000;

/**
 * What a herdr-doc store needs.
 */
export type HerdrStoreOptions = {
  /**
   * The home's Herdr machine name, as this core knows it.
   */
  home: string;
  /**
   * Prefix of every document name (`cs.` in production, a short random one in tests).
   */
  prefix: string;
  /**
   * Sends document calls to this core.
   */
  transport: DocTransport;
  /**
   * This core's Herdr machine name, read once; documents go to `on: home` only when it differs.
   */
  self: Effect.Effect<string, { message: string }>;
  /**
   * This machine's OS hostname, recorded in the claims it takes (default `hostname()`).
   */
  host?: string;
  /**
   * The clock claim expiries are set and checked by (default `Date.now`).
   */
  now?: () => number;
  /**
   * The local state directory: session state and the wiki lint clock stay files here, and so do
   * archives when this machine is the home.
   */
  stateDir: string;
  /**
   * Append archive lines on the home when it is another machine.
   */
  appendRemote: (
    home: string,
    domain: string,
    lines: readonly string[],
  ) => Effect.Effect<void, BacklogError | StoreOffline>;
  /**
   * Read a domain's archive on the home when it is another machine.
   */
  readRemote: (
    home: string,
    domain: string,
  ) => Effect.Effect<string | undefined, BacklogError | StoreOffline>;
  /**
   * Subscribes to this core's document changes, used by `follow` when the home is this core.
   * Without it, the store cannot notify and readers only poll.
   */
  subscribe?: DocSubscriber;
};

type Address = { name: string; field: string | undefined };
type Doc = { value: unknown; version: number };

const encode = (version: number, value: unknown): Version =>
  (value === null ? `${version}:null` : String(version)) as Version;

const decodeVersion = (version: Version): { number: number; absent: boolean } => {
  const [number = "", marker] = version.split(":");
  return { number: Number(number), absent: marker === "null" };
};

const recordsOf = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const records = (value as { records?: unknown }).records;
  return typeof records === "object" && records !== null && !Array.isArray(records)
    ? (records as Record<string, unknown>)
    : undefined;
};

const domainsOf = (value: unknown): string[] | undefined => {
  if (value === null) return [];
  const domains = (value as { domains?: unknown } | undefined)?.domains;
  return Array.isArray(domains) && domains.every((domain) => typeof domain === "string")
    ? domains
    : undefined;
};

type Claim = { token: string; pid: number; host: string; expires?: number };

const claimsOf = (value: unknown): Record<string, Claim> =>
  ((value as { claims?: Record<string, Claim> } | null)?.claims ?? {}) as Record<string, Claim>;

const ownerIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The index and claims documents change by small idempotent edits, so a lost race just re-reads.
const SMALL_EDIT_ATTEMPTS = 5;

/**
 * Shared state in the home Herdr core's document store: one document per domain backlog and
 * capacity queue, one for the harness policy, an index listing the domains (Herdr has no list), the
 * ended records spread over `ENDED_SHARDS` documents, and one claims document per domain. Every
 * write is a compare-and-set on the document's version, so no lock is ever held. Session state and
 * the wiki lint clock stay local files, and archives stay files on the home. An unreachable home
 * fails every call with `StoreOffline`.
 * @param options Home, prefix, transport and local state directory.
 * @returns The store.
 */
export const herdrStore = (options: HerdrStoreOptions): StateStore => {
  const { home, prefix, transport, stateDir } = options;
  const local = filesStore(stateDir);
  const index = `${prefix}domains`;
  const host = options.host ?? hostname();
  const now = options.now ?? Date.now;
  // On this host the owner's pid says whether it still runs; from another host only the expiry
  // can, and a claim without one is taken over.
  const claimHeld = (current: Claim): boolean =>
    current.host === host
      ? ownerIsLive(current.pid)
      : typeof current.expires === "number" && now() < current.expires;

  const isLocal = (key: StateKey) => key.kind === "session" || key.kind === "lint";

  const addressOf = (key: StateKey): Address => {
    switch (key.kind) {
      case "backlog":
        return { name: `${prefix}b.${key.domain}`, field: undefined };
      case "queue":
        return { name: `${prefix}q.${key.domain}`, field: undefined };
      case "policy":
        return { name: `${prefix}policy`, field: undefined };
      case "ended": {
        const shard = (createHash("sha256").update(key.session).digest()[0] ?? 0) % ENDED_SHARDS;
        return { name: `${prefix}ended.${shard}`, field: key.session };
      }
      default:
        throw new Error(`${key.kind} documents stay local`);
    }
  };

  const at = (name: string) => `herdr-doc://${home}/${name}`;

  const location = (key: StateKey): string => {
    if (isLocal(key)) return local.location(key);
    const address = addressOf(key);
    return address.field === undefined ? at(address.name) : `${at(address.name)}#${address.field}`;
  };

  const refusal = (key: StateKey): string | undefined => {
    if (isLocal(key)) return undefined;
    const problem = docNameProblem(addressOf(key).name);
    if (problem === undefined) return undefined;
    return "domain" in key
      ? `domain ${key.domain} cannot be stored in the herdr-doc backend: ${problem}`
      : `${location(key)} cannot be stored in the herdr-doc backend: ${problem}`;
  };

  const offline = (detail: string) =>
    new StoreOffline({
      home,
      message: `the state home ${home} is unreachable (${detail}); shared state was not read or written`,
    });

  let target: { on?: string } | undefined;
  const route = Effect.gen(function* () {
    if (target !== undefined) return target;
    const self = yield* options.self.pipe(
      Effect.mapError((error) =>
        offline(`this machine's herdr-core did not answer: ${error.message}`),
      ),
    );
    // As spec A resolves machine names: "local" and this host's OS name both mean this core.
    target = self === home || home === "local" || home === hostname() ? {} : { on: home };
    return target;
  });

  const call = (requests: readonly DocRequest[]): Effect.Effect<DocReply[], StoreOffline> =>
    Effect.gen(function* () {
      if (requests.length === 0) return [];
      const on = yield* route;
      const replies = yield* transport(
        requests.map(
          (request) => ({ ...request, params: { ...request.params, ...on } }) as DocRequest,
        ),
      ).pipe(Effect.mapError((error) => offline(error.message)));
      const down = replies.find(
        (reply) => !reply.ok && (reply.kind === "unavailable" || reply.kind === "machine_unknown"),
      );
      if (down !== undefined && !down.ok) return yield* offline(down.message);
      return replies;
    });

  // The newest version of each document this store has read or written, so `follow` can tell a
  // change it has not seen yet from the event of one it already holds (its own write).
  const known = new Map<string, number>();
  const note = (name: string, version: number) => {
    if (version > (known.get(name) ?? 0)) known.set(name, version);
  };

  const getDocs = (names: readonly string[]) =>
    Effect.map(
      call(names.map((name) => ({ method: "doc.get" as const, params: { name } }))),
      (replies) =>
        replies.map((reply, index): Doc | { error: string } => {
          if (!reply.ok) return { error: reply.message };
          const doc = reply.result as Doc;
          note(names[index] ?? "", doc.version);
          return doc;
        }),
    );

  const setDoc = (
    name: string,
    value: unknown,
    version: number,
    where: string,
  ): Effect.Effect<number, StoreConflict | BacklogError | StoreOffline> =>
    Effect.gen(function* () {
      const [reply] = yield* call([{ method: "doc.set", params: { name, value, version } }]);
      if (reply === undefined || !reply.ok) {
        if (reply?.kind === "conflict") return yield* new StoreConflict({ location: where });
        return yield* new BacklogError({
          path: where,
          message: `${where}: ${reply?.message ?? "no reply"}`,
        });
      }
      const written = (reply.result as { version: number }).version;
      note(name, written);
      return written;
    });

  const unreadable = (key: StateKey, message: string, stage: "read" | "parse" = "read") =>
    new StoreUnreadable({
      location: location(key),
      stage,
      message,
      detail: message,
      version: null,
    });

  const fromDoc = (key: StateKey, doc: Doc | { error: string }): Stored | StoreUnreadable => {
    if ("error" in doc) return unreadable(key, doc.error);
    const { field } = addressOf(key);
    if (field === undefined) return { value: doc.value, version: encode(doc.version, doc.value) };
    const records = recordsOf(doc.value);
    if (records === undefined)
      return unreadable(key, `${location(key)} holds no ended records`, "parse");
    const value = records[field] ?? null;
    return { value, version: encode(doc.version, value) };
  };

  const readMany = (
    wanted: readonly StateKey[],
  ): Effect.Effect<Array<Stored | StoreUnreadable>, StoreOffline> =>
    Effect.gen(function* () {
      const remote = wanted.filter((key) => !isLocal(key) && refusal(key) === undefined);
      const names = [...new Set(remote.map((key) => addressOf(key).name))];
      const docs = yield* getDocs(names);
      const byName = new Map(names.map((name, index) => [name, docs[index]] as const));
      const results: Array<Stored | StoreUnreadable> = [];
      for (const key of wanted) {
        if (isLocal(key)) {
          results.push(
            yield* local
              .read(key)
              .pipe(Effect.catchTag("StoreUnreadable", (error) => Effect.succeed(error))),
          );
          continue;
        }
        const problem = refusal(key);
        const doc = byName.get(addressOf(key).name);
        results.push(
          problem !== undefined || doc === undefined
            ? unreadable(key, problem ?? "no reply")
            : fromDoc(key, doc),
        );
      }
      return results;
    });

  const read = (key: StateKey): Effect.Effect<Stored, StoreUnreadable | StoreOffline> =>
    isLocal(key)
      ? local.read(key)
      : Effect.flatMap(readMany([key]), ([result]) =>
          result === undefined || result instanceof StoreUnreadable
            ? Effect.fail(result ?? unreadable(key, "no reply"))
            : Effect.succeed(result),
        );

  const changeIndex = (domain: string, present: boolean) =>
    Effect.gen(function* () {
      for (let attempt = 1; ; attempt += 1) {
        const [doc] = yield* getDocs([index]);
        if (doc === undefined || "error" in doc)
          return yield* new BacklogError({ path: at(index), message: doc?.error ?? "no reply" });
        const domains = domainsOf(doc.value);
        if (domains === undefined)
          return yield* new BacklogError({
            path: at(index),
            message: `${at(index)} lists no domains`,
          });
        if (domains.includes(domain) === present) return;
        const next = present
          ? [...domains, domain].toSorted()
          : domains.filter((name) => name !== domain);
        const written = yield* setDoc(index, { domains: next }, doc.version, at(index)).pipe(
          Effect.as(true),
          Effect.catchTag("StoreConflict", (error) =>
            attempt < SMALL_EDIT_ATTEMPTS ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (written) return;
      }
    });

  const write = (
    key: StateKey,
    value: unknown,
    expected: Version,
  ): Effect.Effect<Version, StoreConflict | BacklogError | StoreOffline> =>
    Effect.gen(function* () {
      if (isLocal(key)) return yield* local.write(key, value, expected);
      const where = location(key);
      const problem = refusal(key);
      if (problem !== undefined) return yield* new BacklogError({ path: where, message: problem });
      const { name, field } = addressOf(key);
      const { number, absent } = decodeVersion(expected);
      if (field !== undefined) {
        const [doc] = yield* getDocs([name]);
        if (doc === undefined || "error" in doc)
          return yield* new BacklogError({ path: where, message: doc?.error ?? "no reply" });
        const records = recordsOf(doc.value);
        if (records === undefined)
          return yield* new BacklogError({
            path: where,
            message: `${at(name)} holds no ended records`,
          });
        // Set at the version the caller read: if the shard moved on since, the core refuses it.
        const { [field]: _dropped, ...rest } = records;
        const next = value === null ? rest : { ...rest, [field]: value };
        return encode(yield* setDoc(name, { records: next }, number, where), value);
      }
      const creating = key.kind === "backlog" && absent && value !== null;
      const deleting = key.kind === "backlog" && !absent && value === null;
      // Listed before it exists and unlisted after it is gone, so the index never misses a domain;
      // an entry whose document was never written is filtered out when listing.
      if (creating) yield* changeIndex(key.domain, true);
      const version = yield* setDoc(name, value, number, where);
      if (deleting) yield* changeIndex(key.domain, false);
      return encode(version, value);
    });

  const list = (
    kind: ListedKind,
  ): Effect.Effect<readonly string[], StoreUnreadable | StoreOffline> =>
    Effect.gen(function* () {
      if (kind === "ended") {
        const shards = Array.from(
          { length: ENDED_SHARDS },
          (_, shard) => `${prefix}ended.${shard}`,
        );
        const docs = yield* getDocs(shards);
        const sessions: string[] = [];
        for (const [position, doc] of docs.entries()) {
          const where = at(shards[position] ?? "");
          if ("error" in doc)
            return yield* new StoreUnreadable({
              location: where,
              stage: "read",
              message: doc.error,
              detail: doc.error,
              version: null,
            });
          const records = recordsOf(doc.value);
          if (records === undefined)
            return yield* new StoreUnreadable({
              location: where,
              stage: "parse",
              message: `${where} holds no ended records`,
              detail: "",
              version: null,
            });
          for (const [session, record] of Object.entries(records))
            if (record !== null) sessions.push(session);
        }
        return sessions.toSorted();
      }
      const [doc] = yield* getDocs([index]);
      if (doc === undefined || "error" in doc)
        return yield* new StoreUnreadable({
          location: at(index),
          stage: "read",
          message: doc?.error ?? "no reply",
          detail: "",
          version: null,
        });
      const domains = domainsOf(doc.value);
      if (domains === undefined)
        return yield* new StoreUnreadable({
          location: at(index),
          stage: "parse",
          message: `${at(index)} lists no domains`,
          detail: "",
          version: null,
        });
      const backlogs = yield* getDocs(domains.map((domain) => `${prefix}b.${domain}`));
      return domains
        .filter((_, position) => {
          const backlog = backlogs[position];
          return backlog !== undefined && ("error" in backlog || backlog.value !== null);
        })
        .toSorted();
    });

  const held = new Map<string, { name: string; item: string }>();

  const claim = (
    domain: string,
    item: string,
  ): Effect.Effect<StoreClaim, ClaimBusy | StoreOffline> =>
    Effect.gen(function* () {
      const name = `${prefix}k.${domain}`;
      const where = `${at(name)}#${item}`;
      for (let attempt = 1; ; attempt += 1) {
        const [doc] = yield* getDocs([name]);
        if (doc === undefined || "error" in doc)
          return yield* new ClaimBusy({ message: `queued launch claim is unreadable: ${where}` });
        const claims = claimsOf(doc.value);
        const current = claims[item];
        if (current !== undefined && claimHeld(current))
          return yield* new ClaimBusy({
            message: `queued item is already being retried (pid ${current.pid}${current.host === host ? "" : ` on ${current.host}, until ${new Date(current.expires ?? 0).toISOString()}`})`,
          });
        const token = randomUUID();
        const next = {
          claims: {
            ...claims,
            [item]: { token, pid: process.pid, host, expires: now() + CLAIM_TTL_MS },
          },
        };
        const won: boolean = yield* setDoc(name, next, doc.version, where).pipe(
          Effect.as(true),
          Effect.catchTag("StoreConflict", (error) =>
            attempt < SMALL_EDIT_ATTEMPTS
              ? Effect.succeed(false)
              : Effect.fail(
                  new ClaimBusy({
                    message: `could not take queued launch claim: ${error.location} kept changing`,
                  }),
                ),
          ),
          Effect.catchTag("BacklogError", (error) =>
            Effect.fail(
              new ClaimBusy({ message: `could not take queued launch claim: ${error.message}` }),
            ),
          ),
        );
        if (won) {
          held.set(token, { name, item });
          return { location: where, token };
        }
      }
    });

  const release = (taken: StoreClaim): Effect.Effect<void> =>
    Effect.gen(function* () {
      const owner = held.get(taken.token);
      if (owner === undefined) return;
      for (let attempt = 1; attempt <= SMALL_EDIT_ATTEMPTS; attempt += 1) {
        const [doc] = yield* getDocs([owner.name]);
        if (doc === undefined || "error" in doc) return;
        const claims = claimsOf(doc.value);
        if (claims[owner.item]?.token !== taken.token) break;
        const { [owner.item]: _released, ...rest } = claims;
        const done = yield* setDoc(owner.name, { claims: rest }, doc.version, taken.location).pipe(
          Effect.as(true),
          Effect.catchTag("StoreConflict", () => Effect.succeed(false)),
        );
        if (done) break;
      }
      held.delete(taken.token);
    }).pipe(Effect.ignore);

  const heldClaims = (domains: readonly string[]) =>
    Effect.map(getDocs(domains.map((domain) => `${prefix}k.${domain}`)), (docs) =>
      docs.flatMap((doc, position) => {
        const name = `${prefix}k.${domains[position] ?? ""}`;
        if ("error" in doc) return [at(name)];
        return Object.entries(claimsOf(doc.value))
          .filter(([, held]) => claimHeld(held))
          .map(([item]) => `${at(name)}#${item}`);
      }),
    );

  const appendArchive = (domain: string, lines: readonly string[]) =>
    lines.length === 0
      ? Effect.void
      : Effect.flatMap(route, (on) =>
          on.on === undefined
            ? appendArchiveFile(archivePath(stateDir, domain), lines)
            : options.appendRemote(home, domain, lines),
        );

  const session: StoreSession = { read, write };

  // Herdr subscriptions reach only this core, so only a watcher on the home can be notified. A
  // machine whose own name cannot be read polls.
  const follow = (watched: readonly StateKey[], onChange: () => void) =>
    Effect.gen(function* () {
      const subscribe = options.subscribe;
      if (subscribe === undefined) return undefined;
      const on = yield* route.pipe(Effect.catch(() => Effect.succeed({ on: home })));
      if (on.on !== undefined) return undefined;
      const names = new Set(
        watched.filter((key) => !isLocal(key)).map((key) => addressOf(key).name),
      );
      if (names.size === 0) return undefined;
      const subscription = subscribe([`${prefix}*`], (name, version) => {
        if (names.has(name) && version > (known.get(name) ?? 0)) onChange();
      });
      return { close: subscription.close };
    });

  return {
    backend: "herdr-doc",
    location,
    refusal,
    read,
    readMany,
    write,
    list,
    appendArchive,
    archivesHere: Effect.map(route, (on) => on.on === undefined),
    readArchive: (domain) =>
      Effect.flatMap(route, (on) =>
        on.on === undefined
          ? readArchiveFile(archivePath(stateDir, domain))
          : options.readRemote(home, domain),
      ),
    follow,
    exclusive: (_keys, use) => use(session),
    claim,
    release,
    heldClaims,
  };
};
