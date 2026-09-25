/**
 * Shared readers and writers for the `## ` sections and the `## Tickets` table of RESUME.md.
 *
 * These helpers are pure string transforms. They report structural problems as values so each
 * operation can keep its own stable error codes.
 */

import type { RoleRecord } from "./contract.ts";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Location of one `## <name>` section: the heading start, the first character after the heading
 * line, and the start of the next `## ` heading (or the end of the document).
 */
export type SectionBounds = { start: number; contentStart: number; end: number };

/**
 * Finds the first `## <name>` section.
 *
 * @param markdown - Complete RESUME.md text.
 * @param name - Heading text after `## `.
 * @returns The section bounds, or null when the heading is absent.
 */
export const sectionBounds = (markdown: string, name: string): SectionBounds | null => {
  const heading = new RegExp(`^## ${escapeRegExp(name)}[ \\t]*\\r?$`, "mu").exec(markdown);
  if (heading === null) return null;
  const contentStart = heading.index + heading[0].length;
  const next = /^## /gmu;
  next.lastIndex = contentStart;
  return { start: heading.index, contentStart, end: next.exec(markdown)?.index ?? markdown.length };
};

/**
 * Returns the body of one `## <name>` section.
 *
 * @param markdown - Complete RESUME.md text.
 * @param name - Heading text after `## `.
 * @returns Text between the heading line and the next heading, or null when absent.
 */
export const sectionText = (markdown: string, name: string): string | null => {
  const bounds = sectionBounds(markdown, name);
  return bounds === null ? null : markdown.slice(bounds.contentStart, bounds.end);
};

/**
 * Appends one line to a section unless the section already contains it. A missing section is
 * created before `before` when that heading exists, otherwise at the end of the document.
 *
 * @param markdown - Complete RESUME.md text.
 * @param name - Heading text after `## `.
 * @param line - Exact line to append.
 * @param options - `spacing: "blank"` separates entries with a blank line; `"tight"` does not.
 * @returns Updated Markdown, or the original text when the line is already present.
 */
export const appendSectionLine = (
  markdown: string,
  name: string,
  line: string,
  options: { spacing: "blank" | "tight"; before?: string },
): string => {
  const bounds = sectionBounds(markdown, name);
  if (bounds === null) {
    const anchor = options.before === undefined ? null : sectionBounds(markdown, options.before);
    const insertion = anchor?.start ?? markdown.length;
    const after = markdown.slice(insertion).trimStart();
    return `${markdown.slice(0, insertion).trimEnd()}\n\n## ${name}\n\n${line}\n${after === "" ? "" : `\n${after}`}`;
  }
  const content = markdown.slice(bounds.contentStart, bounds.end);
  if (content.split(/\r?\n/u).includes(line)) return markdown;
  const body = markdown.slice(0, bounds.end).trimEnd();
  const separator = options.spacing === "blank" || content.trim() === "" ? "\n\n" : "\n";
  const after = markdown.slice(bounds.end);
  return `${body}${separator}${line}\n${after === "" ? "" : `\n${after}`}`;
};

/**
 * Splits one Markdown table row into trimmed cells.
 *
 * @param line - A `| a | b |` row.
 * @returns The cell values without the outer pipes.
 */
export const tableCells = (line: string): string[] =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

/**
 * Structural problem found while reading or updating the ticket table.
 */
export type TicketTableProblem =
  | { kind: "section_missing" }
  | { kind: "header_missing" }
  | { kind: "row_missing" }
  | { kind: "row_malformed" }
  | { kind: "column_missing"; column: string };

/**
 * One ticket row keyed by column name.
 */
export type TicketRow = Readonly<Record<string, string>> & { readonly NN: string };

type ParsedTable = {
  bounds: SectionBounds;
  lines: string[];
  columns: string[];
};

const parseTable = (markdown: string): ParsedTable | TicketTableProblem => {
  const bounds = sectionBounds(markdown, "Tickets");
  if (bounds === null) return { kind: "section_missing" };
  const lines = markdown.slice(bounds.contentStart, bounds.end).split("\n");
  const header = lines.find((line) => line.trimStart().startsWith("| NN"));
  if (header === undefined) return { kind: "header_missing" };
  return { bounds, lines, columns: tableCells(header) };
};

const isProblem = (value: object): value is TicketTableProblem => "kind" in value;

/**
 * Distinguishes a structural problem from a ticket row. Every row carries its `NN` cell.
 *
 * @param value - Result of {@link readTicketRow}.
 * @returns True when the value reports a problem.
 */
export const isTicketTableProblem = (
  value: TicketRow | TicketTableProblem,
): value is TicketTableProblem => !("NN" in value);

/**
 * Reads every well-formed ticket row, keyed by the table's own header names.
 *
 * @param markdown - Complete RESUME.md text.
 * @returns Rows in table order, or the structural problem that prevented reading them.
 */
export const readTicketRows = (markdown: string): TicketRow[] | TicketTableProblem => {
  const table = parseTable(markdown);
  if (isProblem(table)) return table;
  return table.lines.flatMap((line) => {
    const cells = tableCells(line.trimEnd());
    if (!/^\d+$/u.test(cells[0] ?? "") || cells.length !== table.columns.length) return [];
    return [Object.fromEntries(table.columns.map((column, index) => [column, cells[index]!]))];
  }) as TicketRow[];
};

