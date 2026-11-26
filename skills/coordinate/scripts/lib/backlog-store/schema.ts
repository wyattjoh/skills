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
 * The statuses `item update --status` may set from outside every Herdr terminal, as the Backlog
 * panel runs it, in the order the panel offers them. Delegated needs a delegate, waiting-user an
 * ask, and done and dismissed close through `item close`, so none of those is here.
 */
export const OUTSIDE_TERMINAL_STATUSES = [
  "open",
  "building",
  "in-review",
  "parked",
] as const satisfies readonly ItemStatus[];

/**
 * The statuses `item start` refuses: a closed item has nothing to start, and a delegated one is
 * already being worked.
 */
export const START_REFUSED_STATUSES = [
  "done",
  "dismissed",
  "delegated",
] as const satisfies readonly ItemStatus[];

/**
 * Whether the user may ask the coordinator to start an item (the Backlog panel's Start button).
 * @param item The item.
 * @returns True unless it is done, dismissed or delegated.
 */
export const canStartItem = (item: { status: ItemStatus }): boolean =>
  !START_REFUSED_STATUSES.some((status) => status === item.status);

/**
 * A prose field as a reader shows it: Markdown when the record has the Markdown sibling, else the
 * deprecated plain text.
 */
export type Prose = { markdown: boolean; value: string };

/**
 * A prose field's shown form: its Markdown sibling when present, else its text, else null (also
 * for an empty discussion note).
 * @param text The deprecated plain text field.
 * @param markdown The Markdown sibling.
 * @returns What to show, or null when the record has neither.
 */
export const prose = (
  text: string | null | undefined,
  markdown: string | null | undefined,
): Prose | null => {
  if (typeof markdown === "string" && markdown !== "") return { markdown: true, value: markdown };
  if (typeof text === "string" && text !== "") return { markdown: false, value: text };
  return null;
};

/**
 * The shape a new finding's detail takes, named wherever a finding is written (`finding add`,
 * its help, the delegate outbox) so the Backlog panel's finding detail says enough to act on.
 */
export const FINDING_DETAIL_SHAPE =
  "Markdown with **What** (the problem or opportunity), **Where** (files, commands or screens), **Why it matters** and **Suggested fix**, plus evidence (a command, log path or commit) when there is one; keep it short when the finding is small";

/**
 * A prose field's source, Markdown or text, for output that shows Markdown raw.
 * @param text The deprecated plain text field.
 * @param markdown The Markdown sibling.
 * @returns The shown source, or an empty string when the record has neither.
 */
export const proseSource = (
  text: string | null | undefined,
  markdown: string | null | undefined,
): string => prose(text, markdown)?.value ?? "";

/**
 * A dated item event, such as a decision or a discussion request: plain `text` (deprecated for
 * coordinator decisions, and the form answer and discussion events keep) or `markdown`, never both.
 */
export type Dated =
  | { text: string; markdown?: never; at: string }
  | { text?: never; markdown: string; at: string };

/**
 * Whether a dated entry records a discussion request rather than a decision or answer.
 * @param text The entry text; a Markdown decision has none.
 * @returns True for the reserved discussion event format.
 */
export const isDiscussion = (text: string | undefined): text is string =>
  text !== undefined && text.startsWith('Discuss "');

/**
 * Whether a decision records the answer to an ask, so the watcher can wake the coordinator on it.
 * @param text A decision's text; a Markdown decision has none.
 * @returns True for a decision `answerDecision` wrote.
 */
export const isAnswer = (text: string | undefined): text is string =>
  text !== undefined && /^Re ".*": /s.test(text);

/**
 * Whether the user may edit or delete a decision from the Backlog panel: a coordinator's decision,
 * not the record of an answer or a discussion request, which stay read-only.
 * @param entry The decision.
 * @returns True for a coordinator's decision.
 */
export const isEditableDecision = (entry: Dated): boolean =>
  !isAnswer(entry.text) && !isDiscussion(entry.text);

