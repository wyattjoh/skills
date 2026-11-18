// What the panel shows, decided without Herdr: which domain it follows, whether that domain's
// document is usable, and how its items group. Where the document lives is the store's paths.
import { ITEM_STATUSES, isRecord, validateBacklog } from "../../lib/store.ts";
import type { Ask, Backlog, DelegateRef, Finding, Item, ItemStatus } from "../../lib/store.ts";

/**
 * The terminal label naming the coordinate domain a coordinator or delegate belongs to.
 */
export const DOMAIN_LABEL = "fleet.domain";

// The coordinate CLI's own domain rule, so a label can never steer a read outside backlogs/.
const DOMAIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Each status group's heading.
 */
export const GROUP_LABELS: Readonly<Record<ItemStatus, string>> = {
  "waiting-user": "Waiting on you",
  building: "Building",
  delegated: "Delegated",
  open: "Open",
  parked: "Parked",
  done: "Done",
  dismissed: "Dismissed",
};

/**
 * Closed groups start folded; everything else starts open.
 */
export const FOLDED_BY_DEFAULT: ReadonlySet<ItemStatus> = new Set(["done", "dismissed"]);

/**
 * One status group of the Items card, in routing order.
 */
export type ItemGroup = { status: ItemStatus; label: string; items: Item[] };

/**
 * The document's items grouped by status in routing order, leaving out empty groups.
 * @param backlog A validated document.
 * @returns The non-empty groups.
 */
export const groupItems = (backlog: Backlog): ItemGroup[] =>
  ITEM_STATUSES.map((status) => ({
    status,
    label: GROUP_LABELS[status],
    items: backlog.items.filter((item) => item.status === status),
  })).filter((group) => group.items.length > 0);

/**
 * The findings still open, in document order.
 * @param backlog A validated document.
 * @returns The open findings.
 */
export const openFindings = (backlog: Backlog): Finding[] =>
  backlog.findings.filter((finding) => finding.status === "open");

/**
 * The findings already acted on or dismissed, in document order.
 * @param backlog A validated document.
 * @returns The closed findings.
 */
export const closedFindings = (backlog: Backlog): Finding[] =>
  backlog.findings.filter((finding) => finding.status !== "open");

/**
 * Each finding status's name on its detail screen.
 */
export const FINDING_STATUS_LABELS: Readonly<Record<Finding["status"], string>> = {
  open: "Open",
  acted: "Acted on",
  dismissed: "Dismissed",
};

/**
 * Each finding kind's name on its detail screen.
 */
export const FINDING_KIND_LABELS: Readonly<Record<Finding["kind"], string>> = {
  issue: "Issue",
  opportunity: "Opportunity",
};

/**
 * A screen of the panel: the all-domains listing, one domain's lists, or one item's or
 * finding's detail in a domain.
 */
export type Screen =
  | { kind: "domains" }
  | { kind: "domain"; domain: string }
  | { kind: "item"; domain: string; id: string }
  | { kind: "finding"; domain: string; id: string };

/**
 * One step of the breadcrumb trail: its element id, its label, and the screen it opens, which
 * only the last step (where the trail ends) has none of.
 */
export type Crumb = { id: string; label: string; to: Screen | undefined };

/**
 * The breadcrumb trail down to a screen, root first: Domains, then the domain, then Items or
 * Findings and the record's id. The section step has no screen of its own, so it opens the
 * domain's lists, where its card is.
 * @param screen The screen shown.
 * @returns The crumbs.
 */
export const trailOf = (screen: Screen): Crumb[] => {
  const steps: { id: string; label: string; screen: Screen }[] = [
    { id: "crumb-domains", label: "Domains", screen: { kind: "domains" } },
  ];
  if (screen.kind !== "domains") {
    const lists: Screen = { kind: "domain", domain: screen.domain };
    steps.push({ id: `crumb-domain-${screen.domain}`, label: screen.domain, screen: lists });
    if (screen.kind === "item")
      steps.push(
        { id: "crumb-items", label: "Items", screen: lists },
        { id: `crumb-item-${screen.id}`, label: screen.id, screen },
      );
    if (screen.kind === "finding")
      steps.push(
        { id: "crumb-findings", label: "Findings", screen: lists },
        { id: `crumb-finding-${screen.id}`, label: screen.id, screen },
      );
  }
  return steps.map((step, index) => ({
    id: step.id,
    label: step.label,
    to: index === steps.length - 1 ? undefined : step.screen,
  }));
};

