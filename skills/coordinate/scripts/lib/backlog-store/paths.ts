// Where a domain's backlog document lives under the coordinate state folder, as plain strings so the
// CLI and the Herdr mods (which have no node:path) can never disagree.

/**
 * Folder of backlog documents, beside the watch and ended folders.
 * @param stateDir State dir.
 * @returns Path.
 */
export const backlogsDir = (stateDir: string): string => `${stateDir}/backlogs`;

/**
 * The backlog document of a domain.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Path.
 */
export const documentPath = (stateDir: string, domain: string): string =>
  `${backlogsDir(stateDir)}/${domain}.json`;

/**
 * The domain's append-only archive of closed records, one JSON record per line.
 * @param stateDir State dir.
 * @param domain Domain.
 * @returns Path.
 */
export const archivePath = (stateDir: string, domain: string): string =>
  `${backlogsDir(stateDir)}/${domain}.archive.jsonl`;
