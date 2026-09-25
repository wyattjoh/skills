import { Data, Effect } from "effect";
import { link, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CliIssue } from "./contract.ts";

/**
 * Situations the engine cannot resolve inside the review and fix contract.
 */
export type EscalationKind = "question" | "snapshot_changed" | "retry_exhausted" | "stall_pause";

/**
 * Durable request for judgment that parks exactly one ticket.
 */
export type Escalation = {
  id: string;
  kind: EscalationKind;
  ticket: string | null;
  summary: string;
  detail: string;
  opened_at: string;
};

/**
 * Durable answer that releases a parked ticket.
 */
export type EscalationAnswer = {
  id: string;
  answer: string;
  answered_by: "coordinator" | "user";
  answered_at: string;
};

/**
 * Typed escalation read, write, or validation failure.
 */
export class EscalationError extends Data.TaggedError("EscalationError")<{
  issue: CliIssue;
}> {}

const escalationError = (code: string, message: string, remediation: string): EscalationError =>
  new EscalationError({ issue: { code, message, remediation } });

const ID = /^[A-Za-z0-9][\w.-]{0,127}$/u;

/**
 * Escalation directory inside a run folder.
 *
 * @param runPath - Run folder.
 * @returns The escalations directory.
 */
export const escalationDir = (runPath: string): string => join(runPath, "escalations");

/**
 * Deterministic escalation id so a replayed engine re-parks on the same file.
 *
 * @param ticket - Ticket number, or null for run-wide escalations.
 * @param kind - Escalation kind.
 * @param cycle - Integration cycle or other monotonic ticket counter.
 * @param sequence - Ordinal of this kind within the cycle.
 * @returns A filesystem-safe id.
 */
export const escalationId = (
  ticket: string | null,
  kind: EscalationKind,
  cycle: number,
  sequence: number,
): string => `${ticket ?? "run"}-${kind}-${cycle}-${sequence}`;

const writeOnce = async (path: string, value: unknown): Promise<boolean> => {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const io = <A>(subject: string, body: () => Promise<A>): Effect.Effect<A, EscalationError> =>
  Effect.tryPromise({
    try: body,
    catch: (error) =>
      error instanceof EscalationError
        ? error
        : escalationError(
            "escalation.io_failed",
            `Could not ${subject}: ${(error as Error).message}`,
            "Verify the run folder is writable, then retry.",
          ),
  });

/**
 * Opens an escalation once; a replayed open returns the existing record unchanged.
 *
 * @param runPath - Run folder.
 * @param escalation - Record to create.
 * @returns An Effect containing the durable record and whether it was new.
 */
export const openEscalation = (
  runPath: string,
  escalation: Escalation,
): Effect.Effect<{ escalation: Escalation; created: boolean }, EscalationError> =>
  io("open the escalation", async () => {
    if (!ID.test(escalation.id)) {
      throw escalationError(
        "escalation.id_invalid",
        `Escalation id \`${escalation.id}\` is not filesystem-safe.`,
        "Build ids with escalationId().",
      );
    }
    await mkdir(escalationDir(runPath), { recursive: true });
    const path = join(escalationDir(runPath), `${escalation.id}.json`);
    const created = await writeOnce(path, escalation);
    return { escalation: (await readJson<Escalation>(path))!, created };
  });

/**
 * Records the single answer for an open escalation.
 *
 * @param runPath - Run folder.
 * @param answer - Answer text and who gave it.
 * @returns An Effect containing the stored answer.
 */
export const answerEscalation = (
  runPath: string,
  answer: EscalationAnswer,
): Effect.Effect<EscalationAnswer, EscalationError> =>
  io("record the answer", async () => {
    if (!ID.test(answer.id)) {
      throw escalationError(
        "escalation.id_invalid",
        `Escalation id \`${answer.id}\` is not valid.`,
        "Copy the id from the wait output.",
      );
    }
    const record = await readJson<Escalation>(join(escalationDir(runPath), `${answer.id}.json`));
    if (record === null) {
      throw escalationError(
        "escalation.unknown",
        `No escalation \`${answer.id}\` exists in this run.`,
        "Copy the id from the wait output.",
      );
    }
    if (answer.answer.trim().length === 0) {
      throw escalationError(
        "escalation.answer_empty",
        "An escalation answer must not be empty.",
        "Provide the decision or information the ticket needs.",
      );
    }
    const path = join(escalationDir(runPath), `${answer.id}.answer.json`);
    if (!(await writeOnce(path, answer))) {
      throw escalationError(
        "escalation.already_answered",
        `Escalation \`${answer.id}\` already has an answer.`,
        "Answers are immutable; wait for the engine to act on the recorded one.",
      );
    }
    return answer;
  });

/**
 * Reads the answer for an escalation, if one exists.
 *
 * @param runPath - Run folder.
 * @param id - Escalation id.
 * @returns An Effect containing the answer or null.
 */
export const readAnswer = (
  runPath: string,
  id: string,
): Effect.Effect<EscalationAnswer | null, EscalationError> =>
  io("read the answer", () =>
    readJson<EscalationAnswer>(join(escalationDir(runPath), `${id}.answer.json`)),
  );

/**
 * Parks the calling fiber until the escalation is answered.
 *
 * @param runPath - Run folder.
 * @param id - Escalation id.
 * @param pollMs - Answer file poll interval.
 * @returns An Effect containing the answer.
 */
export const awaitAnswer = (
  runPath: string,
  id: string,
  pollMs: number,
): Effect.Effect<EscalationAnswer, EscalationError> =>
  Effect.gen(function* () {
    while (true) {
      const answer = yield* readAnswer(runPath, id);
      if (answer !== null) return answer;
      yield* Effect.sleep(pollMs);
    }
  });

/**
 * Lists escalations that have no answer yet, oldest first.
 *
 * @param runPath - Run folder.
 * @returns An Effect containing the open escalations.
 */
export const listOpenEscalations = (
  runPath: string,
): Effect.Effect<Escalation[], EscalationError> =>
  io("list escalations", async () => {
    let names: string[];
    try {
      names = await readdir(escalationDir(runPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const answered = new Set(
      names.filter((name) => name.endsWith(".answer.json")).map((name) => name.slice(0, -12)),
    );
    const pending: Escalation[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".answer.json")) continue;
      const id = name.slice(0, -5);
      if (answered.has(id)) continue;
      const record = await readJson<Escalation>(join(escalationDir(runPath), name));
      if (record !== null) pending.push(record);
    }
    return pending.toSorted((left, right) => left.opened_at.localeCompare(right.opened_at));
  });
