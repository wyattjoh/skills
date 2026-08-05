import { describe, expect, it as test } from "bun:test";
import {
  createValidationReport,
  extractMermaidBlocks,
  validateContent,
  validateMermaid,
} from "./validate.ts";

describe("extractMermaidBlocks", () => {
  test("extracts fenced diagrams with source line numbers", () => {
    const markdown = [
      "# Architecture",
      "",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "~~~mermaid",
      "sequenceDiagram",
      "  A->>B: Hello",
      "~~~",
    ].join("\n");

    expect(extractMermaidBlocks(markdown)).toEqual([
      { code: "flowchart TD\n  A --> B", startLine: 4, endLine: 5 },
      { code: "sequenceDiagram\n  A->>B: Hello", startLine: 9, endLine: 10 },
    ]);
  });
});

describe("validateMermaid", () => {
  test("returns the detected diagram type for valid syntax", async () => {
    expect(await validateMermaid("flowchart TD\n  A --> B")).toEqual({
      index: 1,
      startLine: 1,
      endLine: 2,
      valid: true,
      diagramType: "flowchart-v2",
      error: undefined,
    });
  });

  test("validates flowchart labels that require DOM sanitization", async () => {
    const result = await validateMermaid("flowchart TD\n  S1[hello] --> S2[ok]");

    expect(result.valid).toBe(true);
    expect(result.diagramType).toBe("flowchart-v2");
    expect(result.error).toBeUndefined();
  });

  test("validates state diagrams that require DOM sanitization", async () => {
    const result = await validateMermaid("stateDiagram-v2\n  [*] --> Idle");

    expect(result.valid).toBe(true);
    expect(result.diagramType).toBe("stateDiagram");
    expect(result.error).toBeUndefined();
  });

  test("normalizes parser errors with source locations", async () => {
    const result = await validateMermaid("flowchart TD\n  A -->", "README.md", 2, 10);

    expect(result.valid).toBe(false);
    expect(result.error?.path).toBe("README.md");
    expect(result.error?.diagram).toBe(2);
    expect(result.error?.line).toBe(12);
    expect(result.error?.column).toBe(4);
    expect(result.error?.message.startsWith("Parse error on line 3:")).toBe(true);
  });
});

describe("validateContent", () => {
  test("validates every Mermaid block in Markdown", async () => {
    const result = await validateContent(
      [
        "# Architecture",
        "",
        "```mermaid",
        "flowchart TD",
        "  A --> B",
        "```",
        "",
        "```mermaid",
        "flowchart TD",
        "  A -->",
        "```",
      ].join("\n"),
      "README.md",
    );

    expect(result.path).toBe("README.md");
    expect(result.sourceType).toBe("markdown");
    expect(result.valid).toBe(false);
    expect(result.diagrams.length).toBe(2);
    expect(result.diagrams[0]?.valid).toBe(true);
    expect(result.diagrams[1]?.error?.line).toBe(11);
  });

  test("reports Markdown files without Mermaid blocks", async () => {
    expect(await validateContent("# No diagrams", "README.md")).toEqual({
      path: "README.md",
      sourceType: "markdown",
      valid: true,
      diagrams: [],
    });
  });
});

describe("createValidationReport", () => {
  test("flattens diagram errors", async () => {
    const file = await validateContent("flowchart TD\n  A -->", "diagram.mmd");
    const report = createValidationReport([file]);

    expect(report.valid).toBe(false);
    expect(report.files.length).toBe(1);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]?.path).toBe("diagram.mmd");
  });
});
