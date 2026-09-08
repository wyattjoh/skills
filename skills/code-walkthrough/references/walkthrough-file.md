# The walkthrough definition file

## Contents

- Top level fields
- `files[]` and scope
- `beats[]`
- `intro[]` / `outro[]` bands
- Build flags and what the self-checks catch
- Worked example

## Top level

| Field         | Type               | Required | Notes                                                                 |
| ------------- | ------------------ | -------- | --------------------------------------------------------------------- |
| `title`       | string             | yes      | The `<h1>`. Escaped, so write it as plain text.                       |
| `titleAccent` | string             | no       | A substring of `title` rendered italic in the accent colour.          |
| `pageTitle`   | string             | no       | `<title>` tag. Defaults to `title`.                                   |
| `eyebrow`     | HTML               | no       | Small caps line above the title. `<span>` renders as a dim separator. |
| `lede`        | HTML               | no       | Opening paragraph.                                                    |
| `facts`       | `{label, value}[]` | no       | The metadata grid under the lede. `value` is HTML.                    |
| `intro`       | `Band[]`           | no       | Full-width sections between the masthead and the walkthrough.         |
| `outro`       | `Band[]`           | no       | Full-width sections after the walkthrough.                            |
| `footer`      | HTML               | no       | Closing note. Say where the annotations came from.                    |
| `files`       | `FileSpec[]`       | **yes**  | Sources, in pane order.                                               |
| `beats`       | `Beat[]`           | **yes**  | Annotations, in file order.                                           |

## `files[]`

| Field              | Type      | Notes                                                                              |
| ------------------ | --------- | ---------------------------------------------------------------------------------- |
| `path`             | string    | **Required.** Resolved relative to the definition file.                            |
| `label`            | string    | Pane heading. Defaults to the basename.                                            |
| `sub`              | HTML      | Small line under the label, e.g. `187 lines &middot; 4 tables`.                    |
| `lang`             | string    | Highlighting. Inferred from the extension when omitted.                            |
| `scope`            | see below | What owes an explanation. Whole file when omitted.                                 |
| `foldContextAfter` | number    | Collapse unexplained out-of-scope runs longer than this. Default 12, `0` disables. |

Languages: `sql` `go` `ts` (also js/tsx/jsx) `python` `rust` `json` `yaml` `sh`
`css` `html` `plain`. An unknown language falls back to `plain`, which renders
correctly but uncoloured — never a build failure.

### Scope

Scope answers _which lines does this walkthrough owe an explanation for_. It does
not change what is rendered: the whole file is always in the pane, so the reader
keeps the surrounding context.

```jsonc
// whole file — the default
{ "path": "new_table.sql" }

// only what changed against a revision range
{ "path": "handler.go", "scope": { "diff": "main...HEAD" } }
{ "path": "handler.go", "scope": { "diff": "HEAD~1" } }

// a known region
{ "path": "engine.ts", "scope": { "ranges": [[40, 96], [210, 215]] } }
```

`diff` shells out to `git diff --unified=0 <rev> -- <path>` and takes the added
line ranges. If the diff is empty the build warns and falls back to whole-file
scope rather than producing a page with nothing in scope.

Unexplained out-of-scope runs collapse into a clickable `… N unchanged lines`
marker. A line any beat explains is never folded, even out of scope — so a beat
may deliberately reach into context to show what a change sits next to. A beat
inside a collapsed run forces that run open when it activates.

## `beats[]`

| Field        | Type               | Notes                                                                |
| ------------ | ------------------ | -------------------------------------------------------------------- |
| `id`         | string             | **Required**, unique, kebab-case. Becomes `#b-<id>`.                 |
| `from`, `to` | number             | **Required.** 1-indexed, inclusive. `from === to` for a single line. |
| `file`       | number             | Index into `files[]`. Defaults to `0`.                               |
| `title`      | string             | **Required.** The beat heading. HTML allowed.                        |
| `body`       | HTML               | **Required.** The prose.                                             |
| `section`    | string             | Starts a chapter: heading above this beat, entry in the hover rail.  |
| `sectionSub` | HTML               | Subtitle under the section heading.                                  |
| `tags`       | `[class, label][]` | Badges above the title.                                              |

Beats are rendered in array order and should run in file order — the reader is
scrolling down the file. Ranges may overlap (the build warns; the first beat wins
for click-through) but usually shouldn't.

## Bands

`intro` and `outro` entries are full-width sections outside the two-column
walkthrough:

```json
{
  "heading": "Six ideas that explain the rest",
  "sub": "Read these once and the odd-looking lines stop being odd.",
  "html": "<div class=\"ideas\">…</div>"
}
```

`html` is raw and unescaped — use the classes in [theme.md](theme.md)
(`.ideas`/`.idea`, `.tblwrap` + `<table>`, `.pair`) so bands match the page.

## Build

```bash
bun ${CLAUDE_SKILL_DIR}/scripts/build.ts <definition.json> [flags]
```

| Flag                      | Effect                                                                          |
| ------------------------- | ------------------------------------------------------------------------------- |
| `--out <path>`            | Output file, relative to the definition. Default: definition path with `.html`. |
| `--open`                  | Open in the browser on success.                                                 |
| `--require-full-coverage` | Uncovered in-scope lines become a build failure.                                |

### What the self-checks catch

Hard failures — nothing is written:

- a rendered row that does not match its source line
- a row count that disagrees with the sources
- a beat range outside its file, or a `file` index that does not exist
- a missing source file, a missing template, unreplaced placeholders
- malformed JSON, no `files`, no `beats`
- uncovered in-scope lines, _only_ under `--require-full-coverage`

Warnings — the page is still written:

- in-scope non-blank lines with no beat (listed by file and line)
- lines claimed by more than one beat
- an unknown `lang`, or a `diff` that matched nothing

## Worked example

```json
{
  "title": "The retry loop, and why it backs off the way it does.",
  "titleAccent": "why",
  "eyebrow": "worker <span>&middot;</span> PR 412",
  "lede": "Three lines changed. Here is what they cost and what they bought.",
  "facts": [
    { "label": "Changed", "value": "3 lines" },
    { "label": "Source", "value": "PR 412 review thread" }
  ],
  "files": [
    {
      "path": "../src/worker/retry.ts",
      "sub": "412 lines &middot; only the backoff changed",
      "scope": { "diff": "main...HEAD" },
      "foldContextAfter": 10
    }
  ],
  "beats": [
    {
      "id": "jitter",
      "from": 88,
      "to": 90,
      "section": "The backoff change",
      "sectionSub": "Everything else in this file is context.",
      "tags": [
        ["info", "PR 412"],
        ["good", "measured"]
      ],
      "title": "Full jitter, not exponential-plus-noise",
      "body": "<p>The delay is now <code>random(0, base * 2 ** attempt)</code> rather than <code>base * 2 ** attempt + random(0, 100)</code>.</p><div class=\"note good\"><b>Measured:</b> at 200 concurrent workers the retry thundering herd went from a 3.1s p99 spike to 0.4s.</div><div class=\"note trap\"><b>Trap:</b> the lower bound is 0, so a retry can fire immediately. Anything downstream that assumed a minimum delay must say so itself.</div>"
    }
  ],
  "footer": "Annotations from the PR 412 review thread and the load test in <code>bench/retry.ts</code>."
}
```
