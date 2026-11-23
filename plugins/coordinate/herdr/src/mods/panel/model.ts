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
    label: status === "waiting-user" ? "Answered, waiting for coordinator" : GROUP_LABELS[status],
    items: backlog.items.filter((item) => item.status === status && item.ask === null),
  })).filter((group) => group.items.length > 0);

/**
 * The findings still open, in document order.
 * @param backlog A validated document.
 * @returns The open findings.
 */
export const openFindings = (backlog: Backlog): Finding[] =>
  backlog.findings.filter((finding) => finding.status === "open");

/**
 * A non-empty group of open findings sharing one kind.
 */
export type FindingGroup = {
  kind: Finding["kind"];
  label: string;
  findings: Finding[];
};

const FINDING_GROUPS = [
  { kind: "issue", label: "Issues" },
  { kind: "opportunity", label: "Opportunities" },
] as const;

/**
 * Group open findings by kind, in Issues then Opportunities order, omitting empty groups.
 * @param findings The open findings.
 * @returns The non-empty groups, preserving document order within each kind.
 */
export const groupFindings = (findings: readonly Finding[]): FindingGroup[] =>
  FINDING_GROUPS.map(({ kind, label }) => ({
    kind,
    label,
    findings: findings.filter((finding) => finding.kind === kind),
  })).filter((group) => group.findings.length > 0);

/**
 * Format the open issue and opportunity counts for the domain's Findings row.
 * @param findings The open findings.
 * @returns Both counts, using singular labels for one and plural labels otherwise.
 */
export const formatFindingCounts = (findings: readonly Finding[]): string => {
  const issues = findings.filter((finding) => finding.kind === "issue").length;
  const opportunities = findings.filter((finding) => finding.kind === "opportunity").length;
  return `${issues} ${issues === 1 ? "issue" : "issues"} · ${opportunities} ${opportunities === 1 ? "opportunity" : "opportunities"}`;
};

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
 * A page within one domain's backlog.
 */
export type DomainPage =
  | { kind: "policies"; domain: string }
  | { kind: "findings"; domain: string }
  | { kind: "boundary"; domain: string };

/**
 * A screen of the panel: the all-domains listing, one domain's main list or page, or a record's
 * detail in a domain.
 */
export type Screen =
  | { kind: "domains" }
  | { kind: "domain"; domain: string }
  | DomainPage
  | { kind: "item"; domain: string; id: string }
  | { kind: "finding"; domain: string; id: string };

/**
 * One step of the breadcrumb trail: its element id, label, semantic icon marker, and target screen.
 * Only the last step (where the trail ends) has no target.
 */
export type Crumb = {
  id: string;
  label: string;
  to: Screen | undefined;
  icon: "home" | undefined;
};

/**
 * The breadcrumb trail down to a screen, root first: a home icon, then the domain, then its page,
 * Findings page, or record detail.
 * @param screen The screen shown.
 * @returns The crumbs.
 */
