import { choice, noul } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { JudgePreset } from "../types.ts";

const questions = {
  resolved: noul("The following turns resolved this error."),
  kind: choice("How was the error resolved?", {
    code_fix: null,
    env_fix: null,
    retry: null,
    workaround: null,
    unresolved: null,
  }),
} satisfies Questions;

/**
 * TypeSafe preset for classifying whether and how an error was resolved.
 */
export const errorResolvedPreset: JudgePreset = {
  name: "error-resolved",
  questions,
  buildState: (row) => row,
};
