import { beforeEach, expect, mock, test } from "bun:test";
import { Input, InputState } from "gpui-base";
import {
  addFinding,
  addItem,
  closeFinding,
  closeItem,
  emptyBacklog,
  updateItem,
} from "../../lib/store.ts";
import type { Backlog, Item } from "../../lib/store.ts";
import {
  context,
  get,
  host,
  ids,
  resetHost,
  settle,
  text,
  typeInto,
  useRenderer,
} from "@wyattjoh/herdr-dev/test/renderer";
import type { Node } from "@wyattjoh/herdr-dev/test/renderer";
import { CARD, HERDR_ICONS, PANEL } from "@wyattjoh/herdr-ui";
import {
  ANSWER_CAROUSEL,
  ANSWER_FLOW_SPEED_OPTIONS,
  ANSWER_FLOW_OUTLINE,
  HARNESS_DIALOG,
} from "./look.ts";
const { setAnswerTextareaTestApi } = await import("./textarea.ts");
let textareaAutoGrow: { minRows: number; maxRows: number } | undefined;
setAnswerTextareaTestApi({
  createState: (options) =>
    Object.assign(InputState.new(options), {
      set_auto_grow: (minRows: number, maxRows: number) => {
        textareaAutoGrow = { minRows, maxRows };
      },
    }),
  render: (state) => Input.new(state as ReturnType<typeof InputState.new>),
});
// The shared renderer's herdr mock has no overlays, so record them through the overlay module.
const overlays: { spec: unknown; id: string }[] = [];
const closedOverlays: string[] = [];
mock.module("./overlay.ts", () => ({
  openOverlay: (spec: unknown) => {
    const id = `overlay-${overlays.length + 1}`;
    overlays.push({ spec, id });
    return id;
  },
  closeOverlay: (id: string) => {
    closedOverlays.push(id);
    return null;
  },
}));
const { theme } = await import("herdr");
const { default: Panel } = await import("./index.ts");
const {
  LIST_SCRIPT,
  changedHarnessPolicy,
  policyDialogSpec,
  harnessPolicyFailure,
  harnessPolicyOutput,
  harnessPolicyResetCommand,
  harnessPolicySetCommand,
  harnessPolicyShowCommand,
} = await import("./model.ts");

const STATE = "/Users/test/.local/state/coordinate";
const DOC = `${STATE}/backlogs/alpha.json`;
const NOW = "2026-11-17T12:00:00.000Z";
type PolicySelection = { enabled: ("pi" | "claude")[]; default: "pi" | "claude" | null };
const LEGACY_POLICY: PolicySelection = { enabled: ["pi", "claude"], default: null };

const policyOutput = (
  options: {
    revision?: number;
    global?: PolicySelection;
    source?: "legacy" | "configured";
    domain?: string;
    mode?: "inherit" | "replace";
    override?: PolicySelection | null;
  } = {},
): string => {
  const global = options.global ?? LEGACY_POLICY;
  const mode = options.mode ?? "inherit";
  const override = options.override ?? null;
  const domain =
    options.domain === undefined
      ? null
      : {
          name: options.domain,
          mode,
          override,
          effective: mode === "replace" && override !== null ? override : global,
        };
  return JSON.stringify({
    schemaVersion: 1,
    revision: options.revision ?? 1,
    path: `${STATE}/delegate-harness-policy.json`,
    global: { source: options.source ?? "legacy", policy: global },
    domain,
  });
};

const setPolicyOutput = (stdout: string, code = 0, stderr = "") => {
  const result = { code, stderr, stdout };
  host.execExit = result;
};

const latestWatch = (path: string) => host.watches.filter((watch) => watch.path === path).at(-1);
const backlogWatch = () => latestWatch(`${STATE}/backlogs`);
const policyWatch = () => latestWatch(STATE);

beforeEach(() => {
  resetHost();
  useRenderer({});
  overlays.length = 0;
  closedOverlays.length = 0;
  textareaAutoGrow = undefined;
});

// A coordinator terminal labelled with its domain, focused.
const focusDomain = (domain: string) => {
  host.terminals = [
    {
      address: "t1",
      state: "live",
      labels: { "fleet.role": "coordinator", "fleet.domain": domain },
    },
  ];
  host.focused = { space: "s1", tab: "tab1", pane: "p1", terminal: "t1" };
};

const add = (backlog: Backlog, title: string, patch: Partial<Item> = {}): Backlog => {
  const added = addItem(backlog, { title, now: NOW });
  if (!added.ok) throw new Error(added.reason);
  const id = added.value.id;
  return {
    ...added.backlog,
    items: added.backlog.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
};

const close = (backlog: Backlog, id: string, dismissed: boolean): Backlog => {
  const closed = closeItem(backlog, { id, outcome: "wrapped up", dismissed, now: NOW });
  if (!closed.ok) throw new Error(closed.reason);
  return closed.backlog;
};

const recordAnswer = (backlog: Backlog, id: string, answer: string): Backlog => {
  const updated = updateItem(backlog, {
    id,
    status: undefined,
    outcome: undefined,
    decided: [],
    touch: [],
    untouch: [],
    due: undefined,
    ask: undefined,
    context: undefined,
    options: [],
    rec: undefined,
    why: undefined,
    answer,
    now: NOW,
  });
  if (!updated.ok) throw new Error(updated.reason);
  return updated.backlog;
};

// One item in every status: i1 waiting-user, i2 building, i3 delegated, i4 and i5 open,
// i6 parked, i7 done, i8 dismissed.
const everyStatus = (): Backlog => {
  let backlog: Backlog = { ...emptyBacklog("alpha", null), focus: "Ship the panel tracer" };
  backlog = add(backlog, "Pick a name", {
    status: "waiting-user",
    ask: {
      question: "Which name?",
      context: null,
      options: ["a", "b"],
      rec: "a",
      recReason: "shorter",
      discuss: null,
    },
  });
  backlog = add(backlog, "Build the store", { status: "building" });
  backlog = add(backlog, "Write the panel", {
    status: "delegated",
    delegates: [
      {
        name: "impl",
        session: "s-1",
        branch: null,
        worktree: null,
        brief: "/b.md",
        report: "/r.md",
      },
    ],
  });
  backlog = add(backlog, "Sketch the toggle");
  backlog = add(backlog, "Sketch the listing");
  backlog = add(backlog, "Retention", { status: "parked" });
  backlog = add(backlog, "Old work");
  backlog = add(backlog, "Abandoned work");
  backlog = close(backlog, "i7", false);
  return close(backlog, "i8", true);
};

const find = (
  backlog: Backlog,
  kind: "issue" | "opportunity",
  title: string,
  from: string | undefined = undefined,
): Backlog => {
  const added = addFinding(backlog, { kind, title, detail: undefined, path: undefined, from });
  if (!added.ok) throw new Error(added.reason);
  return added.backlog;
};

// Open findings f2 (issue) and f3 (opportunity, from i1), and f4, an issue already acted on.
const withFindings = (): Backlog => {
  let backlog = add(emptyBacklog("alpha", null), "Base work");
  backlog = find(backlog, "issue", "Flaky watcher test");
  backlog = find(backlog, "opportunity", "Share the validator", "i1");
  backlog = find(backlog, "issue", "Old crash");
  const closed = closeFinding(backlog, { id: "f4", outcome: "fixed", dismissed: false, now: NOW });
  if (!closed.ok) throw new Error(closed.reason);
  return closed.backlog;
};

// The home glyph stands in for the SVG the renderer records without drawing.
const trail = (root: Node) =>
  get(root, "breadcrumb")
    .children.map((child, index) => {
      if (index % 2 === 1) return " › ";
      if (typeof child === "string") return child;
      return child.styles.id === "crumb-home" ? "⌂" : text(child);
    })
    .join("");

// Press a crumb or a page row by its id.
const press = (root: Node, id: string, cx: unknown) => get(root, id).click!({}, cx);
const openPage = (root: Node, page: string, cx: unknown) =>
  get(root, `page-${page}`).click!({}, cx);

const mount = async (preservePolicyReads = false) => {
  const ctx = context();
  const focusHandles: Array<{
    focused: boolean;
    focus: () => void;
    is_focused: () => boolean;
    release: () => boolean;
  }> = [];
  Object.assign(ctx.cx, {
    focus_handle: () => {
      const handle = {
        focused: false,
        focus: () => {
          for (const candidate of focusHandles) candidate.focused = false;
          handle.focused = true;
        },
        is_focused: () => handle.focused,
        release: () => true,
      };
      focusHandles.push(handle);
      return handle;
    },
  });
  const timer = (
    ctx.cx as unknown as {
      timer: {
        after: (
          ms: number,
          handler: (cx: unknown) => void,
        ) => { cancel: () => void; is_done: () => boolean };
      };
    }
  ).timer;
  timer.after = (ms, handler) => {
    const pending = { ms, cancelled: false, handler: (_cx: unknown) => {} };
    pending.handler = (tick) => {
      pending.cancelled = true;
      handler(tick);
    };
    ctx.timers.push(pending);
    return {
      cancel: () => {
        pending.cancelled = true;
      },
      is_done: () => pending.cancelled,
    };
  };
  const view = new Panel();
  view.init(undefined, ctx.cx as never);
  await settle();
  if (!preservePolicyReads)
    host.execs.splice(
      0,
      host.execs.length,
      ...host.execs.filter(({ args }) => args[args.indexOf("harness-policy") + 1] !== "show"),
    );
  return { ctx, view, focusHandles, render: () => view.render(ctx.cx as never) as never };
};

const reportSize = (root: Node, id: string, cx: unknown, height: number, width = 360) => {
  const onSizeChange = get(root, id).styles.on_size_change;
  if (typeof onSizeChange !== "function") throw new Error(`${id} has no size callback`);
  onSizeChange({ width, height }, cx);
};

const measureFlow = (
  root: Node,
  cx: unknown,
  render: () => Node,
  items: { id: string; expandedHeight: number }[],
  viewportHeight = 600,
  viewportWidth = 360,
) => {
  reportSize(root, "answer-flow-track", cx, viewportHeight, viewportWidth);
  const measuredRoot = render();
  const expandedWidth = viewportWidth * ANSWER_CAROUSEL.compactWidthRatio;
  const compactWidth = Math.max(1, expandedWidth - 2 * PANEL.padding);
  const measurementId = (kind: "compact" | "expanded", id: string) => {
    const match = ids(measuredRoot, "answer-flow-measure-").find((candidate) =>
      candidate.endsWith(`-${kind}-${id}`),
    );
    if (match === undefined) throw new Error(`No ${kind} measurement for ${id}`);
    return match;
  };
  for (const item of items) {
    reportSize(measuredRoot, measurementId("compact", item.id), cx, 72, compactWidth);
    reportSize(
      measuredRoot,
      measurementId("expanded", item.id),
      cx,
      item.expandedHeight,
      expandedWidth,
    );
  }
  reportSize(measuredRoot, measurementId("compact", "done"), cx, 72, compactWidth);
  reportSize(measuredRoot, measurementId("expanded", "done"), cx, 120, expandedWidth);
  return render();
};

const openDetail = (view: InstanceType<typeof Panel>, id: string, cx: unknown) => {
  if (view.doc.kind !== "loaded") throw new Error("domain document is not loaded");
  const item = view.doc.backlog.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`missing item ${id}`);
  view.open(item, cx as never);
};

test("renders the Files-style toolbar header", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { render } = await mount();
  const root = render();
  const container = get(root, "coordinate-panel");
  const header = get(root, "toolbar");
  const brand = header.children[0] as Node;
  const spacer = header.children[1] as Node;

  expect([container.styles.text_color, container.styles.text_size]).toEqual(["#f5f5f5", 13]);
  expect(header.styles).toEqual({
    id: "toolbar",
    h: 42,
    flex_none: true,
    px: 14,
    gap: 8,
    items_center: true,
    border_b: 1,
    border_color: "#525252",
  });
  expect(header.children).toHaveLength(3);
  expect([text(brand), brand.styles]).toEqual(["Backlog", { font_semibold: true }]);
  expect([text(spacer), spacer.styles]).toEqual(["", { flex_1: true }]);
  expect(ids(header, "harness-policy-")).toEqual(["harness-policy-open"]);
});

test("uses a multiline textarea configured to grow through 100 rows", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  expect(textareaAutoGrow).toEqual({ minRows: 1, maxRows: 100 });
  get(render(), "item-i1").click!({}, ctx.cx);
  const root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);
  expect(get(root, "answer-flow-ask-i1-answer-field")).toBeDefined();
});

test("separates asked items from status groups and keeps each item row unique", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "focus"))).toBe("Ship the panel tracer");
  expect(text(get(root, "focus-header"))).toBe("Focus");
  expect(ids(root, "focus-card")).toEqual(["focus-card"]);
  expect(ids(root, "waiting-header")).toEqual(["waiting-header"]);
  expect(
    ids(root, "")
      .filter((id) => id.endsWith("-header"))
      .slice(0, 2),
  ).toEqual(["focus-header", "waiting-header"]);
  expect(ids(get(root, "waiting"), "item-")).toEqual(["item-i1"]);
  expect(ids(get(root, "items"), "item-")).toEqual([
    "item-i2",
    "item-i3",
    "item-i4",
    "item-i5",
    "item-i6",
    "item-i7",
    "item-i8",
  ]);
  expect(ids(root, "group-")).toEqual([
    "group-building",
    "group-building-toggle",
    "group-delegated",
    "group-delegated-toggle",
    "group-open",
    "group-open-toggle",
    "group-parked",
    "group-parked-toggle",
    "group-done",
    "group-done-toggle",
    "group-dismissed",
    "group-dismissed-toggle",
  ]);
  expect(text(get(root, "group-open-toggle"))).toBe("Open 2");
  expect(text(get(root, "group-done-toggle"))).toBe("Done 1");
  expect(ids(root, "item-")).toEqual([
    "item-i1",
    "item-i2",
    "item-i3",
    "item-i4",
    "item-i5",
    "item-i6",
    "item-i7",
    "item-i8",
  ]);
});

test("hides the Waiting on you card when no items have open asks", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(recordAnswer(everyStatus(), "i1", "Coordinate backlog")));
  const { render } = await mount();
  const root = render();
  expect(ids(root, "waiting-header")).toEqual([]);
  expect(text(get(root, "group-waiting-user-toggle"))).toBe("Answered, waiting for coordinator 1");
  expect(ids(root, "item-")).toEqual([
    "item-i1",
    "item-i2",
    "item-i3",
    "item-i4",
    "item-i5",
    "item-i6",
    "item-i7",
    "item-i8",
  ]);
});

test("Waiting on you rows use a pulsing accent bar", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "waiting-header"))).toBe("Waiting on you");
  expect(get(root, "waiting-accent-i1").styles.opacity).toBe(0.4);
  expect(get(root, "waiting-accent-i1").styles.loop).toEqual([
    "opacity",
    { from: 0.4, to: 1, period: 1_100 },
  ]);
});

test("answer-flow cards share an item header while the body expands beneath it", async () => {
  focusDomain("alpha");
  const title = "A long answer-flow item title that needs the entire card width to wrap naturally";
  const backlog = withManyAsks(2);
  host.files.set(
    DOC,
    JSON.stringify({
      ...backlog,
      items: backlog.items.map((item) =>
        item.id === "i1" && item.ask !== null
          ? {
              ...item,
              title,
              ask: { ...item.ask, context: "Additional details for the question." },
            }
          : item,
      ),
    }),
  );
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 300 },
    { id: "i2", expandedHeight: 176 },
  ]);
  const panelRoot = get(root, "coordinate-panel");
  const header = get(root, "answer-flow-header-i1");
  const compactHeader = get(root, "answer-flow-header-i2");
  const measuredCompactHeader = get(root, "answer-flow-measure-compact-i1-preview-header");
  const measuredExpandedHeader = get(root, "answer-flow-measure-expanded-i1-content-header");
  const panelChildren = panelRoot.children.map((child) =>
    typeof child === "string" ? child : (child as Node).styles.id,
  );

  expect(panelChildren).toEqual(["toolbar", "breadcrumb", "panel-body"]);
  expect(ids(root, "answer-flow-item-title")).toEqual([]);
  expect(get(root, "panel-body").styles.p).toBe(PANEL.padding);
  expect(header.children.map((child) => text(child as Node))).toEqual(["i1", title]);
  expect(compactHeader.children.map((child) => text(child as Node))).toEqual(["i2", "Question 2"]);
  expect(header.children[1]!.styles).toMatchObject({ flex_1: true, min_w_0: true });
  expect(header.children[1]!.styles.truncate).toBe(undefined);
  expect([header.styles.px, header.styles.py, header.styles.gap, header.styles.border_b]).toEqual([
    compactHeader.styles.px,
    compactHeader.styles.py,
    compactHeader.styles.gap,
    compactHeader.styles.border_b,
  ]);
  expect(header.styles).toMatchObject({ px: CARD.paddingX, border_b: 1 });
  expect(measuredCompactHeader.children.map((child) => text(child as Node))).toEqual(["i1", title]);
  expect(measuredExpandedHeader.children.map((child) => text(child as Node))).toEqual([
    "i1",
    title,
  ]);
  expect(
    get(root, "answer-flow-card-i1").children.map((child) =>
      typeof child === "string" ? child : (child as Node).styles.id,
    ),
  ).toEqual(["answer-flow-header-i1", "answer-flow-body-i1"]);
  expect(
    get(root, "answer-flow-body-i1").children.map((child) =>
      typeof child === "string" ? child : (child as Node).styles.id,
    ),
  ).toEqual(["answer-flow-compact-layer-i1", "answer-flow-expanded-layer-i1"]);
  expect(text(get(root, "answer-flow-ask-i1-question"))).toBe("Question 1?");
  expect(text(get(root, "answer-flow-ask-i1-context"))).toBe(
    "Additional details for the question.",
  );
  const questionBlock = get(root, "answer-flow-ask-i1-question-block");
  expect(questionBlock.styles).toMatchObject({
    bg: "#292929",
    rounded: CARD.innerRadius,
    px: CARD.paddingX,
    py: CARD.paddingY,
    min_w_0: true,
  });
  expect(questionBlock.children.map((child) => (child as Node).styles.id)).toEqual([
    "answer-flow-ask-i1-question",
    "answer-flow-ask-i1-context",
  ]);
  expect(get(root, "answer-flow-ask-i1-question").styles).toMatchObject({
    font_medium: true,
    text_color: "#f5f5f5",
  });
  expect(get(root, "answer-flow-ask-i1-context").styles).toMatchObject({
    text_color: "#a3a3a3",
    min_w_0: true,
  });
  expect(get(root, "answer-flow-ask-i1-question").styles.bg).toBe(undefined);
  expect(get(root, "answer-flow-ask-i1-context").styles.bg).toBe(undefined);
  expect(ids(questionBlock, "answer-flow-ask-i1-option-")).toEqual([]);
  expect(ids(questionBlock, "answer-flow-ask-i1-rec-reason")).toEqual([]);
  expect(text(get(root, "answer-flow-preview-i2-question"))).toBe("Question 2?");
  expect(get(root, "answer-flow-measure-compact-i1").styles.w).toBe(300);
  expect(get(root, "answer-flow-measure-expanded-i1").styles.w).toBe(324);

  reportSize(root, "answer-flow-measure-compact-i1", ctx.cx, 96, 300);
  reportSize(root, "answer-flow-measure-expanded-i1", ctx.cx, 300, 324);
  root = render();
  expect(get(root, "answer-flow-card-i1").styles.h).toBe(300);
  expect(view.answerFlowCardMeasurement("alpha", "i1", "compact")).toEqual({
    width: 300,
    height: 96,
  });
  expect(view.answerFlowCardMeasurement("alpha", "i1", "expanded")).toEqual({
    width: 324,
    height: 300,
  });
});