/**
 * One option of an ask as the detail screen lists it: its text, its place in the ask's own
 * list (a stable id), and whether it is the recommendation.
 */
export type RankedOption = { option: string; index: number; rec: boolean };

/**
 * An ask's options with the recommended one first, the rest in their own order.
 * @param ask The ask.
 * @returns The options to list.
 */
export const rankedOptions = (ask: Ask): RankedOption[] => {
  const options = ask.options.map((option, index) => ({ option, index, rec: option === ask.rec }));
  return [...options.filter((entry) => entry.rec), ...options.filter((entry) => !entry.rec)];
};

/**
 * The domain the panel follows. A focused terminal decides: its `fleet.domain` label, or no
 * domain when it has none. With no terminal focused (the panel's own pane, say), the panel
 * keeps the domain it already shows.
 * @param focus Herdr's `focused()`.
 * @param terminals Herdr's `terminals()`.
 * @param previous The domain shown now, if any.
 * @returns The domain to show, or undefined.
 */
export const targetDomain = (
  focus: { terminal: string | null } | null,
  terminals: readonly Record<string, unknown>[],
  previous: string | undefined,
): string | undefined => {
  const address = focus?.terminal ?? null;
  if (address === null) return previous;
  const labels = terminals.find((terminal) => terminal.address === address)?.labels;
  if (!isRecord(labels)) return undefined;
  const domain = labels[DOMAIN_LABEL];
  return typeof domain === "string" && DOMAIN_NAME.test(domain) ? domain : undefined;
};

/**
 * Where the coordinate config file lives (the CLI's default; mods see no environment).
 * @param home The user's home folder.
 * @returns The path.
 */
export const configPath = (home: string): string => `${home}/.config/coordinate/config.json`;

/**
 * The coordinate state folder: the config's `state_dir` with a leading `~` expanded, else the
 * CLI's default. A missing or unreadable config means the default.
 * @param configText The config file's text, or null when it is absent.
 * @param home The user's home folder.
 * @returns The absolute state folder.
 */
export const stateDirOf = (configText: string | null, home: string): string => {
  const fallback = `${home}/.local/state/coordinate`;
  if (configText === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return fallback;
  }
  const dir = isRecord(parsed) ? parsed.state_dir : undefined;
  if (typeof dir !== "string" || dir === "") return fallback;
  if (dir === "~") return home;
  return dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : dir;
};

/**
 * What the panel knows about the followed domain's document.
 */
export type DocumentState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "unreadable"; reason: string }
  | { kind: "loaded"; backlog: Backlog };

/**
 * Read a document's text with the shared validator. Never throws.
 * @param text The file's text, or null when it is absent.
 * @returns The document, or why it can't be shown.
 */
export const readDocument = (text: string | null): DocumentState => {
  if (text === null) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "the file is not JSON" };
  }
  const validated = validateBacklog(parsed);
  return validated.ok
    ? { kind: "loaded", backlog: validated.backlog }
    : { kind: "invalid", reason: validated.errors.join("; ") };
};

/**
 * What the panel shows for a domain while its read is still running: the last state it read for
 * that domain this session, or loading for a domain it has not read yet.
 * @param shown The last state read per domain.
 * @param domain The domain to show, or undefined for the listing.
 * @returns The state to draw until the read finishes.
 */
export const cachedDocument = (
  shown: ReadonlyMap<string, DocumentState>,
  domain: string | undefined,
): DocumentState => (domain === undefined ? undefined : shown.get(domain)) ?? { kind: "loading" };

