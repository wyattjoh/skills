/** Scoped database ownership for composed command programs. */
import { Effect } from "effect";
import type { Database } from "bun:sqlite";
import { openDbScoped } from "./db.ts";

/**
 * Compose database work in a scope that always closes its connection.
 * @param use - The program using the acquired database.
 * @returns The program's result with connection ownership scoped to this call.
 */
export const withDbEffect = Effect.fn("index.withDb")(function* <A, E>(
  use: (db: Database) => Effect.Effect<A, E>,
) {
  const db = yield* openDbScoped();
  return yield* use(db);
}, Effect.scoped);
