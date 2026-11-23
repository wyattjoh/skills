import {
  isDiscussion,
  ITEM_STATUSES,
  type Ask,
  type Backlog,
  type Item,
  type Policy,
} from "./schema.ts";

const askLines = (ask: Ask, header: string): string[] => {
  const lines = [header];
  if (ask.context) lines.push(`    - context: ${ask.context}`);
  if (ask.discuss !== null)
    lines.push(
      `    - discussion requested (${ask.discuss.at})${ask.discuss.note ? `: ${ask.discuss.note}` : ""}`,
    );
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

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

const answeredLines = (item: Item, verbose: boolean): string[] => {
  const lines: string[] = [];
  for (let index = item.answered.length - 1; index >= 0; index -= 1) {
    const answered = item.answered[index]!;
    if (!verbose) {
      const note = answered.note === null ? "" : oneLine(answered.note);
      lines.push(
        `  - answered (${answered.answeredAt}): ${oneLine(answered.question)} → ${oneLine(answered.answer)}${note ? `. Note: ${note}` : ""}`,
      );
      continue;
    }
    lines.push(
      ...askLines(answered, `  - answered ask (${answered.answeredAt}): ${answered.question}`),
      `    - answer: ${answered.answer}`,
      ...(answered.note === null ? [] : [`    - answer note: ${answered.note}`]),
    );
  }
  return lines;
};

const itemLines = (item: Item, idle: ReadonlySet<string>, verbose: boolean): string[] => {
  const facts = [
    ...(item.due ? [`due ${item.due}`] : []),
    ...(item.touches.length > 0 ? [`touches ${item.touches.join(", ")}`] : []),
  ];
  const lines = [
    `- ${item.id} [${item.status}${idle.has(item.id) ? ", none live" : ""}] ${item.title}${facts.map((fact) => ` · ${fact}`).join("")}`,
  ];
  if (item.ask) lines.push(...askLines(item.ask, `  - ask: ${item.ask.question}`));
  lines.push(...answeredLines(item, verbose));
  for (const entry of item.decided)
    lines.push(
      isDiscussion(entry.text)
        ? `  - discuss ${entry.at}: ${entry.text.slice("Discuss ".length)}`
        : `  - decided ${entry.at}: ${entry.text}`,
    );
  for (const ref of item.delegates)
    lines.push(
      `  - delegate ${ref.name} session ${ref.session}${ref.branch ? ` branch ${ref.branch}` : ""}${ref.worktree ? ` worktree ${ref.worktree}` : ""}${ref.brief ? ` brief ${ref.brief}` : ""}${ref.report ? ` report ${ref.report}` : ""}`,
    );
  return lines;
};

const closedLine = (item: Item): string =>
  `- ${item.id} [${item.status} ${(item.closedAt ?? "").slice(0, 10)}] ${item.title}: ${item.outcome ?? ""}`;

const closedLines = (item: Item, verbose: boolean): string[] => [
  closedLine(item),
  ...answeredLines(item, verbose),
];

const closed = (item: Item): boolean => item.status === "done" || item.status === "dismissed";

/**
 * A policy's wiki citation as printed after its text, or nothing when it cites no page.
 * @param policy The policy.
 * @returns ` (wiki: [[page]])` or an empty string.
 */
export const policyCitation = (policy: Policy): string =>
  policy.wiki === undefined ? "" : ` (wiki: [[${policy.wiki}]])`;

const list = (paths: string[]): string => (paths.length > 0 ? paths.join(", ") : "(none)");

/**
 * Render a backlog as Markdown for reading; the document stays the only source of truth.
 * @param backlog Document.
 * @param idle Ids of delegated items with no live delegate, marked `[delegated, none live]`.
 * @param showDone Include closed items instead of the hidden-count line.
 * @param verbose Render full context, options and recommendations for answered asks.
 * @returns Markdown, ending in a newline.
 */
export const renderBacklog = (
  backlog: Backlog,
  idle: ReadonlySet<string> = new Set(),
  showDone = false,
  verbose = false,
): string => {
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
      ? backlog.policies.map(
          (policy) => `- ${policy.id} ${policy.at}: ${policy.text}${policyCitation(policy)}`,
        )
      : ["(none)"]),
    "",
    "## Open",
    "",
    ...(open.length > 0 ? open.flatMap((item) => itemLines(item, idle, verbose)) : ["(none)"]),
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
    ...(showDone
      ? done.length > 0
        ? done.flatMap((item) => closedLines(item, verbose))
        : ["(none)"]
      : done.length > 0
        ? [`${done.length} closed items hidden (coordinate backlog show --done)`]
        : []),
  );
  return `${lines.join("\n")}\n`;
};
