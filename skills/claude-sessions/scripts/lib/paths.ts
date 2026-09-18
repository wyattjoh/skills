/**
 * Encode/decode between a working directory and the project directory name
 * Claude Code uses under ~/.claude/projects/.
 *
 * Encoding is exact: Claude Code replaces every "/" and "." in the cwd with
 * "-". Decoding is lossy: a real path segment can itself contain "-" (an
 * `agent-toolkit` repo, a `wyattjoh/fix-e2e` worktree name), so turning every
 * "-" back into "/" cannot tell those apart from an encoded separator. Treat
 * `decodeProjectDirLossy` as a display hint only; the authoritative path for
 * a project is the `cwd` field recorded on its own messages, not the decoded
 * directory name.
 */

/** Encode a cwd into the directory name Claude Code stores it under. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Best-effort, lossy decode of an encoded project directory name back into a
 * path-shaped string. Do not treat the result as authoritative; prefer the
 * `cwd` recorded on a project's own messages when one is available.
 */
export function decodeProjectDirLossy(encoded: string): string {
  if (encoded.startsWith("-")) {
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }
  return encoded.replace(/-/g, "/");
}
