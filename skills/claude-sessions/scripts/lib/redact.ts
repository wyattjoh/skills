/**
 * Secret redaction for CLI output. Matching (search, FTS, filters) always
 * runs against raw, unredacted text pulled from the index; this module only
 * transforms what gets printed. Every match is replaced with
 * `[redacted:<kind>]`.
 */

interface SecretPattern {
  kind: string;
  pattern: RegExp;
  /** Given the match groups (index 0 is the full match), build the
   * replacement text. Defaults to replacing the whole match. */
  replace?: (groups: string[]) => string;
}

const wholeMatch = (kind: string) => () => `[redacted:${kind}]`;

const PATTERNS: SecretPattern[] = [
  {
    kind: "anthropic-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g,
  },
  {
    kind: "openai-key",
    pattern: /sk-(?!ant-)[A-Za-z0-9]{20,}/g,
  },
  {
    kind: "github-token",
    pattern: /gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    kind: "aws-key",
    // Trailing boundary: without it, an over-long id like
    // AKIAIOSFODNN7EXAMPLEXYZ redacts to "[redacted:aws-key]XYZ" instead of
    // leaving the whole non-matching string alone.
    pattern: /AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  },
  {
    kind: "aws-secret",
    // A 40-char base64ish string that mixes case and digits, the shape of an
    // AWS secret access key. Requiring all three character classes keeps
    // plain lowercase-hex 40-char strings (git commit shas) unredacted. The
    // boundary class also excludes "-" and "_" (base64url) so a 40-char
    // window in the middle of a longer base64url string, such as a PKCE
    // code challenge or a "sha256-..." integrity hash, is not mistaken for
    // a standalone token: without them, "-" and "_" read as valid
    // boundaries and the match both fires on prose and leaves a mangled
    // tail (e.g. "[redacted:aws-secret]-cM").
    pattern:
      /(?<![A-Za-z0-9/+=_-])(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=_-]))(?=[A-Za-z0-9/+=]*[A-Z])(?=[A-Za-z0-9/+=]*[a-z])(?=[A-Za-z0-9/+=]*[0-9])[A-Za-z0-9/+=]{40}/g,
  },
  {
    kind: "stripe-key",
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  {
    kind: "bearer-token",
    // The word after "Bearer" is only redacted when it looks like a real
    // token: at least 20 characters, or shorter but with both a digit and a
    // non-alphanumeric character. Without a floor, ordinary prose and API
    // docs ("Bearer token", "a Bearer header") get mangled: scanning real
    // transcripts found every un-floored match was a false positive.
    pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]+=*)/g,
    replace: (groups) => {
      const full = groups[0]!;
      const token = groups[1]!;
      const looksLikeToken = token.length >= 20 || (/\d/.test(token) && /[^A-Za-z0-9]/.test(token));
      return looksLikeToken ? "Bearer [redacted:bearer-token]" : full;
    },
  },
  {
    kind: "enc-payload",
    pattern: /enc:v1:[A-Za-z0-9+/=]+/g,
  },
  {
    kind: "env-secret",
    // KEY=, TOKEN=, SECRET=, and prefixed forms like API_KEY=, SECRET_TOKEN=.
    // Require a letter plus a digit or punctuation so ordinary values such as
    // API_KEY=development are not treated as secrets solely because they are
    // long enough.
    pattern: /\b((?:[A-Z0-9]+_)*(?:KEY|TOKEN|SECRET))=([A-Za-z0-9+/_.=-]{8,})/g,
    replace: (groups) => {
      const full = groups[0]!;
      const value = groups[2]!;
      const hasLetter = /[A-Za-z]/.test(value);
      const hasDigit = /\d/.test(value);
      const hasPunctuation = /[^A-Za-z0-9]/.test(value);
      return hasLetter && (hasDigit || hasPunctuation)
        ? `${groups[1]}=[redacted:env-secret]`
        : full;
    },
  },
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

for (const spec of PATTERNS) {
  if (spec.replace === undefined) {
    spec.replace = wholeMatch(spec.kind);
  }
}

function applyPattern(text: string, spec: SecretPattern): string {
  spec.pattern.lastIndex = 0;
  return text.replace(spec.pattern, (...args) => {
    // String.replace passes (match, ...capturedGroups, offset, fullString),
    // and adds a named-groups object at the end when the pattern has any.
    // None of the patterns above use named groups, so the trailing two
    // arguments are always offset and fullString.
    const groups = args.slice(0, -2).map((value) => (typeof value === "string" ? value : ""));
    return spec.replace!(groups);
  });
}

/** Replace every recognized secret pattern in a string. */
export function redactString(text: string): string {
  return PATTERNS.reduce((acc, spec) => applyPattern(acc, spec), text);
}

/**
 * Recursively redact strings inside a value: strings are scanned, arrays and
 * plain objects are walked, everything else passes through unchanged.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(val);
    }
    return result as T;
  }
  return value;
}