/**
 * The shell listing the panel runs through exec, `sh -c LIST_SCRIPT <name> <folder>`: each
 * regular `*.json` file's name without the extension, NUL-terminated. A missing folder lists
 * nothing and succeeds; a folder that exists but can't be read exits 1, naming it on stderr.
 */
export const LIST_SCRIPT =
  '[ -d "$1" ] || exit 0; [ -r "$1" ] && [ -x "$1" ] || { echo "cannot read $1" >&2; exit 1; }; for p in "$1"/*.json; do [ -f "$p" ] || continue; n=${p##*/}; printf "%s\\0" "${n%.json}"; done';

/**
 * The domains in the listing script's output: names the CLI could have written, sorted.
 * @param stdout The script's output.
 * @returns The domain names.
 */
export const parseListing = (stdout: string): string[] =>
  stdout
    .split("\0")
    .filter((name) => DOMAIN_NAME.test(name))
    .sort((a, b) => a.localeCompare(b));

/**
 * The counts a listing row shows: items waiting on the user, delegated and open, and open
 * findings.
 */
export type DomainCounts = { waiting: number; delegated: number; open: number; findings: number };

/**
 * A domain's counts.
 * @param backlog A validated document.
 * @returns The counts.
 */
export const countDomain = (backlog: Backlog): DomainCounts => {
  const items = (status: ItemStatus) =>
    backlog.items.filter((item) => item.status === status).length;
  return {
    waiting: items("waiting-user"),
    delegated: items("delegated"),
    open: items("open"),
    findings: backlog.findings.filter((finding) => finding.status === "open").length,
  };
};

/**
 * One listing row: a domain's counts, or why its document can't be shown.
 */
export type DomainSummary =
  | { domain: string; kind: "loaded"; counts: DomainCounts }
  | { domain: string; kind: "invalid" | "unreadable"; reason: string };

/**
 * Summarize a listed domain from its document's state. A document that vanished after the
 * listing leaves the listing.
 * @param domain The domain.
 * @param doc The document's state.
 * @returns The row, or undefined.
 */
export const summarize = (domain: string, doc: DocumentState): DomainSummary | undefined => {
  if (doc.kind === "loaded") return { domain, kind: "loaded", counts: countDomain(doc.backlog) };
  if (doc.kind === "invalid" || doc.kind === "unreadable")
    return { domain, kind: doc.kind, reason: doc.reason };
  return undefined;
};

/**
 * What the panel knows about the all-domains listing.
 */
export type ListingState =
  | { kind: "loading" }
  | { kind: "unreadable"; reason: string }
  | { kind: "loaded"; domains: DomainSummary[] };

/**
 * The terminal label naming the agent session a delegate runs, which delegate refs key on.
 */
export const SESSION_LABEL = "fleet.session";

/**
 * The terminal label naming a fleet terminal's role; the coordinator's is "coordinator".
 */
export const ROLE_LABEL = "fleet.role";

// A session id the CLI could have written, so a ref can never steer a read outside ended/.
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The statuses Herdr reports for a live agent terminal.
 */
export const LIVE_STATUSES = ["working", "idle", "blocked", "done", "error"] as const;

/**
 * A live agent's status, or unknown when it reports none of Herdr's words yet.
 */
export type LiveStatus = (typeof LIVE_STATUSES)[number] | "unknown";

/**
 * Where a delegate stands: a live terminal's status, an ended record (with the date it ended,
 * when the record names one), or neither.
 */
export type DelegateState =
  | { kind: "live"; status: LiveStatus }
  | { kind: "ended"; at: string | null }
  | { kind: "gone" };

/**
 * One delegate line the panel draws: a delegate ref (keyed by its session) or a live terminal
 * no ref names (keyed by its address), with how deep it nests under a parent delegate.
 */
export type DelegateRow = {
  source: "ref" | "terminal";
  key: string;
  name: string;
  depth: number;
  state: DelegateState;
};

/**
 * Every delegate line of a domain: each item's refs with the terminals nested under them, and
 * the live domain terminals no item names.
 */
