/**
 * The backlog document, schema version 1. This folder imports nothing outside itself, so the
 * coordinate CLI and the Herdr bundle share one copy. Keep it free of Node, Bun and Effect.
 */

/**
 * Every item status, in routing order.
 */
export const ITEM_STATUSES = [
  "waiting-user",
  "building",
  "delegated",
  "open",
  "parked",
  "done",
  "dismissed",
] as const;

/**
 * Where an item stands.
 */
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * A dated entry recorded verbatim: a decision or a standing approval.
 */
export type Dated = { text: string; at: string };

/**
 * A question that waits on the user, with the coordinator's recommendation.
 */
export type Ask = {
  question: string;
  context: string | null;
  options: string[];
  rec: string | null;
  recReason: string | null;
};

/**
 * A delegate filed under an item. The session id is the stable key; no address is stored.
 */
export type DelegateRef = {
  name: string;
  session: string;
  branch: string | null;
  worktree: string | null;
  brief: string;
  report: string;
};

/**
 * One unit of work the domain tracks.
 */
export type Item = {
  id: string;
  title: string;
  status: ItemStatus;
  touches: string[];
  decided: Dated[];
  ask: Ask | null;
  due: string | null;
  delegates: DelegateRef[];
  createdAt: string;
  closedAt: string | null;
  outcome: string | null;
};

/**
 * An issue or opportunity noticed outside an item's scope.
 */
export type Finding = {
  id: string;
  kind: "issue" | "opportunity";
  title: string;
  detail: string | null;
  path: string | null;
  from: string | null;
  status: "open" | "acted" | "dismissed";
  closedAt: string | null;
  outcome: string | null;
};

/**
 * One domain's backlog document.
 */
export type Backlog = {
  schemaVersion: 1;
  domain: string;
  focus: string | null;
  legacy: string | null;
  boundary: { owned: string[]; adjacent: string[] };
  standingYes: Dated[];
  items: Item[];
  findings: Finding[];
  nextId: number;
};

/**
 * A validation result: the typed document, or every reason it is not one.
 */
export type Validated = { ok: true; backlog: Backlog } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check an unknown value against schema v1 and its invariants. Never throws.
 * @param value Parsed JSON.
 * @returns The document, or the reasons it is invalid.
 */
