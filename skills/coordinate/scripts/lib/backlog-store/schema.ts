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
  "in-review",
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
 * A dated item event, such as a decision or a discussion request.
 */
export type Dated = { text: string; at: string };

/**
 * Whether a dated entry records a discussion request rather than a decision or answer.
 * @param text The entry text.
 * @returns True for the reserved discussion event format.
 */
export const isDiscussion = (text: string): boolean => text.startsWith('Discuss "');

/**
 * A reusable policy recorded with its stable short id and date.
 */
export type Policy = { id: string; text: string; at: string };

/**
 * A request to discuss an ask before the user decides it.
 */
export type DiscussionRequest = { note: string; at: string };

/**
 * A question that waits on the user, with the coordinator's recommendation and optional discussion request.
 */
export type Ask = {
  question: string;
  context: string | null;
  options: string[];
  optionDetails?: string[];
  rec: string | null;
  recReason: string | null;
  discuss: DiscussionRequest | null;
};

/** A completed ask and the answer recorded at the time it was resolved. */
export type AnsweredAsk = Ask & { answer: string; note: string | null; answeredAt: string };

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
  answered: AnsweredAsk[];
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
  policies: Policy[];
  items: Item[];
  findings: Finding[];
  nextId: number;
  nextPolicyId: number;
};

/**
 * A validation result: the typed document, or every reason it is not one.
 */
export type Validated = { ok: true; backlog: Backlog } | { ok: false; errors: string[] };

