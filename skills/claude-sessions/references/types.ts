/**
 * Re-export the conversation record model used by the indexed CLI.
 *
 * Keeping one source of truth prevents the public reference types from
 * drifting away from the parser and ingest implementation.
 */
export * from "../scripts/lib/records.ts";
