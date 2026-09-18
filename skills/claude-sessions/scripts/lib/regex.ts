/** Shared safety policy for user-supplied regular expressions. */

export const MAX_REGEX_PATTERN_LENGTH = 256;
export const MAX_REGEX_CANDIDATES = 1_000;
export const MAX_REGEX_TEXT_LENGTH = 32 * 1024;

/** Return the maximum number of rows to fetch when a regex will be evaluated. */
export function regexCandidateLimit(regex: RegExp | undefined): number | undefined {
  return regex === undefined ? undefined : MAX_REGEX_CANDIDATES + 1;
}

/** Reject a candidate set that is too large for synchronous regex evaluation. */
export function assertRegexCandidateCount(count: number, optionName: string): void {
  if (count > MAX_REGEX_CANDIDATES) {
    throw new Error(`Rejected ${optionName}: candidate set exceeds ${MAX_REGEX_CANDIDATES} rows.`);
  }
}

/** Limit the text handed to a user-supplied regex. */
export function boundedRegexText(text: string): string {
  return text.slice(0, MAX_REGEX_TEXT_LENGTH);
}

/** Evaluate a safe regex against only the bounded prefix of a value. */
export function testSafeRegex(regex: RegExp, text: string): boolean {
  return regex.test(boundedRegexText(text));
}

type RegexGroup = {
  hasQuantifier: boolean;
  hasAlternation: boolean;
};

function hasUnsafeRegexStructure(source: string): string | undefined {
  if (/\\(?:[1-9]\d*|k<[^>]+>)/.test(source)) {
    return "backreferences are not allowed";
  }

  const groups: RegexGroup[] = [];
  let escaped = false;
  let inCharacterClass = false;
  let previousGroupHadQuantifier = false;
  let variableQuantifiers = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;

    if (character === "(") {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      previousGroupHadQuantifier = false;
      continue;
    }
    if (character === "|") {
      const group = groups.at(-1);
      if (group !== undefined) group.hasAlternation = true;
      previousGroupHadQuantifier = false;
      continue;
    }
    if (character === ")") {
      const group = groups.pop();
      if (group === undefined) {
        previousGroupHadQuantifier = false;
        continue;
      }
      previousGroupHadQuantifier = group.hasQuantifier || group.hasAlternation;
      const parent = groups.at(-1);
      if (parent !== undefined) {
        parent.hasQuantifier ||= group.hasQuantifier;
        parent.hasAlternation ||= group.hasAlternation;
      }
      continue;
    }

    const isGroupPrefix = character === "?" && source[index - 1] === "(";
    const isQuantifier =
      character === "*" ||
      character === "+" ||
      (character === "?" && !isGroupPrefix) ||
      character === "{";
    if (!isQuantifier) {
      previousGroupHadQuantifier = false;
      continue;
    }

    if (previousGroupHadQuantifier) {
      return "nested or repeated quantified groups are not allowed";
    }

    const rangeEnd = character === "{" ? source.indexOf("}", index + 1) : -1;
    const range =
      rangeEnd === -1
        ? undefined
        : (/^\{(\d+)(?:,(\d*))?\}$/.exec(source.slice(index, rangeEnd + 1)) ?? undefined);
    let isVariableRange = false;
    if (range !== undefined) {
      const lower = Number(range[1]);
      const hasComma = range[2] !== undefined;
      const upper = !hasComma ? lower : range[2] === "" ? undefined : Number(range[2]);
      if (lower > MAX_REGEX_TEXT_LENGTH || (upper !== undefined && upper > MAX_REGEX_TEXT_LENGTH)) {
        return `repetition bounds must not exceed ${MAX_REGEX_TEXT_LENGTH} characters`;
      }
      isVariableRange = hasComma && (range[2] === "" || range[2] !== range[1]);
    }

    const group = groups.at(-1);
    if (group !== undefined) group.hasQuantifier = true;
    if (
      character === "*" ||
      character === "+" ||
      (character === "?" && !isGroupPrefix) ||
      isVariableRange
    ) {
      variableQuantifiers += 1;
      if (variableQuantifiers > 1) {
        return "multiple variable-length quantifiers are not allowed";
      }
    }
    previousGroupHadQuantifier = false;
  }

  return undefined;
}

/** Parse a user-supplied regex under the shared bounded safety policy. */
export function parseSafeRegex(
  raw: string | undefined,
  optionName = "--regex",
  flags = "",
): RegExp | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Rejected ${optionName}: pattern length must be at most ${MAX_REGEX_PATTERN_LENGTH} characters.`,
    );
  }
  const unsafeReason = hasUnsafeRegexStructure(raw);
  if (unsafeReason !== undefined) throw new Error(`Rejected ${optionName}: ${unsafeReason}.`);
  try {
    return new RegExp(raw, flags);
  } catch (err) {
    throw new Error(`Invalid ${optionName}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}
