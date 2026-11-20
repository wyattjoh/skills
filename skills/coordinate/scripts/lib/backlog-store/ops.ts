import type { Ask, Backlog, DelegateRef, Finding, Item, ItemStatus, Policy } from "./schema.ts";

/**
 * An operation's result: the next document and a value, or why the input was refused.
 */
export type OpResult<A> = { ok: true; backlog: Backlog; value: A } | { ok: false; reason: string };

/**
 * A fresh, empty backlog for a domain.
 * @param domain Domain name.
 * @param legacy Path of an old Markdown backlog to point at, or null.
 * @returns The document.
 */
export const emptyBacklog = (domain: string, legacy: string | null): Backlog => ({
  schemaVersion: 1,
  domain,
  focus: null,
  legacy,
  boundary: { owned: [], adjacent: [] },
  policies: [],
  items: [],
  findings: [],
  nextId: 1,
  nextPolicyId: 1,
});

const oneLine = (field: string, value: string): string | undefined => {
  if (value.trim() === "") return `${field} is empty`;
  if (/[\r\n]/.test(value)) return `${field} must be one line`;
  return undefined;
};

/**
 * Add an open item with the next short id.
 * @param backlog Current document.
 * @param input The title, and the time as an ISO string.
 * @returns The next document and the new item.
 */
export const addItem = (
  backlog: Backlog,
  input: { title: string; now: string },
): OpResult<Item> => {
  const problem = oneLine("title", input.title);
  if (problem) return { ok: false, reason: problem };
  const item: Item = {
    id: `i${backlog.nextId}`,
    title: input.title.trim(),
    status: "open",
    touches: [],
    decided: [],
    ask: null,
    answered: [],
    due: null,
    delegates: [],
    createdAt: input.now,
    closedAt: null,
    outcome: null,
  };
  return {
    ok: true,
    backlog: { ...backlog, items: [...backlog.items, item], nextId: backlog.nextId + 1 },
    value: item,
  };
};

/**
 * Close an item as done, or dismissed, with a one-line outcome.
 * @param backlog Current document.
 * @param input Item id, outcome, whether it was dismissed, and the time as an ISO string.
 * @returns The next document and the closed item.
 */
export const closeItem = (
  backlog: Backlog,
  input: { id: string; outcome: string; dismissed: boolean; now: string },
): OpResult<Item> => {
  const found = backlog.items.find((item) => item.id === input.id);
  if (!found) return { ok: false, reason: `no item ${input.id} in ${backlog.domain}` };
  if (found.status === "done" || found.status === "dismissed")
    return { ok: false, reason: `${input.id} is already ${found.status}` };
  const problem = oneLine("outcome", input.outcome);
  if (problem) return { ok: false, reason: `closing ${input.id} needs an outcome: ${problem}` };
  const item: Item = {
    ...found,
    status: input.dismissed ? "dismissed" : "done",
    ask: null,
    closedAt: input.now,
    outcome: input.outcome.trim(),
  };
  return {
    ok: true,
    backlog: {
      ...backlog,
      items: backlog.items.map((entry) => (entry.id === item.id ? item : entry)),
    },
    value: item,
  };
};

/**
 * Add an open finding with the next short id. A `from` item must exist in the document.
 * @param backlog Current document.
 * @param input Kind, one-line title, optional detail and path, and the item it came from.
 * @returns The next document and the new finding.
 */
export const addFinding = (
  backlog: Backlog,
  input: {
    kind: Finding["kind"];
    title: string;
    detail: string | undefined;
    path: string | undefined;
    from: string | undefined;
  },
): OpResult<Finding> => {
  const problem =
    oneLine("title", input.title) ??
    (input.path === undefined ? undefined : oneLine("path", input.path)) ??
    (input.detail?.trim() === "" ? "detail is empty" : undefined);
  if (problem) return { ok: false, reason: problem };
  if (input.from !== undefined && !backlog.items.some((item) => item.id === input.from))
    return {
      ok: false,
      reason: `no item ${input.from} in ${backlog.domain} to file a finding from`,
    };
  const finding: Finding = {
    id: `f${backlog.nextId}`,
    kind: input.kind,
    title: input.title.trim(),
    detail: input.detail?.trim() ?? null,
    path: input.path?.trim() ?? null,
    from: input.from ?? null,
    status: "open",
    closedAt: null,
    outcome: null,
  };
  return {
    ok: true,
    backlog: {
      ...backlog,
      findings: [...backlog.findings, finding],
      nextId: backlog.nextId + 1,
    },
    value: finding,
  };
};

