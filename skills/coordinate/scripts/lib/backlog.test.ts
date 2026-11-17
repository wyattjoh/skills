import { describe, expect, it } from "bun:test";
import {
  appendToSection,
  dueItems,
  missingSections,
  namesSession,
  replaceSection,
  section,
  sections,
  template,
} from "./backlog.ts";

const text = `# app backlog

## Boundary

- Owns: \`~/Code/my repo\` and /srv/app.
- Adjacent: ~/Code/lib,

## Open

\`\`\`md
## Not a heading
\`\`\`
- **Fix** due: 2026-11-10. Session 0b9c2a51-0000.
- Later due 2026-12-01
- same line

## Done

- same line
`;

describe("sections", () => {
  it("ignores headings inside code fences", () => {
    expect(sections(text).map((found) => found.heading)).toEqual(["Boundary", "Open", "Done"]);
  });

  it("returns a section body", () => {
    expect(section(text, "Done")).toBe("\n- same line\n");
    expect(section(text, "Standing yes")).toBe(undefined);
  });

  it("replaces by offset, leaving identical text in other sections", () => {
    const next = replaceSection(text, "Done", "\n- other\n") ?? "";
    expect(section(next, "Done")).toBe("\n- other\n");
    expect(section(next, "Open")).toBe(section(text, "Open"));
  });

  it("appends a line to a section", () => {
    const next = appendToSection(text, "Done", "- new") ?? "";
    expect(section(next, "Done")).toBe("\n- same line\n- new\n\n");
  });

  it("lists missing sections in order", () => {
    expect(missingSections(text)).toEqual(["Standing yes"]);
    expect(missingSections(template("app"))).toEqual([]);
  });
});

describe("dueItems", () => {
  it("returns open items due on or before today", () => {
    expect(dueItems(text, "2026-11-16")).toEqual([
      { date: "2026-11-10", text: "**Fix** due: 2026-11-10. Session 0b9c2a51-0000." },
    ]);
  });
});

describe("namesSession", () => {
  it("matches the first 8 characters", () => {
    expect(namesSession(text, "0b9c2a51-0000-4000-8000-000000000001")).toBe(true);
    expect(namesSession(text, "short")).toBe(false);
  });
});