test("compact previews are centered around the focus at narrow and wide widths", async () => {
  focusDomain("alpha");
  const backlog = withManyAsks(5);
  host.files.set(
    DOC,
    JSON.stringify({
      ...backlog,
      items: backlog.items.map((item) =>
        item.id === "i2"
          ? { ...item, title: "A preview title that wraps at the narrow measured card width" }
          : item,
      ),
    }),
  );
  const { ctx, view, render } = await mount();
  get(render(), "item-i3").click!({}, ctx.cx);
  let root = render();
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `i${index + 1}`,
    expandedHeight: 200,
  }));

  for (const viewportWidth of [280, 640]) {
    root = measureFlow(root, ctx.cx, render, items, 600, viewportWidth);
    const focusWidth = viewportWidth * ANSWER_CAROUSEL.compactWidthRatio;
    const previewWidth = focusWidth - 2 * PANEL.padding;
    const compactTitleHeight = viewportWidth < 400 ? 96 : 72;
    reportSize(root, "answer-flow-measure-compact-i2", ctx.cx, compactTitleHeight, previewWidth);
    root = render();
    const focusLeft = (viewportWidth - focusWidth) / 2;
    const previewLeft = (viewportWidth - previewWidth) / 2;
    const checkPlacement = (focusId: string, previousId: string, nextId: string) => {
      const focus = get(root, `answer-flow-card-${focusId}`).styles;
      const neighbors = [
        get(root, `answer-flow-card-${previousId}`).styles,
        get(root, `answer-flow-card-${nextId}`).styles,
      ];
      expect([focus.left, focus.w, focus.opacity]).toEqual([focusLeft, focusWidth, 1]);
      expect(neighbors.map(({ left, w, opacity }) => ({ left, w, opacity }))).toEqual([
        { left: previewLeft, w: previewWidth, opacity: 0.58 },
        { left: previewLeft, w: previewWidth, opacity: 0.58 },
      ]);
      expect(neighbors.map(({ left, w }) => left + w / 2)).toEqual([
        viewportWidth / 2,
        viewportWidth / 2,
      ]);
    };

    checkPlacement("i3", "i2", "i4");
    expect(get(root, "answer-flow-measure-compact-i2").styles.w).toBe(previewWidth);
    expect(get(root, "answer-flow-measure-expanded-i2").styles.w).toBe(focusWidth);
    expect(view.answerFlowCardMeasurement("alpha", "i2", "compact")).toEqual({
      width: previewWidth,
      height: compactTitleHeight,
    });
    expect(
      get(root, "answer-flow-card-i2").styles.top +
        get(root, "answer-flow-card-i2").styles.h +
        ANSWER_CAROUSEL.gap,
    ).toBe(get(root, "answer-flow-card-i3").styles.top);

    get(root, "answer-flow-card-i4").click!({}, ctx.cx);
    root = render();
    checkPlacement("i4", "i3", "i5");
    expect(get(root, "answer-flow-header-i4").children.map((child) => text(child as Node))).toEqual(
      ["i4", "Question 4"],
    );
    ctx.tick(600);
    root = render();
    get(root, "answer-flow-card-i3").click!({}, ctx.cx);
    root = render();
    checkPlacement("i3", "i2", "i4");
    ctx.tick(600);
    root = render();
  }
});

test("the carousel keeps every question mounted and moves the stack in one fixed-center transition", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withManyAsks(5, "fits this choice")));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = render();
  const cardIds = ["i1", "i2", "i3", "i4", "i5"];
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 5");
  expect(ids(root, "answer-flow-card-i")).toEqual([]);
  root = measureFlow(
    root,
    ctx.cx,
    render,
    cardIds.map((id, index) => ({ id, expandedHeight: [248, 176, 180, 200, 220][index]! })),
  );
  expect(ids(root, "answer-flow-card-i")).toEqual(cardIds.map((id) => `answer-flow-card-${id}`));
  expect(ids(root, "answer-flow-compact-layer-")).toEqual([
    ...cardIds.map((id) => `answer-flow-compact-layer-${id}`),
    "answer-flow-compact-layer-done",
  ]);
  expect(ids(root, "answer-flow-expanded-layer-")).toEqual([
    ...cardIds.map((id) => `answer-flow-expanded-layer-${id}`),
    "answer-flow-expanded-layer-done",
  ]);
  expect(text(get(root, "answer-flow-ask-i1-question"))).toBe("Question 1?");
  expect(text(get(root, "answer-flow-ask-i1-rec-reason"))).toBe("Why recommended fits this choice");
  expect(get(root, "answer-flow-ask-i1-rec-reason").styles).toMatchObject({
    bg: "#292929",
    rounded: CARD.innerRadius,
    px: CARD.paddingX,
    py: CARD.paddingY,
    min_w_0: true,
  });
  expect(ANSWER_CAROUSEL.transitionDuration).toBe(600);
  expect(ANSWER_CAROUSEL.easing).toBe("ease-in-out");
  expect(get(root, "answer-flow-card-i1").styles).toMatchObject({
    left: 18,
    top: 176,
    w: 324,
    h: 248,
    opacity: 1,
  });
  expect(get(root, "answer-flow-card-i2").styles).toMatchObject({
    left: 30,
    top: 434,
    w: 300,
    h: 72,
    opacity: 0.58,
  });
  expect(get(root, "answer-flow-card-i4").styles.opacity).toBeCloseTo(0.58 * (2 / 72));
  expect(get(root, "answer-flow-card-i5").styles.opacity).toBe(0);
  expect(get(root, "answer-flow-expanded-layer-i1").styles).toMatchObject({
    w_full: true,
    opacity: 1,
  });
  expect(get(root, "answer-flow-expanded-layer-i1").styles.top).toBe(undefined);
  expect(get(root, "answer-flow-card-done")).toBeDefined();

  const queue = get(root, "answer-flow-queue-page");
  expect(
    queue.children.map((child) => (typeof child === "string" ? child : (child as Node).styles.id)),
  ).toEqual(["answer-flow-header-alpha", "answer-flow-carousel"]);
  expect(ids(root, "answer-flow-footer")).toEqual([]);
  expect(ids(root, "answer-flow-back")).toEqual([]);
  expect(ids(root, "answer-flow-skip")).toEqual([]);
  expect(text(get(root, "answer-flow-speed-trigger"))).toBe("Speed: Normal");
  expect(typeof get(root, "answer-flow-card-i2").click).toBe("function");
  expect(get(root, "answer-flow-card-i1").click).toBe(undefined);

  const beforeTops = cardIds.map((id) => get(root, `answer-flow-card-${id}`).styles.top);
  get(root, "answer-flow-card-i2").click!({}, ctx.cx);
  root = render();
  const targetTops = cardIds.map((id) => get(root, `answer-flow-card-${id}`).styles.top);
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 5");
  expect(get(root, "answer-flow-header-i1").children.map((child) => text(child as Node))).toEqual([
    "i1",
    "Question 1",
  ]);
  expect(get(root, "answer-flow-header-i2").children.map((child) => text(child as Node))).toEqual([
    "i2",
    "Question 2",
  ]);
  expect(ids(root, "answer-flow-item-title")).toEqual([]);
  expect(
    get(root, "answer-flow-card-i2").children.map((child) =>
      typeof child === "string" ? child : (child as Node).styles.id,
    ),
  ).toEqual(["answer-flow-header-i2", "answer-flow-body-i2"]);
  expect(beforeTops).toEqual([176, 434, 516, 598, 680]);
  expect(targetTops).toEqual([130, 212, 398, 480, 562]);
  expect(targetTops.every((top, index) => top !== beforeTops[index])).toBe(true);
  expect(ctx.timers.at(-1)?.ms).toBe(600);
  expect(get(root, "answer-flow-card-i1").styles).toMatchObject({
    left: 30,
    top: 130,
    w: 300,
    h: 72,
    opacity: 0.58,
    transition: ["opacity", { duration: 600, easing: "ease-in-out" }],
  });
  expect(get(root, "answer-flow-card-i2").styles).toMatchObject({
    left: 18,
    top: 212,
    w: 324,
    h: 176,
    opacity: 1,
  });
  expect(get(root, "answer-flow-compact-layer-i1").styles.opacity).toBe(1);
  expect(get(root, "answer-flow-expanded-layer-i1").styles.opacity).toBe(0);
  expect(get(root, "answer-flow-compact-layer-i2").styles.opacity).toBe(0);
  expect(get(root, "answer-flow-card-i1").styles).toMatchObject({ left: 30, w: 300 });
  expect(get(root, "answer-flow-expanded-layer-i1").styles).toMatchObject({
    w_full: true,
    opacity: 0,
  });
  expect(get(root, "answer-flow-expanded-layer-i1").styles.top).toBe(undefined);
  expect(get(root, "answer-flow-expanded-layer-i2").styles).toMatchObject({
    w_full: true,
    opacity: 1,
    transition: ["opacity", { duration: 180, delay: 420, easing: "ease-in-out" }],
  });
  expect(get(root, "answer-flow-expanded-layer-i2").styles.top).toBe(undefined);
  expect(get(root, "answer-flow-compact-layer-i1").styles).toMatchObject({
    top: 0,
    left: 0,
    w_full: true,
  });
  expect(get(root, "answer-flow-compact-layer-i1").styles.transition).toEqual([
    "opacity",
    { duration: 270, delay: 150, easing: "ease-out" },
  ]);
  expect(get(root, "answer-flow-expanded-layer-i1").styles.transition).toEqual([
    "opacity",
    { duration: 180, easing: "ease-in" },
  ]);
  expect(get(root, "answer-flow-compact-layer-i2").styles.transition).toEqual([
    "opacity",
    { duration: 480, easing: "ease-in" },
  ]);
  expect(get(root, "answer-flow-preview-i2").styles).toMatchObject({ py: 8 });
  expect(get(root, "answer-flow-preview-i2").styles.justify_center).toBe(undefined);
  expect(typeof get(root, "answer-flow-speed-trigger").click).toBe("function");
  ctx.tick(599);
  expect(text(get(render(), "answer-flow-progress"))).toBe("Question 1 of 5");
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 5");
  expect(cardIds.map((id) => get(root, `answer-flow-card-${id}`).styles.top)).toEqual(targetTops);

  get(root, "answer-flow-card-i1").click!({}, ctx.cx);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 5");
  expect(ctx.timers.at(-1)?.ms).toBe(600);
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 5");

  get(root, "answer-flow-card-i2").click!({}, ctx.cx);
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 5");
  get(root, "answer-flow-card-i1").click!({}, ctx.cx);
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 5");
  expect(trail(root)).toBe("⌂ › alpha › Questions");
  press(root, "crumb-domain-alpha", ctx.cx);
  root = render();
  expect(ids(root, "screen-answer-flow")).toEqual([]);
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
});

test("Slow 5 scales one whole transition and remains live during motion", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);
  const toggle = get(root, "answer-flow-speed-trigger");
  expect(text(toggle)).toBe("Speed: Normal");
  toggle.click!({}, ctx.cx);
  root = render();
  get(root, "answer-flow-speed-option-slow-5").click!({}, ctx.cx);
  root = render();
  expect(view.answerFlowSpeed).toBe(5);
  get(root, "answer-flow-card-i2").click!({}, ctx.cx);
  root = render();
  expect([
    ctx.timers.at(-1)?.ms,
    get(root, "answer-flow-card-i1").styles.transition,
    get(root, "answer-flow-expanded-layer-i2").styles.transition,
    get(root, "answer-flow-compact-layer-i2").styles.transition,
    text(get(root, "answer-flow-speed-trigger")),
  ]).toEqual([
    3_000,
    ["opacity", { duration: 3_000, easing: "ease-in-out" }],
    ["opacity", { duration: 900, delay: 2_100, easing: "ease-in-out" }],
    ["opacity", { duration: 2_400, easing: "ease-in" }],
    "Speed: Slow 5",
  ]);

  expect(view.answerFlowSpeed).toBe(5);
  expect(ctx.timers.at(-1)?.ms).toBe(3_000);
  get(root, "answer-flow-speed-trigger").click!({}, ctx.cx);
  root = render();
  get(root, "answer-flow-speed-option-normal").click!({}, ctx.cx);
  root = render();
  expect([
    view.answerFlowSpeed,
    ctx.timers.at(-1)?.ms,
    get(root, "answer-flow-card-i1").styles.transition,
  ]).toEqual([0, 3_000, ["opacity", { duration: 3_000, easing: "ease-in-out" }]]);
  ctx.tick(2_999);
  expect(text(get(render(), "answer-flow-progress"))).toBe("Question 1 of 2");
  ctx.tick(3_000);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");
  get(root, "answer-flow-card-done").click!({}, ctx.cx);
  root = render();
  expect(ctx.timers.at(-1)?.ms).toBe(600);
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Done");
  expect(ids(root, "answer-flow-footer")).toEqual([]);
});

test("offers eleven named speeds and keeps menu focus and drafts intact", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(
    render(),
    ctx.cx,
    render,
    [
      { id: "i1", expandedHeight: 248 },
      { id: "i2", expandedHeight: 176 },
    ],
    220,
    280,
  );
  get(root, "answer-flow-ask-i1-option-0").click!({}, ctx.cx);
  root = render();

  expect(
    ANSWER_FLOW_SPEED_OPTIONS.map(({ name, durationFactor }) => [name, durationFactor]),
  ).toEqual([
    ["Normal", 1],
    ["Slow 1", 1.25],
    ["Slow 2", 1.5],
    ["Slow 3", 2],
    ["Slow 4", 3],
    ["Slow 5", 5],
    ["Fast 1", 1 / 1.25],
    ["Fast 2", 1 / 1.5],
    ["Fast 3", 1 / 2],
    ["Fast 4", 1 / 3],
    ["Fast 5", 1 / 5],
  ]);
  expect(view.answerFlowSpeed).toBe(0);
  expect(text(get(root, "answer-flow-speed-trigger"))).toBe("Speed: Normal");
  get(root, "answer-flow-speed-trigger").click!({}, ctx.cx);
  root = render();
  expect(view.answerFlowSpeedMenuOpen).toBe(true);
  expect(ids(root, "answer-flow-speed-option-")).toEqual(
    ANSWER_FLOW_SPEED_OPTIONS.map(({ id }) => `answer-flow-speed-option-${id}`),
  );
  expect(
    ANSWER_FLOW_SPEED_OPTIONS.map(({ id }) => text(get(root, `answer-flow-speed-option-${id}`))),
  ).toEqual(ANSWER_FLOW_SPEED_OPTIONS.map(({ name }) => name));
  expect(get(root, "answer-flow-speed-options").styles).toMatchObject({
    role: "menu",
    tab_index: 0,
    w: 216,
    max_h: 200,
    overflow_y_scroll: true,
  });
  expect(view.answerFlowSpeedMenuFocus.is_focused()).toBe(true);

  let keyDown = get(root, "answer-flow-speed-options").styles.on_key_down as (
    event: { key: string; keystroke: string },
    cx: unknown,
  ) => void;
  const hoverSlowTwo = get(root, "answer-flow-speed-option-slow-2").styles.on_hover as (
    hovered: boolean,
    cx: unknown,
  ) => void;
  hoverSlowTwo(true, ctx.cx);
  root = render();
  expect([view.answerFlowSpeed, view.answerFlowSpeedActiveIndex]).toEqual([0, 2]);
  keyDown = get(root, "answer-flow-speed-options").styles.on_key_down as typeof keyDown;
  keyDown({ key: "ArrowUp", keystroke: "ArrowUp" }, ctx.cx);
  root = render();
  expect(view.answerFlowSpeedActiveIndex).toBe(1);
  expect(get(root, "answer-flow-speed-option-slow-1").styles.border_color).toBe("#3b82f6");
  keyDown = get(root, "answer-flow-speed-options").styles.on_key_down as typeof keyDown;
  keyDown({ key: "Enter", keystroke: "Enter" }, ctx.cx);
  root = render();
  expect([
    view.answerFlowSpeed,
    view.answerFlowSpeedMenuOpen,
    view.answerFlow?.current,
    view.draft?.choice,
    view.answerFlowSpeedTriggerFocus.is_focused(),
  ]).toEqual([1, false, 0, "Coordinate backlog", true]);

  get(root, "answer-flow-speed-trigger").click!({}, ctx.cx);
  root = render();
  keyDown = get(root, "answer-flow-speed-options").styles.on_key_down as typeof keyDown;
  keyDown({ key: "Escape", keystroke: "Escape" }, ctx.cx);
  root = render();
  expect([view.answerFlowSpeedMenuOpen, view.answerFlowSpeedTriggerFocus.is_focused()]).toEqual([
    false,
    true,
  ]);

  expect([view.answerFlow?.current, view.draft?.choice]).toEqual([0, "Coordinate backlog"]);
});

test("each named speed uses one captured duration for rendering and completion", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);

  for (const [index, speed] of ANSWER_FLOW_SPEED_OPTIONS.entries()) {
    get(root, "answer-flow-speed-trigger").click!({}, ctx.cx);
    root = render();
    get(root, `answer-flow-speed-option-${speed.id}`).click!({}, ctx.cx);
    root = render();
    expect([view.answerFlowSpeed, text(get(root, "answer-flow-speed-trigger"))]).toEqual([
      index,
      `Speed: ${speed.name}`,
    ]);

    const targetId = view.answerFlow?.current === 0 ? "i2" : "i1";
    get(root, `answer-flow-card-${targetId}`).click!({}, ctx.cx);
    root = render();
    const duration = ANSWER_CAROUSEL.transitionDuration * speed.durationFactor;
    expect([
      view.answerFlowMotion?.duration,
      ctx.timers.at(-1)?.ms,
      get(root, "answer-flow-card-i1").styles.transition,
    ]).toEqual([duration, duration, ["opacity", { duration, easing: "ease-in-out" }]]);
    ctx.tick(duration);
    root = render();
    expect(view.answerFlowMotion).toBe(undefined);
  }
});

test("the answer flow header offers Speed only: the Layout comparison is gone", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withManyAsks(2, "fits the choice")));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  const root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 300 },
    { id: "i2", expandedHeight: 300 },
  ]);
  expect(ids(root, "answer-flow-layout")).toEqual([]);
  expect(ids(root, "answer-flow-speed-trigger")).toEqual(["answer-flow-speed-trigger"]);
  expect(text(get(root, "answer-flow-speed-trigger"))).toBe("Speed: Normal");
  expect(text(get(root, "answer-flow-ask-i1-rec-reason"))).toBe("Why recommended fits the choice");
  expect(ids(root, "answer-flow-ask-i1-question-block")).toEqual([
    "answer-flow-ask-i1-question-block",
  ]);
  expect(ids(root, "answer-flow-ask-i1-options-")).toEqual([]);
});

