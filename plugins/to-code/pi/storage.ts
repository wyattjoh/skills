import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { Machine } from "@typeonce/effect-machine";
import { Effect, Schema } from "effect";

import {
  ticketMachine,
  workerMachine,
  type TicketSnapshot,
  type WorkerSnapshot,
} from "../fleet/model.ts";

const WorkerMetadata = {
  id: Schema.NonEmptyString,
  ticketId: Schema.NonEmptyString,
  pane: Schema.NullOr(Schema.NonEmptyString),
  tab: Schema.NullOr(Schema.NonEmptyString),
  name: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  thinking: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh"]),
  pid: Schema.NullOr(Schema.Number),
  callbackReady: Schema.Boolean,
  launch: Schema.Literals(["prepared", "started", "uncertain"]),
  launchError: Schema.NullOr(Schema.NonEmptyString),
};
const TicketMetadata = {
  id: Schema.NonEmptyString,
  implementor: Schema.NonEmptyString,
  reviewer: Schema.NullOr(Schema.NonEmptyString),
};

/**
 * A durable callback remains pending until the recipient's actual custom message is persisted.
 */
export const Callback = Schema.Struct({
  id: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  ticketId: Schema.NonEmptyString,
  workerId: Schema.NonEmptyString,
  assignmentId: Schema.NonEmptyString,
  reportId: Schema.NullOr(Schema.NonEmptyString),
  kind: Schema.Literals([
    "assignment",
    "question",
    "implementation",
    "approval",
    "failure",
    "superseded",
  ]),
  text: Schema.NonEmptyString,
  status: Schema.Literals(["pending", "delivered", "obsolete"]),
});

/**
 * Accepted report identities and request digests make repeated delivery an idempotent operation.
 */
export const ReportRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  workerId: Schema.NonEmptyString,
  assignmentId: Schema.NonEmptyString,
  kind: Schema.Literals([
    "question",
    "implementation",
    "review",
    "approval",
    "failure",
    "re-review",
    "superseded",
  ]),
  requestHash: Schema.NonEmptyString,
  filename: Schema.NullOr(Schema.NonEmptyString),
  fileHash: Schema.NullOr(Schema.NonEmptyString),
  summary: Schema.NonEmptyString,
});

const StoredWorker = Schema.Struct({ ...WorkerMetadata, snapshot: Schema.Unknown });
const StoredTicket = Schema.Struct({ ...TicketMetadata, snapshot: Schema.Unknown });
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
  repository: Schema.NonEmptyString,
  commonDirectory: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  integrationBranch: Schema.NonEmptyString,
  coordinatorPane: Schema.NonEmptyString,
  coordinatorSession: Schema.NonEmptyString,
  coordinatorPid: Schema.Number,
  hostname: Schema.NonEmptyString,
  checks: Schema.Array(Schema.NonEmptyString),
  commandTimeoutMs: Schema.Number,
  workers: Schema.Array(StoredWorker),
  tickets: Schema.Array(StoredTicket),
  reports: Schema.Array(ReportRecord),
  outbox: Schema.Array(Callback),
});

/**
 * Runtime worker metadata plus a schema-decoded production Machine snapshot.
 */
export type WorkerRecord = Omit<typeof StoredWorker.Type, "snapshot"> & {
  readonly snapshot: WorkerSnapshot;
};
/**
 * A ticket owns worker resources, never its branch or the supplied worktree.
 */
export type TicketRecord = Omit<typeof StoredTicket.Type, "snapshot"> & {
  readonly snapshot: TicketSnapshot;
};
/**
 * One atomically committed run owns outcomes, assignments, and the callback outbox together.
 */
export type FleetRun = Omit<typeof Envelope.Type, "workers" | "tickets"> & {
  readonly workers: readonly WorkerRecord[];
  readonly tickets: readonly TicketRecord[];
};

