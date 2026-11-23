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
  /**
   * Whether the card is the active one, clamped to the viewport because its expanded height is
   * taller, so its body scrolls.
   */
  scrolls: boolean;
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

/**
 * A draft's own fields, kept with a queued answer so the question shows it again when revisited.
 */
export type QueuedDraft = {
  choice: string | undefined;
  discuss: boolean;
  text: string;
  note: string;
};

/**
 * An answer queued in the flow and not yet recorded. `key` is the draft key, which names the
 * domain, item and question, so an entry for a question that changed is recognisably stale.
 */
export type QueuedAnswer = {
  id: string;
  key: string;
  answer: string;
  note: string | undefined;
  draft: QueuedDraft;
};

/**
 * Start a flow at the selected question.
 * @param domain The domain whose questions the flow visits.
 * @param ids The open questions, in domain order.
 * @param selected The question to show first.
 * @param queued Questions that already have a queued answer, counted as answered in the flow.
 * @returns The flow.
 */
export const startAnswerFlow = (
  domain: string,
  ids: string[],
  selected: string,
  queued: readonly string[] = [],
): AnswerFlow => ({
  domain,
  ids: [...ids],
  current: Math.max(0, ids.indexOf(selected)),
  answered: ids.filter((id) => queued.includes(id)),
  skipped: [],
});

/**
 * Step to the next card without changing what is answered or skipped, as moving on from a question
 * that already has a queued answer does.
 * @param flow The flow.
 * @returns The flow on the next card, the summary after the last question.
 */
export const stepAnswerFlow = (flow: AnswerFlow): AnswerFlow => ({
  ...flow,
  current: Math.min(flow.current + 1, flow.ids.length),
});

/**
 * Queue an answer: a question answered again replaces its entry where it stands, a new one goes
 * last, so the queue keeps the order questions were first answered in.
 * @param queue The queue.
 * @param entry The answer to queue.
 * @returns The new queue.
 */
export const queueAnswer = (queue: readonly QueuedAnswer[], entry: QueuedAnswer): QueuedAnswer[] =>
  queue.some((queued) => queued.id === entry.id)
    ? queue.map((queued) => (queued.id === entry.id ? entry : queued))
    : [...queue, entry];

/**
 * Find the queued answers whose question is gone: the item vanished, its ask cleared, or it now
 * asks something else.
 * @param queue The queue.
 * @param liveKey The draft key of each id's open question now, undefined when it has none.
 * @returns The ids of the stale entries, in queue order.
 */
export const staleQueuedAnswers = (
  queue: readonly QueuedAnswer[],
  liveKey: (id: string) => string | undefined,
): string[] => queue.filter((entry) => liveKey(entry.id) !== entry.key).map((entry) => entry.id);

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
 * What the live backlog says about a queued question.
 */
export type FlowAskState = "open" | "cleared" | "missing";

/**
 * Drop the questions whose ask cleared outside the flow, so the stack never shows a card for
 * something already answered elsewhere. A question answered in this flow stays, because Back
 * returns to it. A missing item stays too: its card says the question is unavailable.
 * @param flow The flow to repair.
 * @param stateOf The live state of each queued id.
 * @param keep An id never to drop, such as the question being answered right now.
 * @returns The repaired flow, with the same current question when it survives and otherwise the
 * next open one, and the ids dropped. The flow itself, unchanged, when nothing was dropped.
 */
export const dropClearedQuestions = (
  flow: AnswerFlow,
  stateOf: (id: string) => FlowAskState,
  keep?: string,
): { flow: AnswerFlow; dropped: string[] } => {
  const dropped = flow.ids.filter(
    (id) => id !== keep && !flow.answered.includes(id) && stateOf(id) === "cleared",
  );
  if (dropped.length === 0) return { flow, dropped };
  const ids = flow.ids.filter((id) => !dropped.includes(id));
  const skipped = flow.skipped.filter((id) => !dropped.includes(id));
  const currentId = flow.ids[flow.current];
  const isOpen = (id: string) => !flow.answered.includes(id) && !skipped.includes(id);
  let current = ids.length;
  if (currentId !== undefined) {
    const kept = ids.indexOf(currentId);
    const after = flow.ids.slice(flow.current + 1).find((id) => ids.includes(id) && isOpen(id));
    const open = after ?? ids.find(isOpen);
    current = kept >= 0 ? kept : open === undefined ? ids.length : ids.indexOf(open);
  }
  return { flow: { ...flow, ids, skipped, current }, dropped };
};

/**
 * Place every queued card in one vertically ordered stack around a fixed focus-card center.
 * Neighbor cards use their measured compact height and a centered inset width; the active card
 * uses the focus width and its measured expanded height. Compact-card opacity follows viewport overlap
 * and distance, so visible cards fill the available height while offscreen cards fade at the edges.
 * Interpolating numeric endpoints together preserves the gap throughout a motion.
 * An active card taller than the viewport is pinned to its top at the viewport's height instead,
 * and marked to scroll, so a short window still reaches all of it.
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
  const scrolls = !options.exiting && cards[activeIndex]!.expandedHeight > options.viewportHeight;
  const heights = cards.map((card, index) =>
    !options.exiting && index === activeIndex
      ? scrolls
        ? options.viewportHeight
        : card.expandedHeight
      : card.compactHeight,
  );
  const tops = Array.from({ length: cards.length }, () => 0);
  tops[activeIndex] = scrolls ? 0 : (options.viewportHeight - heights[activeIndex]!) / 2;

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
      scrolls: scrolls && index === activeIndex,
    };
  });
};
