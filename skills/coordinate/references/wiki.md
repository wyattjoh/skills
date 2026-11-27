# Wiki

Read this before writing a page, on a `lint-due` event, or when `wiki lint` or `wiki commit` fails. The rules every session follows (single writer, history not present, query, ingest) are in [SKILL.md](../SKILL.md#wiki).

## Pages

One flat folder: `index.md` links every page as `[[name]]`, and each other `*.md` file is a page you write with your ordinary file tools. Each page starts with YAML frontmatter:

```yaml
name: watcher-poll-interval # the file's name without .md
description: one line, used in index.md and WIKI.md
type: decision # decision | problem | subsystem | preference | retro
covers: # optional; omitted = index only
  - repo: github.com/wyattjoh/skills # origin remote slug of a Boundary checkout
    globs: ["skills/coordinate/scripts/lib/watch*.ts"]
  - root: ~/infra # absolute or ~ path outside any repo
    globs: ["herdr/*.toml"]
created: 2026-11-23
updated: 2026-11-23
sources: [item:i4, delegate:fix-watch, commit:wyattjoh/skills@abc1234]
supersedes: []
```

`covers` names the code the page makes claims about. A `repo` slug resolves through the origin remote of each Boundary path (a checkout with no remote is named by its absolute path). A `settled` event carries one `<wiki>` child per page, domain pages first, then shared, holding the page's file path, whose `covers` match a file the delegate changed (committed since its base commit, or left uncommitted, untracked included); with no match it has none.

Keep `sources` naming where each claim came from (`item:`, `delegate:`, `commit:`, `session:`), never an ignored `.scratch/` report path.

## At launch

`coordinate delegate` writes `WIKI.md` beside the delegate's brief, listing each page of your domain wiki and the shared wiki whose `covers` name the delegate's repo (by origin slug, or path when it has no remote) or, for `--cwd`, a `root` containing its folder, with the page's description and those globs. Its first message gains a sentence pointing at `WIKI.md`. Pages without `covers` stay out, and with no matching page neither the file nor the sentence appears.

## Lint and commit

`coordinate wiki lint` exits 1 and names each problem: invalid frontmatter, orphan pages (nothing links to them), pages missing from `index.md`, broken `[[links]]`, undated present-tense claims about code (a line naming code with a present-tense verb and no date or commit hash), `covers` globs matching no files (a `repo` naming no Boundary checkout, such as a shared page covering another domain's repo, is skipped, not flagged), and, for a domain wiki, open findings older than 14 days. `coordinate wiki commit -m "<one line>"` runs lint first and refuses (exit 1, nothing committed) until lint is clean, so fix the pages or close the findings and commit again. Lint is mechanical; contradictions between pages stay your judgment.

## Lint-due

The watcher fires `lint-due` (`due`, and `last`: the last marked lint or `never`) 7 days after the last passing `wiki lint --mark` (or after the wiki was created, before any), once per lapsed week; weeks missed while it was down yield one event. Then run `wiki lint`, fix what it names, close or promote stale findings, read the pages for contradictions and supersede the wrong claim, `wiki commit`, and finish with `wiki lint --mark`, which records today only when lint passes and restarts the clock. `--mark` covers the domain wiki only; `--shared` is refused.

## Reading

`coordinate wiki list` prints the domain wiki's pages in index order with type and description (`--json`: their frontmatter, invalid pages and the last lint), and `wiki show <name>` prints one page's frontmatter and body. Both are read-only and never create the wiki; the Backlog panel shows them under Lists as Wiki.
