import { describe, expect, it } from "bun:test";
import { parseJsonStringArray } from "./json.ts";

describe("parseJsonStringArray", () => {
  it("returns the string members of a JSON array", () => {
    expect(parseJsonStringArray('["claude-sonnet-4-6", 42, null, "claude-opus-5"]')).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-5",
    ]);
  });

  it("returns an empty array for invalid or non-array JSON", () => {
    expect(parseJsonStringArray('{"model":"claude-sonnet-4-6"}')).toEqual([]);
    expect(parseJsonStringArray("not json")).toEqual([]);
  });
});
