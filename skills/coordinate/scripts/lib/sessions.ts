import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { Config } from "./config.ts";
import { L, readEnded, Refused, sessionOf, VerdictSchema, writeEnded } from "./fleet.ts";
import * as hc from "./herdr.ts";

const SessionStateSchema = Schema.Struct({
  session: Schema.String,
  resumes: Schema.Number,
  verdict: Schema.NullOr(VerdictSchema),
});

/**
 * What coordinate keeps about one delegate session across ends, resumes and restarts: how many
 * times it was resumed and the latest verify verdict.
 */
export type SessionState = typeof SessionStateSchema.Type;

/**
 * Folder of per-session state, beside the ended records.
 * @param stateDir State dir.
 * @returns Path.
 */
const sessionsDir = (stateDir: string): string => join(stateDir, "sessions");

const sessionPath = (stateDir: string, session: string): string =>
  join(sessionsDir(stateDir), `${session}.json`);

/**
 * One session's state; a session never verified or resumed reads as zero resumes and no verdict.
 * @param stateDir State dir.
 * @param session Session id.
 * @returns Its state.
 */
export const readSession = Effect.fn("readSession")(function* (stateDir: string, session: string) {
  const fresh: SessionState = { session, resumes: 0, verdict: null };
  const decoded = yield* Effect.tryPromise(async () =>
    JSON.parse(await readFile(sessionPath(stateDir, session), "utf8")),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionStateSchema)), Effect.option);
  return Option.getOrElse(decoded, () => fresh);
});

const writeSession = Effect.fn("writeSession")(function* (stateDir: string, state: SessionState) {
  const dir = sessionsDir(stateDir);
  const path = sessionPath(stateDir, state.session);
  yield* Effect.promise(async () => {
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(state, null, 1)}\n`);
    await rename(temp, path);
  });
  return state;
});

/**
 * Count one more resume of a session.
 * @param stateDir State dir.
 * @param session Session id.
 * @returns The updated state.
 */
export const countResume = Effect.fn("countResume")(function* (stateDir: string, session: string) {
  const state = yield* readSession(stateDir, session);
  return yield* writeSession(stateDir, { ...state, resumes: state.resumes + 1 });
});

/**
 * Record a verify verdict for a delegate, live or ended: a live terminal by name or address that
 * runs a session (its label, else its `--session-id`/`--resume` argument), else the newest ended record with that name. An ended record is
 * rewritten with the verdict too, so the record shows it.
 * @param config Config.
 * @param target Delegate name or address.
 * @param verdict `ok`, or `problem` with a reason.
 * @param json Print the session state as JSON.
 * @returns Lines to print.
 */
export const verifyDelegate = Effect.fn("verifyDelegate")(function* (
  config: Config,
  target: string,
  verdict: { result: "ok" } | { result: "problem"; reason: string },
  json: boolean,
) {
  if (verdict.result === "problem" && verdict.reason.trim() === "")
    return yield* new Refused({ message: '--problem needs a reason: --problem "<why>"' });
  const terminal = yield* hc.get(target);
  const liveSession =
    terminal && terminal.labels[L.role] !== "coordinator"
      ? sessionOf(terminal) || undefined
      : undefined;
  const ended = liveSession
    ? undefined
    : (yield* readEnded(config.stateDir)).records
        .filter((entry) => entry.record.name === target)
        .toSorted((a, b) => b.record.ended_at.localeCompare(a.record.ended_at))[0];
  const session = liveSession ?? ended?.record.session;
  if (!session)
    return yield* new Refused({
      message: `no delegate ${target}: no live delegate terminal or ended record has that name`,
    });
  const name = ended?.record.name ?? terminal?.name ?? target;
  const state = yield* readSession(config.stateDir, session);
  const recorded = yield* writeSession(config.stateDir, {
    ...state,
    verdict: {
      result: verdict.result,
      reason: verdict.result === "problem" ? verdict.reason : null,
      at: new Date().toISOString(),
    },
  });
  if (ended)
    yield* writeEnded(config.stateDir, {
      ...ended.record,
      verdict: recorded.verdict,
      resumes: recorded.resumes,
    });
  if (json) return [JSON.stringify(recorded, null, 2)];
  return [
    verdict.result === "ok"
      ? `recorded ok for ${name} (session ${session})`
      : `recorded problem for ${name} (session ${session}): ${verdict.reason}`,
  ];
});
