import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Effect, Option } from "effect";
import { readDocument, writeAtomic } from "./backlog-doc.ts";
import { backlogsDir } from "./backlog-store/paths.ts";
import type { Backlog } from "./backlog-store/schema.ts";
import { expandHome, type Config } from "./config.ts";
import { Refused } from "./fleet.ts";
import { parseRemote } from "./forge.ts";
import { changedFiles, git, gitOk, gitTry, inside, real, remoteUrl } from "./git.ts";

/**
 * The only domain whose coordinator writes the shared wiki.
 */
export const MANAGER_DOMAIN = "manager";

/**
 * The shared wiki's folder name. A domain name cannot start with `_`, so it never collides.
 */
export const SHARED_WIKI = "_shared";

/**
 * Where a wiki lives: `<state>/wiki/<domain>`, or `<state>/wiki/_shared`.
 * @param stateDir Coordinate state directory.
 * @param domain Domain, or `_shared`.
 * @returns The folder.
 */
export const wikiDir = (stateDir: string, domain: string): string => join(stateDir, "wiki", domain);

/**
 * Which wiki a command addresses, and whether the caller may write it.
 */
export type WikiTarget = { domain: string; shared: boolean; path: string; writer: boolean };

/**
 * The wiki a coordinator addresses: its domain's, or with `--shared` the shared one, which only
 * the manager coordinator writes.
 * @param config Config.
 * @param domain The caller's domain.
 * @param shared `--shared`.
 * @returns The target.
 */
export const wikiTarget = (config: Config, domain: string, shared: boolean): WikiTarget => ({
  domain,
  shared,
  path: wikiDir(config.stateDir, shared ? SHARED_WIKI : domain),
  writer: !shared || domain === MANAGER_DOMAIN,
});

/**
 * Git arguments that commit in a wiki whatever the user's git setup: no hooks, and a fallback
 * identity when none is configured. Repository-location variables are stripped by `git`.
 * @param dir Wiki folder.
 * @returns Leading `-c` arguments.
 */
const commitConfig = Effect.fn("commitConfig")(function* (dir: string) {
  const email = yield* gitTry(dir, ["config", "user.email"]);
  const name = yield* gitTry(dir, ["config", "user.name"]);
  return [
    "-c",
    "core.hooksPath=/dev/null",
    ...(email ? [] : ["-c", "user.email=coordinate@localhost"]),
    ...(name ? [] : ["-c", "user.name=coordinate"]),
  ];
});

/**
 * Create and git-initialize a wiki on first use: an `index.md`, a `.gitignore` for delegate
 * scratch folders, and a first commit. An existing git wiki is left as it is.
 * @param target The wiki.
 */
const ensureWiki = Effect.fn("ensureWiki")(function* (target: WikiTarget) {
  if (existsSync(join(target.path, ".git"))) return;
  const title = target.shared ? "shared" : target.domain;
  yield* Effect.promise(async () => {
    await mkdir(target.path, { recursive: true });
    if (!existsSync(join(target.path, "index.md")))
      await writeFile(join(target.path, "index.md"), `# ${title} wiki\n`);
    if (!existsSync(join(target.path, ".gitignore")))
      await writeFile(join(target.path, ".gitignore"), ".scratch/\n");
  });
  yield* gitOk(target.path, ["init", "-q", "-b", "main"]);
  yield* gitOk(target.path, ["add", "-A"]);
  const config = yield* commitConfig(target.path);
  yield* gitOk(target.path, [...config, "commit", "-q", "-m", `start the ${title} wiki`]);
});

/**
 * `coordinate wiki path`: the wiki's folder, created and git-initialized on first use. Only the
 * manager coordinator creates the shared wiki; any other coordinator gets its path for reading
 * once it exists.
 * @param config Config.
 * @param domain The caller's domain.
 * @param input `--shared` and `--json`.
 * @returns Lines to print.
 */
