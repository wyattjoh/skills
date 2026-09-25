import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const skillDir = resolve(import.meta.dir, "..");
const read = (...path: string[]): string => readFileSync(join(skillDir, ...path), "utf8");
const markdownFiles = [
  "SKILL.md",
  ...readdirSync(join(skillDir, "references"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("references", name)),
];

describe("coordinator documentation", () => {
  it("links only to files that exist", () => {
    const broken = markdownFiles.flatMap((file) =>
      [...read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/gu)]
        .map((match) => match[1]!)
        .filter((target) => !/^[a-z]+:/u.test(target))
        .filter((target) => !existsSync(resolve(skillDir, dirname(file), target)))
        .map((target) => `${file} -> ${target}`),
    );
    expect(broken).toEqual([]);
  });

  it("keeps the published package portable", () => {
    const metadata = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(metadata.os).toEqual(["darwin", "linux"]);
    expect(metadata.engines).toEqual({ bun: ">=1.1.0" });
  });

  it("keeps downstream coordination run-owned and event-driven", () => {
    const downstream = readFileSync(join(skillDir, "..", "core-coordinator", "SKILL.md"), "utf8");
    const loop = readFileSync(
      join(skillDir, "..", "core-coordinator", "references", "loop.md"),
      "utf8",
    );
    expect(downstream.includes("Never edit a run's `RESUME.md` or its global run file.")).toBe(
      true,
    );
    expect(downstream.includes("`agreements.update`")).toBe(true);
    expect(loop.includes("event-driven")).toBe(true);
    const legacy = ["CronCreate", "CronDelete", "python3", "ListAgents", "SendMessage"].filter(
      (term) => `${downstream}\n${loop}`.includes(term),
    );
    expect(legacy).toEqual([]);
  });
});
