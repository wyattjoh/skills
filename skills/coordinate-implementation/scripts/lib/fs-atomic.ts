/**
 * Crash-safe file writes shared by every helper that persists run artifacts.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Raised by {@link writeImmutable} when the path already holds different content.
 */
export class ImmutableContentConflict extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists with different content.`);
  }
}

const writeSynced = async (path: string, content: string, mode: number | undefined) => {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Replaces a file through a uniquely named, fsynced temporary file and one rename, so readers
 * see either the old or the new content and concurrent writers never share a temporary path.
 *
 * @param path - Destination file. Its directory is created when missing.
 * @param content - Complete new content.
 * @param mode - Optional permission bits for the new file.
 */
export const replaceFileAtomically = async (
  path: string,
  content: string,
  mode: number | undefined = undefined,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeSynced(temporary, content, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/**
 * Writes immutable evidence exactly once. Repeating the identical write is a no-op; any other
 * content at the path is a conflict, so earlier evidence is never overwritten.
 *
 * @param path - Destination file. Its directory is created when missing.
 * @param content - Complete content.
 * @param mode - Optional permission bits for the new file.
 * @returns True when this call created the file, false when identical content already existed.
 * @throws ImmutableContentConflict when the path holds different content.
 */
export const writeImmutable = async (
  path: string,
  content: string,
  mode: number | undefined = undefined,
): Promise<boolean> => {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeSynced(path, content, mode);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await readFile(path, "utf8")) !== content) throw new ImmutableContentConflict(path);
  return false;
};