export const wikiPath = Effect.fn("wikiPath")(function* (
  config: Config,
  domain: string,
  input: { shared: boolean; json: boolean },
) {
  const target = wikiTarget(config, domain, input.shared);
  if (target.writer) yield* ensureWiki(target);
  else if (!existsSync(target.path))
    return yield* new Refused({
      message: `there is no shared wiki at ${target.path} yet; only the manager coordinator creates and writes it`,
    });
  return input.json
    ? [JSON.stringify({ domain, shared: input.shared, path: target.path }, null, 2)]
    : [target.path];
});

/**
 * Page types, which group the index.
 */
export const PAGE_TYPES = ["decision", "problem", "subsystem", "preference", "retro"] as const;

const PAGE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "type",
  "covers",
  "created",
  "updated",
  "sources",
  "supersedes",
]);

/**
 * How long a finding may stay open before lint flags it.
 */
export const STALE_FINDING_DAYS = 14;

/**
 * One place a page's claims apply: a repo by remote slug, or a root folder outside any repo.
 */
export type Cover = { repo: string; globs: string[] } | { root: string; globs: string[] };

/**
 * A wiki page's frontmatter, once valid.
 */
export type PageMeta = {
  name: string;
  description: string;
  type: (typeof PAGE_TYPES)[number];
  covers: Cover[];
  created: string;
  updated: string;
  sources: string[];
  supersedes: string[];
};

/**
 * One wiki page as read: its file, its frontmatter when valid, the reasons when not, and its body
 * lines numbered as in the file.
 */
export type Page = {
  file: string;
  name: string;
  meta: PageMeta | undefined;
  errors: string[];
  body: { line: number; text: string }[];
};

/**
 * One lint finding.
 */
export type Problem = {
  kind:
    | "invalid frontmatter"
    | "orphan"
    | "not in index"
    | "broken link"
    | "undated claim"
    | "covers"
    | "stale finding";
  message: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * Check one `covers` entry: exactly one of `repo` or `root`, and a non-empty glob list.
 * @param entry Parsed entry.
 * @param where Its position, such as `covers[0]`.
 * @returns The reasons it is invalid.
 */
const coverErrors = (entry: unknown, where: string): string[] => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return [`${where} must be a mapping with repo or root, and globs`];
  const record = entry as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !["repo", "root", "globs"].includes(key));
  const errors = unknown.map((key) => `${where} has unknown key ${key}`);
  if ("repo" in record === "root" in record)
    errors.push(`${where} needs exactly one of repo or root`);
  else if ("repo" in record && (typeof record.repo !== "string" || record.repo.trim() === ""))
    errors.push(`${where}.repo must be a remote slug, such as github.com/owner/name`);
  else if (
    "root" in record &&
    (typeof record.root !== "string" ||
      !(record.root === "~" || record.root.startsWith("~/") || isAbsolute(record.root)))
  )
    errors.push(`${where}.root must be an absolute or ~ path`);
  if (
    !isStrings(record.globs) ||
    record.globs.length === 0 ||
    record.globs.some((glob) => glob === "")
  )
    errors.push(`${where}.globs must be a non-empty list of globs`);
  return errors;
};

/**
 * Validate parsed frontmatter against the page schema.
 * @param data Parsed YAML.
 * @param stem The file name without `.md`, which `name` must equal.
 * @returns The reasons it is invalid, in schema order.
 */
const metaErrors = (data: unknown, stem: string): string[] => {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return ["the frontmatter is not a mapping"];
  const record = data as Record<string, unknown>;
  const errors = Object.keys(record)
    .filter((key) => !PAGE_KEYS.has(key))
    .map((key) => `unknown key ${key}`);
  if (record.name !== stem) errors.push(`name must be the file's name, ${stem}`);
  if (
    typeof record.description !== "string" ||
    record.description.trim() === "" ||
    /[\r\n]/.test(record.description.trim())
  )
    errors.push("description must be one non-empty line");
  if (!PAGE_TYPES.includes(record.type as PageMeta["type"]))
    errors.push(`type must be one of ${PAGE_TYPES.join(", ")}`);
  if (record.covers !== undefined) {
    if (!Array.isArray(record.covers)) errors.push("covers must be a list");
    else
      record.covers.forEach((entry: unknown, index) =>
        errors.push(...coverErrors(entry, `covers[${index}]`)),
      );
  }
  for (const key of ["created", "updated"])
    if (typeof record[key] !== "string" || !DATE.test(record[key]))
      errors.push(`${key} must be a YYYY-MM-DD date`);
  if (
    typeof record.created === "string" &&
    typeof record.updated === "string" &&
    DATE.test(record.created) &&
    DATE.test(record.updated) &&
    record.updated < record.created
  )
    errors.push("updated is before created");
  for (const key of ["sources", "supersedes"])
    if (!isStrings(record[key])) errors.push(`${key} must be a list of strings`);
  return errors;
};

