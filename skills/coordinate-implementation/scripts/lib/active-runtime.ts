/**
 * Builds the Markdown block matcher for one active ticket runtime.
 *
 * @param ticket - Normalized ticket number used as the block heading.
 * @returns A regular expression matching only that ticket's active runtime block.
 */
export const activeRuntimeBlockPattern = (ticket: string): RegExp =>
  new RegExp(`^### ${ticket}\\r?\\n[\\s\\S]*?(?=^### |^## |(?![\\s\\S]))`, "mu");

/**
 * Parses scalar fields from one active ticket runtime block.
 *
 * @param block - Complete active runtime Markdown block.
 * @returns Field names mapped to their persisted values.
 */
export const parseActiveRuntimeFields = (block: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/u).slice(1)) {
    const field = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/u);
    if (field !== null) fields[field[1]!] = field[2]!;
  }
  return fields;
};
