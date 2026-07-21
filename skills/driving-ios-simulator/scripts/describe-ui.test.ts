import { describe, expect, it } from "bun:test";
import { extractUdid, formatElements, screenHeight, type AXElement } from "./describe-ui.ts";

describe("extractUdid", () => {
  it("pulls the 36-char UDID from simctl output", () => {
    const out = "    iPhone 17 Pro Max (ABCDEF01-2345-6789-ABCD-EF0123456789) (Booted)";
    expect(extractUdid(out)).toBe("ABCDEF01-2345-6789-ABCD-EF0123456789");
  });

  it("returns null when no device is booted", () => {
    expect(extractUdid("== Devices ==\n")).toBeNull();
  });
});

describe("screenHeight", () => {
  it("uses the tallest origin-anchored window", () => {
    const els: AXElement[] = [
      { frame: { x: 0, y: 0, width: 440, height: 956 } },
      { frame: { x: 0, y: 0, width: 440, height: 100 } },
      { frame: { x: 10, y: 0, width: 440, height: 2000 } },
    ];
    expect(screenHeight(els)).toBe(956);
  });

  it("falls back to 956 when no root window is present", () => {
    expect(screenHeight([{ frame: { x: 10, y: 10, width: 1, height: 1 } }])).toBe(956);
  });
});

describe("formatElements", () => {
  it("emits center coords in points with label and value", () => {
    const els: AXElement[] = [
      { frame: { x: 0, y: 0, width: 440, height: 956 } },
      { AXLabel: "All", type: "Button", frame: { x: 20, y: 370, width: 46, height: 30 } },
      {
        AXLabel: "Name",
        AXValue: "Box 1",
        type: "TextField",
        frame: { x: 100, y: 200, width: 200, height: 40 },
      },
    ];
    expect(formatElements(els)).toEqual([
      "(  43, 385) [Button] 'All'",
      "( 200, 220) [TextField] 'Name' = 'Box 1'",
    ]);
  });

  it("marks elements below the screen as offscreen", () => {
    const els: AXElement[] = [
      { frame: { x: 0, y: 0, width: 440, height: 956 } },
      { AXLabel: "Bottom", type: "Cell", frame: { x: 0, y: 1200, width: 440, height: 50 } },
    ];
    expect(formatElements(els)).toEqual([
      "( 220,1225) [Cell] 'Bottom'  (offscreen - scroll to reach)",
    ]);
  });

  it("skips elements with neither label nor value", () => {
    const els: AXElement[] = [{ type: "Other", frame: { x: 0, y: 0, width: 10, height: 10 } }];
    expect(formatElements(els)).toEqual([]);
  });

  it("escapes single quotes in labels", () => {
    const els: AXElement[] = [
      { frame: { x: 0, y: 0, width: 440, height: 956 } },
      { AXLabel: "it's", type: "Button", frame: { x: 0, y: 0, width: 40, height: 40 } },
    ];
    expect(formatElements(els)).toEqual(["(  20,  20) [Button] 'it\\'s'"]);
  });
});
