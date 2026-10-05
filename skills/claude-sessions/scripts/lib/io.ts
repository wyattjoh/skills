/** Typed foreign-I/O boundaries and public API compatibility bridges. */
import { Effect, Schema } from "effect";

/** An external operation failed, retaining its original diagnostic. */
export class SessionIOError extends Schema.TaggedError<SessionIOError>()("SessionIOError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/**
 * Suspend a synchronous foreign operation in the failure channel.
 * @param operation - Diagnostic name of the operation.
 * @param run - External operation, executed once per Effect run.
 * @returns The operation's result or a typed I/O failure.
 */
export function tryIO<A>(operation: string, run: () => A) {
  return Effect.try({ try: run, catch: (cause) => new SessionIOError({ operation, cause }) });
}

/**
 * Suspend an asynchronous foreign operation with cancellation support.
 * @param operation - Diagnostic name of the operation.
 * @param run - External operation accepting the fiber's abort signal.
 * @returns The operation's result or a typed I/O failure.
 */
export function tryPromiseIO<A>(operation: string, run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new SessionIOError({ operation, cause }),
  });
}

/**
 * Preserve native rejections at a public Promise boundary.
 * @param program - The composed Effect program to execute.
 * @returns A Promise rejecting with the original foreign error.
 */
export function runEffectPromise<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program).catch((error) => {
    throw error instanceof SessionIOError ? error.cause : error;
  });
}

/**
 * Preserve native exceptions at a public synchronous boundary.
 * @param program - The synchronous Effect program to execute.
 * @returns Its result, throwing the original foreign error on failure.
 */
export function runEffectSync<A, E>(program: Effect.Effect<A, E>): A {
  try {
    return Effect.runSync(program);
  } catch (error) {
    throw error instanceof SessionIOError ? error.cause : error;
  }
}
