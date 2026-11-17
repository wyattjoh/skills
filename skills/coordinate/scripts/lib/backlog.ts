/**
 * One `## ` section of a backlog, by character offsets into the text.
 */
export type Section = {
  heading: string;
  /**
   * Offset of the `## ` line.
   */
  start: number;
  /**
   * Offset just past the heading line.
   */
  bodyStart: number;
  /**
   * Offset of the next `## ` heading, or the end of the text.
   */
  end: number;
};

/**
 * The sections a backlog has, in order. Every section is fixed.
 */
export const SECTION_NAMES = ["Boundary", "Standing yes", "Open", "Done"] as const;

/**
 * Split a backlog into `## ` sections, ignoring headings inside code fences.
 * @param text Backlog text.
 * @returns Sections by offset.
 */
export const sections = (text: string): Section[] => {
  const found: Section[] = [];
  let offset = 0;
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
    } else if (fence === undefined && /^## (?!#)/.test(line)) {
      const previous = found.at(-1);
      if (previous) previous.end = offset;
      found.push({
        heading: line.slice(3).trim(),
        start: offset,
        bodyStart: Math.min(offset + line.length + 1, text.length),
        end: text.length,
      });
    }
    offset += line.length + 1;
  }
  return found;
};

/**
 * The body of one section.
 * @param text Backlog text.
 * @param heading Heading without `## `.
 * @returns The body, or undefined when the section is missing.
 */
export const section = (text: string, heading: string): string | undefined => {
  const found = sections(text).find((candidate) => candidate.heading === heading);
  return found === undefined ? undefined : text.slice(found.bodyStart, found.end);
};

/**
 * Replace one section's body by offset, so identical text elsewhere is never touched.
 * @param text Backlog text.
 * @param heading Heading without `## `.
 * @param body New body.
 * @returns The new text, or undefined when the section is missing.
 */
export const replaceSection = (text: string, heading: string, body: string): string | undefined => {
  const found = sections(text).find((candidate) => candidate.heading === heading);
  if (found === undefined) return undefined;
  const tail = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  return text.slice(0, found.bodyStart) + tail + text.slice(found.end);
};

/**
 * Append a line to a section's body, before trailing blank lines.
 * @param text Backlog text.
 * @param heading Heading without `## `.
 * @param line Line to add.
 * @returns The new text, or undefined when the section is missing.
 */
export const appendToSection = (
  text: string,
  heading: string,
  line: string,
): string | undefined => {
  const body = section(text, heading);
  if (body === undefined) return undefined;
  const trimmed = body.replace(/\s+$/, "");
  return replaceSection(text, heading, `${trimmed === "" ? "\n" : `${trimmed}\n`}${line}\n\n`);
};

/**
 * A new backlog for a domain.
 * @param domain Domain name.
 * @returns Markdown.
 */
export const template = (domain: string): string => `# ${domain} backlog

## Boundary

- Owns: (repos by path, such as \`~/Code/github.com/<org>/<repo>\`, docs, tools, decisions)
- Adjacent (read freely, change only via a delegated task with the user's yes):

## Standing yes

## Open

## Done
`;

/**
 * Missing sections, in order.
 * @param text Backlog text.
 * @returns Names of sections the backlog lacks.
 */
export const missingSections = (text: string): string[] => {
  const present = new Set(sections(text).map((found) => found.heading));
  return SECTION_NAMES.filter((name) => !present.has(name));
};
