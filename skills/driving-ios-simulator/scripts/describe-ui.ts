#!/usr/bin/env bun
/**
 * describe-ui.ts [UDID]
 *
 * Print every labeled UI element on the booted simulator as:
 *   (centerX,centerY) [Type] 'AXLabel' = 'AXValue'   (offscreen ...)
 *
 * centerX/centerY are in POINTS and are exactly what `idb ui tap X Y` expects.
 * This is the agent's primary "find an element" tool: read the screen, then tap a
 * center coordinate by label instead of eyeballing a screenshot.
 *
 * Usage:
 *   bun scripts/describe-ui.ts [UDID]
 *
 * If no UDID is given, the first booted simulator is used.
 */

import { homedir } from "node:os";
import { Effect, Schema } from "effect";

// ─── Types ───────────────────────────────────────────────────

export interface AXFrame {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface AXElement {
  AXLabel?: string | null;
  AXValue?: string | null;
  type?: string;
  frame?: AXFrame;
}

export class DescribeUiError extends Schema.TaggedError<DescribeUiError>()("DescribeUiError", {
  detail: Schema.String,
}) {}

// ─── Pure helpers (unit-tested) ──────────────────────────────

/** Extract the first booted-simulator UDID from `simctl list devices booted`. */
export function extractUdid(output: string): string | null {
  const match = output.match(/[0-9A-Fa-f-]{36}/);
  return match ? match[0] : null;
}

/**
 * Screen height = the root window: the frame anchored at the origin (x==0, y==0)
 * with the largest height. Falls back to a common iPhone height when no root is
 * present so offscreen detection still works.
 */
export function screenHeight(els: AXElement[]): number {
  const roots = els.map((e) => e.frame).filter((f): f is AXFrame => !!f && f.x === 0 && f.y === 0);
  const heights = roots.map((r) => r.height ?? 0);
  return heights.length > 0 ? Math.max(...heights) : 956;
}

/** Python-style repr: single-quoted with backslash/quote escaping. */
function repr(value: string): string {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/**
 * Format the accessibility tree into one line per labeled element:
 *   (centerX,centerY) [Type] 'label' = 'value'
 */
export function formatElements(els: AXElement[]): string[] {
  const screenH = screenHeight(els);
  const lines: string[] = [];

  for (const el of els) {
    const label = el.AXLabel;
    const value = el.AXValue;
    if (!label && !value) continue;

    const f = el.frame ?? {};
    const x = f.x ?? 0;
    const y = f.y ?? 0;
    const cx = Math.trunc(x + (f.width ?? 0) / 2);
    const cy = Math.trunc(y + (f.height ?? 0) / 2);

    const off = y >= 0 && y <= screenH ? "" : "  (offscreen - scroll to reach)";
    const suffix = value ? ` = ${repr(value)}` : "";
    const labelStr = label == null ? "None" : repr(label);

    lines.push(
      `(${String(cx).padStart(4)},${String(cy).padStart(4)}) [${el.type}] ${labelStr}${suffix}${off}`,
    );
  }

  return lines;
}

const run = Effect.fn("describeUi.run")(function* (cmd: string[]) {
  return yield* Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(cmd, {
        env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(proc.stdout).text();
      return { stdout, code: await proc.exited };
    },
    catch: (cause) => new DescribeUiError({ detail: String(cause) }),
  });
});

export const describeUi = Effect.fn("describeUi")(function* (requestedUdid: string | undefined) {
  let udid = requestedUdid;
  if (!udid) {
    const booted = yield* run(["xcrun", "simctl", "list", "devices", "booted"]);
    udid = extractUdid(booted.stdout) ?? "";
  }
  if (!udid) return yield* new DescribeUiError({ detail: "no booted simulator" });

  const result = yield* run(["idb", "ui", "describe-all", "--udid", udid]);
  const elements = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as AXElement[],
    catch: () =>
      new DescribeUiError({
        detail: "failed to parse idb output (is idb_companion running? run idb-bootstrap.ts)",
      }),
  });
  return formatElements(elements);
});

if (import.meta.main) {
  const exit = await Effect.runPromise(
    describeUi(Bun.argv[2]).pipe(
      Effect.tap((lines) => Effect.sync(() => lines.forEach((line) => console.log(line)))),
      Effect.as(0),
      Effect.catchTag("DescribeUiError", (error) =>
        Effect.sync(() => {
          console.error(error.detail);
          return 1;
        }),
      ),
    ),
  );
  process.exit(exit);
}
