import { describe, it as test, expect } from "bun:test";
import { generateHtml } from "./render.ts";

describe("generateHtml", () => {
  test("produces valid HTML structure", () => {
    const html = generateHtml("flowchart TD\n  A --> B");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('id="diagram-container"');
    expect(html).toContain("mermaid.esm.min.mjs");
  });

  test("includes svg-pan-zoom library", () => {
    const html = generateHtml("flowchart TD\n  A --> B");

    expect(html).toContain("svg-pan-zoom@3.6.1");
    expect(html).toContain("svgPanZoom(");
  });

  test("uses mermaid.render instead of startOnLoad", () => {
    const html = generateHtml("flowchart TD\n  A --> B");

    expect(html).toContain("startOnLoad: false");
    expect(html).toContain('mermaid.render("mermaid-svg"');
  });

  test("embeds mermaid code in output", () => {
    const code = "sequenceDiagram\n  Alice->>Bob: Hello";
    const html = generateHtml(code);

    expect(html).toContain("sequenceDiagram");
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
  });

  test("escapes backticks for template literal embedding", () => {
    const code = "A[`code block`] --> B";
    const html = generateHtml(code);

    expect(html).toContain("\\`code block\\`");
  });

  test("escapes template literal interpolation", () => {
    const code = 'A["${dangerous}"] --> B';
    const html = generateHtml(code);

    expect(html).toContain("\\${dangerous}");
  });

  test("respects theme option", () => {
    const html = generateHtml("graph LR\n  A --> B", { theme: "dark" });

    expect(html).toContain('theme: "dark"');
    expect(html).toContain("background: #1a1a2e");
    expect(html).toContain("color: #e0e0e0");
  });

  test("uses default theme when none specified", () => {
    const html = generateHtml("graph LR\n  A --> B");

    expect(html).toContain('theme: "default"');
    expect(html).toContain("background: #ffffff");
  });
});