export const trailOf = (screen: Screen): Crumb[] => {
  const steps: { id: string; label: string; screen: Screen }[] = [
    { id: "crumb-home", label: "", screen: { kind: "domains" } },
  ];
  if (screen.kind !== "domains") {
    const lists: Screen = { kind: "domain", domain: screen.domain };
    steps.push({ id: `crumb-domain-${screen.domain}`, label: screen.domain, screen: lists });
    if (screen.kind === "policies") steps.push({ id: "crumb-policies", label: "Policies", screen });
    if (screen.kind === "findings") steps.push({ id: "crumb-findings", label: "Findings", screen });
    if (screen.kind === "boundary") steps.push({ id: "crumb-boundary", label: "Boundary", screen });
    if (screen.kind === "finding")
      steps.push({
        id: "crumb-findings",
        label: "Findings",
        screen: { kind: "findings", domain: screen.domain },
      });
    if (screen.kind === "item")
      steps.push({ id: `crumb-item-${screen.id}`, label: screen.id, screen });
    if (screen.kind === "finding")
      steps.push({ id: `crumb-finding-${screen.id}`, label: screen.id, screen });
  }
  return steps.map((step, index) => ({
    id: step.id,
    label: step.label,
    to: index === steps.length - 1 ? undefined : step.screen,
    icon: index === 0 ? "home" : undefined,
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
 * The backlog JSON documents named in a folder-watch batch.
 */
export type ChangedBacklogs = {
  all: boolean;
  domains: string[];
};

/**
 * Select direct-child backlog JSON paths from a folder-watch batch.
 * @param paths The absolute paths reported by Herdr.
 * @param directory The watched backlogs folder.
 * @returns The domains changed, or `all` when Herdr asks for a full refresh.
 */
export const changedBacklogDocuments = (
  paths: readonly string[],
  directory: string,
): ChangedBacklogs => {
  const root = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = `${root}/`;
  const domains = new Set<string>();
  let all = false;
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === root) {
      all = true;
      continue;
    }
    if (!normalized.startsWith(prefix)) continue;
    const name = normalized.slice(prefix.length);
    if (name.includes("/") || !name.endsWith(".json")) continue;
    const domain = name.slice(0, -".json".length);
    if (DOMAIN_NAME.test(domain)) domains.add(domain);
  }
  return { all, domains: [...domains] };
};

/**
 * The counts a listing row shows: live agents and items waiting on the user, delegated and open.
 */
export type DomainCounts = { agents: number; waiting: number; delegated: number; open: number };

/**
 * A domain's counts.
 * @param backlog A validated document.
 * @param agents The number of distinct referenced delegates with a live terminal.
 * @returns The counts.
 */
export const countDomain = (backlog: Backlog, agents = 0): DomainCounts => {
  const items = (status: ItemStatus) =>
    backlog.items.filter((item) => item.status === status).length;
  return {
    agents,
    waiting: items("waiting-user"),
    delegated: items("delegated"),
    open: items("open"),
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
 * @param agents The number of distinct referenced delegates with a live terminal.
 * @returns The row, or undefined.
 */
export const summarize = (
  domain: string,
  doc: DocumentState,
  agents = 0,
): DomainSummary | undefined => {
  if (doc.kind === "loaded")
    return { domain, kind: "loaded", counts: countDomain(doc.backlog, agents) };
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
 * Count every live delegate row in the join once by key, including referenced, nested and
 * unfiled rows.
 * @param join The joined delegate rows for a domain.
 * @returns The number of distinct live delegate keys.
 */
export const countLiveDelegates = (join: DelegateJoin): number => {
  const keys = new Set<string>();
  const addLiveRows = (rows: readonly DelegateRow[]) => {
    for (const row of rows) if (row.state.kind === "live") keys.add(row.key);
  };
  for (const rows of join.byItem.values()) addLiveRows(rows);
  addLiveRows(join.unfiled);
  return keys.size;
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
 * An item's delegate chip: the most urgent state, with a count only when two or more refs exist.
 * Only the item's own refs count; terminals nested under them do not.
 * @param rows The item's delegate rows.
 * @returns The chip label and its state, or undefined for an item with no delegate.
 */
export const delegateLine = (
  rows: readonly DelegateRow[],
): { text: string; state: DelegateState } | undefined => {
  const refs = rows.filter((row) => row.source === "ref");
  if (refs.length === 0) return undefined;
  const urgent = refs.reduce((best, row) =>
    delegateUrgency(row.state) < delegateUrgency(best.state) ? row : best,
  );
  const label = urgent.state.kind === "live" ? urgent.state.status : urgent.state.kind;
  return {
    text: refs.length < 2 ? label : `${label} ×${refs.length}`,
    state: urgent.state,
  };
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

// The deployed mod's folder name: the harness policy dialog opens another copy of this same mod.
const PANEL_MOD = "coordinate-panel";

/**
 * What a dialog copy of the panel is told: the scope its editor shows and the overlay to close.
 */
export type PolicyDialogProps = {
  domain: string | undefined;
  overlay: string;
};

/**
 * Read the props Herdr gives a copy of the mod, deciding whether it is the harness policy dialog.
 * @param props What `init` received.
 * @returns The dialog's scope and overlay id, or undefined for the panel itself.
 */
export const policyDialogProps = (props: unknown): PolicyDialogProps | undefined => {
  if (!isRecord(props)) return undefined;
  const policy = props.harnessPolicy;
  const overlay = props.overlay;
  if (!isRecord(policy) || typeof overlay !== "string" || overlay === "") return undefined;
  const domain = policy.domain;
  if (domain === null) return { domain: undefined, overlay };
  return typeof domain === "string" && DOMAIN_NAME.test(domain) ? { domain, overlay } : undefined;
};

/**
 * The overlay that opens the harness policy editor as a centered dialog.
 * @param domain The domain whose policy to edit, or undefined for the global defaults.
 * @returns The spec for `openOverlay`.
 */
export const policyDialogSpec = (domain: string | undefined) => ({
  mod: PANEL_MOD,
  kind: "dialog" as const,
  // Herdr would close a plain dialog on a click beside it without asking, so the copy covers the
  // whole window with no frame of its own, draws the settings window centered in it, and treats
  // a click on the rest as Cancel: it closes at once, or asks first with unsaved changes. Herdr
  // still dims the window behind it. Herdr's own win98 mod opens its screens the same way.
  modal: true,
  frame: "none" as const,
  width: 1,
  height: 1,
  props: { harnessPolicy: { domain: domain ?? null } },
});

export type DelegateHarness = "pi" | "claude";

export type HarnessSelection = {
  enabled: DelegateHarness[];
  default: DelegateHarness | null;
};

export type HarnessPolicyView = {
  schemaVersion: 1;
  revision: number;
  path: string;
  global: {
    source: "legacy" | "configured";
    policy: HarnessSelection;
  };
  domain: {
    name: string;
    mode: "inherit" | "replace";
    override: HarnessSelection | null;
    effective: HarnessSelection;
  } | null;
};

export type HarnessPolicyState =
  | { kind: "loading" }
  | { kind: "loaded"; view: HarnessPolicyView }
  | { kind: "error"; message: string };

/**
 * The domains whose policy the CLI reports as their own override (Inherit global off), from one
 * scoped read per domain. A read that failed or is invalid counts as no override.
 * @param reads Each domain with the state its scoped read produced.
 * @returns The overriding domains, in the order given.
 */
export const overridingDomains = (
  reads: readonly (readonly [string, HarnessPolicyState])[],
): string[] => domainOverrides(reads).map(([domain]) => domain);

/**
 * Each domain the CLI reports as having its own override, with that override, from one scoped
 * read per domain. A read that failed or is invalid counts as no override.
 * @param reads Each domain with the state its scoped read produced.
 * @returns The overriding domains and their saved selections, in the order given.
 */
export const domainOverrides = (
  reads: readonly (readonly [string, HarnessPolicyState])[],
): [string, HarnessSelection][] =>
  reads.flatMap(([domain, state]): [string, HarnessSelection][] =>
    state.kind === "loaded" && state.view.domain?.mode === "replace" && state.view.domain.override
      ? [[domain, state.view.domain.override]]
      : [],
  );

/**
 * The harnesses a domain override enables that the global selection disables.
 * @param override The domain's own selection.
 * @param global The global selection.
 * @returns The re-enabled harnesses, in the override's order; empty when none.
 */
export const reenabledHarnesses = (
  override: HarnessSelection,
  global: HarnessSelection,
): DelegateHarness[] => override.enabled.filter((harness) => !global.enabled.includes(harness));

/**
 * A note the policy pane shows under its rows: a domain override that enables a harness global
 * disables, an override that only copies global today and so stops following it, or (on the
 * global scope) a domain whose override keeps a harness this global disables.
 */
export type HarnessPolicyNotice =
  | { kind: "reenabled"; harnesses: DelegateHarness[] }
  | { kind: "frozen" }
  | { kind: "kept"; domain: string; harnesses: DelegateHarness[] };

/**
 * The notes for a scope's draft, measured against the global policy as read (for a domain) or
 * against the draft itself (for global), so they show before Save as well as after it.
 * @param view The policy as read for the scope.
 * @param draft The edit in progress for the scope.
 * @param overrides The listed domains' saved overrides.
 * @returns The notes, in display order.
 */
export const harnessPolicyNotices = (
  view: HarnessPolicyView,
  draft: HarnessPolicyDraft,
  overrides: readonly (readonly [string, HarnessSelection])[],
): HarnessPolicyNotice[] => {
  if (draft.domain === undefined)
    return overrides.flatMap(([domain, override]): HarnessPolicyNotice[] => {
      const harnesses = reenabledHarnesses(override, draft.selection);
      return harnesses.length === 0 ? [] : [{ kind: "kept", domain, harnesses }];
    });
  if (draft.inherit) return [];
  const harnesses = reenabledHarnesses(draft.selection, view.global.policy);
  if (harnesses.length > 0) return [{ kind: "reenabled", harnesses }];
  return sameHarnessSelection(draft.selection, view.global.policy) ? [{ kind: "frozen" }] : [];
};

const runner = (home: string, args: string[]) => ({
  command: "/usr/bin/env",
  args: [
    "-u",
    "HC_TERMINAL_ID",
    typeof COORDINATE_BUN === "string" ? COORDINATE_BUN : "bun",
    coordinateCli(home),
    ...args,
  ],
});

/**
 * Build a canonical policy read through the Coordinate CLI, optionally scoped to one domain.
 * @param home The user's home directory.
 * @param domain The domain to show, or undefined for global defaults.
 * @returns The program and its arguments for exec.
 */
export const harnessPolicyShowCommand = (home: string, domain: string | undefined) =>
  runner(home, [
    "harness-policy",
    "show",
    ...(domain === undefined ? [] : ["--domain", domain]),
    "--json",
  ]);

/**
 * Build a revision-checked complete replacement policy command.
 * @param home The user's home directory.
 * @param domain The domain to replace, or undefined to replace global defaults.
 * @param selection The complete enabled set and optional default.
 * @param revision The revision read before editing.
 * @returns The program and its arguments for exec.
 */
export const harnessPolicySetCommand = (
  home: string,
  domain: string | undefined,
  selection: HarnessSelection,
  revision: number,
) =>
  runner(home, [
    "harness-policy",
    ...(domain === undefined ? ["global-set"] : ["domain-set", domain]),
    "--enabled",
    selection.enabled.length === 0 ? "none" : selection.enabled.join(","),
    ...(selection.default === null ? ["--no-default"] : ["--default", selection.default]),
    "--expected-revision",
    String(revision),
    "--json",
  ]);

/**
 * Build a revision-checked command that restores a domain to global inheritance.
 * @param home The user's home directory.
 * @param domain The domain to reset.
 * @param revision The revision read before editing.
 * @returns The program and its arguments for exec.
 */
export const harnessPolicyResetCommand = (home: string, domain: string, revision: number) =>
  runner(home, [
    "harness-policy",
    "domain-reset",
    domain,
    "--expected-revision",
    String(revision),
    "--json",
  ]);

/**
 * An edit in progress for one scope, seeded from the policy that was read. Nothing is written
 * until it is saved.
 */
export type HarnessPolicyDraft = {
  domain: string | undefined;
  revision: number;
  inherit: boolean;
  selection: HarnessSelection;
};

/**
 * A scope's unsaved draft, with the policy view it was made against. The dialog keeps one per
 * scope, so switching scope shows the other scope's draft and asks nothing.
 */
export type HarnessPolicyDraftEntry = { base: HarnessPolicyView; draft: HarnessPolicyDraft };

/**
 * Carry a draft onto a newer read when its own scope's policy did not change. The revision
 * covers the whole policy file, so a save on another scope moves it too; only a change to this
 * scope's policy makes the draft stale.
 * @param entry The draft and the view it was made against.
 * @param view The newer read for the same scope.
 * @returns The entry against the newer view, or the entry unchanged when its scope's policy changed.
 */
export const rebaseHarnessPolicyDraft = (
  entry: HarnessPolicyDraftEntry,
  view: HarnessPolicyView,
): HarnessPolicyDraftEntry => {
  if (entry.draft.revision === view.revision) return entry;
  const before = seedHarnessPolicyDraft(entry.base, entry.draft.domain);
  const after = seedHarnessPolicyDraft(view, entry.draft.domain);
  if (
    before === undefined ||
    after === undefined ||
    before.inherit !== after.inherit ||
    !sameHarnessSelection(before.selection, after.selection)
  )
    return entry;
  return { base: view, draft: { ...entry.draft, revision: view.revision } };
};

/**
 * The draft that matches the policy as read, for a scope.
 * @param view The policy view the CLI reported for that scope.
 * @param domain The domain, or undefined for the global defaults.
 * @returns A draft equal to what is on disk, or undefined when the view is for another scope.
 */
export const seedHarnessPolicyDraft = (
  view: HarnessPolicyView,
  domain: string | undefined,
): HarnessPolicyDraft | undefined => {
  const source = domain === undefined ? view.global.policy : view.domain?.effective;
  if (source === undefined || (domain !== undefined && view.domain === null)) return undefined;
  return {
    domain,
    revision: view.revision,
    inherit: domain !== undefined && view.domain?.mode === "inherit",
    selection: { enabled: [...source.enabled], default: source.default },
  };
};

/**
 * Whether a draft differs from the policy it was seeded from.
 * @param view The policy as read.
 * @param draft The edit in progress.
 * @returns Whether saving it would change anything.
 */
export const harnessPolicyDraftDirty = (
  view: HarnessPolicyView,
  draft: HarnessPolicyDraft,
): boolean => {
  if (draft.domain === undefined) return !sameHarnessSelection(draft.selection, view.global.policy);
  if (view.domain === null) return false;
  if (draft.inherit !== (view.domain.mode === "inherit")) return true;
  return !draft.inherit && !sameHarnessSelection(draft.selection, view.domain.effective);
};

/**
 * The CLI call that saves a draft: a global or domain set, or a domain reset when it inherits.
 * @param home The user's home directory.
 * @param view The policy as read, which holds the revision to check.
 * @param draft The edit to save.
 * @returns The program and arguments, or undefined when there is nothing to write.
 */
export const harnessPolicySaveCommand = (
  home: string,
  view: HarnessPolicyView,
  draft: HarnessPolicyDraft,
): { command: string; args: string[] } | undefined => {
  if (!harnessPolicyDraftDirty(view, draft)) return undefined;
  if (draft.domain !== undefined && draft.inherit)
    return harnessPolicyResetCommand(home, draft.domain, view.revision);
  return harnessPolicySetCommand(home, draft.domain, draft.selection, view.revision);
};

const harnessOf = (value: unknown): value is DelegateHarness =>
  value === "pi" || value === "claude";

const selectionOf = (value: unknown): HarnessSelection | undefined => {
  if (!isRecord(value) || !Array.isArray(value.enabled)) return undefined;
  const enabledValues = value.enabled;
  if (!enabledValues.every(harnessOf) || new Set(enabledValues).size !== enabledValues.length)
    return undefined;
  const enabled = (["pi", "claude"] as const).filter((harness) => enabledValues.includes(harness));
  const defaultHarness = value.default;
  if (defaultHarness !== null && (!harnessOf(defaultHarness) || !enabled.includes(defaultHarness)))
    return undefined;
  return { enabled, default: defaultHarness };
};

/**
 * Whether two complete selections have the same enabled order and default.
 * @param left First selection.
 * @param right Second selection.
 * @returns Whether they match.
 */
export const sameHarnessSelection = (left: HarnessSelection, right: HarnessSelection): boolean =>
  left.default === right.default &&
  left.enabled.length === right.enabled.length &&
  left.enabled.every((harness) => right.enabled.includes(harness));

/**
 * Parse and validate the canonical JSON view printed by `coordinate harness-policy show`.
 * @param text The CLI's stdout.
 * @param domain The requested domain, or undefined for the global view.
 * @returns The policy view, or undefined when the output is invalid or has the wrong scope.
 */
export const harnessPolicyOutput = (
  text: string,
  domain: string | undefined,
): HarnessPolicyView | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) return undefined;
    if (!Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 0) return undefined;
    if (typeof parsed.path !== "string" || parsed.path === "") return undefined;
    if (!isRecord(parsed.global)) return undefined;
    if (parsed.global.source !== "legacy" && parsed.global.source !== "configured")
      return undefined;
    const globalPolicy = selectionOf(parsed.global.policy);
    if (globalPolicy === undefined) return undefined;
    if (parsed.domain === null) {
      if (domain !== undefined) return undefined;
      return {
        schemaVersion: 1,
        revision: parsed.revision as number,
        path: parsed.path,
        global: { source: parsed.global.source, policy: globalPolicy },
        domain: null,
      };
    }
    if (!isRecord(parsed.domain) || domain === undefined || parsed.domain.name !== domain)
      return undefined;
    if (parsed.domain.mode !== "inherit" && parsed.domain.mode !== "replace") return undefined;
    const override =
      parsed.domain.override === null ? null : (selectionOf(parsed.domain.override) ?? undefined);
    const effective = selectionOf(parsed.domain.effective);
    if (override === undefined || effective === undefined) return undefined;
    if ((parsed.domain.mode === "inherit") !== (override === null)) return undefined;
    const expectedEffective = override ?? globalPolicy;
    if (!sameHarnessSelection(effective, expectedEffective)) return undefined;
    return {
      schemaVersion: 1,
      revision: parsed.revision as number,
      path: parsed.path,
      global: { source: parsed.global.source, policy: globalPolicy },
      domain: {
        name: domain,
        mode: parsed.domain.mode,
        override,
        effective,
      },
    };
  } catch {
    return undefined;
  }
};

/**
 * Turn a policy CLI failure into an actionable editor message.
 * @param result The failed command's exit code and output.
 * @returns The user-facing message.
 */
export const harnessPolicyFailure = (result: {
  code: number;
  stdout: string;
  stderr: string;
}): string => {
  const output = result.stderr.trim() || result.stdout.trim();
  if (/stale harness policy revision/i.test(output))
    return "Policy changed elsewhere. The latest is shown; reapply your change.";
  if (
    /(unknown|unrecognized|no) (command|subcommand)/i.test(output) &&
    /(harness-policy|global-set|domain-set|domain-reset)/i.test(output)
  )
    return "The installed Coordinate CLI is too old for harness policy. Update the Coordinate skill, then reopen this panel.";
  return output || `coordinate exited ${result.code}`;
};

/**
 * Whether a state-directory watch event could include a policy change.
 * @param paths Changed paths from Herdr.
 * @param stateDir Coordinate's configured state directory.
 * @returns Whether to reload the canonical policy view.
 */
export const changedHarnessPolicy = (paths: string[], stateDir: string): boolean => {
  const policy = `${stateDir}/delegate-harness-policy.json`;
  return paths.some((path) => path === stateDir || path === policy);
};

/**
 * Parse and validate the JSON Boundary printed by the coordinate CLI.
 * @param text The CLI's stdout.
 * @returns The owned and adjacent paths, or undefined when the output is invalid.
 */
export const boundaryOutput = (text: string): Backlog["boundary"] | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const boundary = parsed as Record<string, unknown>;
    if (
      !Array.isArray(boundary.owned) ||
      !boundary.owned.every((path) => typeof path === "string") ||
      !Array.isArray(boundary.adjacent) ||
      !boundary.adjacent.every((path) => typeof path === "string")
    )
      return undefined;
    return { owned: boundary.owned, adjacent: boundary.adjacent };
  } catch {
    return undefined;
  }
};

/**
 * Build a boundary edit command, which the CLI accepts from outside a Herdr terminal.
 * `env -u HC_TERMINAL_ID` makes the panel the caller even when the app itself was started from
 * a terminal.
 * @param home The user's home directory.
 * @param domain The domain whose backlog is being edited.
 * @param action Whether to add or remove the path.
 * @param path The repo or folder path to edit.
 * @param adjacent Whether an addition targets the Adjacent list.
 * @returns The program and its arguments for exec.
 */
export const boundaryCommand = (
  home: string,
  domain: string,
  action: "add" | "rm",
  path: string,
  adjacent: boolean,
): { command: string; args: string[] } => ({
  command: "/usr/bin/env",
  args: [
    "-u",
    "HC_TERMINAL_ID",
    typeof COORDINATE_BUN === "string" ? COORDINATE_BUN : "bun",
    coordinateCli(home),
    "backlog",
    "boundary",
    action,
    path,
    ...(action === "add" && adjacent ? ["--adjacent"] : []),
    "--domain",
    domain,
    "--json",
  ],
});

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
  note: string | undefined,
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
    ...(note === undefined ? [] : ["--note", note]),
    "--",
    id,
    answer,
  ],
});

