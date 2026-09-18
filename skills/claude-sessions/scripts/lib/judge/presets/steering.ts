import { choice, noul } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { JudgePreset } from "../types.ts";

const questions = {
  kind: choice("What kind of user steering is this interruption?", {
    correction: null,
    clarification: null,
    new_task: null,
    approval: null,
    abort: null,
  }),
  wrong_way: noul("The assistant was heading the wrong way when interrupted."),
} satisfies Questions;

/**
 * TypeSafe preset for classifying steering interruptions.
 */
export const steeringPreset: JudgePreset = {
  name: "steering",
  questions,
  buildState: (row) => row,
};
