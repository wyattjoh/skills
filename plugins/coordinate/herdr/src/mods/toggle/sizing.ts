import { PILL_SPACING, TOGGLE_END_INSET } from "./look.ts";

type Node = Record<string, unknown>;
const record = (value: unknown): Node | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Node)
    : undefined;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * One validated inline coordinate-toggle block with its current width, limits, and trailing inset.
 */
export type FitTarget = {
  id: string;
  current: number | undefined;
  min: number;
  max: number;
  inset: number;
};

/**
 * Per-View resize history used to deduplicate measurements and stop feedback loops.
 */
export type FitHistory = {
  fitted: { id: string; px: number } | undefined;
  requests: number[];
  stopped: boolean;
};

/**
 * Read the explicit block identity supplied to this mod copy.
 * @param props Untrusted Herdr props.
 * @returns A nonblank block id, or undefined when this copy has no identity.
 */
export const fitIdentity = (props: unknown): string | undefined => {
  const id = record(props)?.block;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
};

/**
 * Resolve this copy's unique inline row block and the inset appropriate to its position.
 * Floating blocks, pane-header copies, malformed trees, and ambiguous identities are refused.
 * @param tree The current Herdr layout.
 * @param props This copy's untrusted Herdr props.
 * @returns The matching target, or undefined when resizing is unsafe.
 */
export const fitTarget = (tree: unknown, props: unknown): FitTarget | undefined => {
  const propsRecord = record(props);
  const id = fitIdentity(propsRecord);
  if (id === undefined || propsRecord === undefined) return undefined;
  if (["overlay", "tab", "pane", "terminal"].some((key) => propsRecord[key] !== undefined))
    return undefined;

  let budget = 10_000;
  let invalid = false;
  const seen = new Set<Node>();
  const matches: { node: Node; inline: boolean; last: boolean }[] = [];
  const visit = (
    value: unknown,
    depth: number,
    inline: boolean,
    parentType: unknown,
    last: boolean,
  ): void => {
    if (invalid) return;
    const node = record(value);
    if (node === undefined || --budget < 0 || depth > 64 || seen.has(node)) {
      invalid = true;
      return;
    }
    seen.add(node);
    if (node.id === id) matches.push({ node, inline: inline && parentType === "row", last });
    if (node.type === "block") return;

    for (const field of ["children", "floating"] as const) {
      const children = node[field];
      if (children === undefined) continue;
      if (!Array.isArray(children)) {
        invalid = true;
        continue;
      }
      children.forEach((child: unknown, index: number) =>
        visit(
          child,
          depth + 1,
          inline && field !== "floating",
          node.type,
          index === children.length - 1,
        ),
      );
      if (invalid) return;
    }
  };
  visit(tree, 0, true, undefined, true);
  if (invalid || matches.length !== 1) return undefined;

  const match = matches[0]!;
  const node = match.node;
  const content = record(node.content);
  const contentProps = record(content?.props);
  if (
    !match.inline ||
    node.type !== "block" ||
    content?.mod !== "coordinate-toggle" ||
    fitIdentity(contentProps) !== id
  )
    return undefined;

  const min = node.min === undefined ? 0 : node.min;
  const max = node.max === undefined ? Infinity : node.max;
  if (
    typeof min !== "number" ||
    !Number.isFinite(min) ||
    min < 0 ||
    typeof max !== "number" ||
    (node.max !== undefined && !Number.isFinite(max)) ||
    max <= 0
  )
    return undefined;
  const roundedMin = Math.max(1, Math.ceil(min));
  const roundedMax = Math.floor(max);
  if (roundedMin > roundedMax) return undefined;

  const size = record(node.size);
  const px = size?.px;
  return {
    id,
    current: positive(px) ? px : undefined,
    min: roundedMin,
    max: roundedMax,
    inset: match.last ? TOGGLE_END_INSET : PILL_SPACING,
  };
};

/**
 * Choose the trailing inset from the current layout, falling back to the tab-bar edge inset.
 * @param tree The current Herdr layout.
 * @param props This copy's untrusted Herdr props.
 * @returns Inter-pill spacing, or the tab-bar edge inset if the target is unknown.
 */
export const fitInset = (tree: unknown, props: unknown): number =>
  fitTarget(tree, props)?.inset ?? TOGGLE_END_INSET;

/**
 * Add the outside inset to an intrinsic logical-pixel measurement and round up once.
 * @param width Measured pill wrapper width in logical pixels.
 * @param inset The outside spacing after the pill.
 * @returns A positive whole-pixel block width, or undefined for an invalid value.
 */
export const fitWidth = (width: number, inset: number): number | undefined => {
  if (!positive(width) || !Number.isFinite(inset) || inset < 0) return undefined;
  const px = Math.ceil(width + inset);
  return positive(px) ? px : undefined;
};

/**
 * Clamp and deduplicate a resize request, with a per-copy guard against repeated layout feedback.
 * @param history This View's previous requests.
 * @param target The live target revalidated before resize.
 * @param wanted Measured width including its outside inset.
 * @param now Current time in milliseconds.
 * @returns Updated history and a request only when a resize should be sent.
 */
export const fitRequest = (
  history: FitHistory,
  target: FitTarget,
  wanted: number,
  now: number,
): { history: FitHistory; request: { id: string; px: number } | undefined } => {
  if (history.stopped || !positive(wanted) || !Number.isFinite(now))
    return { history, request: undefined };
  const px = Math.min(target.max, Math.max(target.min, Math.ceil(wanted)));
  if (
    !positive(px) ||
    px === target.current ||
    (history.fitted?.id === target.id && history.fitted.px === px)
  )
    return { history, request: undefined };

  const requests = history.requests.filter((at) => now - at < 1000);
  if (requests.length >= 8)
    return { history: { ...history, requests, stopped: true }, request: undefined };
  const request = { id: target.id, px };
  return {
    history: { fitted: request, requests: [...requests, now], stopped: false },
    request,
  };
};