/**
 * The one-line outcome recorded when a question is dismissed from the answer flow.
 */
export const DISMISS_OUTCOME = "Dismissed from the answer flow";

/**
 * Whether an item can still be closed as dismissed: any item that is not already finished.
 * @param item The item.
 * @returns Whether `item close` would accept it.
 */
export const canDismissItem = (item: Item): boolean =>
  item.status !== "done" && item.status !== "dismissed";

/**
 * Build the `coordinate item close --dismissed` call that closes an item as dismissed from the
 * answer flow. It runs the way `answerCommand` does: as the panel, outside any Herdr terminal.
 * @param home The user's home directory.
 * @param domain The item's domain.
 * @param id The item id.
 * @returns The program and its arguments for exec.
 */
export const dismissCommand = (
  home: string,
  domain: string,
  id: string,
): { command: string; args: string[] } => ({
  command: "/usr/bin/env",
  args: [
    "-u",
    "HC_TERMINAL_ID",
    typeof COORDINATE_BUN === "string" ? COORDINATE_BUN : "bun",
    coordinateCli(home),
    "item",
    "close",
    "--domain",
    domain,
    "--dismissed",
    "--outcome",
    DISMISS_OUTCOME,
    "--",
    id,
  ],
});

/**
 * An answer being written on an item's detail: the option picked, a text answer or note, and the
 * run recording it. `key` names the domain, item and question, so a new ask starts a fresh draft.
 */
export type AnswerDraft = {
  key: string;
  choice: string | undefined;
  discuss: boolean;
  text: string;
  note: string;
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
  kept?.key === key
    ? kept
    : {
        key,
        choice: undefined,
        discuss: false,
        text: "",
        note: "",
        busy: false,
        error: undefined,
      };

/**
 * What Answer records: Discuss, the picked option, or typed text when no option is picked.
 * Typed text is a note when an option or Discuss is picked.
 * @param draft The draft.
 * @returns The answer, or undefined when there is none yet.
 */
export const chosenAnswer = (draft: AnswerDraft): string | undefined => {
  const text = draft.text.trim();
  if (draft.discuss) return "Discuss";
  return draft.choice === undefined ? (text === "" ? undefined : text) : draft.choice;
};

/**
 * What a failed answer run says, for the panel to show as it is.
 * @param result The exec result, with a non-zero code.
 * @returns The CLI's own message, or its exit code when it printed nothing.
 */
export const answerFailure = (result: { code: number; stdout: string; stderr: string }): string =>
  result.stderr.trim() || result.stdout.trim() || `coordinate exited ${result.code}`;