test("answer-flow questions use the Outline treatment without a bottom action bar", async () => {
  focusDomain("alpha");
  const backlog = withManyAsks(2, "fits the choice");
  host.files.set(
    DOC,
    JSON.stringify({
      ...backlog,
      items: backlog.items.map((item) =>
        item.id === "i1" && item.ask !== null
          ? { ...item, ask: { ...item.ask, optionDetails: ["Yes detail", "No detail"] } }
          : item,
      ),
    }),
  );
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(
    render(),
    ctx.cx,
    render,
    [
      { id: "i1", expandedHeight: 248 },
      { id: "i2", expandedHeight: 176 },
    ],
    600,
    280,
  );
  get(root, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  root = render();

  const queue = get(root, "answer-flow-queue-page");
  const selected = get(root, "answer-flow-ask-i1-option-1");
  const unselected = get(root, "answer-flow-ask-i1-option-0");
  expect(view.draft?.choice).toBe("No");
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 2");
  const questionBlock = get(root, "answer-flow-ask-i1-question-block");
  expect(questionBlock.styles.bg).toBe("#292929");
  expect(questionBlock.children.map((child) => (child as Node).styles.id)).toEqual([
    "answer-flow-ask-i1-question",
  ]);
  expect(ids(questionBlock, "answer-flow-ask-i1-context")).toEqual([]);
  expect(ids(questionBlock, "answer-flow-ask-i1-rec-reason")).toEqual([]);
  expect(selected.styles).toMatchObject({
    w_full: true,
    min_w_0: true,
    px: ANSWER_FLOW_OUTLINE.paddingX,
    py: ANSWER_FLOW_OUTLINE.paddingY,
    bg: "#171717",
    border: ANSWER_FLOW_OUTLINE.selectedBorderWidth,
    border_color: "#3b82f6",
    rounded: CARD.innerRadius,
    text_color: "#f5f5f5",
    font_semibold: true,
  });
  expect(selected.hoverStyles.bg).toBe("#171717");
  expect(unselected.styles).toMatchObject({
    w_full: true,
    min_w_0: true,
    px: ANSWER_FLOW_OUTLINE.paddingX,
    py: ANSWER_FLOW_OUTLINE.paddingY,
    bg: "#171717",
    border_1: true,
    border_color: "#525252",
  });
  expect(unselected.hoverStyles.bg).toBe("#404040");
  expect(get(root, "answer-flow-ask-i1-option-1-selection-marker").styles.asset).toBe(
    HERDR_ICONS.circleCheck,
  );
  expect(get(root, "answer-flow-ask-i1-option-0-selection-marker").styles.asset).toBe(undefined);
  expect(text(unselected)).toContain("Recommended");
  expect(get(root, "answer-flow-card-i1").styles.w).toBe(252);
  expect(text(get(root, "answer-flow-ask-i1-rec-reason"))).toBe("Why recommended fits the choice");
  expect(get(root, "answer-flow-ask-i1-rec-reason").styles.bg).toBe("#292929");
  expect(ids(get(root, "answer-flow-ask-i1-rec-reason"), "answer-flow-ask-i1-detail-")).toEqual([]);
  expect(get(root, "answer-flow-ask-i1-content-1").styles.min_w_0).toBe(true);
  expect(text(get(root, "answer-flow-ask-i1-detail-1"))).toBe("No detail");
  expect(text(get(root, "answer-flow-speed-trigger"))).toBe("Speed: Normal");
  expect(queue.children.map((child) => (child as Node).styles.id)).toEqual([
    "answer-flow-header-alpha",
    "answer-flow-carousel",
  ]);
  expect(ids(root, "answer-flow-treatment-")).toEqual([]);
  expect(ids(root, "answer-flow-footer")).toEqual([]);
  expect(ids(root, "answer-flow-back")).toEqual([]);
  expect(ids(root, "answer-flow-skip")).toEqual([]);
});

test("measured viewport resizing reveals more cards without unmounting the queue", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withManyAsks(8)));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  const questionIds = Array.from({ length: 8 }, (_, index) => `i${index + 1}`);
  let root = measureFlow(
    render(),
    ctx.cx,
    render,
    questionIds.map((id) => ({ id, expandedHeight: 300 })),
    360,
  );
  const cardIds = [...questionIds.map((id) => `answer-flow-card-${id}`), "answer-flow-card-done"];
  const shortVisible = ids(root, "answer-flow-card-")
    .filter((id) => !id.includes("-content-"))
    .filter((id) => get(root, id).styles.opacity > 0);

  reportSize(root, "answer-flow-track", ctx.cx, 960);
  root = render();
  const mountedCards = ids(root, "answer-flow-card-").filter((id) => !id.includes("-content-"));
  const tallVisible = mountedCards.filter((id) => get(root, id).styles.opacity > 0);

  expect(mountedCards).toEqual(cardIds);
  expect(shortVisible).toEqual(["answer-flow-card-i1", "answer-flow-card-i2"]);
  expect(tallVisible.length).toBeGreaterThan(shortVisible.length);
  expect(get(root, "answer-flow-card-i1").styles.top + 300 / 2).toBe(480);
});

test("the done summary follows adjacent cards without reserving footer space", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withManyAsks(2)));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);
  get(root, "answer-flow-card-i2").click!({}, ctx.cx);
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");

  const sourceLast = get(root, "answer-flow-card-i2").styles;
  const sourceSummary = get(root, "answer-flow-card-done").styles;
  get(root, "answer-flow-card-done").click!({}, ctx.cx);
  root = render();

  expect(ctx.timers.at(-1)?.ms).toBe(600);
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");
  expect(ids(root, "answer-flow-footer")).toEqual([]);
  expect(ids(root, "answer-flow-back")).toEqual([]);
  expect(ids(root, "answer-flow-skip")).toEqual([]);
  const targetLast = get(root, "answer-flow-card-i2").styles;
  const targetSummary = get(root, "answer-flow-card-done").styles;
  expect(targetLast).toMatchObject({ top: 158, left: 30, w: 300, h: 72, opacity: 0.58 });
  expect(targetSummary).toMatchObject({ top: 240, left: 18, w: 324, h: 120, opacity: 1 });
  expect(
    (sourceSummary.top + targetSummary.top) / 2 -
      (sourceLast.top + targetLast.top) / 2 -
      (sourceLast.h + targetLast.h) / 2,
  ).toBe(10);
  expect(get(root, "answer-flow-compact-layer-i2").styles.transition).toEqual([
    "opacity",
    { duration: 270, delay: 150, easing: "ease-out" },
  ]);
  expect(get(root, "answer-flow-expanded-layer-done").styles.transition).toEqual([
    "opacity",
    { duration: 180, delay: 420, easing: "ease-in-out" },
  ]);
  expect(get(root, "answer-flow-compact-layer-done").styles.transition).toEqual([
    "opacity",
    { duration: 480, easing: "ease-in" },
  ]);

  ctx.tick(599);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");
  expect(ids(root, "answer-flow-footer")).toEqual([]);
  ctx.tick(600);
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Done");
  expect(ids(root, "answer-flow-footer")).toEqual([]);
  expect(trail(root)).toBe("⌂ › alpha › Questions");
});

test("the final successful answer returns to the domain and a new flow can start", async () => {
  focusDomain("alpha");
  let backlog = withManyAsks(1);
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [{ id: "i1", expandedHeight: 248 }]);
  get(root, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  backlog = recordAnswer(backlog, "i1", "No");
  host.files.set(DOC, JSON.stringify(backlog));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  root = render();
  expect(view.answerFlowMotion?.action).toBe("answered");
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 1");
  expect(ids(root, "screen-answer-flow")).toEqual(["screen-answer-flow"]);
  expect(ctx.timers.at(-1)?.ms).toBe(600);

  ctx.tick(599);
  expect(ids(render(), "screen-answer-flow")).toEqual(["screen-answer-flow"]);
  ctx.tick(600);
  await settle();
  root = render();
  expect(view.answerFlow).toBe(undefined);
  expect(ids(root, "screen-answer-flow")).toEqual([]);
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  expect(trail(root)).toBe("⌂ › alpha");
  expect(view.doc.kind).toBe("loaded");
  if (view.doc.kind !== "loaded") throw new Error("domain document did not reload");
  const answeredItem = view.doc.backlog.items.find((item) => item.id === "i1");
  expect([answeredItem?.ask, answeredItem?.answered[0]?.answer]).toEqual([null, "No"]);

  const nextBacklog = add(view.doc.backlog, "Another question", {
    status: "waiting-user",
    ask: {
      question: "Which direction?",
      context: null,
      options: ["North", "South"],
      optionDetails: ["", ""],
      rec: "North",
      recReason: null,
      discuss: null,
    },
  });
  host.files.set(DOC, JSON.stringify(nextBacklog));
  view.load(ctx.cx as never, true);
  await settle();
  root = render();
  get(root, "item-i2").click!({}, ctx.cx);
  root = measureFlow(render(), ctx.cx, render, [{ id: "i2", expandedHeight: 176 }]);
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 1");
  expect(view.answerFlow?.answered).toEqual([]);
  expect(ids(root, "answer-flow-footer")).toEqual([]);
});

test("a failed final flow answer stays on the question", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withManyAsks(1)));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [{ id: "i1", expandedHeight: 248 }]);
  get(root, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  host.execExit = { code: 1, stderr: "refused: i1 has no ask to answer\n" };
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 1");
  expect(text(get(root, "answer-flow-ask-i1-answer-error"))).toBe(
    "refused: i1 has no ask to answer",
  );
  expect(text(get(root, "answer-flow-ask-i1-question"))).toBe("Question 1?");
  expect(view.answerFlow?.current).toBe(0);
  expect(view.answerFlowMotion).toBe(undefined);
  expect(ids(root, "screen-answer-flow")).toEqual(["screen-answer-flow"]);
  expect(ids(root, "answer-flow-footer")).toEqual([]);
  expect(host.execs).toEqual([{ command: "/usr/bin/env", args: answerArgs("i1", "No") }]);
});

const wheelHandlerIds = (node: Node): string[] => [
  ...(typeof node.styles.on_scroll_wheel === "function" ? [String(node.styles.id)] : []),
  ...node.children.flatMap((child) =>
    typeof child === "string" ? [] : wheelHandlerIds(child as Node),
  ),
];

test("the carousel ignores the wheel and keeps click navigation and answer auto-advance", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);
  expect(wheelHandlerIds(get(root, "screen-answer-flow"))).toEqual([]);
  expect("scrollWheel" in view.answerFlowModel()!).toBe(false);
  expect("handleAnswerFlowScrollWheel" in view).toBe(false);

  get(root, "answer-flow-card-i2").click!({}, ctx.cx);
  ctx.tick(600);
  await settle();
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");
  get(root, "answer-flow-card-i1").click!({}, ctx.cx);
  ctx.tick(600);
  await settle();
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 2");
  expect(wheelHandlerIds(get(root, "screen-answer-flow"))).toEqual([]);

  get(root, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  host.files.set(DOC, JSON.stringify(answered("Backlog")));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  ctx.tick(600);
  await settle();
  root = render();
  expect(host.execs).toEqual([{ command: "/usr/bin/env", args: answerArgs("i1", "Backlog") }]);
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");
  expect(view.answerFlow?.current).toBe(1);
});

test("an intermediate flow answer advances without returning to the domain", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);
  get(root, "answer-flow-speed-trigger").click!({}, ctx.cx);
  root = render();
  get(root, "answer-flow-speed-option-fast-5").click!({}, ctx.cx);
  root = render();
  get(root, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  host.files.set(DOC, JSON.stringify(answered("Backlog")));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  root = render();
  expect(host.execs).toEqual([{ command: "/usr/bin/env", args: answerArgs("i1", "Backlog") }]);
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 2");
  expect(text(get(root, "answer-flow-ask-i1-question"))).toBe("Which title?");
  expect(get(root, "answer-flow-card-i1").styles).toMatchObject({
    h: 72,
    opacity: 0.58,
    left: 30,
    w: 300,
  });
  expect(get(root, "answer-flow-card-i2").styles).toMatchObject({
    h: 176,
    opacity: 1,
    left: 18,
    w: 324,
  });
  expect(ctx.timers.at(-1)?.ms).toBe(120);
  ctx.tick(119);
  expect(text(get(render(), "answer-flow-progress"))).toBe("Question 1 of 2");
  ctx.tick(120);
  await settle();
  root = render();
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 2 of 2");
  expect(text(get(root, "answer-flow-ask-i2-question"))).toBe("Which tone?");
  expect(view.answerFlow?.current).toBe(1);
  expect(ids(root, "screen-answer-flow")).toEqual(["screen-answer-flow"]);
  expect(get(root, "screen-list").styles.invisible).toBe(true);
});

test("folds Done and Dismissed by default and toggles a group from its header", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  const before = ctx.notified;
  let root = render();
  expect(get(root, "alpha-group-open-body").styles.h).toBe(64);
  expect(get(root, "alpha-group-done-body").styles.h).toBe(0);
  expect(get(root, "alpha-group-dismissed-body").styles.h).toBe(0);
  get(root, "group-done-toggle").click!({}, ctx.cx);
  get(root, "group-open-toggle").click!({}, ctx.cx);
  root = render();
  expect(get(root, "alpha-group-done-body").styles.h).toBe(32);
  expect(get(root, "alpha-group-open-body").styles.h).toBe(0);
  expect(ctx.notified - before).toBe(2);
});

test("tones each group header by its status with the fixture's colors", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(recordAnswer(everyStatus(), "i1", "Coordinate backlog")));
  const { render } = await mount();
  const root = render();
  const tone = (status: string) =>
    (get(root, `group-${status}-toggle`).nodes[0] as { styles: Record<string, unknown> }).styles
      .text_color;
  expect(
    ["waiting-user", "building", "delegated", "open", "parked", "done", "dismissed"].map(tone),
  ).toEqual(["#ef4444", "#3b82f6", "#a855f7", "#737373", "#a3a3a3", "#22c55e", "#ef4444"]);
  const title = (id: string) =>
    (get(root, id).nodes[1] as { styles: Record<string, unknown> }).styles.text_color;
  expect([title("item-i7"), title("item-i8")]).toEqual(["#f5f5f5", "#737373"]);
});

test("refreshes a same-size replacement when the watch reports the document path", async () => {
  focusDomain("alpha");
  const oldBacklog = { ...emptyBacklog("alpha", null), focus: "Old focus" };
  const newBacklog = { ...oldBacklog, focus: "New focus" };
  const oldText = JSON.stringify(oldBacklog);
  const newText = JSON.stringify(newBacklog);
  expect(newText).toHaveLength(oldText.length);
  host.files.set(DOC, oldText);
  const { render } = await mount();
  expect(host.watches.map((watch) => watch.path)).toEqual([`${STATE}/backlogs`]);
  host.files.set(DOC, newText);
  backlogWatch()!.fire([DOC]);
  await settle();
  expect(text(get(render(), "focus"))).toBe("New focus");
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(2);
  expect(host.watches.map((watch) => watch.path)).toEqual([
    `${STATE}/backlogs`,
    `${STATE}/backlogs`,
  ]);
});

test("ignores archive and other-domain watch events until that domain is selected", async () => {
  focusDomain("alpha");
  const betaPath = `${STATE}/backlogs/beta.json`;
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(betaPath, JSON.stringify({ ...emptyBacklog("beta", null), focus: "Old beta" }));
  const { ctx, render } = await mount();
  const archive = `${STATE}/backlogs/alpha.archive.jsonl`;
  backlogWatch()!.fire([archive]);
  await settle();
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(1);
  expect(host.watches).toHaveLength(2);

  host.files.set(betaPath, JSON.stringify({ ...emptyBacklog("beta", null), focus: "New beta" }));
  backlogWatch()!.fire([betaPath]);
  await settle();
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(1);
  expect(host.reads.filter((path) => path === betaPath)).toHaveLength(0);

  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("New beta");
  expect(host.reads.filter((path) => path === betaPath)).toHaveLength(1);
});

test("rereads the document on the slow timer and rearms a reclaimed watch", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  backlogWatch()!.fire([]);
  await settle();
  expect(host.watches).toHaveLength(1);
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), focus: "Timer change" }));
  ctx.tick(30_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Timer change");
  expect(host.watches).toHaveLength(2);
});

test("the slow timer checks file text but reuses parsed state when it is unchanged", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, view } = await mount();
  const previous = view.doc;
  ctx.tick(30_000);
  await settle();
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(2);
  expect(view.doc).toBe(previous);
});

test("follows focus to another domain's document", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify({ ...emptyBacklog("beta", null), focus: "Beta focus" }),
  );
  const { ctx, render } = await mount();
  focusDomain("beta");
  expect(text(get(render(), "loading"))).toBe("Loading… Reading beta's backlog.");
  ctx.tick(1_000);
  await settle();
  const root = render();
  expect(trail(root)).toBe("⌂ › beta");
  expect(text(get(root, "toolbar"))).toBe("Backlog");
  expect(text(get(root, "focus"))).toBe("Beta focus");
  expect(text(get(root, "items-empty"))).toBe("No items");
});

test("reuses a cached domain on focus return until the timer catches an unseen change", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify({ ...emptyBacklog("beta", null), focus: "Beta focus" }),
  );
  const { ctx, render } = await mount();
  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Beta focus");
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), focus: "Fresh alpha focus" }));
  focusDomain("alpha");
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  ctx.tick(1_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(1);
  ctx.tick(30_000);
  await settle();
  expect(text(get(render(), "focus"))).toBe("Fresh alpha focus");
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(2);
});

test("a failed watched reread replaces the domain's last read", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  backlogWatch()!.fire([DOC]);
  await settle();
  expect(text(get(render(), "invalid"))).toBe("alpha's backlog is invalid items must be a list");
});

test("keeps its domain while a pane with no terminal, such as the panel, has focus", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { render } = await mount();
  host.focused = { space: "s1", tab: "tab1", pane: "p2", terminal: null };
  expect(trail(render())).toBe("⌂ › alpha");
});

test("reads the state folder from the coordinate config", async () => {
  focusDomain("alpha");
  host.files.set(
    "/Users/test/.config/coordinate/config.json",
    JSON.stringify({ state_dir: "~/state" }),
  );
  host.files.set("/Users/test/state/backlogs/alpha.json", JSON.stringify(everyStatus()));
  const { render } = await mount();
  expect(text(get(render(), "focus"))).toBe("Ship the panel tracer");
  expect(host.watches.map((watch) => watch.path)).toEqual(["/Users/test/state/backlogs"]);
});

// A focused terminal with no fleet.domain label.
const focusPlain = () => {
  host.terminals = [{ address: "t9", state: "live", labels: {} }];
  host.focused = { space: "s1", tab: "tab1", pane: "p1", terminal: "t9" };
};

// Focus moves to the panel's own pane, as a click on it does.
const focusPanel = () => {
  host.focused = { space: "s1", tab: "tab1", pane: "p2", terminal: null };
};

const addIssue = (backlog: Backlog, title: string): Backlog => {
  const added = addFinding(backlog, {
    kind: "issue",
    title,
    detail: undefined,
    path: undefined,
    from: undefined,
  });
  if (!added.ok) throw new Error(added.reason);
  return added.backlog;
};

// beta: one open item and two findings, f3 closed as acted on.
const betaBacklog = (): Backlog => {
  let backlog = add({ ...emptyBacklog("beta", null), focus: "Beta focus" }, "Beta work");
  backlog = addIssue(addIssue(backlog, "Flaky test"), "Stale docs");
  const closed = closeFinding(backlog, { id: "f3", outcome: "fixed", dismissed: false, now: NOW });
  if (!closed.ok) throw new Error(closed.reason);
  return closed.backlog;
};

