import type { StateStore } from "./state-store.ts";
import { filesStore } from "./state-files.ts";

/**
 * The store that holds a state directory's shared documents. Files are the only backend so far;
 * the backend choice from config lands here.
 * @param stateDir Coordinate state directory.
 * @returns The store.
 */
export const stateStore = (stateDir: string): StateStore => filesStore(stateDir);
