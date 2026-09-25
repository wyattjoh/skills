import { Data, Effect } from "effect";
import { open, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { CliIssue } from "./contract.ts";

/**
 * File name of the append-only engine event log inside a run folder.
 */
export const EVENT_LOG_FILE = "events.ndjson";

/**
 * One durable engine event. `seq` is strictly increasing from 1 within a run.
 */
export type RuntimeEvent = {
  seq: number;
  at: string;
  type: string;
  ticket: string | null;
  attention: boolean;
  data: Record<string, unknown>;
};

/**
 * Event content supplied by the engine; the log assigns `seq` and `at`.
 */
export type RuntimeEventInput = {
  type: string;
  ticket: string | null;
  attention: boolean;
  data: Record<string, unknown>;
};

/**
 * Single-writer handle over one run's event log. Concurrent appends are
 * serialized in call order.
 */
export type EventLog = {
  path: string;
  lastSeq: () => number;
  append: (event: RuntimeEventInput) => Effect.Effect<RuntimeEvent, EventLogError>;
};

/**
 * Events read after a cursor plus the cursor to pass next time.
 */
export type EventPage = {
  events: RuntimeEvent[];
  next_cursor: number;
};

/**
 * Typed event log read, parse, or write failure.
 */
export class EventLogError extends Data.TaggedError("EventLogError")<{
  issue: CliIssue;
}> {}

const eventLogError = (code: string, message: string, remediation: string): EventLogError =>
  new EventLogError({ issue: { code, message, remediation } });

/**
 * Resolves the event log path for a run folder.
 *
 * @param runPath - Run folder containing RESUME.md.
 * @returns The absolute or run-relative event log path.
 */
export const eventLogPath = (runPath: string): string => join(runPath, EVENT_LOG_FILE);

const readText = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const parseLine = (line: string): RuntimeEvent | undefined => {
  try {
    const value = JSON.parse(line) as Partial<RuntimeEvent>;
    if (
      typeof value.seq !== "number" ||
      !Number.isSafeInteger(value.seq) ||
      typeof value.type !== "string" ||
      typeof value.at !== "string"
    ) {
      return undefined;
    }
    return {
      seq: value.seq,
      at: value.at,
      type: value.type,
      ticket: typeof value.ticket === "string" ? value.ticket : null,
      attention: value.attention === true,
      data:
        typeof value.data === "object" && value.data !== null && !Array.isArray(value.data)
          ? value.data
          : {},
    };
  } catch {
    return undefined;
  }
};

type Parsed = {
  events: RuntimeEvent[];
  completeBytes: number;
};

/**
 * Parses complete lines only. A trailing line without a newline is a torn write
 * from an interrupted engine and is never returned.
 */
const parseLog = (text: string, path: string): Parsed => {
  const events: RuntimeEvent[] = [];
  let offset = 0;
  let completeBytes = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) break;
    const line = text.slice(offset, newline);
    offset = newline + 1;
    completeBytes = Buffer.byteLength(text.slice(0, offset));
    if (line.length === 0) continue;
    const event = parseLine(line);
    const previous = events.at(-1)?.seq ?? 0;
    if (event === undefined || event.seq !== previous + 1) {
      throw eventLogError(
        "event_log.corrupt",
        `Event log \`${path}\` has a malformed or out-of-order entry after seq ${previous}.`,
        "Stop the engine and inspect the event log; never edit it while an engine holds the lease.",
      );
    }
    events.push(event);
  }
  return { events, completeBytes };
};

const toError = (error: unknown, code: string, subject: string): EventLogError =>
  error instanceof EventLogError
    ? error
    : eventLogError(
        code,
        `Could not ${subject}: ${(error as Error).message}`,
        "Verify the run folder is readable and writable, then retry.",
      );

/**
 * Opens the log for the single engine writer, truncating a torn trailing line.
 *
 * @param runPath - Run folder containing RESUME.md.
 * @param now - Clock used for event timestamps.
 * @returns An Effect containing the append handle.
 */
export const openEventLog = (
  runPath: string,
  now: () => Date = () => new Date(),
): Effect.Effect<EventLog, EventLogError> =>
  Effect.tryPromise({
    try: async () => {
      const path = eventLogPath(runPath);
      const text = await readText(path);
      const parsed = parseLog(text, path);
      if (parsed.completeBytes !== Buffer.byteLength(text)) {
        await truncate(path, parsed.completeBytes);
      }
      let seq = parsed.events.at(-1)?.seq ?? 0;
      // Engine fibers append concurrently. Chaining every write behind the
      // previous one keeps `seq` assignment and file order in lockstep.
      let tail: Promise<unknown> = Promise.resolve();
      const write = async (input: RuntimeEventInput): Promise<RuntimeEvent> => {
        const event: RuntimeEvent = {
          seq: seq + 1,
          at: now()
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
          type: input.type,
          ticket: input.ticket,
          attention: input.attention,
          data: input.data,
        };
        const handle = await open(path, "a");
        try {
          await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        seq = event.seq;
        return event;
      };
      const append = (input: RuntimeEventInput): Effect.Effect<RuntimeEvent, EventLogError> =>
        Effect.tryPromise({
          try: () => {
            const result = tail.then(() => write(input));
            tail = result.catch(() => undefined);
            return result;
          },
          catch: (error) => toError(error, "event_log.append_failed", "append to the event log"),
        });
      return { path, lastSeq: () => seq, append };
    },
    catch: (error) => toError(error, "event_log.open_failed", "open the event log"),
  });

/**
 * Reads every complete event whose sequence is greater than the cursor.
 *
 * @param runPath - Run folder containing the event log.
 * @param cursor - Last sequence the reader has already processed.
 * @returns An Effect containing the events and the next cursor.
 */
export const readEventsSince = (
  runPath: string,
  cursor: number,
): Effect.Effect<EventPage, EventLogError> =>
  Effect.tryPromise({
    try: async () => {
      const path = eventLogPath(runPath);
      const { events } = parseLog(await readText(path), path);
      const last = events.at(-1)?.seq ?? 0;
      if (cursor > last) {
        throw eventLogError(
          "event_log.cursor_ahead",
          `Cursor ${cursor} is ahead of the last event ${last} in \`${path}\`.`,
          "Pass a cursor returned by a previous wait, or 0 to read from the start.",
        );
      }
      return { events: events.filter((event) => event.seq > cursor), next_cursor: last };
    },
    catch: (error) => toError(error, "event_log.read_failed", "read the event log"),
  });