test("lists every domain with only its nonzero waiting, delegated and open counts", async () => {
  focusPlain();
  const alpha = everyStatus();
  host.files.set(DOC, JSON.stringify(alpha));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { render } = await mount();
  const root = render();
  expect(host.execs).toEqual([
    { command: "sh", args: ["-c", LIST_SCRIPT, "coordinate-panel", `${STATE}/backlogs`] },
  ]);
  expect(ids(root, "domain-")).toEqual(["domain-alpha", "domain-beta"]);
  expect(text(get(root, "domain-alpha"))).toBe("alpha 1 waiting 1 delegated 2 open");
  expect(text(get(root, "domain-beta"))).toBe("beta 1 open");
});

test("refreshes the changed domain summary while the listing is shown", async () => {
  focusPlain();
  const betaPath = `${STATE}/backlogs/beta.json`;
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(betaPath, JSON.stringify(betaBacklog()));
  const { render } = await mount();
  expect(text(get(render(), "domain-beta"))).toBe("beta 1 open");
  host.files.set(betaPath, JSON.stringify(add(betaBacklog(), "Another beta item")));
  backlogWatch()!.fire([betaPath]);
  await settle();
  expect(text(get(render(), "domain-beta"))).toBe("beta 2 open");
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(1);
  expect(host.reads.filter((path) => path === betaPath)).toHaveLength(2);
});

test("refreshes every listed summary when the watcher reports the folder root", async () => {
  focusPlain();
  const betaPath = `${STATE}/backlogs/beta.json`;
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  host.files.set(betaPath, JSON.stringify(emptyBacklog("beta", null)));
  const { render } = await mount();
  host.files.set(DOC, JSON.stringify(add(emptyBacklog("alpha", null), "Alpha work")));
  host.files.set(
    betaPath,
    JSON.stringify(add(add(emptyBacklog("beta", null), "Beta one"), "Beta two")),
  );
  backlogWatch()!.fire([`${STATE}/backlogs`]);
  await settle();
  expect(text(get(render(), "domain-alpha"))).toBe("alpha 1 open");
  expect(text(get(render(), "domain-beta"))).toBe("beta 2 open");
  expect(host.reads.filter((path) => path === DOC)).toHaveLength(2);
  expect(host.reads.filter((path) => path === betaPath)).toHaveLength(2);
});

test("hides count notes when a domain has no counts", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(emptyBacklog("beta", null)));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "domain-alpha"))).toBe("alpha");
  expect(text(get(root, "domain-beta"))).toBe("beta");
});

test("counts each referenced live delegate once and ignores unmatched terminals", async () => {
  focusPlain();
  const alpha = everyStatus();
  const ref = alpha.items.find((item) => item.id === "i3")?.delegates[0];
  if (ref === undefined) throw new Error("Expected alpha to have a delegate ref");
  host.files.set(
    DOC,
    JSON.stringify(
      add(alpha, "Another delegated item", {
        status: "delegated",
        delegates: [ref],
      }),
    ),
  );
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify(
      add(emptyBacklog("beta", null), "Beta work", {
        status: "delegated",
        delegates: [
          {
            name: "impl",
            session: "s-beta",
            branch: null,
            worktree: null,
            brief: "/b.md",
            report: "/r.md",
          },
        ],
      }),
    ),
  );
  host.terminals.push(
    { address: "t2", state: "live", labels: { "fleet.session": "s-1" } },
    {
      address: "t3",
      state: "live",
      labels: { "fleet.session": "s-unrelated" },
    },
  );
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "domain-alpha"))).toBe("alpha 1 agents 1 waiting 2 delegated 2 open");
  expect(text(get(root, "domain-beta"))).toBe("beta 1 delegated");
});

test("lists only names the CLI could have written, sorted, whatever order the folder gives", async () => {
  focusPlain();
  for (const name of ["beta", "my domain", "Upper", "alpha", ".hidden"])
    host.files.set(`${STATE}/backlogs/${name}.json`, JSON.stringify(betaBacklog()));
  const { render } = await mount();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta"]);
});

test("opens a domain from the listing and the home crumb returns to it", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { ctx, render } = await mount();
  let root = render();
  expect(trail(root)).toBe("⌂");
  const home = get(root, "crumb-home");
  expect(home.styles).toMatchObject({
    tooltip: "All domains",
    accessibility_label: "All domains",
  });
  expect(home.children[0]).toMatchObject({
    kind: "svg",
    styles: { asset: "mods/coordinate-panel/globe.svg" },
  });
  expect(home.click).toBe(undefined);
  focusPanel();
  get(root, "domain-beta").click!({}, ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  root = render();
  expect(trail(root)).toBe("⌂ › beta");
  expect(text(get(root, "focus"))).toBe("Beta focus");
  expect(get(root, "crumb-home").click).toBeDefined();
  press(root, "crumb-home", ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  root = render();
  expect(ids(root, "domain-")).toEqual(["domain-alpha", "domain-beta"]);
  expect(trail(root)).toBe("⌂");
  expect(get(root, "crumb-home").click).toBe(undefined);
  const toolbar = get(root, "toolbar");
  expect(toolbar.children).toHaveLength(3);
  expect(toolbar.children.map((child) => text(child))).toEqual(["Backlog", "", ""]);
});

test("the home crumb lists every domain while focus names one, until focus moves", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  host.files.set(`${STATE}/backlogs/gamma.json`, JSON.stringify(betaBacklog()));
  const { ctx, render } = await mount();
  press(render(), "crumb-home", ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta", "domain-gamma"]);
  get(render(), "domain-beta").click!({}, ctx.cx);
  await settle();
  ctx.tick(1_000);
  await settle();
  expect([trail(render()), text(get(render(), "focus"))]).toEqual(["⌂ › beta", "Beta focus"]);
  host.terminals = [
    {
      address: "t9",
      state: "live",
      labels: { "fleet.role": "coordinator", "fleet.domain": "gamma" },
    },
  ];
  host.focused = { space: "s1", tab: "tab1", pane: "p9", terminal: "t9" };
  ctx.tick(1_000);
  await settle();
  expect(trail(render())).toBe("⌂ › gamma");
});

test("a focused domain terminal wins over a domain opened from the listing", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  const { ctx, render } = await mount();
  focusPanel();
  get(render(), "domain-beta").click!({}, ctx.cx);
  await settle();
  focusDomain("alpha");
  ctx.tick(1_000);
  await settle();
  expect(trail(render())).toBe("⌂ › alpha");
  focusPlain();
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-alpha", "domain-beta"]);
});

test("the home and domain crumbs return from an item to the listing and domain", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, view, render } = await mount();
  focusPanel();
  get(render(), "domain-alpha").click!({}, ctx.cx);
  await settle();
  openDetail(view, "i1", ctx.cx);
  expect(ids(render(), "screen-item")).toEqual(["screen-item"]);
  expect(trail(render())).toBe("⌂ › alpha › i1");
  press(render(), "crumb-domain-alpha", ctx.cx);
  await settle();
  let root = render();
  expect([trail(root), ids(root, "screen-item")]).toEqual(["⌂ › alpha", []]);
  press(root, "crumb-home", ctx.cx);
  await settle();
  root = render();
  expect([trail(root), ids(root, "domain-")]).toEqual(["⌂", ["domain-alpha"]]);
});

test("names an invalid or unreadable domain in the listing instead of failing it", async () => {
  focusPlain();
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  host.files.set(`${STATE}/backlogs/gamma.json`, "{}");
  host.unreadable.add(`${STATE}/backlogs/gamma.json`);
  const { ctx, render } = await mount();
  const root = render();
  expect(text(get(root, "domain-alpha"))).toBe("alpha Invalid");
  expect(text(get(root, "domain-beta"))).toBe("beta 1 open");
  expect(text(get(root, "domain-gamma"))).toBe("gamma Unreadable");
  focusPanel();
  get(root, "domain-alpha").click!({}, ctx.cx);
  await settle();
  expect(text(get(render(), "invalid"))).toBe("alpha's backlog is invalid items must be a list");
});

test("relists the domains when the watched backlogs folder changes", async () => {
  focusPlain();
  const { render } = await mount();
  expect(ids(render(), "no-backlogs")).toEqual(["no-backlogs"]);
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(betaBacklog()));
  backlogWatch()!.fire([`${STATE}/backlogs/beta.json`]);
  await settle();
  expect(ids(render(), "domain-")).toEqual(["domain-beta"]);
});

test("shows an empty state when there are no backlogs", async () => {
  focusPlain();
  const { render } = await mount();
  expect(text(get(render(), "no-backlogs"))).toBe(
    "No backlogs yet Run coordinate start <domain> to create one.",
  );
});

test("shows why the backlogs folder can't be listed", async () => {
  focusPlain();
  host.execExit = { code: 1, stderr: "sh: permission denied\n" };
  let mounted = await mount();
  expect(text(get(mounted.render(), "listing-error"))).toBe(
    "Couldn't list the backlogs sh: permission denied",
  );
  host.execExit = undefined;
  host.execRejects = new Error("cannot start sh: program not found");
  mounted = await mount();
  expect(text(get(mounted.render(), "listing-error"))).toBe(
    "Couldn't list the backlogs Error: cannot start sh: program not found",
  );
});

test("shows why there is nothing to draw for a focused domain", async () => {
  focusDomain("alpha");
  let mounted = await mount();
  expect(text(get(mounted.render(), "missing"))).toBe(
    "No backlog for alpha Run coordinate start alpha to create it.",
  );
  host.files.set(DOC, JSON.stringify({ ...everyStatus(), items: "none" }));
  mounted = await mount();
  expect(text(get(mounted.render(), "invalid"))).toBe(
    "alpha's backlog is invalid items must be a list",
  );
  host.unreadable.add(DOC);
  mounted = await mount();
  expect(text(get(mounted.render(), "unreadable"))).toBe(
    "Couldn't read alpha's backlog Error: permission denied: " + DOC,
  );
});

test("starts nothing under herdr-app check", async () => {
  host.checking = true;
  focusDomain("alpha");
  const { ctx } = await mount();
  expect([ctx.timers.length, host.reads.length, host.watches.length, host.execs.length]).toEqual([
    0, 0, 0, 0,
  ]);
});

test("shows page buttons on the main list and lists only open findings on the Findings page", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  let root = render();
  expect(ids(root, "page-")).toEqual(["page-policies", "page-findings", "page-boundary"]);
  expect(
    ["page-policies", "page-findings", "page-boundary"].map((id) => text(get(root, id))),
  ).toEqual(["Policies 0", "Findings 1 issue · 1 opportunity", "Boundary 0"]);
  expect(ids(root, "finding-")).toEqual([]);

  openPage(root, "findings", ctx.cx);
  root = render();
  expect(trail(root)).toBe("⌂ › alpha › Findings");
  expect([ids(root, "findings-issue"), ids(root, "findings-opportunity")]).toEqual([
    ["findings-issue-header", "findings-issue"],
    ["findings-opportunity-header", "findings-opportunity"],
  ]);
  expect(text(get(root, "findings-issue-header"))).toBe("Issues");
  expect(text(get(root, "findings-opportunity-header"))).toBe("Opportunities");
  expect(ids(root, "finding-")).toEqual(["finding-f2", "finding-f3"]);
  expect(text(get(root, "finding-f2"))).toBe("▲ f2 Flaky watcher test");
  expect(text(get(root, "finding-f3"))).toBe("✦ f3 Share the validator");
  const glyph = (id: string) =>
    (get(root, id).nodes[0] as { styles: Record<string, unknown> }).styles.text_color;
  expect([glyph("finding-f2"), glyph("finding-f3")]).toEqual(["#ef4444", "#f97316"]);
});

test("omits finding-kind cards with no findings and shows an empty state when none are open", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(find(emptyBacklog("alpha", null), "issue", "One issue")));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  let root = render();
  expect([ids(root, "findings-issue"), ids(root, "findings-opportunity")]).toEqual([
    ["findings-issue-header", "findings-issue"],
    [],
  ]);

  host.files.set(DOC, JSON.stringify(everyStatus()));
  backlogWatch()!.fire([DOC]);
  await settle();
  root = render();
  expect([ids(root, "findings-issue"), ids(root, "findings-opportunity")]).toEqual([[], []]);
  expect(text(get(root, "findings-empty"))).toBe("No open findings");
});

// i1 waits on the user with an ask whose recommended option is not listed first; i2 has no rec.
const withAsk = (): Backlog => {
  let backlog = add(emptyBacklog("alpha", null), "Name the panel", {
    status: "waiting-user",
    touches: ["skills", "herdr-finbar"],
    due: "2026-11-20",
    decided: [{ text: "Keep it read-only", at: "2026-11-16T09:00:00.000Z" }],
    ask: {
      question: "Which title?",
      context: "It shows in the tab row",
      options: ["Coordinate backlog", "Backlog", "Queue"],
      optionDetails: ["Long form for the tab", "Short and clear", "A neutral alternative"],
      rec: "Backlog",
      recReason: "fits the pill",
      discuss: null,
    },
    delegates: [
      {
        name: "impl-name",
        session: "s-9",
        branch: "wyattjoh/name",
        worktree: null,
        brief: "/briefs/name.md",
        report: "/reports/name.md",
      },
    ],
  });
  backlog = add(backlog, "Pick a tone", {
    status: "waiting-user",
    ask: {
      question: "Which tone?",
      context: null,
      options: ["ansi3", "blocked"],
      optionDetails: ["", "Blocked means unavailable"],
      rec: null,
      recReason: null,
      discuss: null,
    },
  });
  return backlog;
};

const withManyAsks = (count: number, recReason: string | null = null): Backlog => {
  let backlog: Backlog = emptyBacklog("alpha", null);
  for (let index = 1; index <= count; index += 1) {
    backlog = add(backlog, `Question ${index}`, {
      status: "waiting-user",
      ask: {
        question: `Question ${index}?`,
        context: null,
        options: ["Yes", "No"],
        optionDetails: ["", ""],
        rec: "Yes",
        recReason: index === 1 ? recReason : null,
        discuss: null,
      },
    });
  }
  return backlog;
};

test("ask detail rows use the surface token and put the recommended option first", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  const root = render();
  expect(text(get(root, "detail-title"))).toBe("i1 Name the panel Waiting on you");
  expect(text(get(root, "detail-status"))).toBe("Waiting on you");
  expect(get(root, "detail-status").styles.text_color).toBe("#ef4444");
  expect(text(get(root, "ask-question"))).toBe("Which title?");
  expect(text(get(root, "ask-context"))).toBe("It shows in the tab row");
  expect(ids(root, "ask-option-")).toEqual(["ask-option-1", "ask-option-0", "ask-option-2"]);
  expect([
    text(get(root, "ask-number-1")),
    text(get(root, "ask-number-0")),
    text(get(root, "ask-number-2")),
  ]).toEqual(["1.", "2.", "3."]);
  expect(get(root, "ask-number-1").styles.w).toBe(28);
  expect(get(root, "ask-number-1").styles.text_color).toBe("#a3a3a3");
  expect(get(root, "ask-content-1").styles.flex_1).toBe(true);
  expect(get(root, "ask-content-1").styles.min_w_0).toBe(true);
  expect(text(get(root, "ask-option-1"))).toBe(
    "1. Backlog Recommended Short and clear Why recommended fits the pill",
  );
  expect(text(get(root, "ask-detail-1"))).toBe("Short and clear");
  expect(get(root, "ask-detail-1").styles.text_color).toBe("#a3a3a3");
  expect(text(get(root, "ask-detail-0"))).toBe("Long form for the tab");
  expect(text(get(root, "ask-detail-2"))).toBe("A neutral alternative");
  expect([get(root, "ask-question").styles.bg, get(root, "ask-context").styles.bg]).toEqual([
    "#292929",
    "#171717",
  ]);
  expect([get(root, "ask-option-1").styles.bg, get(root, "ask-option-0").styles.bg]).toEqual([
    "#171717",
    "#171717",
  ]);
  expect(get(root, "ask-option-0").hoverStyles.bg).toBe("#404040");
  expect(text(get(root, "ask-rec-reason"))).toBe("Why recommended fits the pill");
  expect(text(get(root, "ask-rec-reason-label"))).toBe("Why recommended");
  expect(get(root, "ask-rec-reason").styles).toMatchObject({
    bg: "#292929",
    rounded: CARD.innerRadius,
    px: CARD.paddingX,
    py: CARD.paddingY,
    min_w_0: true,
  });
  expect(
    get(root, "ask-content-1").children.map((child) =>
      typeof child === "string" ? child : child.styles.id,
    ),
  ).toEqual([undefined, "ask-detail-1", "ask-rec-reason"]);
  expect(text(get(root, "ask-detail-1"))).toBe("Short and clear");
  expect(get(root, "ask-detail-1").styles.bg).toBe(undefined);
  expect(text(get(root, "ask-touches"))).toBe("Touches skills herdr-finbar");
  expect(get(root, "ask-touches").styles.bg).toBe("#171717");
  expect(ids(root, "fact-touches")).toEqual([]);
  expect(text(get(root, "decided-0"))).toBe("Keep it read-only 2026-11-16");
  expect(text(get(root, "fact-due"))).toBe("Due 2026-11-20");
  expect(text(get(root, "delegate-s-9"))).toBe(
    "impl-name gone Brief /briefs/name.md Report /reports/name.md",
  );
  expect(text(get(root, "fact-created"))).toBe("Created 2026-11-17");
  expect(ids(root, "fact-closed")).toEqual([]);
  expect(trail(root)).toBe("⌂ › alpha › i1");
  expect(get(root, "crumb-item-i1").click).toBe(undefined);
});

test("shows a pending discussion with its marker and note in the ask card", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withDiscussion()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  const root = render();

  expect(text(get(root, "ask-discuss-number"))).toBe("4.");
  expect(get(root, "ask-discuss-number").styles.w).toBe(28);
  expect(get(root, "ask-discuss-content").styles.flex_1).toBe(true);
  expect(get(root, "ask-discuss-content").styles.min_w_0).toBe(true);
  expect(text(get(root, "ask-discuss-tag"))).toBe("In discussion");
  expect(text(get(root, "ask-discuss-note"))).toBe("Note: compare migration support");
  expect(ids(root, "ask-discuss-detail")).toEqual([]);
  expect(get(root, "ask-discuss").styles.bg).toBe("#171717");
  expect(get(root, "ask-discuss").click).toBeDefined();
  expect(ids(root, "decided-")).toEqual(["decided-header", "decided-0"]);
  expect(text(get(root, "decided-0"))).toBe("Keep it read-only 2026-11-16");
});

test("keeps an ask without a recommendation in its own order, with nothing highlighted", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i2", ctx.cx);
  const root = render();
  expect(ids(root, "ask-option-")).toEqual(["ask-option-0", "ask-option-1"]);
  expect([text(get(root, "ask-number-0")), text(get(root, "ask-number-1"))]).toEqual(["1.", "2."]);
  expect(text(get(root, "ask-option-0"))).toBe("1. ansi3");
  expect(text(get(root, "ask-option-1"))).toBe("2. blocked Blocked means unavailable");
  expect(ids(root, "ask-detail-")).toEqual(["ask-detail-1"]);
  expect([get(root, "ask-option-0").styles.bg, get(root, "ask-option-1").styles.bg]).toEqual([
    "#171717",
    "#171717",
  ]);
  expect(ids(root, "ask-rec-reason")).toEqual([]);
  expect(text(get(root, "fact-touches"))).toBe("Touches None");
  expect(text(get(root, "fact-due"))).toBe("Due None");
  expect(ids(root, "delegate-")).toEqual([]);
});

