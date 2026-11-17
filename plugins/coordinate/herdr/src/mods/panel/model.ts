// What the panel shows, decided without Herdr: which domain it follows, where that domain's
// document lives, whether the document is usable, and how its items group.
import { ITEM_STATUSES, validateBacklog } from "../../lib/store.ts";
import type { Backlog, Item, ItemStatus } from "../../lib/store.ts";

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
