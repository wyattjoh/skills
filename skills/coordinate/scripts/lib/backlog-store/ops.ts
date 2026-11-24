import {
  canStartItem,
  questionOf,
  type Ask,
  type Backlog,
  type Boundary,
  type Checkouts,
  type DelegateRef,
  type Finding,
  type Item,
  type ItemStatus,
  type Policy,
} from "./schema.ts";

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
 * Markdown as stored: leading blank lines and trailing whitespace dropped, so a leading indented
 * code block keeps its indent.
 */
const trimMarkdown = (value: string): string => value.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();

/**
 * A prose field given as text or as Markdown: the Markdown, trimmed, with the text field null; or
 * the text as given, for the caller's own checks; or undefined for neither. Refuses both, an empty
 * Markdown value, and a multi-line inline one.
 */
type ProseInput = { text: string; markdown: undefined } | { text: null; markdown: string };

const proseInput = (
  flag: string,
  text: string | undefined,
  markdown: string | undefined,
  inline: boolean,
): ProseInput | undefined | string => {
  if (markdown === undefined) return text === undefined ? undefined : { text, markdown: undefined };
  if (text !== undefined) return `--${flag} and --${flag}-md cannot be combined`;
  if (markdown.trim() === "") return `--${flag}-md is empty`;
  if (inline && /[\r\n]/.test(markdown.trim())) return `--${flag}-md must be one line`;
  return { text: null, markdown: inline ? markdown.trim() : trimMarkdown(markdown) };
};

/**
 * A record without one optional key, for a write that replaces a Markdown sibling with text.
 */
