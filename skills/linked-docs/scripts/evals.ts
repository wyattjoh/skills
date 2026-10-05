import { type Policy } from "./retrieve.ts";

/**
 * A human-reviewed source/span expectation, not an AI-generated answer grade.
 */
export type EvalCase = {
  id: string;
  index: string;
  question: string;
  rationale: string;
  expected: { kind: "evidence"; url: string; includes: string[] } | { kind: "abstain" };
};

/**
 * Comparable routing budgets with the same evidence threshold and algorithm.
 */
export const PROFILES: Record<string, Policy> = {
  baseline: { beam: 3, pages: 6, threshold: 0.6 },
  balanced: { beam: 2, pages: 3, threshold: 0.6 },
  narrow: { beam: 1, pages: 1, threshold: 0.6 },
};

const index = "https://zed.dev/docs/llms.txt";

/**
 * Four source-grounded positives and two indexed-corpus abstention controls.
 * Review labels when corpus hashes change; these are not whole-web assertions.
 */
export const EVALS: EvalCase[] = [
  {
    id: "lsp-binary",
    index,
    question: "How do I override a language server's executable path and startup arguments in Zed?",
    rationale: "The custom-binary example supplies both fields in the same source excerpt.",
    expected: {
      kind: "evidence",
      url: "https://zed.dev/docs/configuring-languages.md",
      includes: ['"binary"', '"path"', '"arguments"'],
    },
  },
  {
    id: "python-indent",
    index,
    question:
      "How can I override Python's indentation tab size without changing every language in Zed?",
    rationale: "The language-specific example puts Python's tab_size under languages.",
    expected: {
      kind: "evidence",
      url: "https://zed.dev/docs/configuring-languages.md",
      includes: ['"languages"', '"Python"', '"tab_size"'],
    },
  },
  {
    id: "rust-check-on-save",
    index,
    question: "How do I disable rust-analyzer's check-on-save in Zed?",
    rationale: "The Rust guide explicitly documents checkOnSave: false.",
    expected: {
      kind: "evidence",
      url: "https://zed.dev/docs/languages/rust.md",
      includes: ["checkOnSave", "false"],
    },
  },
  {
    id: "local-mcp",
    index,
    question: "How do I configure a local MCP server's command and arguments in Zed?",
    rationale: "The MCP configuration example supplies context_servers, command, and args.",
    expected: {
      kind: "evidence",
      url: "https://zed.dev/docs/ai/mcp.md",
      includes: ['"context_servers"', '"command"', '"args"'],
    },
  },
  {
    id: "lean-missing",
    index,
    question: "How do I enable and configure the Lean 4 language server in Zed?",
    rationale:
      "The reviewed index has no Lean-specific guide; generic LSP settings do not establish Lean's extension setup. The external extension README is outside this corpus.",
    expected: { kind: "abstain" },
  },
  {
    id: "invented-setting",
    index,
    question: "How do I enable Zed's teleport_edit setting?",
    rationale:
      "A deliberately invented setting tests whether topical configuration snippets are mistaken for answers.",
    expected: { kind: "abstain" },
  },
];

/**
 * Minimal result seam for grading existing or future retrieval strategies.
 */
export type EvidenceResult = {
  status: string;
  warnings: string[];
  passages: { url: string; text: string; verified: boolean }[];
};

/**
 * Observable retrieval quality, including precision among returned accepted spans.
 */
export type Grade = {
  pass: boolean;
  accepted: number;
  matched: number;
  reason: string;
};

/**
 * Grade a result using one verified source span containing all required strings.
 * Generic snippets, combined fragments, fetch warnings, and errors cannot pass.
 */
export function grade(result: EvidenceResult, expected: EvalCase["expected"]): Grade {
  const accepted = result.passages.filter((passage) => passage.verified);
  if (result.warnings.length)
    return {
      pass: false,
      accepted: accepted.length,
      matched: 0,
      reason: "incomplete source coverage",
    };
  if (expected.kind === "abstain") {
    const pass = result.status === "insufficient_evidence" && accepted.length === 0;
    return {
      pass,
      accepted: accepted.length,
      matched: 0,
      reason: pass ? "correct abstention" : "unsupported evidence accepted",
    };
  }
  const matched = accepted.filter(
    (passage) =>
      passage.url === expected.url &&
      expected.includes.every((text) => passage.text.toLowerCase().includes(text.toLowerCase())),
  ).length;
  const pass = result.status === "evidence" && matched > 0;
  return {
    pass,
    accepted: accepted.length,
    matched,
    reason: pass ? "gold source and span found" : "gold source/span missing",
  };
}