/**
 * Close a finding as acted on, or dismissed, with a one-line outcome.
 * @param backlog Current document.
 * @param input Finding id, outcome, whether it was dismissed, and the time as an ISO string.
 * @returns The next document and the closed finding.
 */
export const closeFinding = (
  backlog: Backlog,
  input: { id: string; outcome: string; dismissed: boolean; now: string },
): OpResult<Finding> => {
  const found = backlog.findings.find((entry) => entry.id === input.id);
  if (!found) return { ok: false, reason: `no finding ${input.id} in ${backlog.domain}` };
  if (found.status !== "open")
    return { ok: false, reason: `${input.id} is already ${found.status}` };
  const problem = oneLine("outcome", input.outcome);
  if (problem) return { ok: false, reason: `closing ${input.id} needs an outcome: ${problem}` };
  const finding: Finding = {
    ...found,
    status: input.dismissed ? "dismissed" : "acted",
    closedAt: input.now,
    outcome: input.outcome.trim(),
  };
  return {
    ok: true,
    backlog: {
      ...backlog,
      findings: backlog.findings.map((entry) => (entry.id === finding.id ? finding : entry)),
    },
    value: finding,
  };
};

/**
 * The changes one `item update` applies. Unset fields, and empty lists, leave the item as it is.
 */
export type ItemUpdate = {
  id: string;
  status: ItemStatus | undefined;
  outcome: string | undefined;
  decided: string[];
  touch: string[];
  untouch: string[];
  due: string | null | undefined;
  ask: string | undefined;
  context: string | undefined;
  options: string[];
  rec: string | undefined;
  why: string | undefined;
  answer: string | undefined;
  now: string;
};

/**
 * The decision an answer appends to its item, the one format `isAnswer` recognises.
 * @param question The ask's question.
 * @param answer The user's answer.
 * @returns The decision text.
 */
export const answerDecision = (question: string, answer: string): string =>
  `Re "${question}": ${answer}`;

/**
 * Whether a decision records the answer to an ask, so the watcher can wake the coordinator on it.
 * @param text A decision's text.
 * @returns True for a decision `answerDecision` wrote.
 */
export const isAnswer = (text: string): boolean => /^Re ".*": /s.test(text);

const refuse = (reason: string): OpResult<Item> => ({ ok: false, reason });

const isClosed = (status: ItemStatus): boolean => status === "done" || status === "dismissed";

const isDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const firstProblem = (field: string, values: string[]): string | undefined =>
  values.map((value) => oneLine(field, value)).find((problem) => problem !== undefined);

/**
 * The ask an update attaches: undefined when it sets none, or why its parts do not fit together.
 */
const askOf = (input: ItemUpdate): Ask | undefined | string => {
  if (input.ask === undefined) {
    const parts = [input.context, input.rec, input.why].some((part) => part !== undefined);
    return parts || input.options.length > 0
      ? "--context, --option, --rec and --why need --ask"
      : undefined;
  }
  const problem =
    oneLine("ask", input.ask) ??
    (input.context === undefined ? undefined : oneLine("context", input.context)) ??
    firstProblem("option", input.options) ??
    (input.why === undefined ? undefined : oneLine("why", input.why));
  if (problem) return problem;
  const options = input.options.map((option) => option.trim());
  const parsed = options.map((option) => {
    const delimiter = option.indexOf(" :: ");
    return {
      label: delimiter === -1 ? option : option.slice(0, delimiter).trim(),
      detail: delimiter === -1 ? "" : option.slice(delimiter + 4).trim(),
    };
  });
  const labels = parsed.map(({ label }) => label);
  const details = parsed.map(({ detail }) => detail);
  const optionDetails = details.some(Boolean) ? details : undefined;
  const labelProblem = firstProblem("option", labels);
  if (labelProblem) return labelProblem;
  if (new Set(labels).size !== labels.length) return "--option values must be unique";
  const rec = input.rec?.trim();
  if (rec !== undefined && !labels.includes(rec))
    return `--rec ${rec} must be one of the --option values: ${labels.length > 0 ? labels.join(", ") : "(none)"}`;
  if (input.why !== undefined && rec === undefined) return "--why needs --rec";
  return {
    question: input.ask.trim(),
    context: input.context?.trim() ?? null,
    options: labels,
    ...(optionDetails ? { optionDetails } : {}),
    rec: rec ?? null,
    recReason: input.why?.trim() ?? null,
  };
};

