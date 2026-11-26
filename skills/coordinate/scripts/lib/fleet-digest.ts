import { Effect, Option } from "effect";
import { readDocument } from "./backlog-doc.ts";
import { proseSource, questionOf, type Backlog } from "./backlog-store/schema.ts";
import type { Config } from "./config.ts";
import { L } from "./fleet.ts";
import * as hc from "./herdr.ts";

/**
 * What a manager compares between wakes for one domain: open asks and statuses by item, the focus
 * line, and the names of its live delegates.
 */
export type BacklogDigest = {
  asks: Readonly<Record<string, string>>;
  statuses: Readonly<Record<string, string>>;
  focus: string | null;
  delegates: readonly string[];
};

/**
 * The digest of one domain's backlog and live delegates.
 * @param backlog The domain's backlog.
 * @param delegates Names of its live delegates.
 * @returns The digest.
 */
export const backlogDigest = (backlog: Backlog, delegates: readonly string[]): BacklogDigest => ({
  asks: Object.fromEntries(
    backlog.items.flatMap((item) => (item.ask === null ? [] : [[item.id, questionOf(item.ask)]])),
  ),
  statuses: Object.fromEntries(backlog.items.map((item) => [item.id, item.status])),
  focus: proseSource(backlog.focus, backlog.focusMarkdown) || null,
  delegates: [...new Set(delegates)].toSorted(),
});

/**
 * Whether two digests say the same.
 * @param a One digest, or undefined when none was taken.
 * @param b The other.
 * @returns True only when both exist and match.
 */
export const sameDigest = (a: BacklogDigest | undefined, b: BacklogDigest | undefined): boolean =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed in a domain between two digests, one line per change, so a wake needs no reread.
 * @param before The digest at the last wake, or undefined when there was none.
 * @param after The current digest.
 * @returns Status changes, new and closed asks, the focus, and delegates started or ended.
 */
export const digestDelta = (before: BacklogDigest | undefined, after: BacklogDigest): string[] => {
  if (before === undefined) return [];
  const lines: string[] = [];
  for (const [id, status] of Object.entries(after.statuses)) {
    const was = before.statuses[id];
    if (was === undefined) lines.push(`${id} added, ${status}`);
    else if (was !== status) lines.push(`${id} ${was} -> ${status}`);
  }
  for (const [id, question] of Object.entries(after.asks))
    if (before.asks[id] !== question) lines.push(`${id} asks: ${question}`);
  for (const id of Object.keys(before.asks))
    if (after.asks[id] === undefined) lines.push(`${id} ask answered or withdrawn`);
  if (before.focus !== after.focus)
    lines.push(after.focus === null ? "focus cleared" : `focus: ${after.focus}`);
  for (const name of after.delegates)
    if (!before.delegates.includes(name)) lines.push(`delegate ${name} started`);
  for (const name of before.delegates)
    if (!after.delegates.includes(name)) lines.push(`delegate ${name} ended`);
  return lines;
};

/**
 * Read one domain's digest: its backlog document and the delegates this machine lists for it.
 * @param config Config.
 * @param domain Domain.
 * @returns The digest, or undefined when the backlog or the listing could not be read.
 */
export const readDigest = Effect.fn("readDigest")(function* (config: Config, domain: string) {
  const read = yield* Effect.all([
    readDocument(config, domain),
    hc.list([`${L.domain}=${domain}`]),
    hc.list([`${L.role}=coordinator`]),
  ]).pipe(Effect.option);
  if (Option.isNone(read)) return undefined;
  const [{ backlog }, members, coordinators] = read.value;
  const skip = new Set(coordinators.map((terminal) => terminal.address));
  return backlogDigest(
    backlog,
    members
      .filter((terminal) => terminal.live && !skip.has(terminal.address))
      .map((terminal) => terminal.name ?? terminal.address),
  );
});

/** The longest last message a fleet event carries. */
export const LAST_MESSAGE_LIMIT = 1500;

const RULE = /^\s*[─━═-]{8,}\s*$/u;
const ASSISTANT = /^⏺ /u;
const TOOL_CALL = /^⏺ [\w.-]+\(/u;
const CHROME =
  /^\s*(?:✻ |⎿|… \+\d+ lines|(?:Read|Ran|Wrote|Searched|Listed) \d+ |⏵⏵ |\? for shortcuts)/u;

/**
 * The last assistant message on an agent terminal's screen, with the TUI around it stripped: the
 * prompt box and status lines below the last rule, tool calls and their output, and timing lines.
 * A screen with no Claude Code message markers keeps its last few lines of text.
 * @param screen `hc read` output.
 * @returns The message on one line, cut at `LAST_MESSAGE_LIMIT` characters; empty when none.
 */
export const lastMessage = (screen: string): string => {
  const lines = screen.split("\n");
  // The input box sits between the last two rules; everything from the first of them down is chrome.
  const rules = lines.flatMap((line, index) => (RULE.test(line) ? [index] : []));
  const body = rules.length >= 2 ? lines.slice(0, rules.at(-2)) : lines;
  const start = body.findLastIndex((line) => ASSISTANT.test(line) && !TOOL_CALL.test(line));
  let kept: string[];
  if (start === -1) {
    kept = body.filter((line) => line.trim() !== "" && !CHROME.test(line)).slice(-8);
  } else {
    kept = [];
    for (const line of body.slice(start)) {
      if (kept.length > 0 && (/^[❯⏺✻]/u.test(line) || CHROME.test(line))) break;
      kept.push(line.replace(ASSISTANT, ""));
    }
  }
  const text = kept
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return text.length <= LAST_MESSAGE_LIMIT ? text : `${text.slice(0, LAST_MESSAGE_LIMIT)}…`;
};

/**
 * Read a coordinator's last assistant message from its screen.
 * @param address Terminal address.
 * @returns The message, or empty when the screen could not be read.
 */
export const readLastMessage = (address: string) =>
  hc.herdr(["hc", "read", address], 10_000).pipe(
    Effect.map(lastMessage),
    Effect.catch(() => Effect.succeed("")),
  );
