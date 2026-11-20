import { ITEM_STATUSES, type Ask, type Backlog, type Item } from "./schema.ts";

const askLines = (ask: Ask, header: string): string[] => {
  const lines = [header];
  if (ask.context) lines.push(`    - context: ${ask.context}`);
  const choices = ask.options.map((option, index) => ({ option, index }));
  const recIndex = ask.rec ? choices.find(({ option }) => option === ask.rec)?.index : undefined;
  const ordered =
    recIndex === undefined
      ? choices
      : [choices[recIndex]!, ...choices.filter(({ index }) => index !== recIndex)];
  for (const { option, index } of ordered) {
    const recommended = option === ask.rec;
    const detail = ask.optionDetails?.[index];
    const label = recommended
      ? `${option} (recommended${ask.recReason ? `: ${ask.recReason}` : ""})`
      : option;
    lines.push(`    - ${label}${detail ? `: ${detail}` : ""}`);
  }
  return lines;
};

const answeredLines = (item: Item): string[] => {
  const lines: string[] = [];
  for (let index = item.answered.length - 1; index >= 0; index -= 1) {
    const answered = item.answered[index]!;
    lines.push(
      ...askLines(answered, `  - answered ask (${answered.answeredAt}): ${answered.question}`),
      `    - answer: ${answered.answer}`,
    );
  }
  return lines;
};

const itemLines = (item: Item, idle: ReadonlySet<string>): string[] => {
  const facts = [
    ...(item.due ? [`due ${item.due}`] : []),
    ...(item.touches.length > 0 ? [`touches ${item.touches.join(", ")}`] : []),
  ];
  const lines = [
    `- ${item.id} [${item.status}${idle.has(item.id) ? ", none live" : ""}] ${item.title}${facts.map((fact) => ` · ${fact}`).join("")}`,
  ];
  if (item.ask) lines.push(...askLines(item.ask, `  - ask: ${item.ask.question}`));
  lines.push(...answeredLines(item));
  for (const entry of item.decided) lines.push(`  - decided ${entry.at}: ${entry.text}`);
  for (const ref of item.delegates)
    lines.push(
      `  - delegate ${ref.name} session ${ref.session}${ref.branch ? ` branch ${ref.branch}` : ""}${ref.worktree ? ` worktree ${ref.worktree}` : ""}${ref.brief ? ` brief ${ref.brief}` : ""}${ref.report ? ` report ${ref.report}` : ""}`,
    );
  return lines;
};

const closedLine = (item: Item): string =>
  `- ${item.id} [${item.status} ${(item.closedAt ?? "").slice(0, 10)}] ${item.title}: ${item.outcome ?? ""}`;

const closedLines = (item: Item): string[] => [closedLine(item), ...answeredLines(item)];

const closed = (item: Item): boolean => item.status === "done" || item.status === "dismissed";

const list = (paths: string[]): string => (paths.length > 0 ? paths.join(", ") : "(none)");

/**
 * Render a backlog as Markdown for reading; the document stays the only source of truth.
 * @param backlog Document.
 * @param idle Ids of delegated items with no live delegate, marked `[delegated, none live]`.
 * @returns Markdown, ending in a newline.
 */
export const renderBacklog = (backlog: Backlog, idle: ReadonlySet<string> = new Set()): string => {
  const open = ITEM_STATUSES.flatMap((status) =>
    backlog.items.filter((item) => item.status === status && !closed(item)),
  );
  const done = backlog.items
    .filter(closed)
    .toSorted((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  const findings = backlog.findings.filter((finding) => finding.status === "open");
  const lines = [`# ${backlog.domain} backlog`, ""];
  if (backlog.legacy)
    lines.push(`Legacy Markdown backlog (reference only, not read): ${backlog.legacy}`, "");
  if (backlog.focus) lines.push(`Focus: ${backlog.focus}`, "");
  lines.push(
    "## Boundary",
    "",
    `- Owned: ${list(backlog.boundary.owned)}`,
    `- Adjacent: ${list(backlog.boundary.adjacent)}`,
    "",
    "## Policies",
    "",
    ...(backlog.policies.length > 0
      ? backlog.policies.map((policy) => `- ${policy.id} ${policy.at}: ${policy.text}`)
      : ["(none)"]),
    "",
    "## Open",
    "",
    ...(open.length > 0 ? open.flatMap((item) => itemLines(item, idle)) : ["(none)"]),
    "",
    "## Findings",
    "",
    ...(findings.length > 0
      ? findings.map(
          (finding) =>
            `- ${finding.id} [${finding.kind}] ${finding.title}${finding.from ? ` (from ${finding.from})` : ""}`,
        )
      : ["(none)"]),
    "",
    "## Done",
    "",
    ...(done.length > 0 ? done.flatMap(closedLines) : ["(none)"]),
  );
  return `${lines.join("\n")}\n`;
};
