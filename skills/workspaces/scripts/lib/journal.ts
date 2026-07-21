import { Data } from "effect";

/**
 * The journal's entry categories. The journal records decisions and
 * deviations, not routine activity; there is deliberately no "misc".
 */
export type JournalCategory = "decision" | "deviation" | "scope" | "cross-repo";

/**
 * Raised when a journal category string is not one of the known categories.
 */
export class UnknownCategoryError extends Data.TaggedError("UnknownCategoryError")<{
  category: string;
}> {}

const CATEGORY_LABELS: Record<JournalCategory, string> = {
  decision: "Decision",
  deviation: "Deviation",
  scope: "Scope change",
  "cross-repo": "Cross-repo change",
};

/**
 * One journal entry before rendering. `links` cross-reference the change
 * three ways (plan/phase, ADR, member PR/commit) per the workspace
 * conventions.
 */
export type JournalEntry = {
  category: JournalCategory;
  title: string;
  links: string[];
  body: string | undefined;
};

/**
 * Narrows an arbitrary string to a `JournalCategory`, returning undefined
 * for unknown values.
 */
export const parseCategory = (value: string): JournalCategory | undefined =>
  value in CATEGORY_LABELS ? (value as JournalCategory) : undefined;

/**
 * Renders one journal entry as markdown (no surrounding date heading).
 */
export const renderEntry = (entry: JournalEntry): string => {
  const lines = [`### ${CATEGORY_LABELS[entry.category]}: ${entry.title}`];
  if (entry.links.length > 0) {
    lines.push("", `**Links:** ${entry.links.join(", ")}`);
  }
  if (entry.body) {
    lines.push("", entry.body.trim());
  }
  return lines.join("\n");
};

/**
 * Inserts an entry into JOURNAL.md content under a `## <date>` heading,
 * newest date first. When the newest section already carries `date`, the
 * entry is appended to that section; otherwise a new date section is
 * inserted ahead of the older ones. The preamble above the first date
 * heading is preserved untouched.
 */
export const appendEntry = (content: string, entry: JournalEntry, date: string): string => {
  const rendered = renderEntry(entry);
  const firstDateHeading = content.search(/^## /m);

  if (firstDateHeading === -1) {
    const trimmed = content.replace(/\s+$/, "");
    return `${trimmed}\n\n## ${date}\n\n${rendered}\n`;
  }

  const preamble = content.slice(0, firstDateHeading);
  const sections = content.slice(firstDateHeading);
  const newestHeading = `## ${date}`;

  if (sections.startsWith(`${newestHeading}\n`)) {
    const rest = sections.slice(newestHeading.length + 1);
    const nextHeading = rest.search(/^## /m);
    if (nextHeading === -1) {
      return `${preamble}${newestHeading}\n${rest.replace(/\s+$/, "")}\n\n${rendered}\n`;
    }
    const currentSection = rest.slice(0, nextHeading).replace(/\s+$/, "");
    const remainder = rest.slice(nextHeading);
    return `${preamble}${newestHeading}\n${currentSection}\n\n${rendered}\n\n${remainder}`;
  }

  return `${preamble}${newestHeading}\n\n${rendered}\n\n${sections}`;
};
