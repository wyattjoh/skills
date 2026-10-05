import { describe, expect, it } from "bun:test";
import { type Reference, updateReferences } from "./table.ts";

const reference: Reference = {
  dependency: "next",
  version: "15.1.0",
  path: ".claude/references/next.js",
  url: "https://github.com/vercel/next.js.git",
  commit: "a".repeat(40),
};
const table = `| Dependency | Version | Path |
| ---------- | ------- | ---- |
| next | 15.1.0 | \`.claude/references/next.js\` |`;

describe("Dependency References table", () => {
  it("creates a document or appends a missing section", () => {
    expect(updateReferences("", reference)).toBe(`## Dependency References\n\n${table}\n`);
    expect(updateReferences("# Project\n", reference)).toBe(
      `# Project\n\n## Dependency References\n\n${table}\n`,
    );
  });

  it("inserts a table under an existing heading without losing prose", () => {
    expect(
      updateReferences("# Project\n\n### Dependency References\n\nLocal sources.\n", reference),
    ).toBe(`# Project\n\n### Dependency References\n\n${table}\n\n\nLocal sources.\n`);
  });

  it("replaces by normalized path, deduplicates, sorts, and preserves adjacent sections", () => {
    const document = `# Project

## Dependency References

| Dependency | Version | Path |
| ---------- | ------- | ---- |
| zebra | 1 | \`.claude/references/zebra\` |
| old-next | 14 | \`.claude/references/next.js/\` |
| duplicate | 14 | \`.claude/references/next.js\` |
| alpha | 1 | \`.claude/references/alpha\` |

Keep this paragraph.

## Other

Keep this section.
`;
    expect(updateReferences(document, reference)).toBe(`# Project

## Dependency References

| Dependency | Version | Path |
| ---------- | ------- | ---- |
| alpha | 1 | \`.claude/references/alpha\` |
| next | 15.1.0 | \`.claude/references/next.js\` |
| zebra | 1 | \`.claude/references/zebra\` |

Keep this paragraph.

## Other

Keep this section.
`);
  });

  it("preserves extra columns and refreshes Repository and Pin", () => {
    const document = `## Dependency References

| Dependency | Version / Tag | Path | Repository | Pin (commit SHA) | Notes |
| ---------- | ------------- | ---- | ---------- | ---------------- | ----- |
| next | 14 | \`.claude/references/next.js\` | old-url | old-pin | Keep |
`;
    expect(updateReferences(document, reference)).toBe(`## Dependency References

| Dependency | Version / Tag | Path | Repository | Pin (commit SHA) | Notes |
| ---------- | ------------- | ---- | ---------- | ---------------- | ----- |
| next | 15.1.0 | \`.claude/references/next.js\` | https://github.com/vercel/next.js.git | \`${reference.commit}\` | Keep |
`);
  });

  it("preserves CRLF and is idempotent", () => {
    const document = `## Dependency References\r\n\r\n${table.replaceAll("\n", "\r\n")}\r\n`;
    expect(updateReferences(document, reference)).toBe(document);
  });

  it("rejects unsupported and ambiguous tables", () => {
    expect(() =>
      updateReferences("## Dependency References\n| Name | Path |\n| --- | --- |\n", reference),
    ).toThrow("needs Dependency, Version, and Path columns");
    expect(() =>
      updateReferences("## Dependency References\n## Dependency References\n", reference),
    ).toThrow("multiple Dependency References sections");
    expect(() =>
      updateReferences(`## Dependency References\n${table}\n\n${table}\n`, reference),
    ).toThrow("multiple tables");
    expect(() =>
      updateReferences(`## Dependency References\n${table}\n| broken |\n`, reference),
    ).toThrow("malformed row");
  });

  it("rejects Markdown injection", () => {
    expect(() => updateReferences("", { ...reference, dependency: "next | extra" })).toThrow(
      "cannot contain pipes",
    );
  });
});
