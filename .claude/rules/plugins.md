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

## One dependency-free core, two thin adapters

Put behaviour in `hooks/core/*.ts`. A mod imports only its own plugin's files, and its
runtime has no Node, DOM, or npm packages, so the core stays plain TypeScript with no
imports outside `hooks/core/`. Effect is not used here; `.claude/rules/skills.md`'s Effect
preference covers `skills/**` only.

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

| Files                                  | Runner                              | Imports               |
| -------------------------------------- | ----------------------------------- | --------------------- |
| `hooks/core/*.spec.ts`, `pi/*.spec.ts` | `bun test`                          | `bun:test`            |
| `tests/*.test.ts`                      | `claude plugin test plugins/<name>` | `claude-code/testing` |

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