const without = <R extends object, K extends keyof R>(record: R, key: K): Omit<R, K> => {
  const { [key]: _dropped, ...rest } = record;
  return rest;
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
 * The outcome fields a close writes: one-line text, or Markdown with the text null.
 */
const closingOutcome = (
  id: string,
  outcome: string,
  markdown: string | undefined,
): { outcome: string | null; outcomeMarkdown?: string } | string => {
  const picked = proseInput("outcome", outcome === "" ? undefined : outcome, markdown, false);
  if (typeof picked === "string") return picked;
  if (picked?.markdown !== undefined) return { outcome: null, outcomeMarkdown: picked.markdown };
  const problem = oneLine("outcome", outcome);
  if (problem) return `closing ${id} needs an outcome: ${problem}`;
  return { outcome: outcome.trim() };
};

/**
 * Close an item as done, or dismissed, with a one-line outcome or a Markdown `outcomeMarkdown`.
 * @param backlog Current document.
 * @param input Item id, outcome, whether it was dismissed, and the time as an ISO string.
 * @returns The next document and the closed item.
 */
export const closeItem = (
  backlog: Backlog,
  input: {
    id: string;
    outcome: string;
    outcomeMarkdown?: string | undefined;
    dismissed: boolean;
    now: string;
  },
): OpResult<Item> => {
  const found = backlog.items.find((item) => item.id === input.id);
  if (!found) return { ok: false, reason: `no item ${input.id} in ${backlog.domain}` };
  if (found.status === "done" || found.status === "dismissed")
    return { ok: false, reason: `${input.id} is already ${found.status}` };
  const outcome = closingOutcome(input.id, input.outcome, input.outcomeMarkdown);
  if (typeof outcome === "string") return { ok: false, reason: outcome };
  const item: Item = {
    ...without(without(found, "outcomeMarkdown"), "startRequested"),
    status: input.dismissed ? "dismissed" : "done",
    ask: null,
    closedAt: input.now,
    ...outcome,
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
 * Record the user's request that the coordinator start an item now, for the watcher's `start`
 * event. Refused for a done, dismissed or delegated item. While a request is pending another one
 * changes nothing, so the watcher fires once per request.
 * @param backlog Current document.
 * @param input Item id and the time as an ISO string.
 * @returns The next document, the item, and whether this call recorded a new request.
 */
export const requestStart = (
  backlog: Backlog,
  input: { id: string; now: string },
): OpResult<{ item: Item; requested: boolean }> => {
  const found = backlog.items.find((item) => item.id === input.id);
  if (!found) return { ok: false, reason: `no item ${input.id} in ${backlog.domain}` };
  if (!canStartItem(found))
    return { ok: false, reason: `${input.id} is ${found.status}, so there is nothing to start` };
  if (found.startRequested !== undefined)
    return { ok: true, backlog, value: { item: found, requested: false } };
  const item: Item = { ...found, startRequested: { at: input.now } };
  return {
    ok: true,
    backlog: {
      ...backlog,
      items: backlog.items.map((entry) => (entry.id === item.id ? item : entry)),
    },
    value: { item, requested: true },
  };
};

/**
 * Add an open finding with the next short id. A `from` item must exist in the document.
 * @param backlog Current document.
 * @param input Kind, one-line title, optional detail and path, the item it came from, an optional
 * one-line source (such as `retro:<delegate>`), and the time as an ISO string, recorded as `createdAt`.
 * @returns The next document and the new finding.
 */
export const addFinding = (
  backlog: Backlog,
  input: {
    kind: Finding["kind"];
    title: string;
    detail: string | undefined;
    detailMarkdown?: string | undefined;
    path: string | undefined;
    from: string | undefined;
    source: string | undefined;
    now: string | undefined;
  },
): OpResult<Finding> => {
  const detail = proseInput("detail", input.detail, input.detailMarkdown, false);
  if (typeof detail === "string") return { ok: false, reason: detail };
  const problem =
    oneLine("title", input.title) ??
    (input.path === undefined ? undefined : oneLine("path", input.path)) ??
    (input.source === undefined ? undefined : oneLine("source", input.source)) ??
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
    ...(detail?.markdown === undefined ? {} : { detailMarkdown: detail.markdown }),
    path: input.path?.trim() ?? null,
    from: input.from ?? null,
    ...(input.source === undefined ? {} : { source: input.source.trim() }),
    ...(input.now === undefined ? {} : { createdAt: input.now }),
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
 * Close a finding as acted on, or dismissed, with a one-line outcome or a Markdown `outcomeMarkdown`.
 * @param backlog Current document.
 * @param input Finding id, outcome, whether it was dismissed, and the time as an ISO string.
 * @returns The next document and the closed finding.
 */
export const closeFinding = (
  backlog: Backlog,
  input: {
    id: string;
    outcome: string;
    outcomeMarkdown?: string | undefined;
    dismissed: boolean;
    now: string;
  },
): OpResult<Finding> => {
  const found = backlog.findings.find((entry) => entry.id === input.id);
  if (!found) return { ok: false, reason: `no finding ${input.id} in ${backlog.domain}` };
  if (found.status !== "open")
    return { ok: false, reason: `${input.id} is already ${found.status}` };
  const outcome = closingOutcome(input.id, input.outcome, input.outcomeMarkdown);
  if (typeof outcome === "string") return { ok: false, reason: outcome };
  const finding: Finding = {
    ...without(found, "outcomeMarkdown"),
    status: input.dismissed ? "dismissed" : "acted",
    closedAt: input.now,
    ...outcome,
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
 * Promote an open finding: add an open item titled after it (or the override), then close the
 * finding as acted with the outcome "promoted to <item id>".
 * @param backlog Current document.
 * @param input Finding id, optional one-line title override, and the time as an ISO string.
 * @returns The next document, the new item and the closed finding.
 */
export const promoteFinding = (
  backlog: Backlog,
  input: { id: string; title: string | undefined; now: string },
): OpResult<{ item: Item; finding: Finding }> => {
  const found = backlog.findings.find((entry) => entry.id === input.id);
  if (!found) return { ok: false, reason: `no finding ${input.id} in ${backlog.domain}` };
  if (found.status !== "open")
    return { ok: false, reason: `${input.id} is already ${found.status}` };
  const added = addItem(backlog, { title: input.title ?? found.title, now: input.now });
  if (!added.ok) return added;
  const closed = closeFinding(added.backlog, {
    id: found.id,
    outcome: `promoted to ${added.value.id}`,
    dismissed: false,
    now: input.now,
  });
  if (!closed.ok) return closed;
  return { ok: true, backlog: closed.backlog, value: { item: added.value, finding: closed.value } };
};

/**
 * The changes one `item update` applies. Unset fields, and empty lists, leave the item as it is.
 * Each `...Markdown` field is the Markdown form of the text field it names, and refused beside it.
 */
export type ItemUpdate = {
  id: string;
  status: ItemStatus | undefined;
  outcome: string | undefined;
  outcomeMarkdown?: string | undefined;
  decided: string[];
  decidedMarkdown?: string[];
  touch: string[];
  untouch: string[];
  due: string | null | undefined;
  ask: string | undefined;
  askMarkdown?: string | undefined;
  context: string | undefined;
  contextMarkdown?: string | undefined;
  options: string[];
  optionsMarkdown?: string[];
  rec: string | undefined;
  why: string | undefined;
  whyMarkdown?: string | undefined;
  answer: string | undefined;
  answerMarkdown?: string | undefined;
  note?: string | undefined;
  noteMarkdown?: string | undefined;
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
 * @param text A decision's text; a Markdown decision has none.
 * @returns True for a decision `answerDecision` wrote.
 */
export const isAnswer = (text: string | undefined): text is string =>
  text !== undefined && /^Re ".*": /s.test(text);

/**
 * Read the reserved Discuss answer form, or return undefined for a real answer.
 * @param answer The submitted answer.
 * @returns The trimmed note, including an empty string for a request without a note.
 */
export const discussionNoteFromAnswer = (answer: string): string | undefined => {
  const trimmed = answer.trim();
  if (trimmed === "Discuss") return "";
  return trimmed.startsWith("Discuss:") ? trimmed.slice("Discuss:".length).trim() : undefined;
};

/**
 * The event text appended when the user asks to discuss an ask.
 * @param question The ask's question.
 * @param note The optional note.
 * @returns The discussion event text.
 */
export const discussionDecision = (question: string, note: string): string =>
  `Discuss "${question}"${note === "" ? "" : `: ${note.replace(/[\r\n]+/g, " ")}`}`;

const refuse = (reason: string): OpResult<Item> => ({ ok: false, reason });

const isClosed = (status: ItemStatus): boolean => status === "done" || status === "dismissed";

const isDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const firstProblem = (field: string, values: string[]): string | undefined =>
  values.map((value) => oneLine(field, value)).find((problem) => problem !== undefined);

const flatten = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/**
 * Split `<label> :: <detail>` options into labels and details, refusing a multi-line label. A
 * Markdown option's detail may span lines.
 */
const parseOptions = (
  flag: string,
  options: string[],
  markdown: boolean,
): { labels: string[]; details: string[] } | string => {
  const parsed = options.map((option) => {
    const delimiter = option.indexOf(" :: ");
    const label = (delimiter === -1 ? option : option.slice(0, delimiter)).trim();
    const detail = delimiter === -1 ? "" : option.slice(delimiter + 4);
    return { label, detail: markdown ? trimMarkdown(detail) : detail.trim() };
  });
  if (!markdown) {
    const problem = firstProblem(flag, options);
    if (problem) return problem;
  }
  const labels = parsed.map(({ label }) => label);
  const labelProblem = firstProblem(flag, labels);
  if (labelProblem) return labelProblem;
  return { labels, details: parsed.map(({ detail }) => detail) };
};

/**
 * The ask an update attaches: undefined when it sets none, or why its parts do not fit together.
 */
const askOf = (input: ItemUpdate): Ask | undefined | string => {
  const optionsMarkdown = input.optionsMarkdown ?? [];
  const question = proseInput("ask", input.ask, input.askMarkdown, true);
  if (typeof question === "string") return question;
  if (question === undefined) {
    const parts = [
      input.context,
      input.contextMarkdown,
      input.rec,
      input.why,
      input.whyMarkdown,
    ].some((part) => part !== undefined);
    return parts || input.options.length > 0 || optionsMarkdown.length > 0
      ? "--context, --option, --rec and --why need --ask"
      : undefined;
  }
  const context = proseInput("context", input.context, input.contextMarkdown, false);
  if (typeof context === "string") return context;
  const why = proseInput("why", input.why, input.whyMarkdown, false);
  if (typeof why === "string") return why;
  if (input.options.length > 0 && optionsMarkdown.length > 0)
    return "--option and --option-md cannot be combined";
  const problem =
    (question.text === null ? undefined : oneLine("ask", question.text)) ??
    (context?.text == null ? undefined : oneLine("context", context.text)) ??
    (why?.text == null ? undefined : oneLine("why", why.text));
  if (problem) return problem;
  const markdownOptions = optionsMarkdown.length > 0;
  const parsed = markdownOptions
    ? parseOptions("option-md", optionsMarkdown, true)
    : parseOptions("option", input.options, false);
  if (typeof parsed === "string") return parsed;
  const { labels, details } = parsed;
  const optionDetails = details.some(Boolean) ? details : undefined;
  if (new Set(labels).size !== labels.length)
    return `--${markdownOptions ? "option-md" : "option"} values must be unique`;
  const rec = input.rec?.trim();
  if (rec !== undefined && !labels.includes(rec))
    return `--rec ${rec} must be one of the --option values: ${labels.length > 0 ? labels.join(", ") : "(none)"}`;
  if (why !== undefined && rec === undefined)
    return why.text === null ? "--why-md needs --rec" : "--why needs --rec";
  return {
    ...(question.text === null
      ? { questionMarkdown: question.markdown }
      : { question: question.text.trim() }),
    context: context?.text?.trim() ?? null,
    ...(context?.markdown === undefined ? {} : { contextMarkdown: context.markdown }),
    options: labels,
    ...(optionDetails === undefined
      ? {}
      : markdownOptions
        ? { optionDetailsMarkdown: optionDetails }
        : { optionDetails }),
    rec: rec ?? null,
    recReason: why?.text?.trim() ?? null,
    ...(why?.markdown === undefined ? {} : { recReasonMarkdown: why.markdown }),
    discuss: null,
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
  const decidedMarkdown = input.decidedMarkdown ?? [];
  const unchanged =
    input.status === undefined &&
    input.outcome === undefined &&
    input.outcomeMarkdown === undefined &&
    input.decided.length === 0 &&
    decidedMarkdown.length === 0 &&
    input.touch.length === 0 &&
    input.untouch.length === 0 &&
    input.due === undefined &&
    input.ask === undefined &&
    input.askMarkdown === undefined &&
    input.context === undefined &&
    input.contextMarkdown === undefined &&
    input.options.length === 0 &&
    (input.optionsMarkdown ?? []).length === 0 &&
    input.rec === undefined &&
    input.why === undefined &&
    input.whyMarkdown === undefined &&
    input.answer === undefined &&
    input.answerMarkdown === undefined &&
    input.note === undefined &&
    input.noteMarkdown === undefined;
  if (unchanged) return refuse(`nothing to update on ${input.id}`);
  const problem =
    firstProblem("decided", input.decided) ??
    (decidedMarkdown.some((entry) => entry.trim() === "") ? "--decided-md is empty" : undefined) ??
    firstProblem("touch", input.touch) ??
    firstProblem("untouch", input.untouch);
  if (problem) return refuse(problem);
  const asked = askOf(input);
  if (typeof asked === "string") return refuse(asked);
  const answer = proseInput("answer", input.answer, input.answerMarkdown, true);
  if (typeof answer === "string") return refuse(answer);
  const note = proseInput("note", input.note, input.noteMarkdown, false);
  if (typeof note === "string") return refuse(note);
  const outcome = proseInput("outcome", input.outcome, input.outcomeMarkdown, false);
  if (typeof outcome === "string") return refuse(outcome);
  const answerText = answer === undefined ? undefined : (answer.text ?? answer.markdown);
  if (answer?.text === null) {
    if (discussionNoteFromAnswer(answer.markdown) !== undefined)
      return refuse("a Discuss request is plain: pass it with --answer");
    if (found.ask?.options.includes(answer.markdown))
      return refuse(`${answer.markdown} is an option label: pass it with --answer`);
  }
  const discussionAnswerNote =
    answer?.text == null ? undefined : discussionNoteFromAnswer(answer.text);
  const discussionNote =
    discussionAnswerNote === undefined
      ? undefined
      : [discussionAnswerNote, note?.text ?? note?.markdown ?? ""]
          .filter(Boolean)
          .join(note?.markdown === undefined ? "; " : "\n\n");
  if (note !== undefined && answer === undefined)
    return refuse(note.text === null ? "--note-md needs --answer" : "--note needs --answer");
  if (answerText !== undefined) {
    if (asked) return refuse("--answer and --ask cannot be combined");
    if (!found.ask) return refuse(`${input.id} has no ask to answer`);
    const unanswerable = oneLine("answer", answerText);
    if (unanswerable) return refuse(unanswerable);
    if (
      discussionNote !== undefined &&
      input.status !== undefined &&
      input.status !== "waiting-user"
    )
      return refuse("a Discuss answer must keep status waiting-user");
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
  if (outcome !== undefined && !(input.status && isClosed(input.status)))
    return refuse(
      `--${outcome.text === null ? "outcome-md" : "outcome"} needs --status done or dismissed`,
    );

  const at = input.now.slice(0, 10);
  const discussed = (ask: Ask, text: string): Ask => ({
    ...ask,
    discuss:
      note?.markdown === undefined ? { note: text, at } : { note: "", noteMarkdown: text, at },
  });
  const noteSource = note === undefined ? undefined : (note.text ?? note.markdown);
  let item: Item = {
    ...found,
    status: discussionNote === undefined ? (input.status ?? found.status) : "waiting-user",
    touches,
    due: input.due === undefined ? found.due : input.due,
    ask:
      asked ??
      (answerText === undefined
        ? found.ask
        : discussionNote === undefined
          ? null
          : found.ask === null
            ? null
            : discussed(found.ask, discussionNote)),
    answered:
      answer !== undefined && found.ask && discussionNote === undefined
        ? [
            ...found.answered,
            {
              ...found.ask,
              discuss: null,
              ...(answer.text === null
                ? { answerMarkdown: answer.markdown }
                : { answer: answer.text.trim() }),
              note: note?.text || null,
              ...(note?.markdown === undefined ? {} : { noteMarkdown: note.markdown }),
              answeredAt: at,
            },
          ]
        : found.answered,
    decided: [
      ...found.decided,
      ...(answerText !== undefined && found.ask
        ? [
            {
              text:
                discussionNote === undefined
                  ? `${answerDecision(questionOf(found.ask), answerText.trim())}${noteSource?.trim() ? `. Note: ${flatten(noteSource)}` : ""}`
                  : discussionDecision(questionOf(found.ask), discussionNote),
              at,
            },
          ]
        : []),
      ...input.decided.map((text) => ({ text: text.trim(), at })),
      ...decidedMarkdown.map((markdown) => ({ markdown: trimMarkdown(markdown), at })),
    ],
  };
  if (asked && isClosed(input.status ?? found.status))
    return refuse("an ask needs an item that is not done or dismissed");
  if (input.status && isClosed(input.status)) {
    if (isClosed(found.status)) return refuse(`${input.id} is already ${found.status}`);
    if (outcome?.text === null)
      item = {
        ...without(item, "outcomeMarkdown"),
        ask: null,
        closedAt: input.now,
        outcome: null,
        outcomeMarkdown: outcome.markdown,
      };
    else {
      if (outcome === undefined || oneLine("outcome", outcome.text))
        return refuse(`${input.id} needs --outcome to become ${input.status}`);
      item = {
        ...without(item, "outcomeMarkdown"),
        ask: null,
        closedAt: input.now,
        outcome: outcome.text.trim(),
      };
    }
  } else if (isClosed(found.status))
    item = { ...without(item, "outcomeMarkdown"), closedAt: null, outcome: null };
  // Moving the item, or asking the user about it, answers a pending start request.
  if (item.startRequested !== undefined && (item.status !== found.status || asked !== undefined))
    item = without(item, "startRequested");
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

// A Boundary with its checkout map, the key dropped while the map is empty.
const withCheckouts = (boundary: Boundary, checkouts: Checkouts): Boundary => {
  const { checkouts: _dropped, ...rest } = boundary;
  return Object.keys(checkouts).length === 0 ? rest : { ...rest, checkouts };
};

/**
 * Record where an owned path's repo is checked out on another machine. The caller validates the
 * machine name against Herdr; a second, different checkout on the same machine is refused.
 * @param backlog Current document.
 * @param input The owned path, the Herdr machine name and the absolute path on that machine.
 * @returns The next document and whether the entry was added.
 */
export const addCheckout = (
  backlog: Backlog,
  input: { path: string; machine: string; checkout: string },
): OpResult<{ added: boolean }> => {
  if (!backlog.boundary.owned.includes(input.path))
    return {
      ok: false,
      reason: `${input.path} is not in the owned Boundary; checkouts are recorded only on owned paths`,
    };
  if (input.checkout === "") return { ok: false, reason: "checkout path is empty" };
  if (/[\r\n]/.test(input.checkout)) return { ok: false, reason: "checkout path must be one line" };
  if (!input.checkout.startsWith("/"))
    return { ok: false, reason: `${input.checkout} is not an absolute path` };
  const current = backlog.boundary.checkouts?.[input.path] ?? {};
  const existing = current[input.machine];
  if (existing === input.checkout) return { ok: true, backlog, value: { added: false } };
  if (existing !== undefined)
    return {
      ok: false,
      reason: `${input.path} already has a checkout on ${input.machine} at ${existing}; remove it first: coordinate backlog boundary rm ${input.path} --machine ${input.machine}`,
    };
  return {
    ok: true,
    backlog: {
      ...backlog,
      boundary: withCheckouts(backlog.boundary, {
        ...backlog.boundary.checkouts,
        [input.path]: { ...current, [input.machine]: input.checkout },
      }),
    },
    value: { added: true },
  };
};

/**
 * Remove an owned path's checkout on one machine.
 * @param backlog Current document.
 * @param input The owned path and the Herdr machine name.
 * @returns The next document; refused when no such entry is recorded.
 */
export const removeCheckout = (
  backlog: Backlog,
  input: { path: string; machine: string },
): OpResult<null> => {
  const current = backlog.boundary.checkouts?.[input.path] ?? {};
  if (current[input.machine] === undefined)
    return { ok: false, reason: `${input.path} has no checkout on ${input.machine}` };
  const remaining = { ...current };
  delete remaining[input.machine];
  const checkouts = { ...backlog.boundary.checkouts };
  if (Object.keys(remaining).length === 0) delete checkouts[input.path];
  else checkouts[input.path] = remaining;
  return {
    ok: true,
    backlog: { ...backlog, boundary: withCheckouts(backlog.boundary, checkouts) },
    value: null,
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
  const rest = { ...backlog.boundary.checkouts };
  delete rest[input.path];
  return {
    ok: true,
    backlog: {
      ...backlog,
      boundary: withCheckouts(
        {
          ...backlog.boundary,
          [input.list]: backlog.boundary[input.list].filter((path) => path !== input.path),
        },
        rest,
      ),
    },
    value: null,
  };
};

/**
 * A policy's body: one-line `text` (deprecated) or block `markdown`, exactly one.
 */
const policyBody = (
  text: string | undefined,
  markdown: string | undefined,
): { text: string } | { markdown: string } | string => {
  if (markdown !== undefined) {
    if (text !== undefined) return "pass the policy as text or --md, not both";
    return markdown.trim() === "" ? "--md is empty" : { markdown: trimMarkdown(markdown) };
  }
  if (text === undefined) return "pass the policy with --md";
  return oneLine("text", text) ?? { text };
};

/**
 * Add a reusable policy with a stable short id.
 * @param backlog Current document.
 * @param input The policy as text or Markdown, date as YYYY-MM-DD, and the wiki page it cites, if any.
 * @returns The next document and the new policy.
 */
export const addPolicy = (
  backlog: Backlog,
  input: {
    text: string | undefined;
    markdown?: string | undefined;
    at: string;
    wiki: string | undefined;
  },
): OpResult<Policy> => {
  const body = policyBody(input.text, input.markdown);
  if (typeof body === "string") return { ok: false, reason: body };
  const problem = input.wiki === undefined ? undefined : oneLine("--wiki", input.wiki);
  if (problem) return { ok: false, reason: problem };
  if (!isDate(input.at)) return { ok: false, reason: "--at must be YYYY-MM-DD" };
  const policy: Policy = {
    id: `p${backlog.nextPolicyId}`,
    ...body,
    at: input.at,
    ...(input.wiki === undefined ? {} : { wiki: input.wiki }),
  };
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
 * Replace a policy's text or Markdown and date while preserving its stable id, and its wiki
 * citation unless a new one is given.
 * @param backlog Current document.
 * @param input The policy id, replacement text or Markdown, date, and the page to cite instead,
 * if any.
 * @returns The next document and the updated policy.
 */
export const replacePolicy = (
  backlog: Backlog,
  input: {
    id: string;
    text: string | undefined;
    markdown?: string | undefined;
    at: string;
    wiki?: string | undefined;
  },
): OpResult<Policy> => {
  const found = backlog.policies.find((entry) => entry.id === input.id);
  if (!found) return { ok: false, reason: `no policy ${input.id} in ${backlog.domain}` };
  const body = policyBody(input.text, input.markdown);
  if (typeof body === "string") return { ok: false, reason: body };
  const problem = input.wiki === undefined ? undefined : oneLine("--wiki", input.wiki);
  if (problem) return { ok: false, reason: problem };
  if (!isDate(input.at)) return { ok: false, reason: "--at must be YYYY-MM-DD" };
  const cited = input.wiki ?? found.wiki;
  const policy: Policy = {
    id: found.id,
    ...body,
    at: input.at,
    ...(cited === undefined ? {} : { wiki: cited }),
  };
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
 * Set the domain's focus line, as text or inline Markdown, or clear it with null.
 * @param backlog Current document.
 * @param input The focus line, or null, or its inline Markdown form.
 * @returns The next document and the focus now stored.
 */
export const setFocus = (
  backlog: Backlog,
  input: { focus: string | null; markdown?: string | undefined },
): OpResult<string | null> => {
  const rest = without(backlog, "focusMarkdown");
  if (input.markdown !== undefined) {
    if (input.focus !== null)
      return { ok: false, reason: "pass the focus as text or --md, not both" };
    if (input.markdown.trim() === "")
      return { ok: false, reason: "focus is empty; pass --clear to clear it" };
    const problem = oneLine("focus", input.markdown.trim());
    if (problem) return { ok: false, reason: problem };
    const focusMarkdown = input.markdown.trim();
    return { ok: true, backlog: { ...rest, focus: null, focusMarkdown }, value: focusMarkdown };
  }
  if (input.focus === null) return { ok: true, backlog: { ...rest, focus: null }, value: null };
  if (input.focus.trim() === "")
    return { ok: false, reason: "focus is empty; pass --clear to clear it" };
  const problem = oneLine("focus", input.focus);
  if (problem) return { ok: false, reason: problem };
  const focus = input.focus.trim();
  return { ok: true, backlog: { ...rest, focus }, value: focus };
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
  const filed: Item = {
    ...without(item, "startRequested"),
    status: "delegated",
    delegates: [...item.delegates, input.ref],
  };
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