export type DelegateJoin = { byItem: ReadonlyMap<string, DelegateRow[]>; unfiled: DelegateRow[] };

/**
 * What the panel knows about ended records, by session: the date one ended, null for a record
 * with no readable date, and no entry when there is no record.
 */
export type EndedRecords = ReadonlyMap<string, string | null>;

type Terminal = Record<string, unknown>;

const labelOf = (terminal: Terminal, key: string): string | undefined => {
  const labels = terminal.labels;
  if (!isRecord(labels)) return undefined;
  const value = labels[key];
  return typeof value === "string" ? value : undefined;
};

const liveTerminals = (terminals: readonly Terminal[]): Terminal[] =>
  terminals.filter((terminal) => terminal.state === "live" && typeof terminal.address === "string");

const liveStatus = (terminal: Terminal): LiveStatus => {
  const status = terminal.status;
  return LIVE_STATUSES.find((known) => known === status) ?? "unknown";
};

const terminalName = (terminal: Terminal): string =>
  typeof terminal.name === "string" && terminal.name !== ""
    ? terminal.name
    : String(terminal.address);

/**
 * Every session a delegate ref in the document names, once each, in document order.
 * @param backlog A validated document.
 * @returns The sessions.
 */
export const referencedSessions = (backlog: Backlog): string[] => {
  const seen = new Set<string>();
  for (const item of backlog.items) for (const ref of item.delegates) seen.add(ref.session);
  return [...seen];
};

/**
 * The referenced sessions with no live terminal, whose ended records decide ended or gone.
 * Only sessions safe to name a file are listed.
 * @param backlog A validated document.
 * @param terminals Herdr's `terminals()`.
 * @returns The sessions to look up, in document order.
 */
export const missingSessions = (backlog: Backlog, terminals: readonly Terminal[]): string[] => {
  const live = new Set(
    liveTerminals(terminals).map((terminal) => labelOf(terminal, SESSION_LABEL)),
  );
  return referencedSessions(backlog).filter(
    (session) => !live.has(session) && SESSION_NAME.test(session),
  );
};

/**
 * Where one session's ended record lives.
 * @param stateDir The coordinate state folder.
 * @param session The session id.
 * @returns The path.
 */
export const endedPath = (stateDir: string, session: string): string =>
  `${stateDir}/ended/${session}.json`;

/**
 * The date an ended record names, or null when its text names none.
 * @param text The record's text.
 * @returns The `YYYY-MM-DD` date, or null.
 */
export const endedDate = (text: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const at = isRecord(parsed) ? parsed.ended_at : undefined;
  return typeof at === "string" && at.length >= 10 ? at.slice(0, 10) : null;
};

/**
 * The ended records known after a lookup: every record already known, with each looked-up
 * session's result laid over it, so a domain shown again keeps its delegates' records while
 * its own lookup runs. A looked-up session with no record (undefined) loses any it had.
 * @param known The records known before the lookup.
 * @param found Each looked-up session and the date its record names (null for none), or
 *   undefined when it has no record.
 * @returns The records.
 */
export const mergeEnded = (
  known: EndedRecords,
  found: readonly (readonly [string, string | null | undefined])[],
): EndedRecords => {
  const merged = new Map(known);
  for (const [session, at] of found)
    if (at === undefined) merged.delete(session);
    else merged.set(session, at);
  return merged;
};

/**
 * Join a domain's delegate refs to the live terminals at render time. A ref matches the live
 * terminal whose `fleet.session` label is its session; with none it is ended when an ended
 * record exists, else gone. Live terminals whose `parent` is a shown delegate nest under it.
 * Live `fleet.domain` terminals that no ref names and that nest under nothing, other than the
 * coordinator, are unfiled.
 * @param backlog A validated document.
 * @param terminals Herdr's `terminals()`.
 * @param ended The ended records known for the missing sessions.
 * @param domain The domain shown.
 * @returns Each item's delegate rows, and the unfiled rows.
 */
