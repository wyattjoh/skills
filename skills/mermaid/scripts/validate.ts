#!/usr/bin/env bun

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Data, Effect } from "effect";

// Mermaid captures DOMPurify when it loads, so browser globals must exist before it is imported.
GlobalRegistrator.register();

type Mermaid = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return mermaidPromise;
}

/**
 * Supported source formats for Mermaid validation.
 */
export type SourceType = "markdown" | "mermaid";

/**
 * A normalized Mermaid syntax error.
 */
export type ValidationError = {
  path: string;
  diagram: number;
  line: number;
  column: number | undefined;
  message: string;
};

/**
 * The validation result for one Mermaid diagram.
 */
export type DiagramValidation = {
  index: number;
  startLine: number;
  endLine: number;
  valid: boolean;
  diagramType: string | undefined;
  error: ValidationError | undefined;
};

/**
 * The validation result for one input file or stdin stream.
 */
export type FileValidation = {
  path: string;
  sourceType: SourceType;
  valid: boolean;
  diagrams: DiagramValidation[];
};

/**
 * The complete structured validation report.
 */
export type ValidationReport = {
  valid: boolean;
  files: FileValidation[];
  errors: ValidationError[];
};

type MermaidParserError = Error & {
  hash?: {
    line?: number;
    loc?: {
      first_column?: number;
    };
  };
};

type ExtractedDiagram = {
  code: string;
  startLine: number;
  endLine: number;
};

class InputReadError extends Data.TaggedError("InputReadError")<{
  path: string;
  cause: unknown;
}> {}

/**
 * Extract Mermaid fenced code blocks from Markdown.
 *
 * @param markdown - Markdown source that may contain Mermaid fences.
 * @returns Mermaid blocks with their source line ranges.
 */
export function extractMermaidBlocks(markdown: string): ExtractedDiagram[] {
  const lines = markdown.split(/\r?\n/);
  const diagrams: ExtractedDiagram[] = [];

  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index]?.match(/^\s*(`{3,}|~{3,})\s*mermaid\s*$/i);
    if (!opening) {
      continue;
    }

    const marker = opening[1];
    const closingPattern = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
    const startLine = index + 2;
    const codeLines: string[] = [];
    index++;

    while (index < lines.length && !closingPattern.test(lines[index] ?? "")) {
      codeLines.push(lines[index] ?? "");
      index++;
    }

    diagrams.push({
      code: codeLines.join("\n"),
      startLine,
      endLine: startLine + Math.max(codeLines.length - 1, 0),
    });
  }

  return diagrams;
}

function parserLocation(error: unknown): { relativeLine: number; column: number | undefined } {
  if (!(error instanceof Error)) {
    return { relativeLine: 0, column: undefined };
  }

  const parserError = error as MermaidParserError;
  return {
    relativeLine: parserError.hash?.line ?? 0,
    column:
      parserError.hash?.loc?.first_column === undefined
        ? undefined
        : parserError.hash.loc.first_column + 1,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate Mermaid source without rendering it.
 *
 * @param code - Mermaid diagram source.
 * @param path - Source path used in diagnostics.
 * @param diagram - One-based diagram index within the source.
 * @param startLine - One-based line where the Mermaid source begins.
 * @returns A structured validation result.
 */
export async function validateMermaid(
  code: string,
  path = "<stdin>",
  diagram = 1,
  startLine = 1,
): Promise<DiagramValidation> {
  const lines = code.split(/\r?\n/);
  const endLine = startLine + Math.max(lines.length - 1, 0);

  try {
    const mermaid = await loadMermaid();
    const parsed = await mermaid.parse(code);
    return {
      index: diagram,
      startLine,
      endLine,
      valid: true,
      diagramType: parsed.diagramType,
      error: undefined,
    };
  } catch (cause) {
    const location = parserLocation(cause);
    const error: ValidationError = {
      path,
      diagram,
      line: startLine + location.relativeLine,
      column: location.column,
      message: errorMessage(cause),
    };

    return {
      index: diagram,
      startLine,
      endLine,
      valid: false,
      diagramType: undefined,
      error,
    };
  }
}

function sourceTypeFor(path: string, content: string): SourceType {
  if (/\.(?:md|mdx|markdown)$/i.test(path) || /^\s*(`{3,}|~{3,})\s*mermaid\s*$/im.test(content)) {
    return "markdown";
  }

  return "mermaid";
}

/**
 * Validate Mermaid diagrams in Mermaid source or Markdown fenced blocks.
 *
 * @param content - File or stdin content.
 * @param path - Source path used in the report.
 * @returns A structured file validation result.
 */
export async function validateContent(content: string, path = "<stdin>"): Promise<FileValidation> {
  const sourceType = sourceTypeFor(path, content);
  const extracted =
    sourceType === "markdown"
      ? extractMermaidBlocks(content)
      : [{ code: content.trim(), startLine: 1, endLine: content.split(/\r?\n/).length }];
  const diagrams: DiagramValidation[] = [];
  for (const [index, { code, startLine }] of extracted.entries()) {
    diagrams.push(await validateMermaid(code, path, index + 1, startLine));
  }

  return {
    path,
    sourceType,
    valid: diagrams.every((diagram) => diagram.valid),
    diagrams,
  };
}

/**
 * Combine file validation results into one report.
 *
 * @param files - Per-file validation results.
 * @returns A report with flattened errors.
 */
export function createValidationReport(files: FileValidation[]): ValidationReport {
  const errors = files.flatMap((file) =>
    file.diagrams.flatMap((diagram) => (diagram.error === undefined ? [] : [diagram.error])),
  );

  return {
    valid: files.every((file) => file.valid),
    files,
    errors,
  };
}

function readInput(path: string): Effect.Effect<string, InputReadError> {
  return Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) => new InputReadError({ path, cause }),
  });
}

function program(args: string[]): Effect.Effect<ValidationReport, InputReadError> {
  if (args.length === 0) {
    return Effect.tryPromise({
      try: () => Bun.stdin.text(),
      catch: (cause) => new InputReadError({ path: "<stdin>", cause }),
    }).pipe(
      Effect.flatMap((content) => Effect.promise(() => validateContent(content))),
      Effect.map((file) => createValidationReport([file])),
    );
  }

  return Effect.forEach(args, (path) =>
    readInput(path).pipe(
      Effect.flatMap((content) => Effect.promise(() => validateContent(content, path))),
    ),
  ).pipe(Effect.map(createValidationReport));
}

async function main(): Promise<void> {
  const report = await Effect.runPromise(
    program(Bun.argv.slice(2)).pipe(
      Effect.catchTag("InputReadError", (error) =>
        Effect.succeed<ValidationReport>({
          valid: false,
          files: [],
          errors: [
            {
              path: error.path,
              diagram: 0,
              line: 0,
              column: undefined,
              message: errorMessage(error.cause),
            },
          ],
        }),
      ),
    ),
  );

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.valid ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