/**
 * Whether a parsed JSON value is an object (not null, not an array), so its fields can be read.
 * @param value Any value.
 * @returns True for a plain object.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize legacy `standingYes` entries to ordered policy ids and derive a missing policy counter,
 * then validate schema v1 and its invariants. Never throws.
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
  const candidate: Record<string, unknown> = { ...value };
  if (!("policies" in candidate) && Array.isArray(candidate.standingYes)) {
    const policies = candidate.standingYes.map((entry: unknown, index) =>
      isRecord(entry) ? { id: `p${index + 1}`, text: entry.text, at: entry.at } : entry,
    );
    candidate.policies = policies;
    delete candidate.standingYes;
  } else if ("policies" in candidate && "standingYes" in candidate) {
    errors.push("standingYes cannot be combined with policies");
  }
  if (!("nextPolicyId" in candidate) && Array.isArray(candidate.policies)) {
    candidate.nextPolicyId = candidate.policies.reduce((next: number, entry: unknown) => {
      if (!isRecord(entry) || typeof entry.id !== "string") return next;
      const match = /^p([1-9]\d*)$/.exec(entry.id);
      const number = match?.[1] === undefined ? 0 : Number(match[1]);
      return Number.isSafeInteger(number) ? Math.max(next, number + 1) : next;
    }, 1);
  }
  if (Array.isArray(candidate.items)) {
    const migrateAsk = (ask: unknown): unknown =>
      isRecord(ask) && !("discuss" in ask) ? { ...ask, discuss: null } : ask;
    candidate.items = candidate.items.map((item: unknown) => {
      if (!isRecord(item)) return item;
      return {
        ...item,
        ...(!("answered" in item) ? { answered: [] } : {}),
        ...(item.ask === null || item.ask === undefined ? {} : { ask: migrateAsk(item.ask) }),
        ...(Array.isArray(item.answered)
          ? {
              answered: item.answered.map((entry: unknown) =>
                isRecord(entry)
                  ? {
                      ...(!("discuss" in entry) ? { discuss: null } : {}),
                      ...(!("note" in entry) ? { note: null } : {}),
                      ...entry,
                    }
                  : entry,
              ),
            }
          : {}),
      };
    });
  }
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  nonEmpty("domain", candidate.domain);
  textOrNull("focus", candidate.focus);
  textOrNull("legacy", candidate.legacy);
  if (!isRecord(candidate.boundary)) errors.push("boundary must be an object");
  else {
    strings("boundary.owned", candidate.boundary.owned);
    strings("boundary.adjacent", candidate.boundary.adjacent);
  }
  const policies = list("policies", candidate.policies);
  policies.forEach((policy: unknown, index) => {
    const where = `policies[${index}]`;
    if (!isRecord(policy)) {
      errors.push(`${where} must be an object`);
      return;
    }
    nonEmpty(`${where}.text`, policy.text);
    nonEmpty(`${where}.at`, policy.at);
  });
  const nextId = candidate.nextId;
  if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1)
    errors.push("nextId must be a positive integer");
  const nextPolicyId = candidate.nextPolicyId;
  if (typeof nextPolicyId !== "number" || !Number.isInteger(nextPolicyId) || nextPolicyId < 1)
    errors.push("nextPolicyId must be a positive integer");

  const ids = new Set<string>();
  const checkId = (where: string, id: unknown, prefix: "i" | "f" | "p"): void => {
    if (typeof id !== "string" || !new RegExp(`^${prefix}[1-9]\\d*$`).test(id)) {
      errors.push(`${where}.id must look like ${prefix}1`);
      return;
    }
    if (ids.has(id)) errors.push(`${where}.id ${id} is not unique`);
    ids.add(id);
    const counter = prefix === "p" ? nextPolicyId : nextId;
    const counterName = prefix === "p" ? "nextPolicyId" : "nextId";
    if (typeof counter === "number" && Number(id.slice(1)) >= counter)
      errors.push(`${where}.id ${id} is not below ${counterName} ${counter}`);
  };
  policies.forEach((policy: unknown, index) => {
    if (isRecord(policy)) checkId(`policies[${index}]`, policy.id, "p");
  });
  const closed = (where: string, closedAt: unknown, outcome: unknown, isClosed: boolean) => {
    if (isClosed) {
      nonEmpty(`${where}.closedAt`, closedAt);
      nonEmpty(`${where}.outcome`, outcome);
    } else {
      textOrNull(`${where}.closedAt`, closedAt);
      textOrNull(`${where}.outcome`, outcome);
    }
  };

  list("items", candidate.items).forEach((item: unknown, index) => {
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
    const checkAsk = (askWhere: string, ask: unknown): void => {
      if (!isRecord(ask)) {
        errors.push(`${askWhere} must be an object`);
        return;
      }
      nonEmpty(`${askWhere}.question`, ask.question);
      textOrNull(`${askWhere}.context`, ask.context);
      strings(`${askWhere}.options`, ask.options);
      if (ask.optionDetails !== undefined) {
        strings(`${askWhere}.optionDetails`, ask.optionDetails);
        if (
          Array.isArray(ask.optionDetails) &&
          Array.isArray(ask.options) &&
          ask.optionDetails.length !== ask.options.length
        )
          errors.push(`${askWhere}.optionDetails must have the same length as options`);
      }
      textOrNull(`${askWhere}.rec`, ask.rec);
      textOrNull(`${askWhere}.recReason`, ask.recReason);
      if (ask.discuss !== null) {
        if (!isRecord(ask.discuss)) errors.push(`${askWhere}.discuss must be an object or null`);
        else {
          text(`${askWhere}.discuss.note`, ask.discuss.note);
          if (typeof ask.discuss.at !== "string" || !DATE.test(ask.discuss.at))
            errors.push(`${askWhere}.discuss.at must be YYYY-MM-DD`);
        }
      }
      if (
        typeof ask.rec === "string" &&
        !(Array.isArray(ask.options) && ask.options.includes(ask.rec))
      )
        errors.push(`${askWhere}.rec must be one of its options`);
    };
    if (item.ask !== null) checkAsk(`${where}.ask`, item.ask);
    list(`${where}.answered`, item.answered).forEach((entry, at) => {
      const entryWhere = `${where}.answered[${at}]`;
      checkAsk(entryWhere, entry);
      if (isRecord(entry)) {
        nonEmpty(`${entryWhere}.answer`, entry.answer);
        textOrNull(`${entryWhere}.note`, entry.note);
        if (typeof entry.answeredAt !== "string" || !DATE.test(entry.answeredAt))
          errors.push(`${entryWhere}.answeredAt must be YYYY-MM-DD`);
      }
    });
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

  list("findings", candidate.findings).forEach((finding: unknown, index) => {
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
    ? { ok: true, backlog: candidate as unknown as Backlog }
    : { ok: false, errors };
};