export const joinDelegates = (
  backlog: Backlog,
  terminals: readonly Terminal[],
  ended: EndedRecords,
  domain: string,
): DelegateJoin => {
  const live = liveTerminals(terminals);
  const referenced = new Set(referencedSessions(backlog));
  const bySession = new Map<string, Terminal>();
  for (const terminal of live) {
    const session = labelOf(terminal, SESSION_LABEL);
    if (session !== undefined && !bySession.has(session)) bySession.set(session, terminal);
  }
  const unreferenced = live.filter((terminal) => {
    const session = labelOf(terminal, SESSION_LABEL);
    return session === undefined || !referenced.has(session);
  });
  // The terminals a ref is shown through, and the unfiled candidates, can both be parents.
  const candidates = unreferenced.filter(
    (terminal) =>
      labelOf(terminal, DOMAIN_LABEL) === domain && labelOf(terminal, ROLE_LABEL) !== "coordinator",
  );
  const parents = new Set<unknown>([
    ...[...bySession.values()].map((terminal) => terminal.address),
    ...candidates.map((terminal) => terminal.address),
  ]);
  const placed = new Set<unknown>();
  const nested = (address: unknown, depth: number): DelegateRow[] =>
    unreferenced
      .filter((terminal) => terminal.parent === address && !placed.has(terminal.address))
      .flatMap((terminal) => {
        placed.add(terminal.address);
        return [terminalRow(terminal, depth), ...nested(terminal.address, depth + 1)];
      });
  const terminalRow = (terminal: Terminal, depth: number): DelegateRow => ({
    source: "terminal",
    key: String(terminal.address),
    name: terminalName(terminal),
    depth,
    state: { kind: "live", status: liveStatus(terminal) },
  });
  const refRows = (ref: DelegateRef): DelegateRow[] => {
    const terminal = bySession.get(ref.session);
    const at = ended.get(ref.session);
    const state: DelegateState =
      terminal !== undefined
        ? { kind: "live", status: liveStatus(terminal) }
        : at !== undefined
          ? { kind: "ended", at }
          : { kind: "gone" };
    const row: DelegateRow = { source: "ref", key: ref.session, name: ref.name, depth: 0, state };
    return terminal === undefined ? [row] : [row, ...nested(terminal.address, 1)];
  };
  const byItem = new Map<string, DelegateRow[]>();
  for (const item of backlog.items) byItem.set(item.id, item.delegates.flatMap(refRows));
  const unfiled = candidates
    .filter((terminal) => !parents.has(terminal.parent) && !placed.has(terminal.address))
    .flatMap((terminal) => {
      placed.add(terminal.address);
      return [terminalRow(terminal, 0), ...nested(terminal.address, 1)];
    });
  return { byItem, unfiled };
};

/**
 * How much a delegate state needs the user, most first: a live agent asking for a person
 * (Herdr's blocked), then one that failed (error), then one at work, then one resting (idle,
 * done, or reporting nothing yet), then a ref with neither terminal nor record (gone), then one
 * whose session ended.
 * @param state The delegate's state.
 * @returns Its rank; lower needs the user more.
 */
export const delegateUrgency = (state: DelegateState): number => {
  if (state.kind === "ended") return 5;
  if (state.kind === "gone") return 4;
  if (state.status === "blocked") return 0;
  if (state.status === "error") return 1;
  if (state.status === "working") return 2;
  return 3;
};

/**
 * A delegate state as a delegate line names it: the live status, gone, or ended with its date
 * when the record names one.
 * @param state The delegate's state.
 * @returns The label.
 */
export const delegateLabel = (state: DelegateState): string => {
  if (state.kind === "live") return state.status;
  if (state.kind === "gone") return "gone";
  return state.at === null ? "ended" : `ended ${state.at}`;
};

/**
 * An item row's second line: its one delegate's name and state, or, with two or more, the most
 * urgent state and the count. The state decides the line's tone. Only the item's own refs
 * count; terminals nested under them do not.
 * @param rows The item's delegate rows.
 * @returns The line, or undefined for an item with no delegate.
 */