/**
 * Apply an update to an item, refusing a result that breaks an item invariant.
 * @param backlog Current document.
 * @param input The changes, and the time as an ISO string.
 * @returns The next document and the updated item.
 */
export const updateItem = (backlog: Backlog, input: ItemUpdate): OpResult<Item> => {
  const found = backlog.items.find((item) => item.id === input.id);
  if (!found) return refuse(`no item ${input.id} in ${backlog.domain}`);
  const unchanged =
    input.status === undefined &&
    input.outcome === undefined &&
    input.decided.length === 0 &&
    input.touch.length === 0 &&
    input.untouch.length === 0 &&
    input.due === undefined &&
    input.ask === undefined &&
    input.context === undefined &&
    input.options.length === 0 &&
    input.rec === undefined &&
    input.why === undefined &&
    input.answer === undefined;
  if (unchanged) return refuse(`nothing to update on ${input.id}`);
  const problem =
    firstProblem("decided", input.decided) ??
    firstProblem("touch", input.touch) ??
    firstProblem("untouch", input.untouch);
  if (problem) return refuse(problem);
  const asked = askOf(input);
  if (typeof asked === "string") return refuse(asked);
  if (input.answer !== undefined) {
    if (asked) return refuse("--answer and --ask cannot be combined");
    if (!found.ask) return refuse(`${input.id} has no ask to answer`);
    const unanswerable = oneLine("answer", input.answer);
    if (unanswerable) return refuse(unanswerable);
  }
  const touches = [...found.touches];
  for (const path of input.untouch.map((entry) => entry.trim())) {
    if (!touches.includes(path)) return refuse(`${input.id} does not touch ${path}`);
    touches.splice(touches.indexOf(path), 1);
  }
  for (const path of input.touch.map((entry) => entry.trim()))
    if (!touches.includes(path)) touches.push(path);
  if (typeof input.due === "string" && !isDate(input.due))
    return refuse("due must be a date as YYYY-MM-DD");
  if (input.outcome !== undefined && !(input.status && isClosed(input.status)))
    return refuse("--outcome needs --status done or dismissed");

  const at = input.now.slice(0, 10);
  let item: Item = {
    ...found,
    status: input.status ?? found.status,
    touches,
    due: input.due === undefined ? found.due : input.due,
    ask: asked ?? (input.answer === undefined ? found.ask : null),
    answered:
      input.answer !== undefined && found.ask
        ? [...found.answered, { ...found.ask, answer: input.answer.trim(), answeredAt: at }]
        : found.answered,
    decided: [
      ...found.decided,
      ...(input.answer !== undefined && found.ask
        ? [{ text: answerDecision(found.ask.question, input.answer.trim()), at }]
        : []),
      ...input.decided.map((text) => ({ text: text.trim(), at })),
    ],
  };
  if (asked && isClosed(input.status ?? found.status))
    return refuse("an ask needs an item that is not done or dismissed");
  if (input.status && isClosed(input.status)) {
    if (isClosed(found.status)) return refuse(`${input.id} is already ${found.status}`);
    if (input.outcome === undefined || oneLine("outcome", input.outcome))
      return refuse(`${input.id} needs --outcome to become ${input.status}`);
    item = { ...item, ask: null, closedAt: input.now, outcome: input.outcome.trim() };
  } else if (isClosed(found.status)) item = { ...item, closedAt: null, outcome: null };
  if (item.status === "delegated" && item.delegates.length === 0)
    return refuse(
      `${input.id} cannot be delegated without a delegate; coordinate delegate --item ${input.id} records one`,
    );
  if (item.status === "waiting-user" && item.ask === null && item.decided.length === 0)
    return refuse(
      `${input.id} cannot wait on the user without an ask (--ask) or a decision naming the pending integration (--decided)`,
    );
  return {
    ok: true,
    backlog: {
      ...backlog,
      items: backlog.items.map((entry) => (entry.id === item.id ? item : entry)),
    },
    value: item,
  };
};

