import { Effect, Option, Schema } from "effect";
import type { Config } from "./config.ts";
import { L, readEnded, Refused, sessionOf, VerdictSchema, writeEnded } from "./fleet.ts";
import * as hc from "./herdr.ts";
import { stateStore } from "./state.ts";
import { BacklogError, keys, runCommand } from "./state-store.ts";

/**
 * Why a retro is due: a problem verdict, two or more resumes, or the domain's fifth settled delegate.
 */
export const RETRO_REASONS = ["problem", "resumes", "every-5th"] as const;

const RetroMarkerSchema = Schema.Struct({
  turn: Schema.Number,
  reason: Schema.Literals(RETRO_REASONS),
  at: Schema.String,
});

/**
 * The last retro due for a session: the turn it was due at, why, and when.
 */
export type RetroMarker = typeof RetroMarkerSchema.Type;

const SessionStateSchema = Schema.Struct({
  session: Schema.String,
  resumes: Schema.Number,
  verdict: Schema.NullOr(VerdictSchema),
  // Optional, so session files written before retro sampling keep their resumes and verdicts.
  counted: Schema.optionalKey(Schema.Boolean),
  retro: Schema.optionalKey(Schema.NullOr(RetroMarkerSchema)),
});

/**
 * What coordinate keeps about one delegate session across ends, resumes and restarts: how many
 * times it was resumed, the latest verify verdict, whether the domain's settled-delegate counter
 * has counted it, and its last retro marker.
 */
export type SessionState = typeof SessionStateSchema.Type;

/**
 * Whether a settle makes a retro due, and why. A problem verdict newer than the last marker always
 * fires, scoped to the turns since that marker; otherwise a session gets one routine retro at most,
 * for two or more resumes or for being the domain's fifth (tenth, ...) settled delegate.
 * @param state The session's state before this settle.
 * @param fifth This settle counted the session and brought the domain's counter to a multiple of 5.
 * @returns The reason and the marker turn it is scoped after, or undefined when no retro is due.
 */
export const retroDue = (
  state: SessionState,
  fifth: boolean,
): { reason: RetroMarker["reason"]; since: number | undefined } | undefined => {
  const marker = state.retro ?? undefined;
  if (state.verdict?.result === "problem" && (marker === undefined || state.verdict.at > marker.at))
    return { reason: "problem", since: marker?.turn };
  if (marker !== undefined) return undefined;
  if (state.resumes >= 2) return { reason: "resumes", since: undefined };
  if (fifth) return { reason: "every-5th", since: undefined };
  return undefined;
};

/**
 * Record a settle on a session: counted by the domain's settled-delegate counter, and its retro
 * marker when one came due. Re-reads the file so a verdict recorded meanwhile survives.
 * @param stateDir State dir.
 * @param session Session id.
 * @param retro The new marker, or undefined to keep the old one.
 * @returns The updated state.
 */
export const markSettled = Effect.fn("markSettled")(function* (
  stateDir: string,
  session: string,
  retro: RetroMarker | undefined,
) {
  return yield* changeSession(stateDir, session, (state) => ({
    ...state,
    counted: true,
    ...(retro === undefined ? {} : { retro }),
  }));
});

const decodeSession = (session: string, value: unknown): SessionState =>
  Option.getOrElse(Schema.decodeUnknownOption(SessionStateSchema)(value), () => ({
    session,
    resumes: 0,
    verdict: null,
  }));

/**
 * One session's state; a session never verified or resumed reads as zero resumes and no verdict.
 * @param stateDir State dir.
 * @param session Session id.
 * @returns Its state.
 */
export const readSession = Effect.fn("readSession")(function* (stateDir: string, session: string) {
  const stored = yield* stateStore(stateDir).read(keys.session(session)).pipe(Effect.option);
  return decodeSession(session, Option.isSome(stored) ? stored.value.value : null);
});

/**
 * Change one session's state: re-read it, apply `update`, and write the result.
 */
const changeSession = (
  stateDir: string,
  session: string,
  update: (state: SessionState) => SessionState,
) =>
  runCommand(stateStore(stateDir), keys.session(session), (current) => {
    const next = update(decodeSession(session, current.value));
    return Effect.succeed({ write: true as const, next, value: next });
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "StoreUnreadable"
        ? new BacklogError({ path: error.location, message: error.message })
        : error,
    ),
  );

/**
 * Count one more resume of a session.
 * @param stateDir State dir.
 * @param session Session id.
 * @returns The updated state.
 */
export const countResume = Effect.fn("countResume")(function* (stateDir: string, session: string) {
  return yield* changeSession(stateDir, session, (state) => ({
    ...state,
    resumes: state.resumes + 1,
  }));
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
  const recorded = yield* changeSession(config.stateDir, session, (state) => ({
    ...state,
    verdict: {
      result: verdict.result,
      reason: verdict.result === "problem" ? verdict.reason : null,
      at: new Date().toISOString(),
    },
  }));
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
