# Knip configuration (`knip.json` and friends)

Knip works with zero config on many projects: defaults plus auto-enabled plugins
find most entry files. Add config when the report shows false positives. Sources:
[configuration overview](https://knip.dev/overview/configuration),
[configuration reference](https://knip.dev/reference/configuration). Keys below exist
in v6.41.0 unless marked otherwise.

## File names and lookup

Knip checks these in order and uses the first one found
([location](https://knip.dev/overview/configuration#location)):

1. `knip.json`
2. `knip.jsonc`
3. `.knip.json`
4. `.knip.jsonc`
5. `knip.ts`
6. `knip.js`
7. `knip.config.ts`
8. `knip.config.js`
9. `package.json`, under the `"knip"` key

`--config <file>` points at any other path. Per the knip source (not stated in the
docs): only the directory Knip runs in (cwd or `--directory`) is searched, with no
walk up to parent directories.

Add a schema for editor completion
([JSON schema](https://knip.dev/reference/configuration#json-schema)):

```jsonc
{
  "$schema": "https://unpkg.com/knip@6/schema.json", // or schema-jsonc.json for .jsonc
}
```

### Dynamic config (`knip.ts` / `knip.js`)

Default-export a `KnipConfig` object, or a sync or async function that returns one.
Use this for real regular expressions and for `compilers`
([dynamic configuration](https://knip.dev/reference/dynamic-configuration)).

```ts
import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/index.ts"],
  project: ["src/**/*.ts"],
  ignoreDependencies: [/@org\/.*/],
};

export default config;
```

## Defaults

```json
{
  "entry": [
    "{index,cli,main}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
    "src/{index,cli,main}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"
  ],
  "project": ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}!"]
}
```

- Setting `entry` or `project` **replaces** these defaults; it does not merge.
- `package.json` fields `main`, `module`, `browser`, `bin`, `types`, `typings`, and
  `exports` are always entry files. `scripts` are parsed for entries and binaries.
- `.gitignore` is respected (`--no-gitignore` turns it off).

Source: [configuring project files](https://knip.dev/guides/configuring-project-files#defaults--plugins),
[entry files](https://knip.dev/explanations/entry-files).

## Top-level keys

### Project

| Key       | Value      | Purpose                                                                                     |
| --------- | ---------- | ------------------------------------------------------------------------------------------- |
| `entry`   | glob array | Starting points of the module graph. `!` prefix negates; `!` suffix marks production files. |
| `project` | glob array | Files in scope for unused-file and unused-export analysis. Negate to exclude.               |
| `paths`   | object     | Import aliases with TypeScript `paths` semantics. `tsconfig.json` paths are read already.   |

Exclude build output and generated code with negated `project` patterns rather than
`ignore`. Do not hide tests with `ignore` or negations; use `--production` instead
([configuring project files](https://knip.dev/guides/configuring-project-files)).

### Workspaces (root only)

| Key                | Value      | Purpose                                                                     |
| ------------------ | ---------- | --------------------------------------------------------------------------- |
| `workspaces`       | object     | Per-workspace config keyed by directory (globs allowed); the root is `"."`. |
| `ignoreWorkspaces` | glob array | Workspaces to skip. `!` suffix: production only.                            |

In a monorepo, root-level `entry` and `project` are ignored; put root settings under
`workspaces["."]`. Workspace values accept `entry`, `project`, `paths`, the `ignore*`
keys, `includeEntryExports`, and plugin keys
([monorepos and workspaces](https://knip.dev/features/monorepos-and-workspaces)).

```json
{
  "workspaces": {
    ".": {
      "entry": "scripts/*.js",
      "project": "scripts/**/*.js"
    },
    "packages/*": {
      "entry": "{index,cli}.ts",
      "project": "**/*.ts"
    },
    "packages/cli": {
      "entry": "bin/cli.js"
    }
  }
}
```

Source: [monorepos and workspaces](https://knip.dev/features/monorepos-and-workspaces).

### Rules and filters

| Key                                   | Value                                     | Purpose                                                                                                                                       |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules`                               | `{ <issueType>: "error"\|"warn"\|"off" }` | Per-type severity. `warn` reports but does not fail. `cycles` defaults to `warn`. Also accepts `devDependencies`, `optionalPeerDependencies`. |
| `include` / `exclude`                 | issue type array                          | Same as the CLI flags.                                                                                                                        |
| `tags`                                | string array                              | e.g. `["-lintignore"]`. Tag names must not contain `-` or `+`.                                                                                |
| `treatConfigHintsAsErrors`            | boolean                                   | Same as the CLI flag.                                                                                                                         |
| `treatTagHintsAsErrors`               | boolean                                   | Same as the CLI flag.                                                                                                                         |
| `preprocessor`, `preprocessorOptions` |                                           | Same as the CLI flags.                                                                                                                        |

Issue type keys are listed in
[`commands/cli-flags.md`](commands/cli-flags.md#issue-types).
Source: [rules and filters](https://knip.dev/features/rules-and-filters).

### Ignoring issues

Prefer the narrowest key that fixes the false positive. Configuration hints tell you
when an ignore entry is no longer needed.

| Key                       | Value                        | Effect                                                                                                                                            |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoreIssues`            | `{ "<glob>": [issueTypes] }` | Suppress chosen issue types in matching files.                                                                                                    |
| `ignoreFiles`             | glob array                   | Exclude from "Unused files" only.                                                                                                                 |
| `ignoreDependencies`      | names or regex strings       | Never report these packages.                                                                                                                      |
| `ignoreBinaries`          | names or regex strings       | Never report these binaries.                                                                                                                      |
| `ignoreMembers`           | names or regex strings       | Never report these enum or namespace members.                                                                                                     |
| `ignoreUnresolved`        | names or regex strings       | Never report these unresolved imports.                                                                                                            |
| `ignoreGlobalBinaries`    | boolean (default `true`)     | Don't report globally available binaries.                                                                                                         |
| `ignoreExportsUsedInFile` | `true` or per-kind object    | Don't report exports used only inside their own file. Kinds: `class`, `enum`, `function`, `interface`, `member`, `namespace`, `type`, `variable`. |
| `ignore`                  | glob array                   | Suppress **all** issues in matching files. Discouraged: files stay in analysis.                                                                   |

`!` suffix (production only) works on `ignoreFiles`, `ignoreBinaries`,
`ignoreDependencies`, and `ignoreWorkspaces`.

```json
{
  "ignoreDependencies": ["hidden-package", "@org/.+"],
  "ignoreExportsUsedInFile": true,
  "ignoreIssues": { "src/generated/**": ["exports", "types"] }
}
```

`(inferred)`: each key is documented separately in the
[configuration reference](https://knip.dev/reference/configuration#ignore-issues);
the combined object is assembled here.

### Exports and cycles

| Key                     | Value                                 | Purpose                                                               |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `includeEntryExports`   | boolean                               | Report unused exports in entry files too.                             |
| `includeSubpathExports` | boolean                               | **6.45.0+ only.** Report unused `package.json#exports` subpaths.      |
| `cycles`                | `{ dynamicImports, allow: [[a, b]] }` | Cycle detection: include dynamic imports, allow known cycles.         |
| `compilers`             | functions                             | Non-standard file types (`.astro`, `.mdx`, ...). Dynamic config only. |

## Plugins

Plugins enable themselves when their package is in `dependencies` or
`devDependencies`. They add entry files (often read from the tool's own config) and
find dependencies referenced in tool config files
([plugins](https://knip.dev/explanations/plugins)).

A plugin key (`eslint`, `vitest`, `playwright`, `next`, `storybook`, `webpack`, ...)
accepts:

- `true` / `false`: force-enable or disable.
- A glob string or array: shorthand for `config`.
- `{ "config": [...], "entry": [...], "project": [...] }`: override what the plugin
  reads and what it treats as entries.

```json
{
  "mocha": {
    "config": "config/mocha.config.js",
    "entry": ["**/*.spec.js"]
  },
  "playwright": true,
  "webpack": false
}
```

Source: [configuration reference: plugins](https://knip.dev/reference/configuration#plugins).
Plugin keys work at the root or per workspace. Per-plugin details live at
`https://knip.dev/reference/plugins/<name>`.

## Production mode (`!` suffix)

```json
{
  "entry": ["src/index.ts!", "build/script.js"],
  "project": ["src/**/*.ts!", "build/*.js"]
}
```

- `knip --production` reads only `!`-suffixed patterns, plugin production entries,
  and the `start` script, and skips `devDependencies` and `@internal` exports.
- `!` on both ends excludes a pattern in production: `"!src/test-helpers/**!"`.

Source: [production mode](https://knip.dev/features/production-mode).

## JSDoc / TSDoc tags

| Tag                         | Effect                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `@public`                   | Never report this export (also under `--include-entry-exports`).                    |
| `@beta`                     | Same as `@public`.                                                                  |
| `@internal`                 | Not reported in production mode.                                                    |
| `@alias`                    | Suppress duplicate-export reporting.                                                |
| custom (e.g. `@lintignore`) | Filter with `--tags` / `tags`. A tag hint appears once an excluded tag is unneeded. |

```ts
/** @lintignore */
export const myUnusedExport = 1;
```

Tags go in `/** */` or `/* */` comments before the declaration. Standalone `//`
line-comment tags need 6.42.0+.
Source: [JSDoc and TSDoc tags](https://knip.dev/reference/jsdoc-tsdoc-tags).