// The document after the CLI recorded an answer to i1's ask.
const answered = (answer: string): Backlog => recordAnswer(withAsk(), "i1", answer);
const withDiscussion = (note = "compare migration support"): Backlog =>
  recordAnswer(withAsk(), "i1", note === "" ? "Discuss" : `Discuss: ${note}`);

const withAskHistory = (): Backlog => {
  const backlog = withAsk();
  return {
    ...backlog,
    items: backlog.items.map((item) =>
      item.id !== "i1"
        ? item
        : {
            ...item,
            answered: [
              {
                question: "Which format?",
                context: "Used in CI",
                options: ["yaml", "json"],
                optionDetails: ["Supports comments", "Easy to inspect"],
                rec: "json",
                recReason: "existing tooling",
                discuss: null,
                answer: "json",
                answeredAt: "2026-11-15",
              },
              {
                question: "Which folder?",
                context: null,
                options: ["docs", "repo"],
                optionDetails: ["Docs folder", "Repo root"],
                rec: "docs",
                recReason: "keeps docs together",
                discuss: null,
                answer: "keep it beside the docs",
                answeredAt: "2026-11-16",
              },
            ],
          },
    ),
  };
};

test("shows the open ask first and earlier answered asks read-only, newest first", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAskHistory()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  const root = render();

  expect(ids(root, "ask-").filter((id) => id.endsWith("-header"))).toEqual([
    "ask-header",
    "ask-answered-1-header",
    "ask-answered-0-header",
  ]);
  expect([
    text(get(root, "ask-question")),
    text(get(root, "ask-answered-1-question")),
    text(get(root, "ask-answered-0-question")),
  ]).toEqual(["Which title?", "Which folder?", "Which format?"]);
  expect(ids(root, "ask-answered-1-context")).toEqual([]);
  expect(ids(root, "ask-answered-0-option-")).toEqual([
    "ask-answered-0-option-1",
    "ask-answered-0-option-0",
  ]);
  expect(get(root, "ask-answered-0-option-1").styles.bg).toBe("#2563eb");
  expect([
    text(get(root, "ask-answered-0-number-1")),
    text(get(root, "ask-answered-0-number-0")),
  ]).toEqual(["1.", "2."]);
  expect(get(root, "ask-answered-0-content-1").styles.flex_1).toBe(true);
  expect(text(get(root, "ask-answered-0-option-1"))).toContain("Recommended Answered");
  expect(text(get(root, "ask-answered-0-detail-1"))).toBe("Easy to inspect");
  expect(text(get(root, "ask-answered-0-rec-reason"))).toBe("Why recommended existing tooling");
  expect(text(get(root, "ask-answered-0-rec-reason-label"))).toBe("Why recommended");
  expect(get(root, "ask-answered-0-rec-reason").styles).toMatchObject({
    bg: "#292929",
    rounded: CARD.innerRadius,
    px: CARD.paddingX,
    py: CARD.paddingY,
  });
  expect(text(get(root, "ask-answered-0-answered-at"))).toBe("Answered 2026-11-15");
  expect(text(get(root, "ask-answered-1-answer"))).toBe(
    "Answer keep it beside the docs 2026-11-16",
  );
  expect(ids(root, "ask-answered-1-answer-submit")).toEqual([]);
  expect(get(root, "ask-answered-1-option-0").click).toBe(undefined);
  expect(get(root, "ask-answered-1-option-1").click).toBe(undefined);
  expect(get(root, "ask-option-0").click).toBeDefined();
});

test("shows a recorded note beneath completed answers and discussions", async () => {
  focusDomain("alpha");
  const backlog = answered("json");
  const item = backlog.items[0]!;
  const withNote: Backlog = {
    ...backlog,
    items: backlog.items.map((entry) =>
      entry.id === item.id
        ? {
            ...entry,
            answered: entry.answered.map((record) => ({
              ...record,
              note: "Use the shared config",
            })),
          }
        : entry,
    ),
  };
  host.files.set(DOC, JSON.stringify(withNote));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  expect(text(get(render(), "ask-answered-0-answer-note"))).toContain("Use the shared config");
  const discussion = {
    ...withNote,
    items: withNote.items.map((entry) =>
      entry.id === item.id
        ? {
            ...entry,
            answered: entry.answered.map((record) => ({
              ...record,
              answer: "Discuss",
              note: "Compare deployment options",
            })),
          }
        : entry,
    ),
  };
  host.files.set(DOC, JSON.stringify(discussion));
  backlogWatch()!.fire([DOC]);
  await settle();
  expect(text(get(render(), "ask-answered-0-answer-note"))).toContain("Compare deployment options");
});

test("loads legacy items without answered history as empty history", async () => {
  focusDomain("alpha");
  const legacy = JSON.parse(JSON.stringify(withAsk()));
  delete legacy.items[0].answered;
  host.files.set(DOC, JSON.stringify(legacy));
  const { view } = await mount();
  expect(view.doc.kind).toBe("loaded");
  if (view.doc.kind === "loaded") expect(view.doc.backlog.items[0]?.answered).toEqual([]);
});

const answerArgs = (id: string, answer: string, note?: string) => [
  "-u",
  "HC_TERMINAL_ID",
  "bun",
  "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
  "item",
  "answer",
  "--domain",
  "alpha",
  ...(note === undefined ? [] : ["--note", note]),
  "--",
  id,
  answer,
];

test("answers with a picked option through the CLI, then keeps the answered ask on reload", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  expect([
    text(get(render(), "ask-answer-submit")),
    get(render(), "ask-answer-submit").styles.bg,
  ]).toEqual(["Answer", "#404040"]);
  get(render(), "ask-option-0").click!({}, ctx.cx);
  typeInto(host.inputs[0]!, "Keep the existing title", ctx.cx);
  expect(get(render(), "ask-answer-submit").styles.bg).toBe("#ffffff");
  const picked = render();
  expect([get(picked, "ask-option-0").styles.bg, get(picked, "ask-option-1").styles.bg]).toEqual([
    "#2563eb",
    "#171717",
  ]);
  expect(host.execs).toEqual([]);
  const recorded = answered("Coordinate backlog");
  recorded.items[0]!.answered[0]!.note = "Keep the existing title";
  host.files.set(DOC, JSON.stringify(recorded));
  get(picked, "ask-answer-submit").click!({}, ctx.cx);
  expect(text(get(render(), "ask-answer-submit"))).toBe("Answering…");
  await settle();
  expect(host.execs).toEqual([
    {
      command: "/usr/bin/env",
      args: answerArgs("i1", "Coordinate backlog", "Keep the existing title"),
    },
  ]);
  const root = render();
  expect(text(get(root, "ask-answered-0-question"))).toBe("Which title?");
  expect(text(get(root, "ask-answered-0-option-0"))).toContain("Answered");
  expect(get(root, "ask-answered-0-option-0").styles.bg).toBe("#2563eb");
  expect(text(get(root, "ask-answered-0-answered-at"))).toBe("Answered 2026-11-17");
  expect(text(get(root, "ask-answered-0-answer-note"))).toBe("Note Keep the existing title");
  expect(ids(root, "ask-answer-submit")).toEqual([]);
  expect(get(root, "ask-answered-0-option-0").click).toBe(undefined);
  expect(text(get(root, "decided-1"))).toBe('Re "Which title?": Coordinate backlog 2026-11-17');
  press(root, "crumb-domain-alpha", ctx.cx);
  const list = render();
  expect(ids(get(list, "waiting"), "item-")).toEqual(["item-i2"]);
  expect(text(get(list, "group-waiting-user-toggle"))).toBe("Answered, waiting for coordinator 1");
  expect(ids(list, "item-")).toEqual(["item-i2", "item-i1"]);
});

test("selects Discuss, accepts an optional note, and submits it through the CLI", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  get(render(), "ask-discuss").click!({}, ctx.cx);
  typeInto(host.inputs[0]!, "compare migration support", ctx.cx);
  const typed = render();
  expect([
    get(typed, "ask-discuss").styles.bg,
    get(typed, "ask-answer-submit").styles.bg,
    text(get(typed, "ask-answer-submit")),
    text(get(typed, "ask-discuss-detail")),
  ]).toEqual(["#2563eb", "#ffffff", "Discuss", "Optional note"]);
  host.files.set(DOC, JSON.stringify(withDiscussion()));
  get(typed, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    { command: "/usr/bin/env", args: answerArgs("i1", "Discuss", "compare migration support") },
  ]);
  expect(text(get(render(), "ask-discuss-tag"))).toBe("In discussion");
  expect(text(get(render(), "ask-discuss-note"))).toBe("Note: compare migration support");
});

test("submits Discuss without a note when the discussion row is selected", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  get(render(), "ask-discuss").click!({}, ctx.cx);
  expect(text(get(render(), "ask-answer-submit"))).toBe("Discuss");
  host.files.set(DOC, JSON.stringify(withDiscussion("")));
  get(render(), "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([{ command: "/usr/bin/env", args: answerArgs("i1", "Discuss") }]);
  expect(ids(render(), "ask-discuss-note")).toEqual([]);
});

test("answers with free text only, without duplicating it as a note", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  typeInto(host.inputs[0]!, "  -call it Board ", ctx.cx);
  const typed = render();
  expect(ids(typed, "ask-option-").map((id) => get(typed, id).styles.bg)).toEqual([
    "#171717",
    "#171717",
    "#171717",
  ]);
  host.files.set(DOC, JSON.stringify(answered("-call it Board")));
  get(typed, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    { command: "/usr/bin/env", args: answerArgs("i1", "-call it Board") },
  ]);
  const root = render();
  expect(text(get(root, "ask-answered-0-answer"))).toBe("Answer -call it Board 2026-11-17");
  expect(ids(root, "ask-answer-submit")).toEqual([]);
});

test("free-text answers accept a separate optional note through the CLI", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 248 },
    { id: "i2", expandedHeight: 176 },
  ]);
  typeInto(host.inputs[0]!, "Custom answer", ctx.cx);
  root = render();
  expect(ids(root, "answer-flow-ask-i1-answer-note-field")).toEqual([
    "answer-flow-ask-i1-answer-note-field",
  ]);
  expect(host.inputs[1]?.placeholder).toBe("Optional note");
  typeInto(host.inputs[1]!, "Why this is the answer", ctx.cx);
  const recorded = answered("Custom answer");
  recorded.items[0]!.answered[0]!.note = "Why this is the answer";
  host.files.set(DOC, JSON.stringify(recorded));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    {
      command: "/usr/bin/env",
      args: answerArgs("i1", "Custom answer", "Why this is the answer"),
    },
  ]);
});

test("unselects a picked option so typed text becomes a free-text answer", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  get(render(), "ask-option-0").click!({}, ctx.cx);
  expect(get(render(), "ask-option-0").styles.bg).toBe("#2563eb");
  get(render(), "ask-option-0").click!({}, ctx.cx);
  expect(get(render(), "ask-option-0").styles.bg).toBe("#171717");
  typeInto(host.inputs[0]!, "Custom answer", ctx.cx);
  const draft = render();
  expect(get(draft, "ask-answer-submit").click).toBeDefined();
  host.files.set(DOC, JSON.stringify(answered("Custom answer")));
  get(draft, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    { command: "/usr/bin/env", args: answerArgs("i1", "Custom answer") },
  ]);
});

test("unselects Discuss so typed text becomes a free-text answer", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  get(render(), "ask-discuss").click!({}, ctx.cx);
  expect(get(render(), "ask-discuss").styles.bg).toBe("#2563eb");
  get(render(), "ask-discuss").click!({}, ctx.cx);
  expect(get(render(), "ask-discuss").styles.bg).toBe("#171717");
  typeInto(host.inputs[0]!, "Custom answer after Discuss", ctx.cx);
  const draft = render();
  expect(text(get(draft, "ask-answer-submit"))).toBe("Answer");
  host.files.set(DOC, JSON.stringify(answered("Custom answer after Discuss")));
  get(draft, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    { command: "/usr/bin/env", args: answerArgs("i1", "Custom answer after Discuss") },
  ]);
});

test("shows the CLI's message and keeps the draft when recording fails or cannot start", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  get(render(), "ask-option-1").click!({}, ctx.cx);
  host.execExit = { code: 1, stderr: "refused: i1 has no ask to answer\n" };
  get(render(), "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  const refused = render();
  expect([
    text(get(refused, "ask-answer-error")),
    text(get(refused, "ask-answer-submit")),
    get(refused, "ask-option-1").styles.bg,
  ]).toEqual(["refused: i1 has no ask to answer", "Answer", "#2563eb"]);
  host.execExit = undefined;
  host.execRejects = new Error("no such file: bun");
  get(refused, "ask-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(text(get(render(), "ask-answer-error"))).toBe(
    "could not run coordinate: Error: no such file: bun",
  );
  expect(host.execs.length).toBe(2);
});

test("keeps Answer inert until an option is picked or text typed", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i2", ctx.cx);
  const empty = get(render(), "ask-answer-submit");
  expect([empty.styles.bg, empty.click]).toEqual(["#404040", undefined]);
  host.inputs[0]!.handlers.get("submit")!({}, ctx.cx);
  typeInto(host.inputs[0]!, "   ", ctx.cx);
  expect(get(render(), "ask-answer-submit").click).toBe(undefined);
  expect(host.execs).toEqual([]);
});

test("the domain crumb returns to the list, which stayed mounted under detail to keep its scroll", async () => {
  focusDomain("alpha");
  const original = JSON.stringify(withAsk());
  host.files.set(DOC, original);
  const { ctx, view, render } = await mount();
  let root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  openDetail(view, "i1", ctx.cx);
  root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(true);
  expect(ids(get(root, "screen-list"), "panel-scroll")).toEqual([
    "panel-scroll-frame",
    "panel-scroll",
  ]);
  expect(ids(root, "screen-item")).toEqual(["screen-item"]);
  press(root, "crumb-domain-alpha", ctx.cx);
  root = render();
  expect(get(root, "screen-list").styles.invisible).toBe(undefined);
  expect(ids(root, "screen-item")).toEqual([]);
  expect(trail(root)).toBe("⌂ › alpha");
  expect(host.files.get(DOC)).toBe(original);
});

test("falls back to the list when the open item leaves the document or focus changes domain", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withAsk()));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(withAsk()));
  const { ctx, view, render } = await mount();
  openDetail(view, "i1", ctx.cx);
  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "screen-item")).toEqual([]);
  focusDomain("alpha");
  ctx.tick(1_000);
  await settle();
  expect(ids(render(), "screen-item")).toEqual([]);
  openDetail(view, "i2", ctx.cx);
  host.files.set(DOC, JSON.stringify({ ...withAsk(), items: withAsk().items.slice(0, 1) }));
  backlogWatch()!.fire([DOC]);
  await settle();
  const root = render();
  expect(ids(root, "screen-item")).toEqual([]);
  expect(trail(root)).toBe("⌂ › alpha");
});

const ref = (name: string, session: string) => ({
  name,
  session,
  branch: null,
  worktree: null,
  brief: `/briefs/${name}.md`,
  report: `/reports/${name}.md`,
});

// A live delegate terminal in alpha, running the given session.
const agent = (
  address: string,
  session: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  address,
  state: "live",
  status,
  name: `agent-${address}`,
  parent: "t1",
  labels: { "fleet.domain": "alpha", "fleet.session": session, "fleet.task": `task ${address}` },
  ...extra,
});

test("counts nested and unfiled live delegate rows on the Domains listing", async () => {
  focusPlain();
  const backlog = add(emptyBacklog("alpha", null), "Reviewed work", {
    status: "delegated",
    delegates: [ref("review", "s-review")],
  });
  host.files.set(DOC, JSON.stringify(backlog));
  host.terminals.push(
    agent("t2", "s-review", "working"),
    agent("t3", "s-child", "idle", { parent: "t2" }),
    agent("t4", "s-unfiled", "working"),
  );
  const { render } = await mount();
  expect(text(get(render(), "domain-alpha"))).toBe("alpha 3 agents 1 delegated");
});

const ENDED = `${STATE}/ended`;

const statusOf = (root: unknown, id: string) => {
  const node = get(root as never, id).nodes[1] as { styles: Record<string, unknown> };
  return [text(node), node.styles.text_color];
};

// An item row's delegate chip: its text and its tone.
const lineOf = (root: unknown, id: string) => {
  const node = get(root as never, `delegates-${id}`);
  return [text(node), node.styles.text_color];
};

test("shows a delegated item's status chip at the right edge of its one-line row", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-w", "working"),
    agent("t3", "s-i", "idle"),
    agent("t4", "s-b", "blocked"),
    agent("t5", "s-d", "done"),
    agent("t6", "s-e", "error"),
  );
  let backlog = emptyBacklog("alpha", null);
  for (const session of ["s-w", "s-i", "s-b", "s-d", "s-e"])
    backlog = add(backlog, `Run ${session}`, {
      status: "delegated",
      delegates: [ref(`d${session}`, session)],
    });
  backlog = add(backlog, "Plain work");
  host.files.set(DOC, JSON.stringify(backlog));
  const { render } = await mount();
  const root = render();
  expect(["i1", "i2", "i3", "i4", "i5"].map((id) => lineOf(root, id))).toEqual([
    ["working", "#3b82f6"],
    ["idle", "#737373"],
    ["blocked", "#ef4444"],
    ["done", "#22c55e"],
    ["error", "#ef4444"],
  ]);
  expect(text(get(root, "item-i1"))).toBe("i1 Run s-w working");
  expect(ids(root, "ref-")).toEqual([]);
  expect(ids(root, "item-i6")).toEqual(["item-i6"]);
  expect([get(root, "item-i1").styles.h, get(root, "item-i6").styles.h]).toEqual([32, 32]);
  expect(get(root, "alpha-group-delegated-body").styles.h).toBe(5 * 32);
});

test("with two or more delegates, shows the most urgent state and the count", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-w", "working"),
    agent("t3", "s-i", "idle"),
    agent("t4", "s-b", "blocked"),
  );
  let backlog = add(emptyBacklog("alpha", null), "Fan out", {
    status: "delegated",
    delegates: [ref("a", "s-w"), ref("b", "s-i"), ref("c", "s-b")],
  });
  backlog = add(backlog, "Pair", {
    status: "delegated",
    delegates: [ref("d", "s-i"), ref("e", "s-w")],
  });
  host.files.set(DOC, JSON.stringify(backlog));
  const { render } = await mount();
  const root = render();
  expect([lineOf(root, "i1"), lineOf(root, "i2")]).toEqual([
    ["blocked ×3", "#ef4444"],
    ["working ×2", "#3b82f6"],
  ]);
});

test("shows a delegate with an ended record as ended and one with neither as gone", async () => {
  focusDomain("alpha");
  let backlog = add(emptyBacklog("alpha", null), "Finished work", {
    status: "delegated",
    delegates: [ref("closer", "s-end")],
  });
  backlog = add(backlog, "Lost work", {
    status: "delegated",
    delegates: [ref("lost", "s-lost")],
  });
  const original = JSON.stringify(backlog);
  host.files.set(DOC, original);
  const record = JSON.stringify({
    name: "closer",
    session: "s-end",
    ended_at: "2026-11-16T08:00:00.000Z",
  });
  host.files.set(`${ENDED}/s-end.json`, record);
  const { render } = await mount();
  const root = render();
  expect([lineOf(root, "i1"), lineOf(root, "i2")]).toEqual([
    ["ended", "#737373"],
    ["gone", "#eab308"],
  ]);
  expect(host.reads.filter((path) => path.startsWith(ENDED))).toEqual([
    `${ENDED}/s-end.json`,
    `${ENDED}/s-lost.json`,
  ]);
  expect([...host.files.entries()]).toEqual([
    [DOC, original],
    [`${ENDED}/s-end.json`, record],
  ]);
  expect([host.execs, host.runs]).toEqual([[], []]);
});

