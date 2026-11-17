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

`plugins/coordinate/herdr/` builds read-only Herdr mods (`coordinate-panel`) for the coordinate
skill's backlog. It is not a Claude Code plugin: no `.claude-plugin/`, no marketplace entry, no
mod or pi extension. It is its own project with its own `package.json`, `bunfig.toml` and
`justfile`. Root `bun test` and `knip` skip it, and root `bun run check` skips its `src/` (its
tests need the renderer preload and its mod sources need Herdr's host `.d.ts` files); root
`check` still type-checks its Bun `scripts/`, and root lint and format cover all of it. Run `just check` there: tests, a typecheck against the installed declarations copied
into `node_modules/.cache/`, and a build that stages each mod under `.scratch/` and runs
`herdr-app check` with that stage as `HERDR_APP_HOME`. Nothing there writes the live Herdr home.

The mods share the backlog schema and validator by relative import from
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
