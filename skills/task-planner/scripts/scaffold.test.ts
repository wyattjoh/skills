import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatPlanFile,
  loadDecomposition,
  scaffoldPlans,
  type DecompositionTask,
} from "./scaffold.ts";

const FIXTURES = join(import.meta.dir, "testdata");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-planner-"));
  tmpDirs.push(dir);
  return dir;
}

const schemaTask: DecompositionTask = {
  id: "01-schema",
  title: "Schema migration",
  dependsOn: [],
  context: "Create the database shape described in `docs/billing-adr.md`.",
  implementation: "Add the migration and update the generated client. Do not touch API handlers.",
  acceptance: ["Migration applies cleanly", "Generated client exposes billing fields"],
};

const apiTask: DecompositionTask = {
  id: "02-api",
  title: "API endpoints for billing",
  dependsOn: ["01-schema"],
  context: "Implements the API slice from `docs/billing-adr.md`.",
  implementation: "Add billing endpoints and route tests. UI integration is out of scope.",
  acceptance: ["Routes validate input", "Endpoint tests cover success and failure cases"],
};

describe("formatPlanFile", () => {
  it("renders a task-orchestrator plan file with inline YAML dependencies", () => {
    expect(formatPlanFile(apiTask)).toBe(`---
title: API endpoints for billing
depends-on: [01-schema]
---

# API endpoints for billing

## Context
Implements the API slice from \`docs/billing-adr.md\`.

## Implementation
Add billing endpoints and route tests. UI integration is out of scope.

## Acceptance criteria
- Routes validate input
- Endpoint tests cover success and failure cases
`);
  });

  it("renders an empty dependency array for independent tasks", () => {
    expect(formatPlanFile(schemaTask).split("\n").slice(0, 3)).toEqual([
      "---",
      "title: Schema migration",
      "depends-on: []",
    ]);
  });

  it("rejects tasks without acceptance criteria", () => {
    expect(() => formatPlanFile({ ...schemaTask, acceptance: [] })).toThrow(
      'Task "01-schema" must include at least one acceptance criterion',
    );
  });

  it("rejects ids that do not match NN-slug", () => {
    expect(() => formatPlanFile({ ...schemaTask, id: "schema" })).toThrow(
      'Task id "schema" must match NN-slug',
    );
  });
});

describe("loadDecomposition", () => {
  it("loads the fixture decomposition", () => {
    expect(loadDecomposition(join(FIXTURES, "billing-decomposition.json"))).toEqual([
      schemaTask,
      apiTask,
    ]);
  });

  it("loads and validates a decomposition JSON array", () => {
    const path = join(tempDir(), "decomposition.json");
    writeFileSync(path, JSON.stringify([schemaTask, apiTask]));

    expect(loadDecomposition(path)).toEqual([schemaTask, apiTask]);
  });

  it("rejects malformed task entries with a helpful message", () => {
    const path = join(tempDir(), "decomposition.json");
    writeFileSync(path, JSON.stringify([{ id: "01-schema", title: "Schema" }]));

    expect(() => loadDecomposition(path)).toThrow(
      'Task "01-schema" must include a dependsOn array',
    );
  });
});

describe("scaffoldPlans", () => {
  it("writes deterministic id-named plan files and returns their paths", () => {
    const outDir = join(tempDir(), "plans", "billing");

    const written = scaffoldPlans([apiTask, schemaTask], outDir);

    expect(written.map((file) => file.id)).toEqual(["01-schema", "02-api"]);
    expect(written.map((file) => file.filename)).toEqual(["01-schema.md", "02-api.md"]);
    expect(readFileSync(join(outDir, "01-schema.md"), "utf8")).toBe(formatPlanFile(schemaTask));
    expect(readFileSync(join(outDir, "02-api.md"), "utf8")).toBe(formatPlanFile(apiTask));
  });

  it("removes stale markdown files from the output directory before writing", () => {
    const outDir = join(tempDir(), "plans", "billing");
    scaffoldPlans([schemaTask, apiTask], outDir);

    scaffoldPlans([schemaTask], outDir);

    expect(existsSync(join(outDir, "02-api.md"))).toBe(false);
  });

  it("preserves non-plan markdown files (only NN-slug.md is managed)", () => {
    const outDir = tempDir();
    const skillDoc = join(outDir, "SKILL.md");
    const readme = join(outDir, "README.md");
    writeFileSync(skillDoc, "# a skill that must survive scaffolding\n");
    writeFileSync(readme, "# readme\n");

    scaffoldPlans([schemaTask], outDir);

    expect(readFileSync(skillDoc, "utf8")).toBe("# a skill that must survive scaffolding\n");
    expect(existsSync(readme)).toBe(true);
    // The managed plan file is still written alongside the untouched docs.
    expect(existsSync(join(outDir, "01-schema.md"))).toBe(true);
  });
});