test("looks up the ended record once a delegate's terminal goes away", async () => {
  focusDomain("alpha");
  host.terminals.push(agent("t2", "s-w", "working"));
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Running work", {
        status: "delegated",
        delegates: [ref("runner", "s-w")],
      }),
    ),
  );
  const { ctx, render } = await mount();
  expect(lineOf(render(), "i1")).toEqual(["working", "#3b82f6"]);
  host.terminals = host.terminals.filter((terminal) => terminal.address !== "t2");
  host.files.set(`${ENDED}/s-w.json`, JSON.stringify({ ended_at: "2026-11-17T10:00:00.000Z" }));
  expect(lineOf(render(), "i1")).toEqual(["gone", "#eab308"]);
  ctx.tick(1_000);
  await settle();
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
  ctx.tick(1_000);
  await settle();
  expect(host.reads.filter((path) => path.startsWith(ENDED))).toEqual([`${ENDED}/s-w.json`]);
});

test("draws no row for a child terminal under a delegate, whose own state names the item's", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-impl", "idle"),
    agent("t3", "s-review", "blocked", { name: "review", parent: "t2" }),
  );
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Build it", {
        status: "delegated",
        delegates: [ref("impl", "s-impl")],
      }),
    ),
  );
  const { render } = await mount();
  const root = render();
  expect(ids(get(root, "alpha-group-delegated-body"), "")).toEqual([
    "alpha-group-delegated-body",
    "item-i1",
    "delegates-i1",
  ]);
  expect(lineOf(root, "i1")).toEqual(["idle", "#737373"]);
  expect(get(root, "alpha-group-delegated-body").styles.h).toBe(32);
  expect(ids(root, "unfiled")).toEqual([]);
});

test("lists live domain terminals no item names under Unfiled delegates", async () => {
  focusDomain("alpha");
  host.terminals.push(
    agent("t2", "s-old", "idle", { name: "old-impl" }),
    agent("t3", "s-old-review", "blocked", { name: "old-review", parent: "t2" }),
    agent("t4", "s-other", "working", {
      name: "elsewhere",
      labels: { "fleet.domain": "beta", "fleet.session": "s-other" },
    }),
    agent("t5", "s-done", "done", { state: "finished" }),
  );
  host.files.set(DOC, JSON.stringify(add(emptyBacklog("alpha", null), "Base work")));
  const { render } = await mount();
  const root = render();
  expect(text(get(root, "unfiled-header"))).toBe("Unfiled delegates");
  expect(ids(get(root, "unfiled"), "term-")).toEqual(["term-t2", "term-t3"]);
  expect(text(get(root, "term-t2"))).toBe("old-impl idle");
  expect([statusOf(root, "term-t3"), get(root, "term-t3").styles.pl]).toEqual([
    ["blocked", "#ef4444"],
    24,
  ]);
  expect(trail(root)).toBe("⌂ › alpha");
});

test("shows each delegate's live status on the item's detail screen", async () => {
  focusDomain("alpha");
  host.terminals.push(agent("t2", "s-w", "blocked"));
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Blocked work", {
        status: "delegated",
        delegates: [ref("runner", "s-w")],
      }),
    ),
  );
  const { ctx, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  expect(text(get(render(), "delegate-s-w"))).toBe(
    "runner blocked Brief /briefs/runner.md Report /reports/runner.md",
  );
});

test("wraps long finding metadata values within the panel width", async () => {
  focusDomain("alpha");
  const title = "A long finding title that wraps instead of pushing beyond the panel width";
  const detail =
    "The failure only appears after the coordinator reloads a large document while another panel is open";
  const path =
    "plugins/coordinate/herdr/src/mods/panel/src/mods/panel/a-long-path-that-should-wrap.ts";
  const original = withFindings();
  const backlog: Backlog = {
    ...original,
    findings: original.findings.map((finding) =>
      finding.id === "f3" ? { ...finding, title, detail, path } : finding,
    ),
  };
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f3").click!({}, ctx.cx);
  const root = render();

  expect([
    text(get(root, "finding-title")),
    text(get(root, "fact-detail")),
    text(get(root, "fact-path")),
  ]).toEqual([`f3 ${title} Open`, `Detail ${detail}`, `Path ${path}`]);
  expect(get(root, "fact-detail-values").styles).toMatchObject({ w_full: true, min_w_0: true });
  expect(get(root, "fact-detail-value-0").styles).toMatchObject({
    flex_1: true,
    min_w_0: true,
  });
  expect(get(root, "fact-path-value-0").styles).toMatchObject({
    flex_1: true,
    min_w_0: true,
  });
  expect((get(root, "finding-title").nodes[1] as Node).styles).toMatchObject({
    flex_1: true,
    min_w_0: true,
  });
});

test("finding detail links back to Findings, and its origin opens the item", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f3").click!({}, ctx.cx);
  let root = render();
  expect(ids(root, "screen-finding")).toEqual(["screen-finding"]);
  expect(get(root, "screen-list").styles.invisible).toBe(true);
  expect(trail(root)).toBe("⌂ › alpha › Findings › f3");
  expect(text(get(root, "finding-title"))).toBe("f3 Share the validator Open");
  expect([
    text(get(root, "finding-status")),
    get(root, "finding-status").styles.text_color,
  ]).toEqual(["Open", "#737373"]);
  expect(
    ["fact-kind", "fact-detail", "fact-path", "fact-origin"].map((id) => text(get(root, id))),
  ).toEqual(["Kind Opportunity", "Detail None", "Path None", "Origin i1 Base work"]);
  expect([ids(root, "fact-outcome"), ids(root, "fact-closed")]).toEqual([[], []]);
  press(root, "crumb-findings", ctx.cx);
  root = render();
  expect([ids(root, "screen-finding"), ids(root, "screen-page"), trail(root)]).toEqual([
    [],
    ["screen-page"],
    "⌂ › alpha › Findings",
  ]);
  expect(text(get(root, "findings-opportunity"))).toContain("f3 Share the validator");
  get(root, "finding-f3").click!({}, ctx.cx);
  root = render();
  expect(trail(root)).toBe("⌂ › alpha › Findings › f3");
  get(root, "fact-origin-link").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "screen-finding"), ids(root, "screen-item")]).toEqual([[], ["screen-item"]]);
  expect(trail(root)).toBe("⌂ › alpha › i1");
});

test("the domain crumb returns from a finding detail to the domain list", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f3").click!({}, ctx.cx);
  let root = render();
  expect(trail(root)).toBe("⌂ › alpha › Findings › f3");
  press(root, "crumb-domain-alpha", ctx.cx);
  root = render();
  expect([
    ids(root, "screen-finding"),
    ids(root, "screen-page"),
    ids(root, "item-"),
    trail(root),
  ]).toEqual([[], [], ["item-i1"], "⌂ › alpha"]);
  expect(ids(root, "finding-")).toEqual([]);
});

test("a finding that leaves the document falls back to the lists", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(withFindings()));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  get(render(), "finding-f2").click!({}, ctx.cx);
  host.files.set(DOC, JSON.stringify({ ...withFindings(), findings: [] }));
  backlogWatch()!.fire([DOC]);
  await settle();
  const root = render();
  expect([ids(root, "screen-finding"), trail(root)]).toEqual([[], "⌂ › alpha › Findings"]);
});

test("shows a closed item's closing date beside its creation date", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(everyStatus()));
  const { ctx, render } = await mount();
  get(render(), "group-done-toggle").click!({}, ctx.cx);
  get(render(), "item-i7").click!({}, ctx.cx);
  const root = render();
  expect(["fact-created", "fact-closed", "fact-outcome"].map((id) => text(get(root, id)))).toEqual([
    "Created 2026-11-17",
    "Closed 2026-11-17",
    "Outcome wrapped up",
  ]);
});

test("migrates legacy approvals and opens Policies and Boundary from count rows", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify({
      schemaVersion: 1,
      domain: "alpha",
      focus: null,
      legacy: "/old/backlog.md",
      boundary: { owned: ["skills/coordinate", "plugins/coordinate"], adjacent: [] },
      standingYes: [
        { text: "Merge doc fixes", at: NOW },
        { text: "Rebase local branches", at: "2026-11-15T09:00:00.000Z" },
      ],
      items: [],
      findings: [],
      nextId: 1,
    }),
  );
  const { ctx, render } = await mount();
  let root = render();
  expect([text(get(root, "page-policies")), text(get(root, "page-boundary"))]).toEqual([
    "Policies 2",
    "Boundary 2",
  ]);
  expect(ids(root, "policy-")).toEqual([]);
  expect(ids(root, "boundary-")).toEqual([]);

  openPage(root, "policies", ctx.cx);
  root = render();
  expect(trail(root)).toBe("⌂ › alpha › Policies");
  expect(["policy-p1", "policy-p2"].map((id) => text(get(root, id)))).toEqual([
    "Merge doc fixes 2026-11-17",
    "Rebase local branches 2026-11-15",
  ]);
  press(root, "crumb-domain-alpha", ctx.cx);
  root = render();
  expect([ids(root, "screen-page"), trail(root)]).toEqual([[], "⌂ › alpha"]);

  openPage(root, "boundary", ctx.cx);
  root = render();
  expect(trail(root)).toBe("⌂ › alpha › Boundary");
  expect(ids(root, "boundary-")).toEqual([
    "boundary-owned-header",
    "boundary-alpha-owned-add",
    "boundary-owned",
    "boundary-alpha-owned-skills/coordinate",
    "boundary-alpha-owned-plugins/coordinate",
    "boundary-adjacent-header",
    "boundary-alpha-adjacent-add",
    "boundary-adjacent",
    "boundary-alpha-adjacent-empty",
  ]);
  expect(
    ["boundary-owned-header", "boundary-adjacent-header"].map((id) => text(get(root, id))),
  ).toEqual(["Owned +", "Adjacent +"]);
  expect(
    [
      "boundary-alpha-owned-skills/coordinate",
      "boundary-alpha-owned-plugins/coordinate",
      "boundary-alpha-adjacent-empty",
    ].map((id) => text(get(root, id))),
  ).toEqual(["skills/coordinate", "plugins/coordinate", "None"]);
});

test("shows a hovered X on boundary rows and runs rm with the row path and domain", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify({
      ...emptyBacklog("alpha", null),
      boundary: { owned: ["plugins/coordinate"], adjacent: [] },
    }),
  );
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  let root = render();
  expect(ids(root, "boundary-alpha-owned-remove-")).toEqual([]);
  const hover = get(root, "boundary-alpha-owned-plugins/coordinate").styles.on_hover;
  if (typeof hover !== "function") throw new Error("boundary row has no hover handler");
  (hover as (hovering: boolean, cx: unknown) => void)(true, ctx.cx);
  root = render();
  const remove = get(root, "boundary-alpha-owned-remove-plugins/coordinate");
  expect((remove.nodes[0] as Node).styles.asset).toBe("mods/workspace-chrome/x.svg");
  expect(remove.calls).toContain("on_click");
  remove.click!({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    {
      command: "/usr/bin/env",
      args: [
        "-u",
        "HC_TERMINAL_ID",
        "bun",
        "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
        "backlog",
        "boundary",
        "rm",
        "plugins/coordinate",
        "--domain",
        "alpha",
        "--json",
      ],
    },
  ]);
  expect(host.reads).toContain(DOC);
});

test("Escape cancels an inline boundary input", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  get(render(), "boundary-alpha-owned-add").click!({}, ctx.cx);
  const field = get(render(), "boundary-alpha-owned-input");
  const keyDown = (field.nodes[0] as Node).styles.on_key_down;
  if (typeof keyDown !== "function") throw new Error("boundary input has no key handler");
  (keyDown as (event: { keystroke: string }, cx: unknown) => void)({ keystroke: "escape" }, ctx.cx);
  expect(ids(render(), "boundary-alpha-owned-input")).toEqual([]);
  expect(host.execs).toEqual([]);
});

test("opens the Adjacent inline input and adds with --adjacent and the focused domain", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  get(render(), "boundary-alpha-adjacent-add").click!({}, ctx.cx);
  const root = render();
  expect(get(root, "boundary-alpha-adjacent-input")).toBeDefined();
  const input = host.inputs.at(-1)!;
  typeInto(input, "/tmp/new-adjacent-path", ctx.cx);
  input.handlers.get("submit")?.({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([
    {
      command: "/usr/bin/env",
      args: [
        "-u",
        "HC_TERMINAL_ID",
        "bun",
        "/Users/test/.claude/skills/coordinate/scripts/coordinate.ts",
        "backlog",
        "boundary",
        "add",
        "/tmp/new-adjacent-path",
        "--adjacent",
        "--domain",
        "alpha",
        "--json",
      ],
    },
  ]);
  expect(host.reads).toContain(DOC);
});

test("shows the boundary CLI refusal on the card and refuses a blank path locally", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "boundary", ctx.cx);
  get(render(), "boundary-alpha-owned-add").click!({}, ctx.cx);
  const input = host.inputs.at(-1)!;
  input.handlers.get("submit")?.({}, ctx.cx);
  await settle();
  expect(host.execs).toEqual([]);
  expect(text(get(render(), "boundary-alpha-owned-error"))).toBe("refused: path must not be blank");

  typeInto(input, "/tmp/duplicate-boundary-path", ctx.cx);
  host.execExit = { code: 1, stderr: "refused: duplicate path" };
  input.handlers.get("submit")?.({}, ctx.cx);
  await settle();
  expect(host.execs.length).toBe(1);
  expect(text(get(render(), "boundary-alpha-owned-error-/tmp/duplicate-boundary-path"))).toBe(
    "refused: duplicate path",
  );
});

test("shows None on an empty Policies page", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  openPage(render(), "policies", ctx.cx);
  expect(text(get(render(), "policies-empty"))).toBe("None");
});

test("keeps a domain's ended records while another domain's are looked up", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify(
      add(emptyBacklog("alpha", null), "Alpha work", {
        status: "delegated",
        delegates: [ref("closer", "s-a")],
      }),
    ),
  );
  host.files.set(
    `${STATE}/backlogs/beta.json`,
    JSON.stringify(
      add(emptyBacklog("beta", null), "Beta work", {
        status: "delegated",
        delegates: [ref("other", "s-b")],
      }),
    ),
  );
  host.files.set(`${ENDED}/s-a.json`, JSON.stringify({ ended_at: "2026-11-16T08:00:00.000Z" }));
  host.files.set(`${ENDED}/s-b.json`, JSON.stringify({ ended_at: "2026-11-15T08:00:00.000Z" }));
  const { ctx, render } = await mount();
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
  focusDomain("alpha");
  expect(lineOf(render(), "i1")).toEqual(["ended", "#737373"]);
});

test("reveals item rows ten at a time and resets pagination when the domain changes", async () => {
  const manyItems = (domain: string, count: number) => {
    let backlog = emptyBacklog(domain, null);
    for (let index = 1; index <= count; index++) backlog = add(backlog, `Work ${index}`);
    return backlog;
  };
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(manyItems("alpha", 25)));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(manyItems("beta", 15)));
  const { ctx, render } = await mount();
  let root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-group-open"],
  ]);
  get(root, "load-more-group-open").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([
    20,
    ["load-more-group-open"],
  ]);
  get(root, "load-more-group-open").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([25, []]);

  focusDomain("beta");
  ctx.tick(1_000);
  await settle();
  expect([ids(render(), "item-").length, ids(render(), "load-more-")]).toEqual([
    10,
    ["load-more-group-open"],
  ]);
  focusDomain("alpha");
  ctx.tick(1_000);
  await settle();
  expect([ids(render(), "item-").length, ids(render(), "load-more-")]).toEqual([
    10,
    ["load-more-group-open"],
  ]);
});

test("paginates open findings while leaving closed findings off the Findings page", async () => {
  let backlog = emptyBacklog("alpha", null);
  for (let index = 1; index <= 25; index++) backlog = find(backlog, "issue", `Finding ${index}`);
  const allIds = backlog.findings.map((finding) => finding.id);
  for (const id of allIds.slice(0, 12)) {
    const closed = closeFinding(backlog, {
      id,
      outcome: "fixed",
      dismissed: false,
      now: NOW,
    });
    if (!closed.ok) throw new Error(closed.reason);
    backlog = closed.backlog;
  }
  const openIds = allIds.slice(12).map((id) => `finding-${id}`);
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, render } = await mount();
  openPage(render(), "findings", ctx.cx);
  let root = render();
  expect([ids(root, "finding-"), ids(root, "load-more-")]).toEqual([
    openIds.slice(0, 10),
    ["load-more-findings-issue"],
  ]);

  get(root, "load-more-findings-issue").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "finding-"), ids(root, "load-more-")]).toEqual([openIds, []]);
});

test("paginates Unfiled delegates while preserving nested rows", async () => {
  focusDomain("alpha");
  host.terminals.push(
    ...Array.from({ length: 9 }, (_, index) => agent(`t${index + 2}`, `s${index + 2}`, "idle")),
    agent("t11", "s11", "idle"),
    agent("t12", "s12", "working", { parent: "t11" }),
  );
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, render } = await mount();
  let root = render();
  expect([ids(get(root, "unfiled"), "term-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-unfiled"],
  ]);
  get(root, "load-more-unfiled").click!({}, ctx.cx);
  root = render();
  expect([ids(get(root, "unfiled"), "term-").length, ids(root, "load-more-")]).toEqual([11, []]);
});

test("paginates Policies ten at a time", async () => {
  focusDomain("alpha");
  host.files.set(
    DOC,
    JSON.stringify({
      ...emptyBacklog("alpha", null),
      policies: Array.from({ length: 12 }, (_, index) => ({
        id: `p${index + 1}`,
        text: `Policy ${index + 1}`,
        at: NOW,
      })),
      nextPolicyId: 13,
    }),
  );
  const { ctx, render } = await mount();
  openPage(render(), "policies", ctx.cx);
  let root = render();
  const policyRows = () => ids(root, "policy-");
  expect([policyRows().length, ids(root, "load-more-")]).toEqual([10, ["load-more-policies"]]);
  get(root, "load-more-policies").click!({}, ctx.cx);
  root = render();
  expect([policyRows().length, ids(root, "load-more-")]).toEqual([12, []]);
});

test("shows every domain in listing order without Load more", async () => {
  for (let index = 11; index >= 0; index--) {
    const domain = `domain-${String.fromCharCode(97 + index)}`;
    host.files.set(`${STATE}/backlogs/${domain}.json`, JSON.stringify(emptyBacklog(domain, null)));
  }
  const { render } = await mount();
  const root = render();
  expect(ids(root, "domain-")).toEqual(
    Array.from({ length: 12 }, (_, index) => `domain-domain-${String.fromCharCode(97 + index)}`),
  );
  expect(ids(root, "load-more-")).toEqual([]);
});

