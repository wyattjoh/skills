/**
 * A pinned reference used to populate the project's Dependency References table.
 */
export type Reference = {
  dependency: string;
  version: string;
  path: string;
  url: string;
  commit: string;
};

const cells = (line: string): string[] =>
  line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
const unquote = (cell: string): string => cell.replace(/`/g, "").replace(/\/$/, "");
const row = (values: readonly string[]): string => `| ${values.join(" | ")} |`;

/**
 * Insert or replace a reference by path, sort by dependency, and preserve surrounding
 * prose and extra table columns. Reject ambiguous or unsupported existing tables.
 */
export const updateReferences = (document: string, reference: Reference): string => {
  for (const value of Object.values(reference)) {
    if (/[|`\r\n]/.test(value))
      throw new Error("Reference values cannot contain pipes, backticks, or newlines.");
  }
  const newline = document.includes("\r\n") ? "\r\n" : "\n";
  const lines = document.split(/\r?\n/);
  const headings = lines.flatMap((line, index) =>
    /^#{1,6}\s+Dependency References\s*$/.test(line) ? [index] : [],
  );
  if (headings.length > 1)
    throw new Error("CLAUDE.md has multiple Dependency References sections.");
  const heading = headings[0];
  if (heading === undefined) {
    const table = [
      "## Dependency References",
      "",
      row(["Dependency", "Version", "Path"]),
      row(["----------", "-------", "----"]),
      row([reference.dependency, reference.version, `\`${reference.path}\``]),
    ].join(newline);
    return `${document.trimEnd()}${document.trim() ? newline + newline : ""}${table}${newline}`;
  }
  const level = lines[heading]!.match(/^#+/)![0].length;
  let end = heading + 1;
  while (end < lines.length) {
    const next = lines[end]!.match(/^(#{1,6})\s/);
    if (next && next[1]!.length <= level) break;
    end++;
  }
  const tables = lines
    .slice(heading + 1, end)
    .flatMap((line, index) =>
      line.trim().startsWith("|") && lines[heading + index + 2]?.trim().match(/^\|[\s:|-]+\|$/)
        ? [heading + index + 1]
        : [],
    );
  if (tables.length > 1)
    throw new Error("Dependency References has multiple tables; edit it manually first.");
  const start = tables[0];
  if (start === undefined) {
    const addition = updateReferences("", reference).split(/\r?\n/).slice(2, -1);
    lines.splice(heading + 1, 0, "", ...addition, "");
    return lines.join(newline);
  }
  const headers = cells(lines[start]!);
  const dependency = headers.findIndex((cell) => cell === "Dependency");
  const version = headers.findIndex((cell) => /^Version(?:\s|$)/.test(cell));
  const path = headers.findIndex((cell) => cell === "Path");
  if (dependency < 0 || version < 0 || path < 0) {
    throw new Error("Dependency References table needs Dependency, Version, and Path columns.");
  }
  let stop = start + 2;
  while (stop < end && lines[stop]!.trim().startsWith("|")) stop++;
  const rows = lines.slice(start + 2, stop).map(cells);
  if (rows.some((values) => values.length !== headers.length)) {
    throw new Error("Dependency References table has a malformed row.");
  }
  const entry =
    rows.find((values) => unquote(values[path]!) === reference.path)?.slice() ??
    headers.map(() => "");
  entry[dependency] = reference.dependency;
  entry[version] = reference.version;
  entry[path] = `\`${reference.path}\``;
  headers.forEach((header, index) => {
    if (header === "Repository") entry[index] = reference.url;
    if (/^Pin(?:\s|$)/.test(header)) entry[index] = `\`${reference.commit}\``;
  });
  const updated = [
    ...rows.filter((values) => unquote(values[path]!) !== reference.path),
    entry,
  ].toSorted((a, b) => a[dependency]!.localeCompare(b[dependency]!));
  lines.splice(start + 2, stop - start - 2, ...updated.map(row));
  return lines.join(newline);
};