/**
 * Read one page: split its frontmatter from its body, parse it with Bun's YAML parser, and
 * validate it.
 * @param file File name inside the wiki.
 * @param text Its contents.
 * @returns The page.
 */
export const parsePage = (file: string, text: string): Page => {
  const stem = file.replace(/\.md$/, "");
  const lines = text.split("\n");
  const numbered = (from: number) =>
    lines.slice(from).map((line, index) => ({ line: from + index + 1, text: line }));
  const invalid = (reason: string, from: number): Page => ({
    file,
    name: stem,
    meta: undefined,
    errors: [reason],
    body: numbered(from),
  });
  if (lines[0] !== "---") return invalid("the page does not start with a --- frontmatter block", 0);
  const end = lines.indexOf("---", 1);
  if (end === -1) return invalid("the frontmatter block has no closing ---", 0);
  let data: unknown;
  try {
    data = Bun.YAML.parse(lines.slice(1, end).join("\n"));
  } catch (cause) {
    return invalid(`the frontmatter is not YAML: ${String(cause)}`, end + 1);
  }
  const errors = metaErrors(data, stem);
  const meta = data as PageMeta;
  return {
    file,
    name: stem,
    meta: errors.length === 0 ? { ...meta, covers: meta.covers ?? [] } : undefined,
    errors,
    body: numbered(end + 1),
  };
};

/**
 * Body lines outside fenced code blocks.
 * @param body Numbered lines.
 * @returns The prose lines.
 */
