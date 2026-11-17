// What the panel shows, decided without Herdr: which domain it follows, where that domain's
// document lives, whether the document is usable, and how its items group.
import { ITEM_STATUSES, validateBacklog } from "../../lib/store.ts";
import type { Ask, Backlog, Finding, Item, ItemStatus } from "../../lib/store.ts";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
 * The folder holding every domain's document, which the panel watches.
 * @param stateDir The coordinate state folder.
 * @returns The path.
 */
export const backlogsDir = (stateDir: string): string => `${stateDir}/backlogs`;

/**
 * One domain's document.
 * @param stateDir The coordinate state folder.
 * @param domain The domain.
 * @returns The path.
 */
export const documentPath = (stateDir: string, domain: string): string =>
  `${backlogsDir(stateDir)}/${domain}.json`;

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
