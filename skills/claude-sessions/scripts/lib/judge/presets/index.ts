import { errorResolvedPreset } from "./error-resolved.ts";
import { relevancePreset } from "./relevance.ts";
import { steeringPreset } from "./steering.ts";
import { taskKindPreset } from "./task-kind.ts";
import type { JudgePreset, JudgePresetName } from "../types.ts";

/**
 * All built-in judge presets keyed by their CLI name.
 */
export const presets: Readonly<Record<JudgePresetName, JudgePreset>> = {
  steering: steeringPreset,
  "error-resolved": errorResolvedPreset,
  "task-kind": taskKindPreset,
  relevance: relevancePreset,
};

/**
 * Look up a built-in preset by CLI name.
 *
 * @param name Preset name from --judge.
 * @returns The preset, or undefined for an unknown name.
 */
export function findPreset(name: string): JudgePreset | undefined {
  return Object.hasOwn(presets, name) ? presets[name as JudgePresetName] : undefined;
}