export const validateBacklog = (value: unknown): Validated => {
  const errors: string[] = [];
  const text = (where: string, field: unknown): void => {
    if (typeof field !== "string") errors.push(`${where} must be a string`);
  };
  const nonEmpty = (where: string, field: unknown): void => {
    if (typeof field !== "string" || field.trim() === "")
      errors.push(`${where} must be a non-empty string`);
  };
  const textOrNull = (where: string, field: unknown): void => {
    if (field !== null && typeof field !== "string")
      errors.push(`${where} must be a string or null`);
  };
  const strings = (where: string, field: unknown): void => {
    if (!Array.isArray(field) || field.some((entry) => typeof entry !== "string"))
      errors.push(`${where} must be a list of strings`);
  };
  const dated = (where: string, field: unknown): void => {
    if (!Array.isArray(field)) {
      errors.push(`${where} must be a list`);
      return;
    }
    field.forEach((entry: unknown, index) => {
      if (!isRecord(entry)) errors.push(`${where}[${index}] must be an object`);
      else {
        nonEmpty(`${where}[${index}].text`, entry.text);
        nonEmpty(`${where}[${index}].at`, entry.at);
      }
    });
  };
  const list = (where: string, field: unknown): unknown[] => {
    if (Array.isArray(field)) return field;
    errors.push(`${where} must be a list`);
    return [];
  };

  if (!isRecord(value)) return { ok: false, errors: ["the document must be a JSON object"] };
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  nonEmpty("domain", value.domain);
  textOrNull("focus", value.focus);
  textOrNull("legacy", value.legacy);
  if (!isRecord(value.boundary)) errors.push("boundary must be an object");
  else {
    strings("boundary.owned", value.boundary.owned);
    strings("boundary.adjacent", value.boundary.adjacent);
  }
  dated("standingYes", value.standingYes);
  const nextId = value.nextId;
  if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1)
    errors.push("nextId must be a positive integer");

  const ids = new Set<string>();
  const checkId = (where: string, id: unknown, prefix: "i" | "f"): void => {
    if (typeof id !== "string" || !new RegExp(`^${prefix}[1-9]\\d*$`).test(id)) {
      errors.push(`${where}.id must look like ${prefix}1`);
      return;
    }
    if (ids.has(id)) errors.push(`${where}.id ${id} is not unique`);
    ids.add(id);
    if (typeof nextId === "number" && Number(id.slice(1)) >= nextId)
      errors.push(`${where}.id ${id} is not below nextId ${nextId}`);
  };
  const closed = (where: string, closedAt: unknown, outcome: unknown, isClosed: boolean) => {
    if (isClosed) {
      nonEmpty(`${where}.closedAt`, closedAt);
      nonEmpty(`${where}.outcome`, outcome);
    } else {
      textOrNull(`${where}.closedAt`, closedAt);
      textOrNull(`${where}.outcome`, outcome);
    }
  };

  list("items", value.items).forEach((item: unknown, index) => {
    const where = `items[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${where} must be an object`);
      return;
    }
    checkId(where, item.id, "i");
    nonEmpty(`${where}.title`, item.title);
    const status = item.status;
    if (!ITEM_STATUSES.some((known) => known === status))
      errors.push(`${where}.status must be one of ${ITEM_STATUSES.join(", ")}`);
    strings(`${where}.touches`, item.touches);
    dated(`${where}.decided`, item.decided);
    if (item.ask !== null) {
      if (!isRecord(item.ask)) errors.push(`${where}.ask must be an object or null`);
      else {
        nonEmpty(`${where}.ask.question`, item.ask.question);
        textOrNull(`${where}.ask.context`, item.ask.context);
        strings(`${where}.ask.options`, item.ask.options);
        textOrNull(`${where}.ask.rec`, item.ask.rec);
        textOrNull(`${where}.ask.recReason`, item.ask.recReason);
        const { options, rec } = item.ask;
        if (typeof rec === "string" && !(Array.isArray(options) && options.includes(rec)))
          errors.push(`${where}.ask.rec must be one of its options`);
      }
    }
    if (item.due !== null && !(typeof item.due === "string" && DATE.test(item.due)))
      errors.push(`${where}.due must be YYYY-MM-DD or null`);
    const delegates = list(`${where}.delegates`, item.delegates);
    delegates.forEach((ref: unknown, at) => {
      const refWhere = `${where}.delegates[${at}]`;
      if (!isRecord(ref)) {
        errors.push(`${refWhere} must be an object`);
        return;
      }
      nonEmpty(`${refWhere}.name`, ref.name);
      nonEmpty(`${refWhere}.session`, ref.session);
      textOrNull(`${refWhere}.branch`, ref.branch);
      textOrNull(`${refWhere}.worktree`, ref.worktree);
      text(`${refWhere}.brief`, ref.brief);
      text(`${refWhere}.report`, ref.report);
    });
    nonEmpty(`${where}.createdAt`, item.createdAt);
    closed(where, item.closedAt, item.outcome, status === "done" || status === "dismissed");
    if (status === "delegated" && delegates.length === 0)
      errors.push(`${where} is delegated but has no delegate`);
    if (
      status === "waiting-user" &&
      item.ask === null &&
      !(Array.isArray(item.decided) && item.decided.length > 0)
    )
      errors.push(`${where} is waiting-user but has no ask and no decision`);
  });

  list("findings", value.findings).forEach((finding: unknown, index) => {
    const where = `findings[${index}]`;
    if (!isRecord(finding)) {
      errors.push(`${where} must be an object`);
      return;
    }
    checkId(where, finding.id, "f");
    if (finding.kind !== "issue" && finding.kind !== "opportunity")
      errors.push(`${where}.kind must be issue or opportunity`);
    nonEmpty(`${where}.title`, finding.title);
    textOrNull(`${where}.detail`, finding.detail);
    textOrNull(`${where}.path`, finding.path);
    textOrNull(`${where}.from`, finding.from);
    if (!["open", "acted", "dismissed"].includes(String(finding.status)))
      errors.push(`${where}.status must be open, acted or dismissed`);
    closed(where, finding.closedAt, finding.outcome, finding.status !== "open");
  });

  return errors.length === 0
    ? { ok: true, backlog: value as unknown as Backlog }
    : { ok: false, errors };
};