const prose = (body: Page["body"]): Page["body"] => {
  let fenced = false;
  return body.filter((entry) => {
    if (/^\s*(```|~~~)/.test(entry.text)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
};

const LINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/**
 * The page names a text links to with `[[name]]`, `[[name|label]]` or `[[name#part]]`.
 * @param lines Prose lines.
 * @returns Names in order of first appearance.
 */
const linksIn = (lines: readonly { text: string }[]): string[] => [
  ...new Set(
    lines.flatMap((entry) =>
      [...entry.text.matchAll(LINK)].map((match) => (match[1] ?? "").trim()),
    ),
  ),
];

const CODE_REFERENCE =
  /`[^`]+`|[\w.-]+\/[\w./*-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|nix|toml|ya?ml|rs|go|py|swift|sh)\b/;
const PRESENT_TENSE =
  /\b(?:is|are|does|do|has|have|uses|calls|returns|runs|reads|writes|lives|holds|stores|keeps|sends|takes|accepts|refuses|prints|handles|exports|imports|owns|depends|lacks|needs|contains|polls|starts|stops|checks|creates)\b/i;
const DATED = /\b\d{4}-\d{2}-\d{2}\b|\b[0-9a-f]{7,40}\b/;

/**
 * Whether a prose line is a present-tense claim about code with no date or commit: it names code
 * (an inline code span, a path, or a source file name), uses a present-tense verb outside code
 * spans, and carries neither a YYYY-MM-DD date nor a commit hash. Headings are exempt.
 * @param text The line.
 * @returns True when lint flags it.
 */
export const undatedClaim = (text: string): boolean =>
  !/^\s*#/.test(text) &&
  CODE_REFERENCE.test(text) &&
  PRESENT_TENSE.test(text.replace(/`[^`]*`/g, " ")) &&
  !DATED.test(text);

/**
 * A repo slug in the form `host/owner/name`, lowercased, from a slug or a remote URL.
 * @param value Slug or URL.
 * @returns The normalized slug.
 */
export const normalizeSlug = (value: string): string => {
  const trimmed = value.trim();
  const remote =
    trimmed.includes("://") || /^[^/]*@|^[^/]+:/.test(trimmed) ? parseRemote(trimmed) : undefined;
  const slug = remote ? `${remote.host}/${remote.slug}` : trimmed;
  return slug
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
};

/**
 * The normalized slug (`github.com/owner/name`) of a checkout's origin remote, else of its first
 * remote.
 * @param path Checkout.
 * @returns The slug, or undefined when it has no remote.
 */
const checkoutSlug = Effect.fn("checkoutSlug")(function* (path: string) {
  const url = yield* remoteUrl(path);
  const remote = url === undefined ? undefined : parseRemote(url);
  return remote ? normalizeSlug(`${remote.host}/${remote.slug}`) : undefined;
});

/**
 * The local checkout of each repo the Boundary names, keyed by its origin remote's normalized
 * slug (`github.com/owner/name`); a checkout with no remote is keyed by its real path.
 * @param boundaries Boundary paths, owned and adjacent.
 * @returns Slug or path to checkout.
 */
export const boundaryCheckouts = Effect.fn("boundaryCheckouts")(function* (
  boundaries: readonly string[],
) {
  const checkouts = new Map<string, string>();
  for (const path of boundaries) {
    if (!existsSync(path)) continue;
    const key = (yield* checkoutSlug(path)) ?? real(path);
    if (!checkouts.has(key)) checkouts.set(key, path);
  }
  return checkouts;
});

/**
 * Where a cover's globs are matched: the repo's checkout, or the expanded, real `root`.
 * @param cover The cover.
 * @param checkouts Boundary checkouts by slug or path.
 * @returns Its label and folder, the folder undefined when no checkout matches.
 */
export const coverFolder = (
  cover: Cover,
  checkouts: ReadonlyMap<string, string>,
): { label: string; folder: string | undefined } => {
  if ("root" in cover) return { label: cover.root, folder: real(expandHome(cover.root)) };
  const key =
    cover.repo.startsWith("/") || cover.repo.startsWith("~")
      ? real(expandHome(cover.repo))
      : normalizeSlug(cover.repo);
  return { label: cover.repo, folder: checkouts.get(key) };
};

/**
 * Whether a glob matches at least one file under a folder, with Bun's glob.
 * @param folder Folder.
 * @param glob Glob relative to it.
 * @returns True on the first match.
 */
const globMatches = async (folder: string, glob: string): Promise<boolean> => {
  if (!existsSync(folder)) return false;
  for await (const _ of new Bun.Glob(glob).scan({ cwd: folder, onlyFiles: true, dot: true }))
    return true;
  return false;
};

/**
 * Read a wiki's pages: every top-level `*.md` file except `index.md`, sorted by name.
 * @param path Wiki folder.
 * @returns The pages and the index text.
 */
export const readWiki = (path: string) =>
  Effect.promise(async () => {
    const files = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
      .map((entry) => entry.name)
      .toSorted();
    const pages = await Promise.all(
      files.map(async (name) => parsePage(name, await readFile(join(path, name), "utf8"))),
    );
    const index = await readFile(join(path, "index.md"), "utf8").catch(() => "");
    return { pages, index };
  });

/**
 * Check that a policy's `--wiki` citation names a page in the domain's wiki or the shared wiki,
 * matching page names as `readWiki` lists them (so `index` and paths never match). A missing
 * wiki has no pages; neither wiki is created.
 * @param config Config.
 * @param domain The policy's domain.
 * @param page The cited page name.
 * @returns The page name, or a refusal naming both wikis.
 */
export const citedPage = Effect.fn("citedPage")(function* (
  config: Config,
  domain: string,
  page: string,
) {
  const folders = [wikiDir(config.stateDir, domain), wikiDir(config.stateDir, SHARED_WIKI)];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    const { pages } = yield* readWiki(folder);
    if (pages.some((entry) => entry.name === page)) return page;
  }
  return yield* new Refused({
    message: `no page [[${page}]] in the ${domain} wiki (${folders[0]}) or the shared wiki (${folders[1]})`,
  });
});

/**
 * The Boundary paths covers are resolved against: the domain's owned and adjacent paths, or for
 * the shared wiki every domain's.
 * @param config Config.
 * @param target The wiki.
 * @param backlog The caller's backlog.
 * @returns Paths.
 */
const coverBoundaries = Effect.fn("coverBoundaries")(function* (
  config: Config,
  target: WikiTarget,
  backlog: Backlog,
) {
  const own = [...backlog.boundary.owned, ...backlog.boundary.adjacent];
  if (!target.shared) return own;
  const dir = backlogsDir(config.stateDir);
  const domains = yield* Effect.promise(async () =>
    (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .toSorted(),
  );
  const others: string[] = [];
  for (const domain of domains) {
    const read = yield* readDocument(config, domain).pipe(Effect.option);
    if (Option.isSome(read))
      others.push(...read.value.backlog.boundary.owned, ...read.value.backlog.boundary.adjacent);
  }
  return [...own, ...others];
});

/**
 * Lint one wiki mechanically: invalid frontmatter, orphan pages, pages missing from index.md,
 * broken `[[links]]`, undated present-tense claims about code, covers globs matching no files
 * (a `repo` cover naming no Boundary checkout is skipped), and, for a domain wiki, findings open longer than 14 days. Contradictions stay a coordinator
 * judgment.
 * @param config Config.
 * @param domain The caller's domain.
 * @param input `--shared`, and the time.
 * @returns The wiki's path, its page count and every problem, in report order.
 */
export const lintWiki = Effect.fn("lintWiki")(function* (
  config: Config,
  domain: string,
  input: { shared: boolean; now: Date },
) {
  const target = wikiTarget(config, domain, input.shared);
  if (!existsSync(target.path))
    return yield* new Refused({
      message: `there is no wiki at ${target.path}; run coordinate wiki path${input.shared ? " --shared" : ""}`,
    });
  const { backlog } = yield* readDocument(config, domain);
  const { pages, index } = yield* readWiki(target.path);
  const names = new Set(pages.map((page) => page.name));
  const indexLines = prose(index.split("\n").map((text, at) => ({ line: at + 1, text })));
  const indexLinks = new Set(linksIn(indexLines));
  const outbound = new Map(pages.map((page) => [page.name, linksIn(prose(page.body))]));
  const problems: Problem[] = [];
  const add = (kind: Problem["kind"], message: string) => problems.push({ kind, message });

  for (const page of pages)
    for (const error of page.errors) add("invalid frontmatter", `${page.file}: ${error}`);
  const unindexed = pages.filter((page) => !indexLinks.has(page.name));
  const linkedFromPages = (name: string) =>
    pages.some((page) => page.name !== name && (outbound.get(page.name) ?? []).includes(name));
  for (const page of unindexed)
    if (!linkedFromPages(page.name))
      add("orphan", `${page.file}: no page and no index.md entry links to [[${page.name}]]`);
  for (const page of unindexed)
    if (linkedFromPages(page.name))
      add("not in index", `${page.file}: index.md does not link to [[${page.name}]]`);
  const sources = [
    ...pages.map((page) => ({ file: page.file, links: outbound.get(page.name) ?? [] })),
    { file: "index.md", links: [...indexLinks] },
  ].toSorted((a, b) => a.file.localeCompare(b.file));
  for (const source of sources)
    for (const link of source.links)
      if (!names.has(link)) add("broken link", `${source.file}: [[${link}]] names no page`);
  for (const page of pages)
    for (const entry of prose(page.body))
      if (undatedClaim(entry.text))
        add(
          "undated claim",
          `${page.file}:${entry.line}: date it or cite a commit: ${entry.text.trim()}`,
        );
  const checkouts = yield* boundaryCheckouts(yield* coverBoundaries(config, target, backlog));
  for (const page of pages)
    for (const cover of page.meta?.covers ?? []) {
      const { label, folder } = coverFolder(cover, checkouts);
      // A repo outside every Boundary (a shared page covering another domain's repo) has no
      // checkout here to check its globs against, so it is skipped rather than flagged.
      if (folder === undefined) continue;
      for (const glob of cover.globs)
        if (!(yield* Effect.promise(() => globMatches(folder, glob))))
          add("covers", `${page.file}: ${label} ${glob} matches no files`);
    }
  if (!target.shared) {
    const cutoff = input.now.getTime() - STALE_FINDING_DAYS * 86_400_000;
    for (const finding of backlog.findings)
      if (
        finding.status === "open" &&
        finding.createdAt !== undefined &&
        Date.parse(finding.createdAt) < cutoff
      )
        add(
          "stale finding",
          `${finding.id} has been open since ${finding.createdAt.slice(0, 10)}, over ${STALE_FINDING_DAYS} days: close or promote it`,
        );
  }
  return { path: target.path, pages: pages.length, problems };
});

/**
 * The wiki pages a settled delegate's changes may have made stale: every valid page in the domain
 * wiki, then the shared wiki, with a `covers` entry whose globs match a file the delegate changed
 * since its base commit or left uncommitted. A `repo` entry matches the delegate's checkout by
 * origin remote slug (or by path), and a `root` entry matches changed files inside it.
 * @param config Config.
 * @param domain The delegate's domain.
 * @param cwd The delegate's working folder.
 * @param base Its base commit, from its terminal labels, when it has one.
 * @returns The matching pages' file paths, domain pages first, each wiki sorted by name.
 */
export const settledWikiPages = Effect.fn("settledWikiPages")(function* (
  config: Config,
  domain: string,
  cwd: string,
  base: string | undefined,
) {
  const changed = yield* changedFiles(cwd, base);
  if (changed === undefined || changed.files.length === 0) return [];
  const slug = yield* checkoutSlug(changed.top);
  const checkouts = new Map([[changed.top, changed.top]]);
  if (slug !== undefined) checkouts.set(slug, changed.top);
  const absolute = changed.files.map((file) => join(changed.top, file));
  const matches = (cover: Cover): boolean => {
    const { folder } = coverFolder(cover, checkouts);
    if (folder === undefined) return false;
    const globs = cover.globs.map((glob) => new Bun.Glob(glob));
    return absolute.some(
      (path) => inside(path, folder) && globs.some((glob) => glob.match(relative(folder, path))),
    );
  };
  const found: string[] = [];
  for (const wiki of [domain, SHARED_WIKI]) {
    const path = wikiDir(config.stateDir, wiki);
    if (!existsSync(path)) continue;
    const { pages } = yield* readWiki(path);
    for (const page of pages)
      if ((page.meta?.covers ?? []).some(matches)) found.push(join(path, page.file));
  }
  return found;
});

/**
 * A lint result as printed: one `<kind>: <message>` line per problem and a summary line.
 * @param result The lint result.
 * @returns Lines to print.
 */
export const lintLines = (result: { path: string; pages: number; problems: Problem[] }): string[] =>
  result.problems.length === 0
    ? [`wiki lint: ${result.path} is clean (${result.pages} pages)`]
    : [
        ...result.problems.map((problem) => `${problem.kind}: ${problem.message}`),
        `wiki lint: ${result.problems.length} problems in ${result.path}`,
      ];

/**
 * `coordinate wiki commit`: lint the wiki, then commit every change in it. Lint problems refuse
 * the commit and are returned, so each commit leaves the wiki lint-clean. Only the manager
 * coordinator commits the shared wiki. Nothing is pushed: the wiki has no remote.
 * @param config Config.
 * @param domain The caller's domain.
 * @param input `--shared`, the commit message, and the time.
 * @returns The wiki's path, the new commit's short hash (null when nothing changed or lint
 * refused), and the lint problems.
 */
export const commitWiki = Effect.fn("commitWiki")(function* (
  config: Config,
  domain: string,
  input: { shared: boolean; message: string; now: Date },
) {
  const target = wikiTarget(config, domain, input.shared);
  if (!target.writer)
    return yield* new Refused({
      message: `only the manager coordinator writes the shared wiki; request the change as an item in the manager domain: coordinate item add "<change> (from ${domain})" --domain ${MANAGER_DOMAIN}`,
    });
  const message = input.message.trim();
  if (message === "" || /[\r\n]/.test(message))
    return yield* new Refused({ message: "-m needs a one-line commit message" });
  if (!existsSync(join(target.path, ".git")))
    return yield* new Refused({
      message: `there is no wiki at ${target.path}; run coordinate wiki path${input.shared ? " --shared" : ""}`,
    });
  const lint = yield* lintWiki(config, domain, { shared: input.shared, now: input.now });
  if (lint.problems.length > 0)
    return { path: target.path, committed: null, problems: lint.problems };
  yield* gitOk(target.path, ["add", "-A"]);
  const staged = yield* git(target.path, ["diff", "--cached", "--quiet"]);
  if (staged.exitCode === 0) return { path: target.path, committed: null, problems: [] };
  const commitArgs = yield* commitConfig(target.path);
  yield* gitOk(target.path, [...commitArgs, "commit", "-q", "-m", message]);
  const committed = yield* gitOk(target.path, ["rev-parse", "--short", "HEAD"]);
  return { path: target.path, committed, problems: [] as Problem[] };
});

/**
 * Where a delegate works, for matching covers: a repo (its main checkout) or a folder outside one.
 */
export type DelegatePlace = { repo: string } | { cwd: string };

/**
 * The page a delegate's WIKI.md lists: its file, description, and the globs of the covers that
 * name the delegate's repo or a root containing its folder.
 */
type CoveringPage = { file: string; description: string; globs: string[] };

/**
 * The globs of a page's covers that apply to a delegate: for a repo, covers naming its origin slug
 * or its path; for a folder, `root` covers containing it. Undefined when none apply.
 * @param meta The page's frontmatter.
 * @param checkouts The repo's checkout keyed by its slug and real path, or undefined for a folder.
 * @param cwd The folder's real path, for a `--cwd` delegate.
 * @returns The globs, in covers order.
 */
const coveringGlobs = (
  meta: PageMeta,
  checkouts: ReadonlyMap<string, string> | undefined,
  cwd: string | undefined,
): string[] | undefined => {
  const globs = meta.covers.flatMap((cover) => {
    if ("root" in cover) {
      const { folder } = coverFolder(cover, new Map());
      return cwd !== undefined && folder !== undefined && inside(cwd, folder) ? cover.globs : [];
    }
    if (checkouts === undefined) return [];
    return coverFolder(cover, checkouts).folder !== undefined ? cover.globs : [];
  });
  return globs.length === 0 ? undefined : [...new Set(globs)];
};

/**
 * Write WIKI.md into a new delegate's scratch folder: the pages of the domain wiki and the shared
 * wiki whose covers name the delegate's repo (by origin slug, or path when it has no remote) or,
 * for a `--cwd` delegate, a root containing its folder. Pages without covers stay out. Nothing is
 * written when no page matches, and neither wiki is created.
 * @param config Config.
 * @param domain The delegate's domain.
 * @param input The delegate's name, scratch folder, and where it works.
 * @returns The WIKI.md path, or undefined when no page covers the delegate.
 */
export const writeDelegateWiki = Effect.fn("writeDelegateWiki")(function* (
  config: Config,
  domain: string,
  input: { name: string; scratch: string; place: DelegatePlace },
) {
  let label: string;
  let checkouts: Map<string, string> | undefined;
  let cwd: string | undefined;
  if ("repo" in input.place) {
    const path = real(input.place.repo);
    label = (yield* checkoutSlug(path)) ?? path;
    checkouts = new Map([
      [label, path],
      [path, path],
    ]);
  } else {
    cwd = real(input.place.cwd);
    label = cwd;
  }
  const wikis = [
    { title: `${domain} wiki`, path: wikiDir(config.stateDir, domain) },
    { title: "shared wiki", path: wikiDir(config.stateDir, SHARED_WIKI) },
  ];
  const sections: { title: string; pages: CoveringPage[] }[] = [];
  for (const wiki of wikis) {
    if (!existsSync(wiki.path)) continue;
    const { pages } = yield* readWiki(wiki.path);
    const covering = pages.flatMap((page): CoveringPage[] => {
      if (page.meta === undefined) return [];
      const globs = coveringGlobs(page.meta, checkouts, cwd);
      return globs === undefined
        ? []
        : [{ file: join(wiki.path, page.file), description: page.meta.description, globs }];
    });
    if (covering.length > 0) sections.push({ title: wiki.title, pages: covering });
  }
  if (sections.length === 0) return undefined;
  const text = [
    `# Wiki pages for ${input.name}`,
    "",
    `Pages from the ${domain} and shared wikis whose covers name ${label}. Open a page before you change the files its globs match. If a claim looks stale, say so in your report: only the coordinator edits the wiki.`,
    ...sections.flatMap((section) => [
      "",
      `## ${section.title}`,
      "",
      ...section.pages.flatMap((page) => [
        `- ${page.file}: ${page.description}`,
        `  - globs: ${page.globs.join(", ")}`,
      ]),
    ]),
    "",
  ].join("\n");
  const destination = join(input.scratch, "WIKI.md");
  yield* Effect.promise(async () => {
    await mkdir(input.scratch, { recursive: true });
    await writeFile(destination, text);
  });
  return destination;
});

/**
 * How many days after the last lint (or the wiki's creation) the watcher fires `lint-due`.
 */
export const LINT_INTERVAL_DAYS = 7;

/**
 * Where `wiki lint --mark` records a domain's last passing lint: its own folder, apart from the
 * watcher's snapshot, which the running watcher rewrites every tick. The CLI is this file's only
 * writer, and the watcher reads it each tick.
 * @param stateDir Coordinate state directory.
 * @param domain Domain.
 * @returns The file.
 */
export const lintClockPath = (stateDir: string, domain: string): string =>
  join(stateDir, "wiki-lint", `${domain}.json`);

/**
 * The domain's last recorded passing lint, as `YYYY-MM-DD`; undefined when none is recorded or
 * the file cannot be read.
 * @param config Config.
 * @param domain Domain.
 * @returns The date.
 */
export const lastLint = (config: Config, domain: string) =>
  Effect.promise(async (): Promise<string | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(lintClockPath(config.stateDir, domain), "utf8")) as {
        lastLint?: unknown;
      };
      return typeof parsed.lastLint === "string" && DATE.test(parsed.lastLint)
        ? parsed.lastLint
        : undefined;
    } catch {
      return undefined;
    }
  });

/**
 * Record a passing lint of the domain wiki, which restarts the watcher's `lint-due` clock.
 * @param config Config.
 * @param domain Domain.
 * @param today The date to record, `YYYY-MM-DD` (UTC, like the watcher's).
 */
export const markLint = Effect.fn("markLint")(function* (
  config: Config,
  domain: string,
  today: string,
) {
  const path = lintClockPath(config.stateDir, domain);
  yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
  yield* writeAtomic(path, `${JSON.stringify({ lastLint: today })}\n`);
});

/**
 * The UTC date of the domain wiki's first commit, the `lint-due` clock's start before any lint is
 * recorded; undefined when the wiki does not exist yet.
 * @param config Config.
 * @param domain Domain.
 * @returns `YYYY-MM-DD`, or undefined.
 */
export const wikiCreated = Effect.fn("wikiCreated")(function* (config: Config, domain: string) {
  const path = wikiDir(config.stateDir, domain);
  if (!existsSync(join(path, ".git"))) return undefined;
  const out = yield* gitTry(path, ["log", "--max-parents=0", "--format=%ct", "-1"]);
  const seconds = Number(out);
  if (out === undefined || out === "" || !Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
});