export const delegateLine = (
  rows: readonly DelegateRow[],
): { text: string; state: DelegateState } | undefined => {
  const refs = rows.filter((row) => row.source === "ref");
  const [first] = refs;
  if (first === undefined) return undefined;
  if (refs.length === 1)
    return { text: `${first.name} · ${delegateLabel(first.state)}`, state: first.state };
  const urgent = refs.reduce((best, row) =>
    delegateUrgency(row.state) < delegateUrgency(best.state) ? row : best,
  );
  const label = urgent.state.kind === "live" ? urgent.state.status : urgent.state.kind;
  return { text: `${label} ×${refs.length}`, state: urgent.state };
};

// The bun the build found on its PATH, baked in by scripts/build.ts with --define: a mod's exec
// runs with the app's environment, whose PATH (often /usr/bin:/bin:/usr/sbin:/sbin) has no bun.
// Unbundled (in tests) it is undeclared, and the bare name stands in.
declare const COORDINATE_BUN: string | undefined;

/**
 * The installed coordinate CLI, where the skill's installer links it under the user's home.
 * @param home The user's home directory.
 * @returns Its absolute path.
 */
export const coordinateCli = (home: string): string =>
  `${home}/.claude/skills/coordinate/scripts/coordinate.ts`;

/**
 * The command that records an answer: `coordinate item answer`, the one backlog change the CLI
 * accepts from outside a Herdr terminal. `env -u HC_TERMINAL_ID` makes the panel that caller
 * even when the app itself was started from a terminal, and `--` keeps an answer that starts
 * with a dash from reading as a flag.
 * @param home The user's home directory.
 * @param domain The item's domain.
 * @param id The item id.
 * @param answer The answer, one line.
 * @returns The program and its arguments for exec.
 */
export const answerCommand = (
  home: string,
  domain: string,
  id: string,
  answer: string,
): { command: string; args: string[] } => ({
  command: "/usr/bin/env",
  args: [
    "-u",
    "HC_TERMINAL_ID",
    typeof COORDINATE_BUN === "string" ? COORDINATE_BUN : "bun",
    coordinateCli(home),
    "item",
    "answer",
    "--domain",
    domain,
    "--",
    id,
    answer,
  ],
});

/**
 * An answer being written on an item's detail: the option picked, the text typed, and the run
 * recording it. `key` names the domain, item and question, so a new ask starts a fresh draft.
 */
export type AnswerDraft = {
  key: string;
  choice: string | undefined;
  text: string;
  busy: boolean;
  error: string | undefined;
};

/**
 * The key a draft belongs to.
 * @param domain The domain.
 * @param item The item, which has an ask.
 * @param ask The item's ask.
 * @returns The key.
 */
export const draftKey = (domain: string, item: Item, ask: Ask): string =>
  `${domain}\0${item.id}\0${ask.question}`;

/**
 * The draft for a key: the one kept when it matches, else a fresh one with nothing picked, so
 * every answer is chosen before Answer records it.
 * @param key The draft key.
 * @param ask The ask being answered.
 * @param kept The draft the panel holds, if any.
 * @returns The draft.
 */
export const draftFor = (key: string, ask: Ask, kept: AnswerDraft | undefined): AnswerDraft =>
  kept?.key === key ? kept : { key, choice: undefined, text: "", busy: false, error: undefined };

/**
 * What Answer records: typed text when there is any, else the picked option.
 * @param draft The draft.
 * @returns The answer, or undefined when there is none yet.
 */
export const chosenAnswer = (draft: AnswerDraft): string | undefined =>
  draft.text.trim() === "" ? draft.choice : draft.text.trim();

/**
 * What a failed answer run says, for the panel to show as it is.
 * @param result The exec result, with a non-zero code.
 * @returns The CLI's own message, or its exit code when it printed nothing.
 */
export const answerFailure = (result: { code: number; stdout: string; stderr: string }): string =>
  result.stderr.trim() || result.stdout.trim() || `coordinate exited ${result.code}`;