const decode = async (json: string): Promise<FleetRun> => {
  const stored = Schema.decodeUnknownSync(Envelope)(JSON.parse(json));
  const workers = await Promise.all(
    stored.workers.map(async (worker) => ({
      ...worker,
      snapshot: await Effect.runPromise(Machine.decodeSnapshot(workerMachine, worker.snapshot)),
    })),
  );
  const tickets = await Promise.all(
    stored.tickets.map(async (ticket) => ({
      ...ticket,
      snapshot: await Effect.runPromise(Machine.decodeSnapshot(ticketMachine, ticket.snapshot)),
    })),
  );
  if (
    new Set(workers.map((worker) => worker.id)).size !== workers.length ||
    new Set(tickets.map((ticket) => ticket.id)).size !== tickets.length
  ) {
    throw new Error("Duplicate identities in fleet storage");
  }
  return { ...stored, workers, tickets };
};
const encode = async (run: FleetRun): Promise<string> => {
  const workers = await Promise.all(
    run.workers.map(async (worker) => ({
      ...worker,
      snapshot: await Effect.runPromise(Machine.encodeSnapshot(workerMachine, worker.snapshot)),
    })),
  );
  const tickets = await Promise.all(
    run.tickets.map(async (ticket) => ({
      ...ticket,
      snapshot: await Effect.runPromise(Machine.encodeSnapshot(ticketMachine, ticket.snapshot)),
    })),
  );
  return (
    JSON.stringify(Schema.decodeUnknownSync(Envelope)({ ...run, workers, tickets }), null, 2) + "\n"
  );
};
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;
const LockOwner = Schema.Struct({
  pid: Schema.Number,
  token: Schema.NonEmptyString,
  hostname: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
});

/**
 * Durable snapshot storage with a bounded cross-process lock. A proven-dead local writer's
 * nonempty lock is atomically archived to its unique token, never deleted. Keeping that
 * nonempty archive prevents a competing recovery from renaming a newly acquired lock
 * into the old destination. Live, remote-host, and ambiguously owned locks fail closed.
 */
export const fleetStorage = (directory: string, lockTimeoutMs = 5_000) => {
  const stateFile = join(directory, "state.json");
  const lock = join(directory, ".write-lock");
  const commit = async (run: FleetRun): Promise<void> => {
    const filename = join(directory, `.state-${randomUUID()}.tmp`);
    const file = await open(filename, "wx", 0o600);
    try {
      await file.writeFile(await encode(run));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(filename, stateFile);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  const recoverDeadWriter = async (): Promise<void> => {
    let owner: typeof LockOwner.Type;
    try {
      owner = Schema.decodeUnknownSync(LockOwner)(
        JSON.parse(await readFile(join(lock, "owner.json"), "utf8")),
      );
    } catch {
      return;
    }
    if (
      owner.hostname !== hostname() ||
      !/^[a-f0-9-]{36}$/.test(owner.token) ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0
    )
      return;
    try {
      process.kill(owner.pid, 0);
      return;
    } catch (error) {
      if (!hasCode(error, "ESRCH")) return;
    }
    try {
      await rename(lock, join(directory, `.abandoned-lock-${owner.token}`));
    } catch (error) {
      if (!["ENOENT", "EEXIST", "ENOTEMPTY"].some((code) => hasCode(error, code))) throw error;
    }
  };
  const locked = async <A>(operation: () => Promise<A>): Promise<A> => {
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Fleet writer lock timed out: ${lock}. Inspect owner.json; never steal a live or ambiguous lock.`,
            { cause: error },
          );
        await recoverDeadWriter();
        await setTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
    const owner = join(lock, "owner.json");
    try {
      const file = await open(owner, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            pid: process.pid,
            token: randomUUID(),
            hostname: hostname(),
            createdAt: new Date().toISOString(),
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      return await operation();
    } finally {
      await unlink(owner);
      await rmdir(lock);
    }
  };
  return {
    read: async (): Promise<FleetRun> => decode(await readFile(stateFile, "utf8")),
    initialize: async (run: FleetRun): Promise<void> => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await locked(async () => {
        const reserved = await open(stateFile, "wx", 0o600);
        await reserved.close();
        await commit(run);
      });
    },
    change: async <A>(
      operation: (run: FleetRun) => Promise<{ run: FleetRun; value: A }>,
    ): Promise<A> =>
      locked(async () => {
        const current = await decode(await readFile(stateFile, "utf8"));
        const result = await operation(current);
        await commit(result.run);
        return result.value;
      }),
  };
};

/**
 * Storage port shared by the controller and deterministic runtime tests.
 */
export type FleetStorage = ReturnType<typeof fleetStorage>;