// FNV-1a over UTF-16 code units: no TextEncoder or crypto, so a Herdr mod computes the same value.
const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * A decision's stable key for an edit or delete: its index in the stored `decided` list and a
 * fingerprint of its date and text, `<index>:<fingerprint>`. Decisions are dated by day, so the
 * fingerprint is what tells a stale key (the list shifted, or the entry changed) from a live one.
 * @param entry The decision.
 * @param index Its index in the item's stored `decided` list.
 * @returns The key.
 */
export const decisionKey = (entry: Dated, index: number): string =>
  `${index}:${fingerprint(`${entry.at}\n${entry.text ?? ""}\n${entry.markdown ?? ""}`)}`;

/**
 * A reusable policy recorded with its stable short id and date: `markdown`, or the deprecated plain
 * `text`, never both. `wiki` names the domain or shared wiki page that explains it, and is absent
 * when the policy cites none.
 */
export type Policy = { id: string; at: string; wiki?: string } & (
  | { text: string; markdown?: never }
  | { text?: never; markdown: string }
);

/**
 * A request to discuss an ask before the user decides it. `noteMarkdown` replaces `note`, which is
 * then empty.
 */
export type DiscussionRequest = { note: string; noteMarkdown?: string; at: string };

/**
 * A question that waits on the user, with the coordinator's recommendation and optional discussion
 * request. Each `...Markdown` field is the Markdown sibling of the deprecated text field it names;
 * a record holds one or the other. `questionMarkdown` is inline (one line); the others are blocks.
 * With `questionMarkdown` the record has no `question`; with another sibling its text is null.
 */
export type Ask = {
  question?: string;
  questionMarkdown?: string;
  context: string | null;
  contextMarkdown?: string;
  options: string[];
  optionDetails?: string[];
  optionDetailsMarkdown?: string[];
  rec: string | null;
  recReason: string | null;
  recReasonMarkdown?: string;
  discuss: DiscussionRequest | null;
};

/**
 * The ask's question as a reader shows it, Markdown (inline) or text.
 * @param ask The ask.
 * @returns The question's source.
 */
export const questionOf = (ask: Ask): string => proseSource(ask.question, ask.questionMarkdown);

/**
 * A completed ask and the answer recorded at the time it was resolved. A free-text answer may be
 * inline `answerMarkdown` instead of `answer`; `noteMarkdown` replaces `note`, which is then null.
 */
export type AnsweredAsk = Ask & {
  answer?: string;
  answerMarkdown?: string;
  note: string | null;
  noteMarkdown?: string;
  answeredAt: string;
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
  /**
   * The Herdr machine the delegate runs on, absent for this machine; `worktree`, `brief` and
   * `report` are then paths on that machine.
   */
  machine?: string;
};

/**
 * The user's pending request that the coordinator start an item now, recorded by `item start`
 * with the request's ISO time and, when the user gave one with Start, the note's Markdown (also
 * kept as a decision). It clears when `item update` sets a status (even the current one) or an
 * ask, when a delegate is filed, and when the item closes.
 */
export type StartRequest = { at: string; noteMarkdown?: string };

/**
 * Which record field a pending edit changed: an item's or finding's `title` or `outcome`, an
 * item's `decision`, a finding's `detail`, a `policy`'s text, the domain's `focus`, or a path in
 * the `owned` or `adjacent` Boundary.
 */
export const EDIT_FIELDS = [
  "title",
  "outcome",
  "decision",
  "detail",
  "policy",
  "focus",
  "owned",
  "adjacent",
] as const;

/**
 * A field a pending edit names.
 */
export type EditField = (typeof EDIT_FIELDS)[number];

