import { describe, expect, it as test } from "bun:test";
import {
  createValidationReport,
  extractMermaidBlocks,
  validateContent,
  validateMermaid,
  type ValidationReport,
} from "./validate.ts";

const TESTDATA_DIRECTORY = `${import.meta.dir}/testdata`;
const VALIDATE_SCRIPT = `${import.meta.dir}/validate.ts`;

async function validateFixture(name: string) {
  const path = `testdata/${name}`;
  return validateContent(await Bun.file(`${TESTDATA_DIRECTORY}/${name}`).text(), path);
}

async function runValidator(paths: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  report: ValidationReport;
}> {
  const child = Bun.spawn([process.execPath, VALIDATE_SCRIPT, ...paths], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return {
    exitCode,
    stdout,
    stderr,
    report: JSON.parse(stdout) as ValidationReport,
  };
}

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

describe("Markdown fixtures", () => {
  test("validates mixed diagram types and preserves source ranges", async () => {
    const result = await validateFixture("valid-mixed.md");

    expect(result.valid).toBe(true);
    expect(
      result.diagrams.map(({ startLine, endLine, diagramType }) => ({
        startLine,
        endLine,
        diagramType,
      })),
    ).toEqual([
      { startLine: 6, endLine: 9, diagramType: "flowchart-v2" },
      { startLine: 13, endLine: 17, diagramType: "sequence" },
      { startLine: 21, endLine: 24, diagramType: "stateDiagram" },
      { startLine: 28, endLine: 32, diagramType: "class" },
      { startLine: 36, endLine: 37, diagramType: "er" },
      { startLine: 41, endLine: 45, diagramType: "gantt" },
      { startLine: 49, endLine: 51, diagramType: "pie" },
      { startLine: 55, endLine: 59, diagramType: "gitGraph" },
      { startLine: 63, endLine: 66, diagramType: "mindmap" },
      { startLine: 70, endLine: 73, diagramType: "timeline" },
    ]);
  });

  test("snapshots multiple syntax failures with Markdown line numbers", async () => {
    expect(await validateFixture("invalid-multiple.md")).toMatchSnapshot();
  });

  test("accepts prose and ordinary code fences without Mermaid diagrams", async () => {
    expect(await validateFixture("no-mermaid.md")).toEqual({
      path: "testdata/no-mermaid.md",
      sourceType: "markdown",
      valid: true,
      diagrams: [],
    });
  });

  test("accepts an empty Markdown file", async () => {
    expect(await validateFixture("empty.md")).toEqual({
      path: "testdata/empty.md",
      sourceType: "markdown",
      valid: true,
      diagrams: [],
    });
  });

  test("parses case-insensitive tilde and longer backtick fences with CRLF", async () => {
    const result = await validateFixture("tilde-crlf.md");

    expect(result.valid).toBe(true);
    expect(
      result.diagrams.map(({ startLine, endLine, diagramType }) => ({
        startLine,
        endLine,
        diagramType,
      })),
    ).toEqual([
      { startLine: 4, endLine: 5, diagramType: "flowchart-v2" },
      { startLine: 9, endLine: 10, diagramType: "sequence" },
    ]);
  });

  test("validates Mermaid source through the end of an unclosed fence", async () => {
    const result = await validateFixture("unclosed-mermaid.md");

    expect(result.valid).toBe(true);
    expect(result.diagrams).toEqual([
      {
        index: 1,
        startLine: 6,
        endLine: 8,
        valid: true,
        diagramType: "flowchart-v2",
        error: undefined,
      },
    ]);
  });

  test("snapshots an empty Mermaid fence failure", async () => {
    expect(await validateFixture("empty-mermaid.md")).toMatchSnapshot();
  });
});

describe("validate CLI fixtures", () => {
  test("snapshots structured output for valid and diagram-free Markdown files", async () => {
    const result = await runValidator([
      "testdata/valid-mixed.md",
      "testdata/no-mermaid.md",
      "testdata/empty.md",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.report).toMatchSnapshot();
  });

  test("snapshots structured output and exit code for invalid Markdown files", async () => {
    const result = await runValidator([
      "testdata/invalid-multiple.md",
      "testdata/empty-mermaid.md",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.report).toMatchSnapshot();
  });
});
