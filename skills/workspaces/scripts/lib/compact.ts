import { Data, Effect } from "effect";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type GitCommandError, isDirty, isGitRepo, runGit } from "./git.ts";

/**
 * Raised when the compact flow cannot proceed: the hub is not a clean git
 * repository, there is nothing to compact, or a prior compaction left the
 * archive in a state that would be overwritten.
 */
export class CompactError extends Data.TaggedError("CompactError")<{
  message: string;
}> {}

/**
 * One ADR parsed from `docs/adr/`. ADRs are intentionally minimal (a title
 * and a few sentences, optional `status` frontmatter), so every field beyond
 * the filename is best-effort: `title` falls back to the slug and `status`
 * is null when the ADR records none.
 */
export type AdrRecord = {
  /** Sequential number from the `NNNN-` filename prefix, or null if unnumbered. */
  number: number | null;
  /** Kebab slug from the filename (without number prefix or `.md`). */
  slug: string;
  /** File name relative to `docs/adr/`, e.g. `0001-event-sourcing.md`. */
  file: string;
  /** First `# ` heading, or the slug when the ADR has no heading. */
  title: string;
  /** Declared MADR status (`accepted`, `superseded by ADR-3`, …) or null. */
  status: string | null;
  /** ADR numbers this ADR references (supersession targets, links), ascending. */
  references: number[];
};

/**
 * One switch recorded in the journal: a Deviation or Scope change entry.
 * These are the historical course-corrections compaction drops from the ADR
 * set, surfaced here so the flow can reason about which decisions reversed.
 */
export type JournalSwitch = {
  date: string;
  category: "Deviation" | "Scope change";
  title: string;
  links: string[];
};

/**
 * The result of archiving the live ADRs: what moved into `docs/adr/archive/`.
 * The compact flow turns this into the archive mapping manifest.
 */
export type ArchivedAdr = {
  number: number | null;
  slug: string;
  file: string;
};

const ADR_FILENAME = /^(\d+)-(.+)\.md$/;
const HEADING = /^#\s+(.+?)\s*$/m;
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const FRONTMATTER_STATUS = /^status\s*:\s*(.+?)\s*$/im;
const INLINE_STATUS = /^\s*(?:[-*]\s+)?\*{0,2}status\s*:\s*\*{0,2}\s*(.+?)\s*\*{0,2}\s*$/im;
const ADR_REFERENCE = /\badr[-\s/]?0*(\d{1,4})\b/gi;

/**
 * Parses one ADR file into a structured record. Tolerant by design: ADRs may
 * carry no frontmatter, no status, and only a title, so this never throws on a
 * sparse ADR; it fills what it can and leaves the rest null/empty.
 */
export const parseAdr = (file: string, content: string): AdrRecord => {
  const nameMatch = ADR_FILENAME.exec(file);
  const number = nameMatch ? Number.parseInt(nameMatch[1], 10) : null;
  const slug = nameMatch ? nameMatch[2] : file.replace(/\.md$/, "");

  const headingMatch = HEADING.exec(content);
  const title = headingMatch ? headingMatch[1] : slug;

  const frontmatter = FRONTMATTER.exec(content);
  const statusMatch = frontmatter
    ? FRONTMATTER_STATUS.exec(frontmatter[1])
    : INLINE_STATUS.exec(content);
  const status = statusMatch ? statusMatch[1] : null;

  const references = new Set<number>();
  for (const match of content.matchAll(ADR_REFERENCE)) {
    const referenced = Number.parseInt(match[1], 10);
    if (referenced !== number) references.add(referenced);
  }

  return {
    number,
    slug,
    file,
    title,
    status,
    references: [...references].toSorted((a, b) => a - b),
  };
};

const compareAdr = (a: AdrRecord, b: AdrRecord): number => {
  if (a.number !== null && b.number !== null) return a.number - b.number;
  if (a.number !== null) return -1;
  if (b.number !== null) return 1;
  return a.slug.localeCompare(b.slug);
};

/**
 * Reads the live ADRs under `docs/adr/`, ordered by number then slug. The
 * `archive/` subdirectory (compacted history) and any `README.md` mapping
 * manifest are skipped, leaving only the active minimal set.
 */
export const inventoryAdrs = (root: string): AdrRecord[] => {
  const adrDir = join(root, "docs/adr");
  if (!existsSync(adrDir)) return [];
  return readdirSync(adrDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => parseAdr(entry.name, readFileSync(join(adrDir, entry.name), "utf8")))
    .toSorted(compareAdr);
};

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const SWITCH_ENTRY = /^###\s+(Deviation|Scope change):\s+(.+?)\s*$/;
const LINKS_LINE = /^\*\*Links:\*\*\s+(.+?)\s*$/;

/**
 * Extracts every Deviation and Scope change entry from `JOURNAL.md`, tagged
 * with the date section it sits under. These are the switches the flow reads
 * to understand which decisions were reversed during the design process.
 */
export const journalSwitches = (root: string): JournalSwitch[] => {
  const path = join(root, "JOURNAL.md");
  if (!existsSync(path)) return [];
  const switches: JournalSwitch[] = [];
  let date = "";
  let current: JournalSwitch | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const dateMatch = DATE_HEADING.exec(line);
    if (dateMatch) {
      date = dateMatch[1];
      current = null;
      continue;
    }
    const entryMatch = SWITCH_ENTRY.exec(line);
    if (entryMatch) {
      current = {
        date,
        category: entryMatch[1] as JournalSwitch["category"],
        title: entryMatch[2],
        links: [],
      };
      switches.push(current);
      continue;
    }
    if (current) {
      const linksMatch = LINKS_LINE.exec(line);
      if (linksMatch) {
        current.links = linksMatch[1]
          .split(",")
          .map((link) => link.trim())
          .filter((link) => link !== "");
      } else if (line.startsWith("### ") || line.startsWith("## ")) {
        current = null;
      }
    }
  }
  return switches;
};

/**
 * Moves the live ADRs into `docs/adr/archive/` via `git mv`, returning the
 * archived mapping. Refuses to run unless the hub is a clean git work tree
 * (so the whole compaction stays one reviewable, revertible diff) and refuses
 * to overwrite an existing archived file from a prior compaction.
 */
export const archiveAdrs = (
  root: string,
): Effect.Effect<ArchivedAdr[], GitCommandError | CompactError> =>
  Effect.gen(function* () {
    if (!isGitRepo(root)) {
      return yield* new CompactError({ message: `${root} is not a git repository` });
    }
    if (yield* isDirty(root)) {
      return yield* new CompactError({
        message:
          "hub working tree is dirty; commit or stash first so the compaction is a single reviewable diff",
      });
    }
    if (!existsSync(join(root, "docs/adr"))) {
      return yield* new CompactError({ message: "docs/adr/ does not exist; nothing to compact" });
    }
    const records = inventoryAdrs(root);
    if (records.length === 0) {
      return yield* new CompactError({
        message: "no ADRs found under docs/adr/; nothing to archive",
      });
    }
    mkdirSync(join(root, "docs/adr/archive"), { recursive: true });
    const archived: ArchivedAdr[] = [];
    for (const record of records) {
      if (existsSync(join(root, "docs/adr/archive", record.file))) {
        return yield* new CompactError({
          message: `docs/adr/archive/${record.file} already exists from a prior compaction; resolve it by hand before re-running`,
        });
      }
      yield* runGit(root, ["mv", `docs/adr/${record.file}`, `docs/adr/archive/${record.file}`]);
      archived.push({ number: record.number, slug: record.slug, file: record.file });
    }
    return archived;
  });
