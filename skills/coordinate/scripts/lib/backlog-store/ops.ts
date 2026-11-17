import type { Backlog, Finding, Item } from "./schema.ts";

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
  standingYes: [],
  items: [],
  findings: [],
  nextId: 1,
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
