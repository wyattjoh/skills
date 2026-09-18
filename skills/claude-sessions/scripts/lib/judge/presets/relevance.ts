import { noul, score } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { JudgePreset } from "../types.ts";

const questions = {
  relevance: score("How directly does this state answer the supplied query?", [
    "unrelated",
    "tangentially related",
    "partially answers",
    "directly answers",
  ]),
  concrete_example: noul("The state contains a concrete example."),
} satisfies Questions;

/**
 * TypeSafe preset for scoring a row's relevance to a caller-supplied query.
 */
export const relevancePreset: JudgePreset = {
  name: "relevance",
  questions,
  buildState: (row, context) => ({ query: context.query, row }),
};