/**
 * A change the user made from outside every Herdr terminal (the Backlog panel), waiting for the
 * watcher to deliver it to the coordinator as an `edited` event, which then clears it. `record` is
 * the item, finding or policy id, `focus`, or `boundary`; `old` is the text before (null when the
 * field was empty) and `new` the text after, or null when the entry was deleted; `at` is the ISO
 * time. The id (`c<n>`) is never reused.
 */
export type RecordEdit = {
  id: string;
  record: string;
  field: EditField;
  old: string | null;
  new: string | null;
  at: string;
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
  /**
   * The outcome as Markdown; the deprecated `outcome` is then null.
   */
  outcomeMarkdown?: string;
  /**
   * A pending start request; absent when there is none. Older documents never have it.
   */
  startRequested?: StartRequest;
};

/**
 * An issue or opportunity noticed outside an item's scope.
 */
export type Finding = {
  id: string;
  kind: "issue" | "opportunity";
  title: string;
  detail: string | null;
  /**
   * The detail as Markdown; the deprecated `detail` is then null.
   */
  detailMarkdown?: string;
  path: string | null;
  from: string | null;
  /**
   * Where the finding came from, such as `retro:<delegate>`. Findings without one omit it.
   */
  source?: string;
  /**
   * When it was added. Findings recorded before this field existed have none.
   */
  createdAt?: string;
  status: "open" | "acted" | "dismissed";
  closedAt: string | null;
  outcome: string | null;
  /**
   * The outcome as Markdown; the deprecated `outcome` is then null.
   */
  outcomeMarkdown?: string;
};

/**
 * Where an owned path's repo is checked out on each remote machine: owned path, then Herdr machine
 * name, to the absolute path on that machine.
 */
export type Checkouts = Record<string, Record<string, string>>;

/**
 * The paths a domain owns and those next to it. `checkouts` is absent while no owned path records
 * a checkout on another machine.
 */
export type Boundary = { owned: string[]; adjacent: string[]; checkouts?: Checkouts };

/**
 * One domain's backlog document.
 */
export type Backlog = {
  schemaVersion: 1;
  domain: string;
  focus: string | null;
  /**
   * The focus line as inline Markdown; the deprecated `focus` is then null.
   */
  focusMarkdown?: string;
  legacy: string | null;
  boundary: Boundary;
  policies: Policy[];
  items: Item[];
  findings: Finding[];
  nextId: number;
  nextPolicyId: number;
  /**
   * The user's edits not yet delivered to the coordinator; absent when there are none. Older
   * documents never have it.
   */
  edits?: RecordEdit[];
  /**
   * The next pending edit's number, kept after its edits clear so an id is never reused; absent
   * until the first edit.
   */
  nextEditId?: number;
  /**
   * The coordinator lease (lease.ts): which machine and terminal coordinate the domain, until when.
   */
  lease?: Lease;
};

/**
 * The coordinator that holds a domain: its Herdr machine (that core's own name), its terminal
 * address on that machine (bare, as its own core names it), and when the lease expires (ISO).
 */
