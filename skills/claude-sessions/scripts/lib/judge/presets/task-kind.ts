import { choice, noul } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { JudgePreset } from "../types.ts";

const questions = {
  kind: choice("What kind of work is represented by this session?", {
    feature: null,
    bugfix: null,
    refactor: null,
    research: null,
    ops: null,
    docs: null,
    review: null,
    other: null,
  }),
  delegation_shaped: noul(
    "This work is delegation-shaped: repeatable, bounded, and could be an agent or skill.",
  ),
} satisfies Questions;

/**
 * TypeSafe preset for classifying the kind and delegation shape of a session.
 */
export const taskKindPreset: JudgePreset = {
  name: "task-kind",
  questions,
  buildState: (row) => row,
};
