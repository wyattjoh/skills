---
paths:
  - "plugins/**"
---

# Optional plugins under `plugins/`

Each `plugins/<name>/` is its own marketplace entry (`.claude-plugin/marketplace.json`,
`source: "./plugins/<name>"`), so installing the root `wyattjoh` plugin never loads it.
A plugin may ship as a Claude Code function-hooks mod and a pi extension from one folder.
Load the `plugin-authoring` skill before changing a mod: it lays the API types for the
running build.

## Exception: `plugins/coordinate`

`plugins/coordinate/herdr/` builds `coordinate-panel`, a Herdr mod for the coordinate skill's
backlog. The backlog is read-only except for answering an ask, dismissing an item, changing an item's status, starting an item, triaging a finding, and editing or deleting record text; the separate delegate-harness
policy editor delegates all policy writes to the Coordinate CLI. The panel follows the focused
terminal. It is not a Claude Code plugin: no `.claude-plugin/`, no marketplace entry, no mod or pi
extension. It is its own project with its own `package.json`, `bunfig.toml` and `justfile`. Root
`bun test` and `knip` skip it, and root `bun run check` skips its `src/` (its
tests need the renderer preload and its mod sources need Herdr's host `.d.ts` files); root
`check` still type-checks its Bun `scripts/`, and root lint and format cover all of it. It depends on
`@wyattjoh/herdr-ui`, which the root install does not provide. CI runs `bun install --frozen-lockfile`
in that folder after the root install; run `bun install` there in every fresh worktree too before
`just check`. Run `just check` there: tests, a typecheck against the installed declarations copied
into `node_modules/.cache/`, and a build that stages each mod under `.scratch/` and runs
`herdr-app check` with that stage as `HERDR_APP_HOME`. `just check` never writes the live Herdr
home. Only `just install [--replace]`, run after the user approves, does: it builds and checks a
stage, copies every mod into `$HERDR_APP_HOME/mods`, and merges `keys.json`'s bindings into the
person's `keys.json` when the plugin defines any, refusing a key they already bind elsewhere.
Point `HERDR_APP_HOME` at a scratch folder to exercise it.

The mods never write the backlog document or message a terminal: the coordinate CLI is the
document's only writer. The panel's backlog writes are answers, Dismiss, Change status, and Start (`coordinate item start --domain <d> -- <id>`, shown unless the item is done, dismissed or delegated; the watcher turns the recorded request into a `start` event for the coordinator; while a request is pending, the item's row carries a Starting chip and its detail status reads Starting, in the building tone, derived from `startRequested` with no stored status). The Answer button on an item's detail
screen runs `coordinate item answer --domain <d> -- <id> <answer>` at once; in the answer flow, Answer only queues (per domain, kept while the panel lives) and "Send all and back" runs that command once per queued answer in order, stopping at the first failure with the rest still queued. Dismiss runs `coordinate item close --domain <d> --dismissed --outcome ...`. Change status, at the bottom of an item's detail screen (not on a done or dismissed item), opens a menu drawn in the flow below it (plain state, not a Popover) of open, building, in-review and parked minus the item's own (`OUTSIDE_TERMINAL_STATUSES`); a choice runs `coordinate item update --domain <d> --status <s> -- <id>`, shows "Moving to ..." while it runs, shows the CLI's message on failure and reloads after exit 0. Edit and Delete (`FieldEditModel` in view.ts, `EditTarget`, `editCommand` and `deleteCommand` in model.ts) cover an item's title and a closed item's outcome, each coordinator decision (not answer or discussion records, nor the open ask, answers and notes), a finding's title, detail and closed outcome, each policy, the focus and each Boundary path: hovering the row shows Edit (a text button: Herdr ships no pencil icon) and, on a list entry (a decision, a policy, a Boundary path), Delete (the x icon), at the row's end or beside a title's status. Edit opens the answer field's textarea in place with the field's current Markdown or text, then Save and Cancel; Save runs `item edit --title|--outcome-md|--decision <key> --md`, `finding edit --title|--detail-md|--outcome-md`, `backlog policy replace --md`, `backlog focus --md` or `backlog boundary replace` (titles go as plain text), closes the editor and reloads after exit 0, and keeps it open with the CLI's message otherwise. Delete first shows "Delete?" with Delete and Cancel on the entry, then runs `item edit --decision <key> --remove`, `backlog policy rm` or `backlog boundary rm`. A decision is addressed by `decisionKey` from the store. Each is a mutation the CLI accepts
from outside a Herdr terminal and records for the watcher's `edited` event; for `item update` only a lone `--status` from that list is. Delegate-harness policy reads and edits also go through the CLI:
`harness-policy show --json [--domain <d>]`, `global-set`, `domain-set`, and `domain-reset`, with
`--expected-revision` on every mutation. Never read or write the policy JSON from the mod. The domain
page also reads `queue show --domain <d> --json` (the Queued item group: an open item in the
capacity queue shows only there, with its machine and place in that machine's queue, unless it
has an ask) and `watch outbox --domain <d> --json` (the Lists card's Outbox row and page of
undelivered watcher events) and `wiki list --domain <d> --json` (the Lists card's Wiki row and page:
the domain wiki's pages in index order, never the shared wiki) after each load of the shown domain's
backlog, and `wiki show --domain <d> --json -- <name>` when a wiki page opens (its frontmatter
facts from the list, its body as `TextView.markdown`). A policy's `wiki: [[name]]` on the Policies
page links to that page while the list has it, and stays plain text otherwise. A failed or invalid
read shows nothing (a 0 count, no body), never an error. Never read the capacity or watch JSON, or
the wiki folder, from the mod. Displayed paths show the home folder as `~` through `tildePath` in model.ts (display only: argv, ids and keys keep the full path), and a fact's values stack one per row, never in columns. On an item's detail screen, answered asks show only their question, context and answer line (the answer row, plus its note row when there is one, drawn as the expanded card draws them) above a full-width Show all / Show less row (per card, panel memory); the open ask stays full. No part inside an ask card (detail or answer flow) has its own border or rounded corners; parts are ruled off by dividers. Before drawing, `linkIds`/`linkProse` in `model.ts` turn whole-token ids the shown domain's backlog has (`i<n>`, `f<n>`, `p<n>`, closed records included) into `coordinate-panel:<id>` links; plain text that contains one renders as escaped Markdown. Every prose `TextView` has `on_link_click`: an id opens its item, finding or the Policies page, an http(s) URL opens in the browser, anything else does nothing. Every CLI
call runs as `/usr/bin/env -u HC_TERMINAL_ID <bun>
~/.claude/skills/coordinate/scripts/coordinate.ts`. Unsetting the variable keeps the panel that
caller even in an app started from a terminal. A mod's `exec` runs with the app's environment,
whose PATH has no bun, so `scripts/build.ts` bakes `<bun>` from the build's own PATH as
`COORDINATE_BUN`; reinstall after moving bun. The answer flow shows the CLI's message on a non-zero exit or failed start and reloads the backlog only after exit 0. Policy writes use revision checks; on a stale revision the panel rereads canonical policy to surface a conflict, while other failures preserve the draft and show the CLI message. The editor opens in a Herdr dialog: the settings cog in the panel header (Herdr's shipped `mods/workspace-chrome/settings.svg`) calls `openOverlay` (through `overlay.ts`, which the tests replace) for another copy of this same mod, with the domain on a domain page or global defaults on Domains. A copy reads its overlay props from `props()`, never from `init`'s argument, and `policyDialogProps` validates them; the tests mount the copy through a `props()` override of the real shape. That copy draws `policy-dialog.ts`, a settings window that mirrors herdr-finbar's (880 by 620, drawn by the mod with its own border, corners and shadow inside a frameless, full-window, `modal` dialog, as Herdr's win98 mod does; a sidebar with its title and one Harness section; a pane whose top row holds the section label and a scope dropdown, Global with herdr-ui's globe then every backlog domain, over switch and segmented rows). The dropdown tags each domain with its own saved override (Inherit global off) "Override"; the global view lists no overrides, so the copy reads `harness-policy show --json --domain <d>` once per listed domain, again on each policy change and after a successful write, and a failed read just shows no tag. The dropdown is plain state, not a Popover: a Popover also reacts to the press on its trigger, and a click handler that toggled it then closed it again on release. It only reads and writes policy, keeps a draft per scope that Save writes through the revision-checked CLI (a domain's Inherit global switch is part of the draft: a set, or a reset). Switching scope never asks: it shows that scope's draft. The revision covers the whole file, so a draft is carried onto a newer read when its own scope's policy is unchanged and is stale only when that changed. It shows write errors, a stale draft and a Reload button inline, plus notices computed from the draft: a domain override that equals global (it will stop following global), a domain override that re-enables a harness global disables, and on the global scope each domain whose override keeps a harness the draft disables; and asks "Discard changes?" in the window before closing (Cancel, Escape, or a click beside the window) while any scope has unsaved changes, and closes at once otherwise; Escape is handled in the window and stops there, as Herdr's shipped `confirm` dialog does. Herdr would close a plain dialog on a click beside it without asking, which is why the mod draws the window and catches that click itself. The panel renders a prose field's Markdown sibling (`prose()` from the store picks it) with native `TextView.markdown`, inline fields through `inlineMarkdown` in `model.ts` so they stay one paragraph, and a truncated caption through `markdownPlain`; it shows the plain text field, as before, only when there is no sibling. Its own writes (answers, Dismiss) keep the plain flags, so a new panel still works against an older CLI. The mods share the backlog schema and validator by relative import from
`skills/coordinate/scripts/lib/backlog-store/`, which must stay dependency-free (Herdr has no
`TextEncoder`, so Effect Schema cannot load in a mod).

## Shared unmanaged core and Pi async fleets

Keep mod-compatible behaviour in `hooks/core/*.ts`. A mod imports only its own plugin's
files, and its runtime has no Node, DOM, or npm packages, so that core stays plain
TypeScript with no imports outside `hooks/core/`.

For `to-code` async fleets, put the browser-safe Effect Machine definition and report
validation in `fleet/`, Node/Herdr/storage operations in `pi/`, and the simulator in
`demo/`. Pi tools and the browser must import the same `fleet/` definition, never copy
its transitions into a separate reducer. The Claude mod retains the dependency-free
unmanaged tools and does not import `fleet/`.

```ts
// Pi and the browser share this model; only Pi imports Node-backed operations.
import { ticketMachine } from "../fleet/model.ts";
```

Record accepted reports and pending callbacks durably before releasing a worker's
assignment stop gate. Rearm that gate on every correlated follow-up assignment. Machine
snapshots alone do not provide cross-process persistence or reliable callback delivery.

Use current `hc` contracts in `hooks/core/herdr.ts` for shared transport. Core terminal addresses, not app pane IDs, identify workers; `herdr-app` owns visible topology. Keep startup registration separate from task completion and preserve predecessor evidence needed for callback recovery. The supported runtime and persisted-run boundary live in `plugins/to-code/README.md`.

The adapters inject what differs per harness, the process runner and the session store:

```ts
// hooks/register.ts (Claude Code mod)
const processRunner = ($: EngineInterface): Runner => async (argv, timeoutMs) => {
  const ran = await $.process.run(argv, { timeoutMs: Math.min(timeoutMs, 600_000) });
  return { exitCode: ran.exitCode ?? 1, stdout: ran.stdout, stderr: ran.stderr };
};

// pi/index.ts (pi extension, Node is available)
export const nodeRunner: Runner = (argv, timeoutMs, signal) => /* execFile with signal */;
```

Mod constraints that `claude plugin validate` enforces:

- `$` may only be passed to functions declared at the top level of `register.ts`.
- Matchers name tools literally or by `RegExp` (`{ tool: /^mcp__to-code__fleet_/ }`); a
  computed string fails the type-check.
- Values a drawing or a later hook reads go in `$.state`, declared in `types/index.d.ts`.

## Two test runners

| Files                                                                       | Runner                              | Imports               |
| --------------------------------------------------------------------------- | ----------------------------------- | --------------------- |
| `hooks/core/*.spec.ts`, `fleet/*.spec.ts`, `pi/*.spec.ts`, `demo/*.spec.ts` | `bun test`                          | `bun:test`            |
| `tests/*.test.ts`                                                           | `claude plugin test plugins/<name>` | `claude-code/testing` |

`claude plugin test` runs every `*.test.ts` under the plugin, so bun tests use the
`.spec.ts` suffix. `bunfig.toml` ignores `plugins/*/tests/**` so `bun test` skips the mod
tests. In a mod test, answer each op the plugin calls beneath it, wrapped in `value`:
`on("process.run", async () => ({ value: { exitCode: 0, stdout, stderr: "", ... } }))`.

## Checks

- Root `bun run check` type-checks the core and the pi adapter; it excludes `hooks/register.ts`,
  `tests/`, and `types/`.
- `tsc -p plugins/<name>` type-checks the mod against `.claude-plugin/types/`, which Claude
  Code writes when it loads the mod (`claude --plugin-dir plugins/<name>`) and git ignores.
- `claude plugin validate plugins/<name>` and `claude plugin validate .` after manifest edits.
- pi dev dependencies pin a release at least five days old (`bunfig.toml`
  `minimumReleaseAge`), with peer dependencies `"*"`.