const sequence = (record: Item | Finding): number => Number(record.id.slice(1));

/**
 * How many closed items and findings, together, a document keeps.
 */
export const RETAINED_CLOSED = 50;

/**
 * Split off the closed items and findings beyond the newest `keep`, by close time.
 * @param backlog Current document.
 * @param keep How many closed records stay.
 * @returns The document without them, and the removed records oldest first.
 */
export const retain = (
  backlog: Backlog,
  keep: number,
): { backlog: Backlog; archived: (Item | Finding)[] } => {
  const closed: (Item | Finding)[] = [...backlog.items, ...backlog.findings].filter(
    (record) => record.closedAt !== null,
  );
  // Copy-then-sort, not toSorted: this module is bundled into Herdr, whose lib lacks ES2023.
  const archived = [...closed]
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy; see above.
    .sort(
      (a: Item | Finding, b: Item | Finding) =>
        (a.closedAt ?? "").localeCompare(b.closedAt ?? "") || sequence(a) - sequence(b),
    )
    .slice(0, Math.max(0, closed.length - keep));
  if (archived.length === 0) return { backlog, archived };
  const gone = new Set(archived.map((record) => record.id));
  return {
    backlog: {
      ...backlog,
      items: backlog.items.filter((item) => !gone.has(item.id)),
      findings: backlog.findings.filter((finding) => !gone.has(finding.id)),
    },
    archived,
  };
};

/**
 * Which Boundary list a path belongs to.
 */
export type BoundaryList = "owned" | "adjacent";

const boundaryPath = (path: string): string | undefined => {
  if (path === "") return "path is empty";
  if (/[\r\n]/.test(path)) return "path must be one line";
  if (!path.startsWith("/")) return `${path} is not an absolute path`;
  return undefined;
};

/**
 * Add an absolute path to the owned or adjacent Boundary. A path already in that list is kept
 * once; a path in the other list is refused, so the two lists never overlap.
 * @param backlog Current document.
 * @param input The absolute path and which list.
 * @returns The next document and whether the path was added.
 */
export const addBoundary = (
  backlog: Backlog,
  input: { path: string; list: BoundaryList },
): OpResult<{ added: boolean }> => {
  const problem = boundaryPath(input.path);
  if (problem) return { ok: false, reason: problem };
  const other: BoundaryList = input.list === "owned" ? "adjacent" : "owned";
  if (backlog.boundary[other].includes(input.path))
    return {
      ok: false,
      reason: `${input.path} is already ${other}; remove it first: coordinate backlog boundary rm ${input.path}${other === "adjacent" ? " --adjacent" : ""}`,
    };
  if (backlog.boundary[input.list].includes(input.path))
    return { ok: true, backlog, value: { added: false } };
  return {
    ok: true,
    backlog: {
      ...backlog,
      boundary: {
        ...backlog.boundary,
        [input.list]: [...backlog.boundary[input.list], input.path],
      },
    },
    value: { added: true },
  };
};

/**
 * Remove a path from the owned or adjacent Boundary.
 * @param backlog Current document.
 * @param input The absolute path and which list.
 * @returns The next document; refused when the list does not hold the path.
 */
