import { describe, expect, it } from "bun:test";
import { readJsonSection, readRepositoryPolicy } from "./policy-records.ts";

const record = (name: string, json: string): string =>
  `# Run\n\n## ${name}\n\n\`\`\`json\n${json}\n\`\`\`\n`;

const POLICY = {
  remote: "repository",
  remote_sync_argv: ["git", "fetch"],
  cleanup: "native-safe",
  commit: { commits: "multiple", fixes: "append" },
};

describe("policy records", () => {
  it("reads one fenced JSON section", () => {
    expect(readJsonSection(record("Review policy", '{"gates":[]}'), "Review policy")).toEqual({
      value: { gates: [] },
    });
    expect(readJsonSection("# Run\n", "Review policy")).toEqual({ problem: "missing" });
    expect(readJsonSection(record("Review policy", "{"), "Review policy")).toEqual({
      problem: "malformed",
    });
  });

  it("validates the repository policy", () => {
    expect<unknown>(
      readRepositoryPolicy(record("Repository policy", JSON.stringify(POLICY))),
    ).toEqual({
      policy: POLICY,
    });
    expect(
      readRepositoryPolicy(
        record("Repository policy", JSON.stringify({ ...POLICY, remote_sync_argv: [] })),
      ),
    ).toEqual({ problem: "malformed" });
    expect(
      readRepositoryPolicy(
        record("Repository policy", JSON.stringify({ ...POLICY, commit: { commits: "multiple" } })),
      ),
    ).toEqual({ problem: "malformed" });
  });
});
