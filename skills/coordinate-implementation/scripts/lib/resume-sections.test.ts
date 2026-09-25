import { describe, expect, it } from "bun:test";
import {
  appendSectionLine,
  readFieldBlock,
  readRoleBlock,
  readTicketRow,
  readTicketRows,
  sectionBounds,
  sectionText,
  ticketRows,
  updateTicketCells,
} from "./resume-sections.ts";

const STATE = [
  "# Run",
  "",
  "## Tickets",
  "",
  "| NN | harness | status | sha |",
  "| -- | ------- | ------ | --- |",
  "| 01 | claude | queued | - |",
  "| 02 | pi | landed | abc |",
  "",
  "## Decisions",
  "",
  "- first",
  "",
].join("\n");

describe("sections", () => {
  it("locates a section and its body", () => {
    const bounds = sectionBounds(STATE, "Decisions");

    expect(bounds).toEqual({
      start: STATE.indexOf("## Decisions"),
      contentStart: STATE.indexOf("## Decisions") + "## Decisions".length,
      end: STATE.length,
    });
    expect(sectionText(STATE, "Decisions")).toBe("\n\n- first\n");
    expect(sectionText(STATE, "Missing")).toBe(null);
  });

  it("treats regular expression characters in names literally", () => {
    expect(sectionBounds("## A.B\n", "A+B")).toBe(null);
    expect(sectionText("## A+B\nbody\n", "A+B")).toBe("\nbody\n");
  });

  it("appends with blank or tight spacing and ignores duplicates", () => {
    expect(appendSectionLine(STATE, "Decisions", "- second", { spacing: "blank" })).toBe(
      `${STATE}\n- second\n`,
    );
    expect(appendSectionLine(STATE, "Decisions", "- second", { spacing: "tight" })).toBe(
      `${STATE.trimEnd()}\n- second\n`,
    );
    expect(appendSectionLine(STATE, "Decisions", "- first", { spacing: "tight" })).toBe(STATE);
  });

  it("keeps a blank line before the following section", () => {
    const updated = appendSectionLine(STATE, "Tickets", "note", { spacing: "tight" });

    expect(updated).toBe(
      STATE.replace("| 02 | pi | landed | abc |\n", "| 02 | pi | landed | abc |\nnote\n"),
    );
  });

  it("creates a missing section before an anchor or at the end", () => {
    expect(
      appendSectionLine(STATE, "Review evidence", "- e", { spacing: "tight", before: "Decisions" }),
    ).toBe(STATE.replace("## Decisions", "## Review evidence\n\n- e\n\n## Decisions"));
    expect(appendSectionLine(STATE, "Landed evidence", "- l", { spacing: "blank" })).toBe(
      `${STATE}\n## Landed evidence\n\n- l\n`,
    );
  });
});

describe("ticket table", () => {
  it("reads rows keyed by header", () => {
    expect(ticketRows(STATE)).toEqual([
      { NN: "01", harness: "claude", status: "queued", sha: "-" },
      { NN: "02", harness: "pi", status: "landed", sha: "abc" },
    ]);
    expect(readTicketRow(STATE, "02")).toEqual({
      NN: "02",
      harness: "pi",
      status: "landed",
      sha: "abc",
    });
  });

  it("reports structural problems", () => {
    expect(readTicketRows("# Run\n")).toEqual({ kind: "section_missing" });
    expect(readTicketRows("## Tickets\n\nnone\n")).toEqual({ kind: "header_missing" });
    expect(ticketRows("# Run\n")).toEqual([]);
    expect(readTicketRow(STATE, "09")).toEqual({ kind: "row_missing" });
    expect(
      readTicketRow(STATE.replace("| 01 | claude | queued | - |", "| 01 | claude |"), "01"),
    ).toEqual({
      kind: "row_malformed",
    });
    expect(updateTicketCells(STATE, "01", { effort: "high" })).toEqual({
      kind: "column_missing",
      column: "effort",
    });
  });

  it("rewrites named cells and preserves carriage returns", () => {
    expect(updateTicketCells(STATE, "01", { status: "landed", sha: "def" })).toBe(
      STATE.replace("| 01 | claude | queued | - |", "| 01 | claude | landed | def |"),
    );
    const crlf = STATE.replaceAll("\n", "\r\n");

    expect(updateTicketCells(crlf, "02", { status: "closed" })).toBe(
      crlf.replace("| 02 | pi | landed | abc |", "| 02 | pi | closed | abc |"),
    );
  });
});

describe("field and role blocks", () => {
  const ROLE = "Implementor:\n  harness: pi\n  model: gpt\n  effort: high\n";

  it("reads a complete role", () => {
    expect(readRoleBlock(ROLE, "Implementor")).toEqual({
      harness: "pi",
      model: "gpt",
      effort: "high",
    });
  });

  it("reports missing, duplicate, malformed, and incomplete blocks", () => {
    expect(readRoleBlock("# Run\n", "Implementor")).toBe("block_count");
    expect(readRoleBlock(`${ROLE}\n${ROLE}`, "Implementor")).toBe("block_count");
    expect(readRoleBlock(`${ROLE}  model: other\n`, "Implementor")).toBe("fields_malformed");
    expect(
      readRoleBlock("Implementor:\n  harness: vim\n  model: m\n  effort: e\n", "Implementor"),
    ).toBe("role_incomplete");
  });

  it("reads multi-word field names", () => {
    expect(
      readFieldBlock(
        "Coordinator ownership:\n  generation: 2\n  pane: w1\n",
        "Coordinator ownership",
      ),
    ).toEqual({
      generation: "2",
      pane: "w1",
    });
  });
});