export const removeBoundary = (
  backlog: Backlog,
  input: { path: string; list: BoundaryList },
): OpResult<null> => {
  if (!backlog.boundary[input.list].includes(input.path))
    return { ok: false, reason: `${input.path} is not in the ${input.list} Boundary` };
  return {
    ok: true,
    backlog: {
      ...backlog,
      boundary: {
        ...backlog.boundary,
        [input.list]: backlog.boundary[input.list].filter((path) => path !== input.path),
      },
    },
    value: null,
  };
};

/**
 * Add a reusable policy with a stable short id.
 * @param backlog Current document.
 * @param input The policy text and date as YYYY-MM-DD.
 * @returns The next document and the new policy.
 */
export const addPolicy = (
  backlog: Backlog,
  input: { text: string; at: string },
): OpResult<Policy> => {
  const problem = oneLine("text", input.text);
  if (problem) return { ok: false, reason: problem };
  if (!isDate(input.at)) return { ok: false, reason: "--at must be YYYY-MM-DD" };
  const policy: Policy = { id: `p${backlog.nextPolicyId}`, text: input.text, at: input.at };
  return {
    ok: true,
    backlog: {
      ...backlog,
      policies: [...backlog.policies, policy],
      nextPolicyId: backlog.nextPolicyId + 1,
    },
    value: policy,
  };
};

/**
 * Remove a policy by its stable id.
 * @param backlog Current document.
 * @param id Policy id.
 * @returns The next document and the removed policy.
 */
export const removePolicy = (backlog: Backlog, id: string): OpResult<Policy> => {
  const policy = backlog.policies.find((entry) => entry.id === id);
  if (!policy) return { ok: false, reason: `no policy ${id} in ${backlog.domain}` };
  return {
    ok: true,
    backlog: { ...backlog, policies: backlog.policies.filter((entry) => entry.id !== id) },
    value: policy,
  };
};

/**
 * Replace a policy's text and date while preserving its stable id.
 * @param backlog Current document.
 * @param input The policy id, replacement text and date.
 * @returns The next document and the updated policy.
 */
export const replacePolicy = (
  backlog: Backlog,
  input: { id: string; text: string; at: string },
): OpResult<Policy> => {
  const found = backlog.policies.find((entry) => entry.id === input.id);
  if (!found) return { ok: false, reason: `no policy ${input.id} in ${backlog.domain}` };
  const problem = oneLine("text", input.text);
  if (problem) return { ok: false, reason: problem };
  if (!isDate(input.at)) return { ok: false, reason: "--at must be YYYY-MM-DD" };
  const policy: Policy = { ...found, text: input.text, at: input.at };
  return {
    ok: true,
    backlog: {
      ...backlog,
      policies: backlog.policies.map((entry) => (entry.id === policy.id ? policy : entry)),
    },
    value: policy,
  };
};

/**
 * Set the domain's focus line, or clear it with null.
 * @param backlog Current document.
 * @param input The focus line, or null.
 * @returns The next document and the focus now stored.
 */
export const setFocus = (
  backlog: Backlog,
  input: { focus: string | null },
): OpResult<string | null> => {
  if (input.focus === null) return { ok: true, backlog: { ...backlog, focus: null }, value: null };
  if (input.focus.trim() === "")
    return { ok: false, reason: "focus is empty; pass --clear to clear it" };
  const problem = oneLine("focus", input.focus);
  if (problem) return { ok: false, reason: problem };
  const focus = input.focus.trim();
  return { ok: true, backlog: { ...backlog, focus }, value: focus };
};

/**
 * Why an item cannot take a delegate, or undefined when it can: it must exist and be open.
 * @param backlog Current document.
 * @param id Item id.
 * @returns The refusal, or undefined.
 */
export const unfileable = (backlog: Backlog, id: string): string | undefined => {
  const found = backlog.items.find((item) => item.id === id);
  if (!found) return `no item ${id} in ${backlog.domain}`;
  if (isClosed(found.status))
    return `${id} is already ${found.status}; a delegate needs an open item`;
  return undefined;
};

/**
 * The item whose delegate refs name a session, open or closed.
 * @param backlog Current document.
 * @param session Session id.
 * @returns The item, or undefined when no item names it.
 */
