import { describe, expect, it } from "bun:test";
import { matchesProjectIdentity, resolveProjectIdentity } from "./project-identity.ts";

describe("matchesProjectIdentity", () => {
  const identity = "/Users/example/Code/github.com/wyattjoh/skills";

  it("requires an exact match for a plain canonical path", () => {
    expect(matchesProjectIdentity(identity, identity)).toBe(true);
    expect(matchesProjectIdentity(identity, "skills")).toBe(false);
    expect(matchesProjectIdentity(`${identity}-private`, identity)).toBe(false);
  });

  it("supports case-sensitive shell-style globs", () => {
    expect(matchesProjectIdentity(identity, "/Users/*/Code/**/skills")).toBe(true);
    expect(matchesProjectIdentity(identity, "/users/*/skills")).toBe(false);
    expect(matchesProjectIdentity(identity, "/Users/example/Code/github.com/wyattjo?/skills")).toBe(
      true,
    );
    expect(
      matchesProjectIdentity(identity, "/Users/example/Code/github.com/wyattjo[h]/skills"),
    ).toBe(true);
  });
});

describe("resolveProjectIdentity", () => {
  it("resolves the current checkout to its primary repository root", () => {
    expect(typeof resolveProjectIdentity(".")).toBe("string");
  });

  it("returns null for an unresolvable historical path", () => {
    expect(resolveProjectIdentity("/path/that/does/not/exist/claude-sessions-test")).toBe(null);
  });
});