test("paginates the Done status group ten rows at a time", async () => {
  let backlog = emptyBacklog("alpha", null);
  for (let index = 1; index <= 12; index++) {
    backlog = add(backlog, `Work ${index}`);
    backlog = close(backlog, `i${index}`, false);
  }
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, render } = await mount();
  get(render(), "group-done-toggle").click!({}, ctx.cx);
  let root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([
    10,
    ["load-more-group-done"],
  ]);
  get(root, "load-more-group-done").click!({}, ctx.cx);
  root = render();
  expect([ids(root, "item-").length, ids(root, "load-more-")]).toEqual([12, []]);
});

// Herdr hands an overlay's props to its copy of the mod through props(), not through init: what
// the opener passed, plus the overlay's own id. Mount the copy the way the app starts it.
const dialogPropsFor = (spec: unknown, overlay: string) => ({
  ...(spec as { props: Record<string, unknown> }).props,
  overlay,
});
const mountDialog = (domain: string | undefined) => {
  useRenderer({ herdr: { props: () => dialogPropsFor(policyDialogSpec(domain), "overlay-1") } });
  return mount(true);
};
const harnessPolicyCalls = () => host.execs.filter(({ args }) => args.includes("harness-policy"));
const policyCommandArgs = (args: string[]) => args.slice(args.indexOf("harness-policy"));

test("builds scoped policy CLI commands with revision checks", () => {
  const home = "/Users/test";
  expect(harnessPolicyShowCommand(home, undefined)).toEqual({
    command: "/usr/bin/env",
    args: [
      "-u",
      "HC_TERMINAL_ID",
      "bun",
      `${home}/.claude/skills/coordinate/scripts/coordinate.ts`,
      "harness-policy",
      "show",
      "--json",
    ],
  });
  expect(
    harnessPolicySetCommand(home, undefined, { enabled: [], default: null }, 4).args.slice(4),
  ).toEqual([
    "harness-policy",
    "global-set",
    "--enabled",
    "none",
    "--no-default",
    "--expected-revision",
    "4",
    "--json",
  ]);
  expect(
    harnessPolicySetCommand(home, "alpha", { enabled: ["pi"], default: "pi" }, 5).args.slice(4),
  ).toEqual([
    "harness-policy",
    "domain-set",
    "alpha",
    "--enabled",
    "pi",
    "--default",
    "pi",
    "--expected-revision",
    "5",
    "--json",
  ]);
  expect(harnessPolicyResetCommand(home, "alpha", 6).args.slice(4)).toEqual([
    "harness-policy",
    "domain-reset",
    "alpha",
    "--expected-revision",
    "6",
    "--json",
  ]);
});

test("validates canonical policy views and classifies stale and older CLI errors", () => {
  const global = harnessPolicyOutput(policyOutput(), undefined);
  expect(global?.global).toEqual({ source: "legacy", policy: LEGACY_POLICY });
  const inherited = harnessPolicyOutput(policyOutput({ domain: "alpha" }), "alpha");
  expect(inherited?.domain?.effective).toEqual(LEGACY_POLICY);
  const invalid = JSON.parse(policyOutput()) as {
    global: { policy: PolicySelection };
  };
  invalid.global.policy = { enabled: ["pi"], default: "claude" };
  expect(harnessPolicyOutput(JSON.stringify(invalid), undefined)).toBeUndefined();
  expect(harnessPolicyOutput(policyOutput({ domain: "alpha" }), undefined)).toBeUndefined();
  expect(changedHarnessPolicy([`${STATE}/delegate-harness-policy.json`], STATE)).toBe(true);
  expect(changedHarnessPolicy([`${STATE}/ended/s-a.json`], STATE)).toBe(false);
  expect(
    harnessPolicyFailure({
      code: 1,
      stdout: "",
      stderr: "stale harness policy revision: expected 4, current 5",
    }),
  ).toBe("Policy changed elsewhere. The latest is shown; reapply your change.");
  expect(
    harnessPolicyFailure({ code: 1, stdout: "", stderr: "Unknown command: harness-policy" }),
  ).toBe(
    "The installed Coordinate CLI is too old for harness policy. Update the Coordinate skill, then reopen this panel.",
  );
});

// What the CLI is asked to write for a selection, built by the same command the panel uses.
const setArgs = (domain: string | undefined, selection: PolicySelection, revision: number) =>
  policyCommandArgs(harnessPolicySetCommand("/Users/test", domain, selection, revision).args);
const showArgs = (domain?: string) =>
  domain === undefined
    ? ["harness-policy", "show", "--json"]
    : ["harness-policy", "show", "--domain", domain, "--json"];
const policyWrites = () => harnessPolicyCalls().map(({ args }) => policyCommandArgs(args));

test("the Global pane lists enabled harnesses as switches and the default as a segmented picker", async () => {
  setPolicyOutput(policyOutput({ revision: 4 }));
  const { render } = await mountDialog(undefined);
  const root = render();
  expect(text(get(root, "harness-policy-pane-head"))).toBe("HARNESS Global");
  expect(text(get(root, "harness-policy-source"))).toBe("Legacy defaults");
  expect(ids(root, "harness-policy-row-")).toEqual([
    "harness-policy-row-enabled",
    "harness-policy-row-default",
  ]);
  expect(ids(root, "harness-policy-inherit")).toEqual([]);
  expect(text(get(root, "harness-policy-row-enabled"))).toBe(
    "Enabled harnesses Harnesses delegates may be launched with. A disabled harness is refused, including on resume. Pi Claude Code Codex Unavailable",
  );
  expect(get(root, "harness-policy-enabled-pi").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-enabled-claude").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-enabled-codex").styles.bg).toBe(theme().hover);
  expect(get(root, "harness-policy-enabled-codex").click).toBe(undefined);
  expect(get(root, "harness-policy-default-none").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-default-pi").styles.bg).toBe(theme().surface);
});

test("a switch edits the draft only: nothing is written and Save lights up until it is pressed", async () => {
  setPolicyOutput(policyOutput({ revision: 4 }));
  const { ctx, render } = await mountDialog(undefined);
  let root = render();
  expect(get(root, "harness-policy-save").click).toBe(undefined);
  expect(get(root, "harness-policy-save").styles.bg).toBe(theme().raised);
  expect(text(get(root, "harness-policy-source"))).toBe("Legacy defaults");
  get(root, "harness-policy-enabled-pi").click!({}, ctx.cx);
  root = render();
  expect(get(root, "harness-policy-enabled-pi").styles.bg).toBe(theme().hover);
  expect(text(get(root, "harness-policy-source"))).toBe("Legacy defaults · Unsaved changes");
  expect(get(root, "harness-policy-save").click).toBeDefined();
  expect(get(root, "harness-policy-save").styles.bg).toBe(theme().solid);
  expect(get(root, "harness-policy-cancel").styles.bg).toBe(theme().raised);
  expect(policyWrites()).toEqual([showArgs()]);
});

test("Save writes the exact selection with the revision it was read at, then shows the saved state and stays open", async () => {
  setPolicyOutput(policyOutput({ revision: 4 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  setPolicyOutput(
    policyOutput({
      revision: 5,
      source: "configured",
      global: { enabled: ["claude"], default: null },
    }),
  );
  get(render(), "harness-policy-save").click!({}, ctx.cx);
  await settle();
  expect(policyWrites()).toEqual([
    showArgs(),
    setArgs(undefined, { enabled: ["claude"], default: null }, 4),
    showArgs(),
  ]);
  const root = render();
  expect(text(get(root, "harness-policy-source"))).toBe("Global policy");
  expect(get(root, "harness-policy-save").click).toBe(undefined);
  expect(view.harnessPolicyDraft).toBe(undefined);
  expect(closedOverlays).toEqual([]);
});

test("turning off the default's harness clears the default in the draft, and only enabled harnesses can be chosen", async () => {
  setPolicyOutput(
    policyOutput({ revision: 2, global: { enabled: ["pi", "claude"], default: "pi" } }),
  );
  const { ctx, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  let root = render();
  expect(get(root, "harness-policy-default-none").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-default-pi").click).toBe(undefined);
  expect(get(root, "harness-policy-default-claude").click).toBeDefined();
  get(root, "harness-policy-default-claude").click!({}, ctx.cx);
  root = render();
  expect(get(root, "harness-policy-default-claude").styles.bg).toBe(theme().accent);
  get(root, "harness-policy-save").click!({}, ctx.cx);
  await settle();
  expect(policyWrites()[1]).toEqual(
    setArgs(undefined, { enabled: ["claude"], default: "claude" }, 2),
  );
});

test("a draft equal to the saved policy is clean again, so Save is inert", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  expect(view.harnessPolicyDraft).toBeDefined();
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  expect(view.policyDirty(undefined)).toBe(false);
  expect(view.harnessPolicyDraft).toBe(undefined);
  expect(get(render(), "harness-policy-save").click).toBe(undefined);
  // With no edits left, a change on disk is not a conflict.
  setPolicyOutput(policyOutput({ revision: 3, source: "configured" }));
  policyWatch()!.fire([`${STATE}/delegate-harness-policy.json`]);
  await settle();
  expect(ids(render(), "harness-policy-failure")).toEqual([]);
  expect(get(render(), "harness-policy-enabled-pi").click).toBeDefined();
});

test("turning Inherit global on previews the global policy the domain will use", async () => {
  setPolicyOutput(
    policyOutput({
      revision: 10,
      source: "configured",
      domain: "alpha",
      mode: "replace",
      override: { enabled: ["claude"], default: "claude" },
    }),
  );
  const { ctx, render } = await mountDialog("alpha");
  expect(get(render(), "harness-policy-enabled-pi").styles.bg).toBe(theme().hover);
  get(render(), "harness-policy-inherit-toggle").click!({}, ctx.cx);
  const root = render();
  expect(get(root, "harness-policy-enabled-pi").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-default-none").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-enabled-pi").click).toBe(undefined);
});

test("a domain pane starts inherited: Inherit global is on, the other rows and Save are inert", async () => {
  setPolicyOutput(policyOutput({ revision: 7, domain: "alpha" }));
  const { render } = await mountDialog("alpha");
  const root = render();
  expect(text(get(root, "harness-policy-pane-head"))).toBe("HARNESS alpha");
  expect(text(get(root, "harness-policy-source"))).toBe("Inherits legacy defaults");
  expect(ids(root, "harness-policy-row-")).toEqual([
    "harness-policy-row-inherit",
    "harness-policy-row-enabled",
    "harness-policy-row-default",
  ]);
  expect(get(root, "harness-policy-inherit-toggle").styles.bg).toBe(theme().accent);
  expect(get(root, "harness-policy-enabled-pi").click).toBe(undefined);
  expect(get(root, "harness-policy-default-pi").click).toBe(undefined);
  expect(get(root, "harness-policy-save").click).toBe(undefined);
});

test("Inherit global is part of the draft: off then Save is a domain-set seeded from the effective policy, on then Save a domain-reset", async () => {
  setPolicyOutput(policyOutput({ revision: 7, domain: "alpha" }));
  const { ctx, render } = await mountDialog("alpha");
  get(render(), "harness-policy-inherit-toggle").click!({}, ctx.cx);
  let root = render();
  expect(text(get(root, "harness-policy-source"))).toBe("Domain override · Unsaved changes");
  expect(get(root, "harness-policy-enabled-pi").click).toBeDefined();
  expect(policyWrites()).toEqual([showArgs("alpha")]);
  setPolicyOutput(
    policyOutput({
      revision: 8,
      source: "configured",
      domain: "alpha",
      mode: "replace",
      override: LEGACY_POLICY,
    }),
  );
  get(root, "harness-policy-save").click!({}, ctx.cx);
  await settle();
  expect(policyWrites()).toEqual([
    showArgs("alpha"),
    setArgs("alpha", LEGACY_POLICY, 7),
    showArgs("alpha"),
  ]);
  root = render();
  expect(text(get(root, "harness-policy-source"))).toBe("Domain override");
  expect(get(root, "harness-policy-inherit-toggle").styles.bg).toBe(theme().hover);

  get(root, "harness-policy-inherit-toggle").click!({}, ctx.cx);
  setPolicyOutput(policyOutput({ revision: 9, source: "configured", domain: "alpha" }));
  get(render(), "harness-policy-save").click!({}, ctx.cx);
  await settle();
  expect(policyWrites().slice(3)).toEqual([
    ["harness-policy", "domain-reset", "alpha", "--expected-revision", "8", "--json"],
    showArgs("alpha"),
  ]);
  expect(text(get(render(), "harness-policy-source"))).toBe("Inherits global policy");
});

test("a domain override's switches are saved as the domain's own selection", async () => {
  setPolicyOutput(
    policyOutput({
      revision: 10,
      source: "configured",
      domain: "alpha",
      mode: "replace",
      override: { enabled: ["claude"], default: "claude" },
    }),
  );
  const { ctx, render } = await mountDialog("alpha");
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  get(render(), "harness-policy-save").click!({}, ctx.cx);
  await settle();
  expect(policyWrites()[1]).toEqual(
    setArgs("alpha", { enabled: ["pi", "claude"], default: "claude" }, 10),
  );
});

test("a refused save shows the CLI's message inline, keeps the draft and offers Reload", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  setPolicyOutput("", 1, "refused: policy default must be enabled");
  get(render(), "harness-policy-save").click!({}, ctx.cx);
  await settle();
  const root = render();
  expect(text(get(root, "harness-policy-failure"))).toBe("refused: policy default must be enabled");
  expect(text(get(root, "harness-policy-reload"))).toBe("Reload policy");
  expect(get(root, "harness-policy-enabled-pi").styles.bg).toBe(theme().hover);
  expect(view.policyDirty(undefined)).toBe(true);
  expect(get(root, "harness-policy-save").click).toBeDefined();
});

test("a stale save rereads the policy, marks the draft stale and Reload discards it", async () => {
  setPolicyOutput(policyOutput({ revision: 3 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  setPolicyOutput("", 1, "stale harness policy revision: expected 3, current 4");
  get(render(), "harness-policy-save").click!({}, ctx.cx);
  setPolicyOutput(policyOutput({ revision: 4, source: "configured" }));
  await settle();
  const root = render();
  expect(text(get(root, "harness-policy-failure"))).toBe(
    "Policy changed while you were editing. Reload to discard your changes, then make them again.",
  );
  expect(get(root, "harness-policy-save").click).toBe(undefined);
  expect(get(root, "harness-policy-enabled-pi").click).toBe(undefined);
  get(root, "harness-policy-reload").click!({}, ctx.cx);
  await settle();
  expect(view.harnessPolicyDraft).toBe(undefined);
  expect(ids(render(), "harness-policy-failure")).toEqual([]);
  expect(text(get(render(), "harness-policy-source"))).toBe("Global policy");
});

test("a policy change on disk while the draft is dirty marks the draft stale", async () => {
  setPolicyOutput(policyOutput({ revision: 1 }));
  const { ctx, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  setPolicyOutput(policyOutput({ revision: 2, source: "configured" }));
  policyWatch()!.fire([`${STATE}/delegate-harness-policy.json`]);
  await settle();
  const root = render();
  expect(text(get(root, "harness-policy-failure"))).toBe(
    "Policy changed while you were editing. Reload to discard your changes, then make them again.",
  );
  expect(get(root, "harness-policy-save").click).toBe(undefined);
});

test("an older CLI shows its error in the pane with a Reload button", async () => {
  setPolicyOutput("", 1, "Unknown command: harness-policy");
  const { render } = await mountDialog(undefined);
  const root = render();
  expect(text(get(root, "harness-policy-failure"))).toBe(
    "The installed Coordinate CLI is too old for harness policy. Update the Coordinate skill, then reopen this panel.",
  );
  expect(get(root, "harness-policy-reload").click).toBeDefined();
});

// What dismissing the window does with and without unsaved changes. Each way out goes through the
// same request, which asks first when the draft is dirty.
const dismissals = {
  Cancel: (render: () => Node, ctx: { cx: unknown }) =>
    get(render(), "harness-policy-cancel").click!({}, ctx.cx),
  Escape: (render: () => Node, ctx: { cx: unknown }) =>
    (
      get(render(), "harness-policy-dialog").styles.on_key_down as (
        event: { key: string },
        cx: unknown,
      ) => void
    )({ key: "escape" }, ctx.cx),
} as const;

for (const [way, dismiss] of Object.entries(dismissals)) {
  test(`${way} closes at once when nothing changed`, async () => {
    setPolicyOutput(policyOutput({ revision: 2 }));
    const { ctx, render } = await mountDialog(undefined);
    dismiss(render, ctx);
    expect(closedOverlays).toEqual(["overlay-1"]);
    expect(ids(render(), "harness-policy-confirm")).toEqual([]);
  });

  test(`${way} with unsaved changes asks to discard them instead of closing`, async () => {
    setPolicyOutput(policyOutput({ revision: 2 }));
    const { ctx, view, render } = await mountDialog(undefined);
    get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
    dismiss(render, ctx);
    const root = render();
    expect(closedOverlays).toEqual([]);
    expect(text(get(root, "harness-policy-confirm"))).toBe(
      "Discard changes? Your harness setting changes will be lost. Keep editing Discard",
    );
    expect(get(root, "harness-policy-discard").styles.bg).toBe(theme().blocked);
    expect(get(root, "harness-policy-discard").styles.text_color).toBe(theme().solid_foreground);
    expect(view.policyDirty(undefined)).toBe(true);
  });
}

test("Keep editing returns to the window with the draft intact", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  dismissals.Cancel(render, ctx);
  get(render(), "harness-policy-keep-editing").click!({}, ctx.cx);
  const root = render();
  expect(ids(root, "harness-policy-confirm")).toEqual([]);
  expect(closedOverlays).toEqual([]);
  expect(view.policyDirty(undefined)).toBe(true);
  expect(get(root, "harness-policy-enabled-pi").styles.bg).toBe(theme().hover);
});

test("Escape on the confirm keeps editing", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  dismissals.Escape(render, ctx);
  dismissals.Escape(render, ctx);
  expect(ids(render(), "harness-policy-confirm")).toEqual([]);
  expect(closedOverlays).toEqual([]);
  expect(view.policyDirty(undefined)).toBe(true);
});

test("Discard drops the draft and closes the dialog", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  dismissals.Cancel(render, ctx);
  get(render(), "harness-policy-discard").click!({}, ctx.cx);
  expect(closedOverlays).toEqual(["overlay-1"]);
  expect(view.harnessPolicyDraft).toBe(undefined);
  expect(policyWrites()).toEqual([showArgs()]);
});

test("switching scope with unsaved changes asks first: Keep editing stays, Discard switches", async () => {
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, view, render } = await mountDialog(undefined);
  setPolicyOutput(policyOutput({ revision: 2 }));
  policyWatch()!.fire([`${STATE}/delegate-harness-policy.json`]);
  await settle();
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  get(render(), "harness-policy-scope-trigger").click!({}, ctx.cx);
  get(render(), "harness-policy-scope-domain-alpha").click!({}, ctx.cx);
  expect(text(get(render(), "harness-policy-confirm"))).toContain("Discard changes?");
  expect(view.policyDialog?.domain).toBe(undefined);
  get(render(), "harness-policy-keep-editing").click!({}, ctx.cx);
  expect(view.policyDialog?.domain).toBe(undefined);
  expect(view.policyDirty(undefined)).toBe(true);

  get(render(), "harness-policy-scope-trigger").click!({}, ctx.cx);
  get(render(), "harness-policy-scope-domain-alpha").click!({}, ctx.cx);
  setPolicyOutput(policyOutput({ revision: 2, domain: "alpha" }));
  get(render(), "harness-policy-discard").click!({}, ctx.cx);
  await settle();
  expect(view.policyDialog?.domain).toBe("alpha");
  expect(view.harnessPolicyDraft).toBe(undefined);
  expect(text(get(render(), "harness-policy-pane-head"))).toBe("HARNESS alpha");
  expect(closedOverlays).toEqual([]);
  expect(policyWrites().at(-1)).toEqual(showArgs("alpha"));
});

test("switching scope with nothing changed goes at once", async () => {
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-scope-trigger").click!({}, ctx.cx);
  get(render(), "harness-policy-scope-domain-alpha").click!({}, ctx.cx);
  expect(ids(render(), "harness-policy-confirm")).toEqual([]);
  expect(view.policyDialog?.domain).toBe("alpha");
});

test("dismissing is ignored while a save is running", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  get(render(), "harness-policy-enabled-pi").click!({}, ctx.cx);
  get(render(), "harness-policy-save").click!({}, ctx.cx);
  expect(view.harnessPolicyBusy).toBe(true);
  expect(text(get(render(), "harness-policy-save"))).toBe("Saving…");
  expect(get(render(), "harness-policy-cancel").click).toBe(undefined);
  dismissals.Escape(render, ctx);
  expect(closedOverlays).toEqual([]);
  expect(ids(render(), "harness-policy-confirm")).toEqual([]);
});

test("the dialog reloads when the state-directory watcher sees the policy file", async () => {
  setPolicyOutput(policyOutput({ revision: 1 }));
  const { render } = await mountDialog(undefined);
  setPolicyOutput(
    policyOutput({
      revision: 2,
      source: "configured",
      global: { enabled: ["claude"], default: "claude" },
    }),
  );
  policyWatch()!.fire([`${STATE}/delegate-harness-policy.json`]);
  await settle();
  const root = render();
  expect(text(get(root, "harness-policy-source"))).toBe("Global policy");
  expect(get(root, "harness-policy-default-claude").styles.bg).toBe(theme().accent);
});

test("the sidebar has the title and one Harness section, and the pane's scope dropdown lists Global then every domain", async () => {
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  host.files.set(`${STATE}/backlogs/beta.json`, JSON.stringify(emptyBacklog("beta", null)));
  // The fake host answers every exec alike, so the listing is read before any policy output is set.
  const { ctx, render, view } = await mountDialog(undefined);
  expect(view.policyDomains).toEqual(["alpha", "beta"]);
  let root = render();
  expect(text(get(root, "harness-policy-nav"))).toBe("Backlog Harness");
  expect(get(root, "harness-policy-nav").styles.w).toBe(190);
  expect(get(root, "harness-policy-nav-harness").styles.bg).toBe(theme().raised);
  expect(text(get(root, "harness-policy-pane-head"))).toBe("HARNESS Global");
  expect(ids(root, "harness-policy-scope-")).toEqual(["harness-policy-scope-trigger"]);
  get(root, "harness-policy-scope-trigger").click!({}, ctx.cx);
  root = render();
  expect(ids(root, "harness-policy-scope-")).toEqual([
    "harness-policy-scope-trigger",
    "harness-policy-scope-backdrop",
    "harness-policy-scope-options",
    "harness-policy-scope-global",
    "harness-policy-scope-domain-alpha",
    "harness-policy-scope-domain-beta",
  ]);
  setPolicyOutput(policyOutput({ revision: 1, domain: "beta" }));
  get(root, "harness-policy-scope-domain-beta").click!({}, ctx.cx);
  await settle();
  root = render();
  expect(ids(root, "harness-policy-scope-")).toEqual(["harness-policy-scope-trigger"]);
  expect(text(get(root, "harness-policy-pane-head"))).toBe("HARNESS beta");
  expect(policyWrites().at(-1)).toEqual(showArgs("beta"));
  get(root, "harness-policy-scope-trigger").click!({}, ctx.cx);
  setPolicyOutput(policyOutput({ revision: 1 }));
  get(render(), "harness-policy-scope-global").click!({}, ctx.cx);
  await settle();
  expect(text(get(render(), "harness-policy-pane-head"))).toBe("HARNESS Global");
});

test("one click opens the scope dropdown and it stays open until a choice, Escape or a click outside", async () => {
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, render } = await mountDialog(undefined);
  const menuIds = () => ids(render(), "harness-policy-scope-options");

  // The trigger reacts to its click alone. A Popover also reports a change from the press on its
  // trigger, and that second toggle closed the menu again when the button was released.
  const trigger = get(render(), "harness-policy-scope-trigger");
  expect(trigger.styles.on_open_change).toBe(undefined);
  trigger.click!({}, ctx.cx);
  expect(view.policyDomainMenuOpen).toBe(true);
  for (let frame = 0; frame < 3; frame += 1)
    expect(menuIds()).toEqual(["harness-policy-scope-options"]);
  ctx.tick(30_000);
  await settle();
  expect(menuIds()).toEqual(["harness-policy-scope-options"]);
  trigger.click!({}, ctx.cx);
  expect(view.policyDomainMenuOpen).toBe(true);

  get(render(), "harness-policy-scope-backdrop").click!({}, ctx.cx);
  expect(menuIds()).toEqual([]);
  expect(closedOverlays).toEqual([]);

  get(render(), "harness-policy-scope-trigger").click!({}, ctx.cx);
  get(render(), "harness-policy-scope-global").click!({}, ctx.cx);
  expect(menuIds()).toEqual([]);
  expect(view.harnessPolicyBusy).toBe(false);
  // The slow refresh read the policy again; nothing wrote it.
  expect(policyWrites().map((args) => args[1])).toEqual(["show", "show"]);
});