export const filedUnder = (backlog: Backlog, session: string): Item | undefined =>
  backlog.items.find((item) => item.delegates.some((ref) => ref.session === session));

/**
 * The items still `delegated` that none of whose delegate refs names a live session. One
 * definition of "no live delegate" for `end`, `status` and `backlog show`.
 * @param backlog Current document.
 * @param live Session ids of the domain's live delegates.
 * @returns The idle delegated items, in document order.
 */
export const idleDelegated = (backlog: Backlog, live: ReadonlySet<string>): Item[] =>
  backlog.items.filter(
    (item) => item.status === "delegated" && item.delegates.every((ref) => !live.has(ref.session)),
  );

/**
 * File a delegate under an item: append its ref and set the item to delegated. A session any
 * item already names is refused, so one session is filed under one item.
 * @param backlog Current document.
 * @param input Item id and the delegate ref.
 * @returns The next document and the updated item.
 */
export const fileDelegate = (
  backlog: Backlog,
  input: { id: string; ref: DelegateRef },
): OpResult<Item> => {
  const problem = unfileable(backlog, input.id);
  if (problem) return refuse(problem);
  const item = backlog.items.find((entry) => entry.id === input.id);
  if (!item) return refuse(`no item ${input.id} in ${backlog.domain}`);
  const holder = filedUnder(backlog, input.ref.session);
  if (holder) {
    const held = holder.delegates.find((ref) => ref.session === input.ref.session);
    return refuse(
      holder.id === input.id
        ? `${held?.name ?? input.ref.name} is already filed under ${holder.id}`
        : `${held?.name ?? input.ref.name} is already filed under ${holder.id}; detach it first: coordinate item detach ${holder.id} ${held?.name ?? input.ref.session}`,
    );
  }
  const filed: Item = { ...item, status: "delegated", delegates: [...item.delegates, input.ref] };
  return {
    ok: true,
    backlog: {
      ...backlog,
      items: backlog.items.map((entry) => (entry.id === filed.id ? filed : entry)),
    },
    value: filed,
  };
};

/**
 * Undo a filing: remove one delegate ref from an item, matched by session id, else by name. An
 * item left `delegated` with no delegates goes back to `open`; any other status stays, so a
 * closed item keeps its outcome.
 * @param backlog Current document.
 * @param input Item id, and the delegate's session id or name.
 * @returns The next document, the updated item and the removed ref.
 */
export const unfileDelegate = (
  backlog: Backlog,
  input: { id: string; key: string },
): OpResult<{ item: Item; ref: DelegateRef }> => {
  const found = backlog.items.find((item) => item.id === input.id);
  if (!found) return { ok: false, reason: `no item ${input.id} in ${backlog.domain}` };
  const bySession = found.delegates.filter((ref) => ref.session === input.key);
  const matches =
    bySession.length > 0 ? bySession : found.delegates.filter((ref) => ref.name === input.key);
  const [ref] = matches;
  if (ref === undefined) {
    const holder = filedUnder(backlog, input.key);
    const named = backlog.items.find((item) =>
      item.delegates.some((entry) => entry.name === input.key),
    );
    const elsewhere = holder ?? named;
    return {
      ok: false,
      reason: elsewhere
        ? `${input.key} is filed under ${elsewhere.id}, not ${input.id}`
        : `${input.id} has no delegate ${input.key}`,
    };
  }
  if (matches.length > 1)
    return {
      ok: false,
      reason: `${input.key} names ${matches.length} delegates on ${input.id}; pass a session id: ${matches.map((entry) => entry.session).join(", ")}`,
    };
  const delegates = found.delegates.filter((entry) => entry !== ref);
  const item: Item = {
    ...found,
    delegates,
    status: found.status === "delegated" && delegates.length === 0 ? "open" : found.status,
  };
  return {
    ok: true,
    backlog: {
      ...backlog,
      items: backlog.items.map((entry) => (entry.id === item.id ? item : entry)),
    },
    value: { item, ref },
  };
};
