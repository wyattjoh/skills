/**
 * Minimal argv parser shared by the CLI router and the shared filters.
 *
 * Supports `--key=value`, `--key value`, bare boolean flags (`--flag`),
 * `--no-flag` negation, and repeatable flags (each repetition collects into
 * an array in declaration order). Anything not starting with `--` is a
 * positional; a bare `--` stops flag parsing and treats the rest of argv as
 * positionals.
 *
 * This is deliberately schema-free about *unknown* flags: it never throws on
 * one it has not heard of. It does, however, accept the caller's list of
 * boolean flag names, because a bare `--flag` cannot otherwise be told apart
 * from `--flag <value>`: without that list, `search --table "forgejo
 * census"` would swallow the query as the value of `--table`. Commands that
 * need strict validation beyond that (see commands/sync.ts) can still reach
 * for `node:util`'s `parseArgs` directly.
 */

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

function setFlag(flags: Record<string, FlagValue>, key: string, value: string | boolean): void {
  if (typeof value === "boolean") {
    flags[key] = value;
    return;
  }

  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  if (typeof existing === "string") {
    flags[key] = [existing, value];
    return;
  }
  // A boolean flag followed by a valued repetition of the same name: the
  // valued form wins.
  flags[key] = value;
}

/**
 * Parse argv into positionals and flags. See module docs for the grammar.
 *
 * `booleanFlags` names the flags that never take a following-token value
 * (matching each command's own `options` list, where `type: "boolean"`).
 * A bare `--flag` for one of these names is always `true`; the next token,
 * if any, is left alone as a positional instead of being consumed as the
 * flag's value.
 */
export function parseArgv(argv: string[], booleanFlags: Iterable<string> = []): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  const booleanNames = new Set(booleanFlags);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      setFlag(flags, body.slice(0, eq), body.slice(eq + 1));
      continue;
    }

    if (body.startsWith("no-") && body.length > "no-".length) {
      setFlag(flags, body.slice("no-".length), false);
      continue;
    }

    if (booleanNames.has(body)) {
      setFlag(flags, body, true);
      continue;
    }

    const next = argv[i + 1];
    const nextIsValue = next !== undefined && !next.startsWith("--");
    if (nextIsValue) {
      setFlag(flags, body, next);
      i += 1;
      continue;
    }

    setFlag(flags, body, true);
  }

  return { positionals, flags };
}

/**
 * Return the names of boolean options declared by a command.
 *
 * @param options Command option metadata.
 * @returns Boolean flag names for parseArgv's schema.
 */
export function booleanFlagNames(
  options: ReadonlyArray<{ name: string; type: "string" | "boolean" }>,
): string[] {
  return options.filter((option) => option.type === "boolean").map((option) => option.name);
}

/** All values given for a repeatable string flag, in declaration order. */
export function flagStrings(flags: Record<string, FlagValue>, key: string): string[] {
  const value = flags[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

/** The last value given for a flag, or undefined if it was never a string. */
export function flagString(flags: Record<string, FlagValue>, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return undefined;
}

/** A boolean flag's value, defaulting when absent. `--no-x` yields false. */
export function flagBoolean(
  flags: Record<string, FlagValue>,
  key: string,
  fallback = false,
): boolean {
  const value = flags[key];
  if (typeof value === "boolean") return value;
  if (value === undefined) return fallback;
  // A string value on a boolean-shaped flag (`--include-subagents=false`):
  // honor the falsy spellings explicitly rather than treating any non-empty
  // string as present.
  const resolved = Array.isArray(value) ? value[value.length - 1] : value;
  return resolved !== "false" && resolved !== "0" && resolved !== "no";
}
