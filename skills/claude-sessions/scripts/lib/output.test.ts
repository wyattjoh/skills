import { describe, expect, it } from "bun:test";
import {
  buildDocument,
  parseJsonValue,
  renderOptionsFromFlags,
  renderOutput,
  toIsoTimestamp,
} from "./output.ts";

describe("shared output helpers", () => {
  it("parses JSON values and leaves plain text unchanged", () => {
    expect(parseJsonValue('{"name":"value"}')).toEqual({ name: "value" });
    expect(parseJsonValue("plain text")).toBe("plain text");
  });

  it("normalizes valid timestamps and clears missing or invalid values", () => {
    expect(toIsoTimestamp("2026-01-01T01:00:00+01:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(toIsoTimestamp(null)).toBe(null);
    expect(toIsoTimestamp("not-a-timestamp")).toBe(null);
  });

  it("turns parsed table and redaction flags into render options", () => {
    expect(renderOptionsFromFlags({ table: true, redact: false })).toEqual({
      table: true,
      redact: false,
    });
  });
});

describe("buildDocument", () => {
  it("wraps rows with a command name and count", () => {
    expect(buildDocument("projects", [{ dir: "a" }, { dir: "b" }])).toEqual({
      command: "projects",
      count: 2,
      rows: [{ dir: "a" }, { dir: "b" }],
    });
  });

  it("omits the judge key when no judge is given", () => {
    const document = buildDocument("projects", []);
    expect(Object.keys(document)).toEqual(["command", "count", "rows"]);
  });

  it("includes the judge key when a judge is given", () => {
    const document = buildDocument("interruptions", [], { status: "skipped" });
    expect(document).toEqual({
      command: "interruptions",
      count: 0,
      judge: { status: "skipped" },
      rows: [],
    });
  });
});

describe("renderOutput", () => {
  it("renders JSON by default", () => {
    const document = buildDocument("projects", [{ dir: "myapp" }]);
    expect(renderOutput(document)).toBe(JSON.stringify(document, null, 2));
  });

  it("redacts secrets in JSON output by default", () => {
    const document = buildDocument("search", [{ text: "KEY=abcd1234efgh" }]);
    const rendered = JSON.parse(renderOutput(document));
    expect(rendered.rows).toEqual([{ text: "KEY=[redacted:env-secret]" }]);
  });

  it("leaves secrets untouched when redact is disabled", () => {
    const document = buildDocument("search", [{ text: "KEY=abcd1234efgh" }]);
    const rendered = JSON.parse(renderOutput(document, { redact: false }));
    expect(rendered.rows).toEqual([{ text: "KEY=abcd1234efgh" }]);
  });

  it("renders a table with a header, separator, and one line per row", () => {
    const document = buildDocument("projects", [
      { dir: "myapp", sessions: 3 },
      { dir: "other", sessions: 12 },
    ]);
    expect(renderOutput(document, { table: true })).toBe(
      ["dir    sessions", "-----  --------", "myapp  3       ", "other  12      "].join("\n"),
    );
  });

  it("renders a placeholder line for an empty table", () => {
    const document = buildDocument("projects", []);
    expect(renderOutput(document, { table: true })).toBe("projects: 0 rows");
  });

  it("redacts secrets in table output too", () => {
    const document = buildDocument("search", [{ text: "KEY=abcd1234efgh" }]);
    expect(renderOutput(document, { table: true })).toBe(
      ["text                     ", "-------------------------", "KEY=[redacted:env-secret]"].join(
        "\n",
      ),
    );
  });

  it("escapes embedded newlines so a multi-line cell cannot break column alignment", () => {
    const document = buildDocument("messages", [{ text: "line one\nline two" }]);
    expect(renderOutput(document, { table: true })).toBe(
      ["text              ", "------------------", "line one\\nline two"].join("\n"),
    );
  });

  it("renders a table for a large row count without overflowing the call stack", () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ n: i }));
    const document = buildDocument("sql", rows);
    const rendered = renderOutput(document, { table: true });
    expect(rendered.split("\n")).toHaveLength(200_002);
  });
});