export type Lease = { machine: string; address: string; expiry: string };

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
        textOrMarkdown(`${where}[${index}]`, entry);
        nonEmpty(`${where}[${index}].at`, entry.at);
      }
    });
  };
  /**
   * Check a Markdown sibling when present, and that its text field is not set beside it. A text
   * field counts as set when it is a non-empty string.
   */
  const sibling = (
    where: string,
    textName: string,
    textField: unknown,
    name: string,
    field: unknown,
    inline: boolean,
  ): boolean => {
    if (field === undefined) return false;
    nonEmpty(`${where}.${name}`, field);
    if (inline && typeof field === "string" && /[\r\n]/.test(field))
      errors.push(`${where}.${name} must be one line`);
    if (typeof textField === "string" && textField !== "")
      errors.push(`${where} cannot have both ${textName} and ${name}`);
    return true;
  };
  const textOrMarkdown = (where: string, record: Record<string, unknown>): void => {
    if (!sibling(where, "text", record.text, "markdown", record.markdown, false))
      nonEmpty(`${where}.text`, record.text);
    else if (record.text !== undefined) text(`${where}.text`, record.text);
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
  sibling("the document", "focus", candidate.focus, "focusMarkdown", candidate.focusMarkdown, true);
  textOrNull("legacy", candidate.legacy);
  if (!isRecord(candidate.boundary)) errors.push("boundary must be an object");
  else {
    strings("boundary.owned", candidate.boundary.owned);
    strings("boundary.adjacent", candidate.boundary.adjacent);
    const { checkouts, owned } = candidate.boundary;
    if ("checkouts" in candidate.boundary) {
      if (!isRecord(checkouts)) errors.push("boundary.checkouts must be an object");
      else
        for (const [path, byMachine] of Object.entries(checkouts)) {
          const where = `boundary.checkouts[${JSON.stringify(path)}]`;
          if (!Array.isArray(owned) || !owned.includes(path))
            errors.push(`${where} must name an owned path`);
          if (!isRecord(byMachine) || Object.keys(byMachine).length === 0) {
            errors.push(`${where} must be a non-empty object`);
            continue;
          }
          for (const [machine, checkout] of Object.entries(byMachine))
            if (typeof checkout !== "string" || !checkout.startsWith("/"))
              errors.push(`${where}.${machine} must be an absolute path`);
        }
    }
  }
  const policies = list("policies", candidate.policies);
  policies.forEach((policy: unknown, index) => {
    const where = `policies[${index}]`;
    if (!isRecord(policy)) {
      errors.push(`${where} must be an object`);
      return;
    }
    textOrMarkdown(where, policy);
    nonEmpty(`${where}.at`, policy.at);
    if ("wiki" in policy) nonEmpty(`${where}.wiki`, policy.wiki);
  });
  const nextId = candidate.nextId;
  if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1)
    errors.push("nextId must be a positive integer");
  const nextPolicyId = candidate.nextPolicyId;
  if (typeof nextPolicyId !== "number" || !Number.isInteger(nextPolicyId) || nextPolicyId < 1)
    errors.push("nextPolicyId must be a positive integer");
  if ("lease" in candidate) {
    const lease = candidate.lease;
    if (!isRecord(lease)) errors.push("lease must be an object");
    else {
      nonEmpty("lease.machine", lease.machine);
      nonEmpty("lease.address", lease.address);
      if (typeof lease.expiry !== "string" || Number.isNaN(Date.parse(lease.expiry)))
        errors.push("lease.expiry must be an ISO time");
    }
  }

  if ("edits" in candidate) {
    const edits = list("edits", candidate.edits);
    const nextEditId = candidate.nextEditId;
    if (typeof nextEditId !== "number" || !Number.isInteger(nextEditId) || nextEditId < 1)
      errors.push("nextEditId must be a positive integer when there are edits");
    edits.forEach((entry: unknown, index) => {
      const where = `edits[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const match = typeof entry.id === "string" ? /^c([1-9]\d*)$/.exec(entry.id) : null;
      if (match === null) errors.push(`${where}.id must look like c1`);
      else if (typeof nextEditId === "number" && Number(match[1]) >= nextEditId)
        errors.push(`${where}.id ${String(entry.id)} is not below nextEditId ${nextEditId}`);
      nonEmpty(`${where}.record`, entry.record);
      if (!EDIT_FIELDS.some((field) => field === entry.field))
        errors.push(`${where}.field must be one of ${EDIT_FIELDS.join(", ")}`);
      textOrNull(`${where}.old`, entry.old);
      textOrNull(`${where}.new`, entry.new);
      nonEmpty(`${where}.at`, entry.at);
    });
  } else if ("nextEditId" in candidate) {
    const nextEditId = candidate.nextEditId;
    if (typeof nextEditId !== "number" || !Number.isInteger(nextEditId) || nextEditId < 1)
      errors.push("nextEditId must be a positive integer");
  }

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
  const closed = (where: string, record: Record<string, unknown>, isClosed: boolean) => {
    const markdown = sibling(
      where,
      "outcome",
      record.outcome,
      "outcomeMarkdown",
      record.outcomeMarkdown,
      false,
    );
    if (isClosed) {
      nonEmpty(`${where}.closedAt`, record.closedAt);
      if (markdown) textOrNull(`${where}.outcome`, record.outcome);
      else nonEmpty(`${where}.outcome`, record.outcome);
    } else {
      textOrNull(`${where}.closedAt`, record.closedAt);
      textOrNull(`${where}.outcome`, record.outcome);
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
      if (
        !sibling(askWhere, "question", ask.question, "questionMarkdown", ask.questionMarkdown, true)
      )
        nonEmpty(`${askWhere}.question`, ask.question);
      textOrNull(`${askWhere}.context`, ask.context);
      sibling(askWhere, "context", ask.context, "contextMarkdown", ask.contextMarkdown, false);
      strings(`${askWhere}.options`, ask.options);
      if (ask.optionDetailsMarkdown !== undefined) {
        strings(`${askWhere}.optionDetailsMarkdown`, ask.optionDetailsMarkdown);
        if (
          Array.isArray(ask.optionDetailsMarkdown) &&
          Array.isArray(ask.options) &&
          ask.optionDetailsMarkdown.length !== ask.options.length
        )
          errors.push(`${askWhere}.optionDetailsMarkdown must have the same length as options`);
        if (ask.optionDetails !== undefined)
          errors.push(`${askWhere} cannot have both optionDetails and optionDetailsMarkdown`);
      }
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
      sibling(
        askWhere,
        "recReason",
        ask.recReason,
        "recReasonMarkdown",
        ask.recReasonMarkdown,
        false,
      );
      if (ask.discuss !== null) {
        if (!isRecord(ask.discuss)) errors.push(`${askWhere}.discuss must be an object or null`);
        else {
          text(`${askWhere}.discuss.note`, ask.discuss.note);
          sibling(
            `${askWhere}.discuss`,
            "note",
            ask.discuss.note,
            "noteMarkdown",
            ask.discuss.noteMarkdown,
            false,
          );
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
        if (
          !sibling(entryWhere, "answer", entry.answer, "answerMarkdown", entry.answerMarkdown, true)
        )
          nonEmpty(`${entryWhere}.answer`, entry.answer);
        textOrNull(`${entryWhere}.note`, entry.note);
        sibling(entryWhere, "note", entry.note, "noteMarkdown", entry.noteMarkdown, false);
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
      if (ref.machine !== undefined) nonEmpty(`${refWhere}.machine`, ref.machine);
    });
    nonEmpty(`${where}.createdAt`, item.createdAt);
    if ("startRequested" in item) {
      if (!isRecord(item.startRequested)) errors.push(`${where}.startRequested must be an object`);
      else {
        nonEmpty(`${where}.startRequested.at`, item.startRequested.at);
        if ("noteMarkdown" in item.startRequested)
          nonEmpty(`${where}.startRequested.noteMarkdown`, item.startRequested.noteMarkdown);
      }
    }
    closed(where, item, status === "done" || status === "dismissed");
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
    sibling(where, "detail", finding.detail, "detailMarkdown", finding.detailMarkdown, false);
    textOrNull(`${where}.path`, finding.path);
    textOrNull(`${where}.from`, finding.from);
    if ("source" in finding) nonEmpty(`${where}.source`, finding.source);
    if ("createdAt" in finding) nonEmpty(`${where}.createdAt`, finding.createdAt);
    if (!["open", "acted", "dismissed"].includes(String(finding.status)))
      errors.push(`${where}.status must be open, acted or dismissed`);
    closed(where, finding, finding.status !== "open");
  });

  return errors.length === 0
    ? { ok: true, backlog: candidate as unknown as Backlog }
    : { ok: false, errors };
};
