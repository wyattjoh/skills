import { describe, expect, it } from "bun:test";
import { type DomainCheckResult, formatJson, formatTable, parseCli } from "./check-domains.ts";

// ── parseCli ─────────────────────────────────────────────────────────────────

describe("parseCli", () => {
  it("single name with default TLD", () => {
    const result = parseCli(["example"]);
    expect(result.names).toEqual(["example"]);
    expect(result.tlds).toEqual(["com"]);
    expect(result.json).toBe(false);
    expect(result.help).toBe(false);
  });

  it("multiple names", () => {
    const result = parseCli(["foo", "bar", "baz"]);
    expect(result.names).toEqual(["foo", "bar", "baz"]);
  });

  it("custom TLDs", () => {
    const result = parseCli(["--tlds=com,dev,io", "example"]);
    expect(result.tlds).toEqual(["com", "dev", "io"]);
  });

  it("json flag", () => {
    const result = parseCli(["--json", "example"]);
    expect(result.json).toBe(true);
  });

  it("help flag", () => {
    const result = parseCli(["--help"]);
    expect(result.help).toBe(true);
  });

  it("names are lowercased", () => {
    const result = parseCli(["MyProject", "ANOTHER"]);
    expect(result.names).toEqual(["myproject", "another"]);
  });

  it("TLDs are trimmed and lowercased", () => {
    const result = parseCli(["--tlds= COM , Dev ,IO ", "test"]);
    expect(result.tlds).toEqual(["com", "dev", "io"]);
  });

  it("no args gives empty names", () => {
    const result = parseCli([]);
    expect(result.names).toEqual([]);
    expect(result.tlds).toEqual(["com"]);
  });
});

// ── formatJson ───────────────────────────────────────────────────────────────

describe("formatJson", () => {
  it("available domain", () => {
    const results: DomainCheckResult[] = [{ domain: "example.com", status: "available" }];
    const output = JSON.parse(formatJson(results));
    expect(output.results.length).toBe(1);
    expect(output.results[0].domain).toBe("example.com");
    expect(output.results[0].available).toBe(true);
    expect(output.results[0].error).toBeUndefined();
  });

  it("registered domain", () => {
    const results: DomainCheckResult[] = [{ domain: "google.com", status: "registered" }];
    const output = JSON.parse(formatJson(results));
    expect(output.results[0].available).toBe(false);
  });

  it("unknown with error", () => {
    const results: DomainCheckResult[] = [
      { domain: "test.xyz", status: "unknown", error: "No RDAP server for .xyz" },
    ];
    const output = JSON.parse(formatJson(results));
    expect(output.results[0].available).toBe(false);
    expect(output.results[0].error).toBe("No RDAP server for .xyz");
  });

  it("multiple results", () => {
    const results: DomainCheckResult[] = [
      { domain: "foo.com", status: "available" },
      { domain: "foo.dev", status: "registered" },
      { domain: "foo.io", status: "unknown", error: "Timeout" },
    ];
    const output = JSON.parse(formatJson(results));
    expect(output.results.length).toBe(3);
  });
});

// ── formatTable ──────────────────────────────────────────────────────────────

describe("formatTable", () => {
  it("contains header and separator", () => {
    const results: DomainCheckResult[] = [{ domain: "test.com", status: "available" }];
    const table = formatTable(results);
    const lines = table.split("\n");
    expect(lines[0]).toBe("Domain              Status");
    expect(lines[1]).toBe("─".repeat(35));
  });

  it("available shows checkmark", () => {
    const results: DomainCheckResult[] = [{ domain: "test.com", status: "available" }];
    const table = formatTable(results);
    expect(table.includes("Available ✓")).toBe(true);
  });

  it("registered shows status", () => {
    const results: DomainCheckResult[] = [{ domain: "test.com", status: "registered" }];
    const table = formatTable(results);
    expect(table.includes("Registered")).toBe(true);
  });

  it("unknown with error", () => {
    const results: DomainCheckResult[] = [
      { domain: "test.xyz", status: "unknown", error: "No server" },
    ];
    const table = formatTable(results);
    expect(table.includes("Unknown (No server)")).toBe(true);
  });
});
