import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  buildManifest,
  discoverTasks,
  extractFrontmatter,
  parseDependsOn,
  type TaskInput,
} from "./plan-graph.ts";

const FIXTURES = join(import.meta.dir, "testdata");

function task(id: string, dependsOn: string[] = []): TaskInput {
  return { id, planPath: null, dependsOn, title: id };
}

describe("extractFrontmatter", () => {
  it("returns the block between fences", () => {
    expect(extractFrontmatter("---\ntitle: Hi\n---\nbody")).toBe("title: Hi");
  });

  it("returns null without a leading fence", () => {
    expect(extractFrontmatter("# Heading\nbody")).toBeNull();
  });

  it("returns null when the closing fence is missing", () => {
    expect(extractFrontmatter("---\ntitle: Hi\nbody")).toBeNull();
  });
});

describe("parseDependsOn", () => {
  it("parses inline array form", () => {
    expect(parseDependsOn("depends-on: [a, b, c]")).toEqual(["a", "b", "c"]);
  });

  it("parses quoted inline entries", () => {
    expect(parseDependsOn("depends-on: [\"a\", 'b']")).toEqual(["a", "b"]);
  });

  it("parses a single scalar", () => {
    expect(parseDependsOn("depends-on: a")).toEqual(["a"]);
  });

  it("parses block list form", () => {
    expect(parseDependsOn("depends-on:\n  - a\n  - b")).toEqual(["a", "b"]);
  });

  it("returns empty when key is absent", () => {
    expect(parseDependsOn("title: x")).toEqual([]);
  });
});

describe("buildManifest", () => {
  it("computes the ready set from dependency-free tasks", () => {
    const m = buildManifest([task("b", ["a"]), task("a"), task("c")]);
    expect(m.ok).toBe(true);
    expect(m.readySet).toEqual(["a", "c"]);
  });

  it("emits edges in [dependency, dependent] order", () => {
    const m = buildManifest([task("a"), task("b", ["a"])]);
    expect(m.edges).toEqual([["a", "b"]]);
  });

  it("sorts tasks deterministically by id", () => {
    const m = buildManifest([task("c"), task("a"), task("b")]);
    expect(m.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("flags an unknown dependency", () => {
    const m = buildManifest([task("a", ["ghost"])]);
    expect(m.ok).toBe(false);
    expect(m.errors).toContainEqual(
      expect.objectContaining({ type: "unknown-dep", task: "a", dep: "ghost" }),
    );
  });

  it("flags a duplicate id", () => {
    const m = buildManifest([task("a"), task("a")]);
    expect(m.ok).toBe(false);
    expect(m.errors.some((e) => e.type === "duplicate-id")).toBe(true);
  });

  it("detects a direct cycle", () => {
    const m = buildManifest([task("a", ["b"]), task("b", ["a"])]);
    expect(m.ok).toBe(false);
    const cycle = m.errors.find((e) => e.type === "cycle");
    expect(cycle?.detail).toContain("a");
    expect(cycle?.detail).toContain("b");
  });

  it("accepts a valid diamond DAG", () => {
    const m = buildManifest([
      task("top"),
      task("left", ["top"]),
      task("right", ["top"]),
      task("bottom", ["left", "right"]),
    ]);
    expect(m.ok).toBe(true);
    expect(m.readySet).toEqual(["top"]);
  });
});

describe("discoverTasks", () => {
  it("reads plan files from a directory and parses frontmatter", () => {
    const tasks = discoverTasks([FIXTURES]);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    expect(byId["00-schema"].dependsOn).toEqual([]);
    expect(byId["00-schema"].title).toBe("Schema migration");
    expect(byId["01-api"].dependsOn).toEqual(["00-schema"]);
    expect(byId["02-ui"].dependsOn).toEqual(["01-api"]);
  });

  it("produces a valid manifest from the fixtures", () => {
    const m = buildManifest(discoverTasks([FIXTURES]));
    expect(m.ok).toBe(true);
    expect(m.readySet).toEqual(["00-schema"]);
  });
});