/**
 * Reads every well-formed ticket row, treating a missing table as empty.
 *
 * @param markdown - Complete RESUME.md text.
 * @returns Rows in table order.
 */
export const ticketRows = (markdown: string): TicketRow[] => {
  const rows = readTicketRows(markdown);
  return Array.isArray(rows) ? rows : [];
};

/**
 * Finds one ticket row.
 *
 * @param markdown - Complete RESUME.md text.
 * @param ticket - Ticket number exactly as recorded.
 * @returns The row, or the structural problem that prevented finding it.
 */
export const readTicketRow = (markdown: string, ticket: string): TicketRow | TicketTableProblem => {
  const table = parseTable(markdown);
  if (isProblem(table)) return table;
  const line = table.lines.find((candidate) => tableCells(candidate)[0] === ticket);
  if (line === undefined) return { kind: "row_missing" };
  const cells = tableCells(line.trimEnd());
  if (cells.length !== table.columns.length) return { kind: "row_malformed" };
  return Object.fromEntries(
    table.columns.map((column, index) => [column, cells[index]!]),
  ) as TicketRow;
};

/**
 * Rewrites named cells of one ticket row.
 *
 * @param markdown - Complete RESUME.md text.
 * @param ticket - Ticket number exactly as recorded.
 * @param updates - New values keyed by column name.
 * @returns Updated Markdown, or the structural problem that prevented the update.
 */
export const updateTicketCells = (
  markdown: string,
  ticket: string,
  updates: Readonly<Record<string, string>>,
): string | TicketTableProblem => {
  const table = parseTable(markdown);
  if (isProblem(table)) return table;
  const rowIndex = table.lines.findIndex((line) => tableCells(line)[0] === ticket);
  if (rowIndex < 0) return { kind: "row_missing" };
  const cells = tableCells(table.lines[rowIndex]!.trimEnd());
  if (cells.length !== table.columns.length) return { kind: "row_malformed" };
  for (const [column, value] of Object.entries(updates)) {
    const index = table.columns.indexOf(column);
    if (index < 0) return { kind: "column_missing", column };
    cells[index] = value;
  }
  const carriage = table.lines[rowIndex]!.endsWith("\r") ? "\r" : "";
  const lines = table.lines.with(rowIndex, `| ${cells.join(" | ")} |${carriage}`);
  return `${markdown.slice(0, table.bounds.contentStart)}${lines.join("\n")}${markdown.slice(table.bounds.end)}`;
};

/**
 * Matches every indented `<label>:` field block, such as `Implementor:` or `Coordinator ownership:`.
 *
 * @param label - Block label before the colon.
 * @returns A global multiline pattern whose first group is the indented field lines.
 */
export const fieldBlockPattern = (label: string): RegExp =>
  new RegExp(`^${escapeRegExp(label)}:\\r?\\n((?:  [^\\r\\n]*(?:\\r?\\n|$))+)`, "gmu");

/**
 * Structural problem found while reading a field block.
 */
export type FieldBlockProblem = "block_count" | "fields_malformed";

/**
 * Reads the single `<label>:` block as a field map. Every non-empty line must be a unique
 * `  name: value` pair with a non-empty value.
 *
 * @param markdown - Complete RESUME.md text.
 * @param label - Block label before the colon.
 * @returns The fields, or the problem that prevented reading them.
 */
export const readFieldBlock = (
  markdown: string,
  label: string,
): Record<string, string> | FieldBlockProblem => {
  const matches = [...markdown.matchAll(fieldBlockPattern(label))];
  if (matches.length !== 1) return "block_count";
  const fields: Record<string, string> = {};
  for (const line of matches[0]![1]!.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const field = /^  ([a-z][a-z ]*):\s*(.*)$/u.exec(line);
    if (field === null || field[2]!.length === 0 || fields[field[1]!] !== undefined) {
      return "fields_malformed";
    }
    fields[field[1]!] = field[2]!;
  }
  return fields;
};

/**
 * Reads a role record from a field map.
 *
 * @param fields - Fields from {@link readFieldBlock}.
 * @returns The role, or null when harness, model, or effort is missing or invalid.
 */
export const roleFromFields = (fields: Readonly<Record<string, string>>): RoleRecord | null => {
  const { harness, model, effort } = fields;
  if ((harness !== "claude" && harness !== "pi") || model === undefined || effort === undefined) {
    return null;
  }
  return { harness, model, effort };
};

/**
 * Reads the single `<label>:` role block.
 *
 * @param markdown - Complete RESUME.md text.
 * @param label - Role block label, such as `Implementor`.
 * @returns The role, or the problem that prevented reading it.
 */
export const readRoleBlock = (
  markdown: string,
  label: string,
): RoleRecord | FieldBlockProblem | "role_incomplete" => {
  const fields = readFieldBlock(markdown, label);
  if (typeof fields === "string") return fields;
  return roleFromFields(fields) ?? "role_incomplete";
};

/**
 * Compares two role records field by field.
 *
 * @param left - First role.
 * @param right - Second role.
 * @returns True when harness, model, and effort all match.
 */
export const sameRole = (left: RoleRecord, right: RoleRecord): boolean =>
  left.harness === right.harness && left.model === right.model && left.effort === right.effort;
