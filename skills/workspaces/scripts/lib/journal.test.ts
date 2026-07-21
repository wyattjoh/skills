import { describe, expect, it } from "bun:test";
import { appendEntry, parseCategory, renderEntry } from "./journal.ts";

const PREAMBLE = `# Journal

Deviation-driven log for this workspace.
`;

describe("parseCategory", () => {
  it("accepts every known category", () => {
    expect(parseCategory("decision")).toBe("decision");
    expect(parseCategory("deviation")).toBe("deviation");
    expect(parseCategory("scope")).toBe("scope");
    expect(parseCategory("cross-repo")).toBe("cross-repo");
  });

  it("returns undefined for unknown categories", () => {
    expect(parseCategory("misc")).toBeUndefined();
  });
});

describe("renderEntry", () => {
  it("renders title, links, and body", () => {
    expect(
      renderEntry({
        category: "deviation",
        title: "Dropped payments phase 1 API change",
        links: ["adr/0003", "phase 1", "acme/payments#42"],
        body: "The API change moved to phase 2 after load testing.",
      }),
    ).toBe(
      `### Deviation: Dropped payments phase 1 API change\n\n**Links:** adr/0003, phase 1, acme/payments#42\n\nThe API change moved to phase 2 after load testing.`,
    );
  });

  it("renders a minimal entry without links or body", () => {
    expect(
      renderEntry({
        category: "decision",
        title: "Adopt squash merges",
        links: [],
        body: undefined,
      }),
    ).toBe("### Decision: Adopt squash merges");
  });
});

describe("appendEntry", () => {
  const entry = {
    category: "decision" as const,
    title: "Adopt squash merges",
    links: ["adr/0001"],
    body: undefined,
  };

  it("creates the first date section under the preamble", () => {
    expect(appendEntry(PREAMBLE, entry, "2026-07-15")).toBe(
      `# Journal

Deviation-driven log for this workspace.

## 2026-07-15

### Decision: Adopt squash merges

**Links:** adr/0001
`,
    );
  });

  it("appends to an existing section for the same date", () => {
    const existing = `${PREAMBLE}
## 2026-07-15

### Decision: Earlier decision
`;
    expect(appendEntry(existing, entry, "2026-07-15")).toBe(
      `# Journal

Deviation-driven log for this workspace.

## 2026-07-15

### Decision: Earlier decision

### Decision: Adopt squash merges

**Links:** adr/0001
`,
    );
  });

  it("inserts a new date section ahead of older ones", () => {
    const existing = `${PREAMBLE}
## 2026-07-10

### Deviation: Old deviation
`;
    expect(appendEntry(existing, entry, "2026-07-15")).toBe(
      `# Journal

Deviation-driven log for this workspace.

## 2026-07-15

### Decision: Adopt squash merges

**Links:** adr/0001

## 2026-07-10

### Deviation: Old deviation
`,
    );
  });
});
