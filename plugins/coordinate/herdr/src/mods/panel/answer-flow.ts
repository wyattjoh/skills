// Pure answer-flow navigation and carousel geometry, without Herdr state or view dependencies.

export type AnswerFlow = {
  domain: string;
  ids: string[];
  current: number;
  answered: string[];
  skipped: string[];
};

export type AnswerFlowLayoutCard = {
  id: string;
  compactHeight: number;
  expandedHeight: number;
};

export type AnswerFlowCardPlacement = {
  id: string;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  opacity: number;
  expanded: boolean;
};

export type AnswerFlowLayoutOptions = {
  activeIndex: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  compactWidthRatio: number;
  compactNeighborInset: number;
  neighborOpacity: number;
  distanceOpacityFalloff: number;
  exiting?: boolean;
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

/**
 * Place every queued card in one vertically ordered stack around a fixed focus-card center.
 * Neighbor cards use their measured compact height and a centered inset width; the active card
 * uses the focus width and its measured expanded height. Compact-card opacity follows viewport overlap
 * and distance, so visible cards fill the available height while offscreen cards fade at the edges.
 * Interpolating numeric endpoints together preserves the gap throughout a motion.
 * @param cards Every question card followed by the completion card.
 * @param options The focus index, viewport dimensions, stack gap, and compact-card appearance.
 * @returns Numeric top, left, width, height, and opacity targets in stable card order.
 */
export const layoutAnswerFlowCards = (
  cards: readonly AnswerFlowLayoutCard[],
  options: AnswerFlowLayoutOptions,
): AnswerFlowCardPlacement[] => {
  if (cards.length === 0) return [];

  const activeIndex = Math.max(0, Math.min(options.activeIndex, cards.length - 1));
  const focusWidth = options.viewportWidth * options.compactWidthRatio;
  const compactWidth = Math.max(1, focusWidth - 2 * options.compactNeighborInset);
  const heights = cards.map((card, index) =>
    !options.exiting && index === activeIndex ? card.expandedHeight : card.compactHeight,
  );
  const tops = Array.from({ length: cards.length }, () => 0);
  tops[activeIndex] = (options.viewportHeight - heights[activeIndex]!) / 2;

  for (let index = activeIndex + 1; index < cards.length; index += 1) {
    tops[index] = tops[index - 1]! + heights[index - 1]! + options.gap;
  }
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    tops[index] = tops[index + 1]! - options.gap - heights[index]!;
  }

  return cards.map((card, index) => {
    const expanded = !options.exiting && index === activeIndex;
    const width = expanded ? focusWidth : compactWidth;
    const distance = Math.abs(index - activeIndex);
    const visibleHeight = Math.max(
      0,
      Math.min(options.viewportHeight, tops[index]! + heights[index]!) - Math.max(0, tops[index]!),
    );
    const visibleFraction = heights[index]! > 0 ? visibleHeight / heights[index]! : 0;
    const distanceOpacity = Math.max(
      0,
      1 - Math.max(0, distance - 1) * options.distanceOpacityFalloff,
    );
    const opacity = options.exiting
      ? 0
      : distance === 0
        ? 1
        : options.neighborOpacity * distanceOpacity * visibleFraction;
    return {
      id: card.id,
      index,
      top: tops[index]!,
      left: (options.viewportWidth - width) / 2,
      width,
      height: heights[index]!,
      opacity,
      expanded,
    };
  });
};
