import {
  isDiscussion,
  ITEM_STATUSES,
  prose,
  proseSource,
  questionOf,
  type Ask,
  type Prose,
  type Backlog,
  type Finding,
  type Item,
  type Policy,
} from "./schema.ts";

const multiLine = (text: string): boolean => /[\r\n]/.test(text);

/**
 * Markdown as continuation lines inside a list item whose content starts at `indent` columns,
 * after a blank line, so a list, fence or heading in it stays inside that item.
 */
const continuation = (text: string, indent: number): string[] => [
  "",
  ...text.split(/\r?\n/).map((line) => (line.trim() === "" ? "" : `${" ".repeat(indent)}${line}`)),
];

/**
 * A bullet whose value may be multi-line Markdown: one line stays after the head; more go below it.
 * Plain text stays after the head as it always has.
 * @param head The bullet up to the value, such as `  - decided 2026-01-01:`.
 * @param value The shown prose, or null for none.
 * @param indent The bullet's content column.
 */
const bullet = (head: string, value: Prose | null, indent: number): string[] =>
  value?.markdown && multiLine(value.value)
    ? [head, ...continuation(value.value, indent)]
    : [`${head} ${value?.value ?? ""}`];

const below = (value: Prose | null): boolean => value?.markdown === true && multiLine(value.value);

const askLines = (ask: Ask, header: string): string[] => {
  const lines = [header];
  const context = prose(ask.context, ask.contextMarkdown);
  if (context) lines.push(...bullet("    - context:", context, 6));
  if (ask.discuss !== null) {
    const note = prose(ask.discuss.note, ask.discuss.noteMarkdown);
    const head = `    - discussion requested (${ask.discuss.at})`;
    lines.push(...(note ? bullet(`${head}:`, note, 6) : [head]));
  }
  const choices = ask.options.map((option, index) => ({ option, index }));
  const recIndex = ask.rec ? choices.find(({ option }) => option === ask.rec)?.index : undefined;
  const ordered =
    recIndex === undefined
      ? choices
      : [choices[recIndex]!, ...choices.filter(({ index }) => index !== recIndex)];
  const reason = prose(ask.recReason, ask.recReasonMarkdown);
  for (const { option, index } of ordered) {
    const recommended = option === ask.rec;
    const detail = prose(ask.optionDetails?.[index], ask.optionDetailsMarkdown?.[index]);
    const label = recommended
      ? `${option} (recommended${reason && !below(reason) ? `: ${reason.value}` : ""})`
      : option;
    lines.push(
      `    - ${label}${detail && !below(detail) ? `: ${detail.value}` : ""}`,
      ...(recommended && reason && below(reason) ? continuation(reason.value, 6) : []),
      ...(detail && below(detail) ? continuation(detail.value, 6) : []),
    );
  }
  return lines;
};

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

const answeredLines = (item: Item, verbose: boolean): string[] => {
  const lines: string[] = [];
  for (let index = item.answered.length - 1; index >= 0; index -= 1) {
    const answered = item.answered[index]!;
    const answer = proseSource(answered.answer, answered.answerMarkdown);
    const note = prose(answered.note, answered.noteMarkdown);
    if (!verbose) {
      lines.push(
        `  - answered (${answered.answeredAt}): ${oneLine(questionOf(answered))} → ${oneLine(answer)}${note ? `. Note: ${oneLine(note.value)}` : ""}`,
      );
      continue;
    }
    lines.push(
      ...askLines(answered, `  - answered ask (${answered.answeredAt}): ${questionOf(answered)}`),
      `    - answer: ${answer}`,
      ...(answered.note === null && note === null ? [] : bullet("    - answer note:", note, 6)),
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
  if (item.ask) lines.push(...askLines(item.ask, `  - ask: ${questionOf(item.ask)}`));
  lines.push(...answeredLines(item, verbose));
  for (const entry of item.decided)
    lines.push(
      ...(isDiscussion(entry.text)
        ? [`  - discuss ${entry.at}: ${entry.text.slice("Discuss ".length)}`]
        : bullet(`  - decided ${entry.at}:`, prose(entry.text, entry.markdown), 4)),
    );
  for (const ref of item.delegates)
    lines.push(
      `  - delegate ${ref.name} session ${ref.session}${ref.branch ? ` branch ${ref.branch}` : ""}${ref.worktree ? ` worktree ${ref.worktree}` : ""}${ref.brief ? ` brief ${ref.brief}` : ""}${ref.report ? ` report ${ref.report}` : ""}`,
    );
  return lines;
};

const closedLines = (item: Item, verbose: boolean): string[] => [
  ...bullet(
    `- ${item.id} [${item.status} ${(item.closedAt ?? "").slice(0, 10)}] ${item.title}:`,
    prose(item.outcome, item.outcomeMarkdown),
    2,
  ),
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

const findingOrigin = (finding: Finding): string => {
  const parts = [
    ...(finding.from ? [`from ${finding.from}`] : []),
    ...(finding.source ? [`source ${finding.source}`] : []),
  ];
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
};

// Each owned path's checkouts on other machines, by machine name, under the Owned line.
const checkoutLines = (backlog: Backlog): string[] =>
  backlog.boundary.owned.flatMap((path) =>
    Object.entries(backlog.boundary.checkouts?.[path] ?? {})
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([machine, checkout]) => `  - ${path} on ${machine}: ${checkout}`),
  );

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
  const focus = proseSource(backlog.focus, backlog.focusMarkdown);
  if (focus) lines.push(`Focus: ${oneLine(focus)}`, "");
  lines.push(
    "## Boundary",
    "",
    `- Owned: ${list(backlog.boundary.owned)}`,
    ...checkoutLines(backlog),
    `- Adjacent: ${list(backlog.boundary.adjacent)}`,
    "",
    "## Policies",
    "",
    ...(backlog.policies.length > 0
      ? backlog.policies.flatMap((policy) => {
          const body = prose(policy.text, policy.markdown);
          return body?.markdown && multiLine(body.value)
            ? [
                `- ${policy.id} ${policy.at}:${policyCitation(policy)}`,
                ...continuation(body.value, 2),
              ]
            : [`- ${policy.id} ${policy.at}: ${body?.value ?? ""}${policyCitation(policy)}`];
        })
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
            `- ${finding.id} [${finding.kind}] ${finding.title}${findingOrigin(finding)}`,
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
