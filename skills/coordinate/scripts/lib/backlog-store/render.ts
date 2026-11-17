import { ITEM_STATUSES, type Backlog, type Item } from "./schema.ts";

const itemLines = (item: Item): string[] => {
  const facts = [
    ...(item.due ? [`due ${item.due}`] : []),
    ...(item.touches.length > 0 ? [`touches ${item.touches.join(", ")}`] : []),
  ];
  const lines = [
    `- ${item.id} [${item.status}] ${item.title}${facts.map((fact) => ` · ${fact}`).join("")}`,
  ];
  if (item.ask) {
    lines.push(`  - ask: ${item.ask.question}`);
    if (item.ask.context) lines.push(`    - context: ${item.ask.context}`);
    const ordered = item.ask.rec
      ? [item.ask.rec, ...item.ask.options.filter((option) => option !== item.ask?.rec)]
      : item.ask.options;
    for (const option of ordered)
      lines.push(
        option === item.ask.rec
          ? `    - ${option} (recommended${item.ask.recReason ? `: ${item.ask.recReason}` : ""})`
          : `    - ${option}`,
      );
  }
  for (const entry of item.decided) lines.push(`  - decided ${entry.at}: ${entry.text}`);
  for (const ref of item.delegates)
    lines.push(
      `  - delegate ${ref.name} session ${ref.session}${ref.branch ? ` branch ${ref.branch}` : ""}${ref.worktree ? ` worktree ${ref.worktree}` : ""}${ref.brief ? ` brief ${ref.brief}` : ""}${ref.report ? ` report ${ref.report}` : ""}`,
    );
  return lines;
};

const closedLine = (item: Item): string =>
  `- ${item.id} [${item.status} ${(item.closedAt ?? "").slice(0, 10)}] ${item.title}: ${item.outcome ?? ""}`;

const closed = (item: Item): boolean => item.status === "done" || item.status === "dismissed";

const list = (paths: string[]): string => (paths.length > 0 ? paths.join(", ") : "(none)");

/**
 * Render a backlog as Markdown for reading; the document stays the only source of truth.
 * @param backlog Document.
 * @returns Markdown, ending in a newline.
 */
export const renderBacklog = (backlog: Backlog): string => {
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
    "## Standing yes",
    "",
    ...(backlog.standingYes.length > 0
      ? backlog.standingYes.map((entry) => `- ${entry.at}: ${entry.text}`)
      : ["(none)"]),
    "",
    "## Open",
    "",
    ...(open.length > 0 ? open.flatMap(itemLines) : ["(none)"]),
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
    ...(done.length > 0 ? done.map(closedLine) : ["(none)"]),
  );
  return `${lines.join("\n")}\n`;
};