test("Escape closes the scope dropdown first, then the dialog, and the dialog takes the keyboard", async () => {
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { ctx, view, focusHandles, render } = await mountDialog(undefined);
  expect(view.policyDialogFocus?.is_focused()).toBe(true);
  expect(focusHandles.length).toBe(1);
  get(render(), "harness-policy-scope-trigger").click!({}, ctx.cx);
  const escape = () =>
    (
      get(render(), "harness-policy-dialog").styles.on_key_down as (
        event: { key: string },
        cx: unknown,
      ) => void
    )({ key: "escape" }, ctx.cx);
  escape();
  expect(view.policyDomainMenuOpen).toBe(false);
  expect(closedOverlays).toEqual([]);
  escape();
  expect(closedOverlays).toEqual(["overlay-1"]);
});

test("the dialog is Finbar-sized and drawn as a sidebar beside a scrolling pane", async () => {
  setPolicyOutput(policyOutput({ revision: 2 }));
  const { render } = await mountDialog(undefined);
  const root = render();
  expect(get(root, "harness-policy-dialog").styles.h).toBe(620);
  expect(policyDialogSpec(undefined)).toMatchObject({ width: 880, height: 620 });
  expect(get(root, "harness-policy-pane").styles.px).toBe(28);
  expect(get(root, "harness-policy-row-enabled").styles.border_b).toBe(1);
});

test("the dialog copy reads only its policy and domain names, and starts nothing under herdr-app check", async () => {
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  setPolicyOutput(policyOutput({ revision: 1, domain: "alpha" }));
  const { ctx, render } = await mountDialog("alpha");
  expect(ids(render(), "harness-policy-title")).toEqual(["harness-policy-title"]);
  expect(host.reads.filter((path) => path === DOC)).toEqual([]);
  expect(host.watches.map((watch) => watch.path)).toEqual([STATE]);
  expect(ctx.timers.map((timer) => timer.ms)).toEqual([30_000]);

  resetHost();
  host.checking = true;
  const checked = await mountDialog("alpha");
  expect([
    checked.ctx.timers.length,
    host.reads.length,
    host.watches.length,
    host.execs.length,
  ]).toEqual([0, 0, 0, 0]);
});

const POLICY_SPEC = {
  mod: "coordinate-panel",
  kind: "dialog",
  modal: true,
  width: HARNESS_DIALOG.width,
  height: HARNESS_DIALOG.height,
};

test("the header cog replaces the domain label and opens the global policy on Domains", async () => {
  focusPlain();
  const { ctx, render } = await mount();
  const root = render();
  expect([ids(root, "domain-"), text(get(root, "no-backlogs"))]).toEqual([
    [],
    "No backlogs yet Run coordinate start <domain> to create one.",
  ]);
  expect(ids(root, "harness-policy-")).toEqual(["harness-policy-open"]);
  expect(text(get(root, "toolbar"))).toBe("Backlog");
  expect(get(root, "harness-policy-open").styles.tooltip).toBe("Delegate harness policy");
  expect(get(root, "harness-policy-open").styles.bg).toBe(theme().chrome);
  get(root, "harness-policy-open").click!({}, ctx.cx);
  expect(overlays).toEqual([
    {
      id: "overlay-1",
      spec: { ...POLICY_SPEC, props: { harnessPolicy: { domain: null } } },
    },
  ]);
  expect(harnessPolicyCalls()).toEqual([]);
});

test("on a domain page the cog opens that domain's policy, from the overview, a subpage and a detail", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(add(emptyBacklog("alpha", null), "A work item")));
  const { ctx, render } = await mount();
  expect(text(get(render(), "toolbar"))).toBe("Backlog");
  expect(ids(render(), "harness-policy-")).toEqual(["harness-policy-open"]);
  openPage(render(), "policies", ctx.cx);
  get(render(), "harness-policy-open").click!({}, ctx.cx);
  press(render(), "crumb-domain-alpha", ctx.cx);
  get(render(), "item-i1").click!({}, ctx.cx);
  get(render(), "harness-policy-open").click!({}, ctx.cx);
  const domains = overlays.map(
    ({ spec }) =>
      (spec as { props: { harnessPolicy: { domain: string | null } } }).props.harnessPolicy.domain,
  );
  expect(domains).toEqual(["alpha", "alpha"]);
});

test("the Domains listing and the domain overview carry no policy button", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(add(emptyBacklog("alpha", null), "A work item")));
  const { ctx, render } = await mount();
  expect(ids(get(render(), "domain"), "harness-policy-")).toEqual([]);
  press(render(), "crumb-home", ctx.cx);
  await settle();
  expect(ids(get(render(), "panel-scroll"), "harness-policy-")).toEqual([]);
});

test("the opener's spec round-trips through props() into the dialog copy", async () => {
  focusDomain("alpha");
  host.files.set(DOC, JSON.stringify(emptyBacklog("alpha", null)));
  const opener = await mount();
  get(opener.render(), "harness-policy-open").click!({}, opener.ctx.cx);
  const [opened] = overlays;
  resetHost();
  setPolicyOutput(policyOutput({ revision: 3, domain: "alpha" }));
  useRenderer({ herdr: { props: () => dialogPropsFor(opened!.spec, opened!.id) } });
  const dialog = await mount(true);
  const root = dialog.render();
  expect(ids(root, "harness-policy-dialog")).toEqual(["harness-policy-dialog"]);
  expect(ids(root, "toolbar")).toEqual([]);
  expect(text(get(root, "harness-policy-pane-head"))).toBe("HARNESS alpha");
  expect(text(get(root, "harness-policy-source"))).toBe("Inherits legacy defaults");
});

test("a copy given the panel's own props shows the panel, not the dialog", async () => {
  useRenderer({ herdr: { props: () => ({ tab: "pane", overlay: "overlay-9" }) } });
  focusPlain();
  const { render } = await mount();
  expect(ids(render(), "harness-policy-dialog")).toEqual([]);
  expect(ids(render(), "toolbar")).toEqual(["toolbar"]);
});

test("a card's remeasured size is kept when it arrives during an answer motion", async () => {
  focusDomain("alpha");
  let backlog = withManyAsks(2);
  host.files.set(DOC, JSON.stringify(backlog));
  const { ctx, view, render } = await mount();
  get(render(), "item-i1").click!({}, ctx.cx);
  let root = measureFlow(render(), ctx.cx, render, [
    { id: "i1", expandedHeight: 300 },
    { id: "i2", expandedHeight: 300 },
  ]);
  const expandedWidth = 360 * ANSWER_CAROUSEL.compactWidthRatio;
  const key = view.flowCardSizeKey("alpha", "i1");
  get(root, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  backlog = recordAnswer(backlog, "i1", "No");
  host.files.set(DOC, JSON.stringify(backlog));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  expect(view.answerFlowMotion?.action).toBe("answered");

  // The answered card is now one line, and its hidden measurement reports that mid-motion.
  reportSize(render(), "answer-flow-measure-expanded-i1", ctx.cx, 100, expandedWidth);
  expect(view.answerFlowCardSizes.get(key)?.expanded?.height).toBe(300);

  ctx.tick(600);
  await settle();
  expect(view.answerFlowCardSizes.get(key)?.expanded?.height).toBe(100);

  root = render();
  get(root, "answer-flow-card-i1").click!({}, ctx.cx);
  root = render();
  expect(get(root, "answer-flow-card-i1").styles.h).toBe(100);
  expect(text(get(root, "answer-flow-detail-i1-answered"))).toBe("Answered: No");
});

const flowSetup = async (count: number) => {
  focusDomain("alpha");
  let backlog = withManyAsks(count);
  host.files.set(DOC, JSON.stringify(backlog));
  const mounted = await mount();
  get(mounted.render(), "item-i1").click!({}, mounted.ctx.cx);
  const questionIds = Array.from({ length: count }, (_, index) => `i${index + 1}`);
  const root = measureFlow(
    mounted.render(),
    mounted.ctx.cx,
    mounted.render,
    questionIds.map((id) => ({ id, expandedHeight: 300 })),
  );
  return { ...mounted, root, backlog, questionIds };
};

const flowCardIds = (root: Node) =>
  ids(root, "answer-flow-card-").filter((id) => !id.includes("-content-"));

test("a question answered outside the flow is dropped wherever it sits, with its sizes", async () => {
  const { ctx, view, render, backlog } = await flowSetup(3);
  const key = view.flowCardSizeKey("alpha", "i2");
  expect(view.answerFlowCardSizes.has(key)).toBe(true);

  host.files.set(DOC, JSON.stringify(recordAnswer(backlog, "i2", "Yes")));
  backlogWatch()!.fire([DOC]);
  await settle();
  const root = render();

  expect(flowCardIds(root)).toEqual([
    "answer-flow-card-i1",
    "answer-flow-card-i3",
    "answer-flow-card-done",
  ]);
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 2");
  expect(view.answerFlow?.ids).toEqual(["i1", "i3"]);
  expect(view.answerFlowCardSizes.has(key)).toBe(false);
  expect(ids(root, "answer-flow-detail-i2")).toEqual([]);
  expect(ctx.notified > 0).toBe(true);
});

test("a current question answered outside the flow is dropped and the next open one is shown", async () => {
  const { view, render, backlog } = await flowSetup(3);

  host.files.set(DOC, JSON.stringify(recordAnswer(backlog, "i1", "Yes")));
  backlogWatch()!.fire([DOC]);
  await settle();
  const root = render();

  expect(view.answerFlow?.ids).toEqual(["i2", "i3"]);
  expect([view.answerFlow?.current, view.answerFlow?.answered]).toEqual([0, []]);
  expect(view.selected).toEqual({ kind: "item", domain: "alpha", id: "i2" });
  expect(text(get(root, "answer-flow-progress"))).toBe("Question 1 of 2");
});

test("the summary counts only what was answered or skipped in the flow", async () => {
  const { ctx, view, render, backlog } = await flowSetup(3);

  host.files.set(DOC, JSON.stringify(recordAnswer(backlog, "i3", "No")));
  backlogWatch()!.fire([DOC]);
  await settle();
  get(render(), "answer-flow-card-i2").click!({}, ctx.cx);
  ctx.tick(600);
  await settle();
  get(render(), "answer-flow-card-done").click!({}, ctx.cx);
  ctx.tick(600);
  await settle();
  const root = render();

  expect(view.answerFlow?.ids).toEqual(["i1", "i2"]);
  expect(text(get(root, "answer-flow-progress"))).toBe("Done");
  expect(text(get(root, "answer-flow-detail-done-count"))).toBe("0 answered, 2 skipped.");
});

test("a question cleared while the flow is not looking is dropped before a skip chooses its target", async () => {
  const { ctx, view, render, backlog } = await flowSetup(3);

  // A read the flow has not reconciled yet, as one that arrived during a motion would be.
  view.doc = { kind: "loaded", backlog: recordAnswer(backlog, "i2", "Yes") };
  get(render(), "answer-flow-card-i2").click!({}, ctx.cx);

  expect(view.answerFlow?.ids).toEqual(["i1", "i3"]);
  expect(view.answerFlowMotion?.targetFlow?.current).toBe(1);
  expect(flowCardIds(render())).toEqual([
    "answer-flow-card-i1",
    "answer-flow-card-i3",
    "answer-flow-card-done",
  ]);
});

test("answering the current question keeps it, even when the document already shows it answered", async () => {
  const { ctx, view, render, backlog } = await flowSetup(3);

  get(render(), "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  const answeredBacklog = recordAnswer(backlog, "i1", "No");
  host.files.set(DOC, JSON.stringify(answeredBacklog));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  // The read that follows the CLI's write lands first: while the answer is in flight the flow
  // leaves its own question alone, then keeps it when it moves on.
  view.reconcileAnswerFlow("alpha", { kind: "loaded", backlog: answeredBacklog });
  expect([view.answerFlow?.ids, view.answerFlow?.current]).toEqual([["i1", "i2", "i3"], 0]);
  view.doc = { kind: "loaded", backlog: answeredBacklog };
  await settle();

  expect(view.answerFlowMotion?.action).toBe("answered");
  expect(view.answerFlowMotion?.targetFlow?.answered).toEqual(["i1"]);
  expect(view.answerFlow?.ids).toEqual(["i1", "i2", "i3"]);
});

test("a question answered in the flow is read-only on Back: the answer on record, sized to its content", async () => {
  const { ctx, view, render, root: measured, backlog } = await flowSetup(2);
  const expandedWidth = 360 * ANSWER_CAROUSEL.compactWidthRatio;

  get(measured, "answer-flow-ask-i1-option-1").click!({}, ctx.cx);
  const answeredBacklog = recordAnswer(backlog, "i1", "No");
  host.files.set(DOC, JSON.stringify(answeredBacklog));
  get(render(), "answer-flow-ask-i1-answer-submit").click!({}, ctx.cx);
  await settle();
  reportSize(render(), "answer-flow-measure-expanded-i1", ctx.cx, 100, expandedWidth);
  ctx.tick(600);
  await settle();
  expect(view.answerFlow?.ids).toEqual(["i1", "i2"]);
  get(render(), "answer-flow-card-i1").click!({}, ctx.cx);
  const root = render();

  expect(text(get(root, "answer-flow-detail-i1-answered"))).toBe("Answered: No");
  expect(get(root, "answer-flow-card-i1").styles.h).toBe(100);
  expect(text(get(root, "answer-flow-preview-i1"))).toContain("Question 1?");
});

test("a missing item's card still says the question is unavailable", async () => {
  const { view, render, backlog } = await flowSetup(3);

  view.doc = {
    kind: "loaded",
    backlog: { ...backlog, items: backlog.items.filter((item) => item.id !== "i2") },
  };
  const root = render();

  expect(text(get(root, "answer-flow-measure-expanded-i2-detail-missing"))).toBe(
    "Question unavailable. Go back to the domain.",
  );
});
