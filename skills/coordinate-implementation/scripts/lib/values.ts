/**
 * Small pure helpers shared across coordinate-implementation modules.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/**
 * Tests for a plain JSON object.
 *
 * @param value - Any parsed value.
 * @returns True for a non-null, non-array object.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Escapes text for literal use inside a regular expression.
 *
 * @param value - Literal text, such as a section heading.
 * @returns The escaped pattern source.
 */
export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Formats a time as whole-second UTC ISO-8601, the form every persisted timestamp uses.
 *
 * @param date - Time to format; defaults to now.
 * @returns For example `2026-09-25T12:00:00Z`.
 */
export const utcSeconds = (date: Date = new Date()): string =>
  date.toISOString().replace(/\.\d{3}Z$/u, "Z");

/**
 * Hashes text or bytes with SHA-256.
 *
 * @param content - Content to hash.
 * @returns The lowercase hex digest.
 */
export const sha256Hex = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/**
 * Resolves symlinks in the longest existing prefix of a path and appends the missing rest, so a
 * not-yet-created file can still be checked against a canonical root.
 *
 * @param path - Absolute or relative path.
 * @returns The canonical path.
 */
export const canonicalPathAllowingMissing = async (path: string): Promise<string> => {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
};
