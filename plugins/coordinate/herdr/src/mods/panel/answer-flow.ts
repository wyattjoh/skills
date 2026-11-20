// Pure preference validation and navigation, without Herdr state or view dependencies.
export const FLOW_VARIATIONS = ["queue", "stepper", "stack", "list-detail", "focus"] as const;
export type FlowVariation = (typeof FLOW_VARIATIONS)[number];

export const storedFlowVariation = (value: unknown): FlowVariation =>
  FLOW_VARIATIONS.find((variation) => variation === value) ?? "queue";

export type AnswerFlow = {
  domain: string;
  ids: string[];
  current: number;
  answered: string[];
  skipped: string[];
};

export const startAnswerFlow = (domain: string, ids: string[], selected: string): AnswerFlow => ({
  domain,
  ids: [...ids],
  current: Math.max(0, ids.indexOf(selected)),
  answered: [],
  skipped: [],
});

// Visit the remaining questions in order after the selected question.
export const advanceAnswerFlow = (flow: AnswerFlow, result: "answered" | "skipped"): AnswerFlow => {
  const id = flow.ids[flow.current];
  if (id === undefined) return flow;
  const answered =
    result === "answered"
      ? [...new Set([...flow.answered, id])]
      : flow.answered.filter((candidate) => candidate !== id);
  const skipped =
    result === "skipped"
      ? [...new Set([...flow.skipped.filter((candidate) => candidate !== id), id])]
      : flow.skipped.filter((candidate) => candidate !== id);
  const isOpen = (candidate: string) =>
    !answered.includes(candidate) && !skipped.includes(candidate);
  const next = flow.ids.findIndex((candidate, index) => index > flow.current && isOpen(candidate));
  const wrapped = flow.ids.findIndex(isOpen);
  return {
    ...flow,
    answered,
    skipped,
    current: next >= 0 ? next : wrapped >= 0 ? wrapped : flow.ids.length,
  };
};
