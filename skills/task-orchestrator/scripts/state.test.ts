import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, type TaskInput } from "./plan-graph.ts";
import {
  computeReady,
  initState,
  isTaskStatus,
  type OrchestratorState,
  propagateBlocks,
  readState,
  reconcileWithGit,
  resumeSummary,
  statePath,
  type TaskStatus,
  updateTask,
  validateBatchName,
  writeState,
} from "./state.ts";

function task(id: string, dependsOn: string[] = []): TaskInput {
  return { id, planPath: null, dependsOn, title: id };
}

function diamond(): OrchestratorState {
  const manifest = buildManifest([
    task("top"),
    task("left", ["top"]),
    task("right", ["top"]),
    task("bottom", ["left", "right"]),
  ]);
  return initState({
    batch: "demo",
    baseBranch: "main",
    integrationBranch: "wyattjoh/demo",
    concurrency: 3,
    manifest,
  });
}

const tmp = mkdtempSync(join(tmpdir(), "task-orch-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("statePath", () => {
  it("nests under the scratch root, not a worktree", () => {
    expect(statePath("demo")).toBe(".claude/task-orchestrator/demo/state.json");
  });
});

describe("validateBatchName / statePath containment", () => {
  it("accepts a simple valid name", () => {
    expect(statePath("demo", tmp)).toBe(`${tmp}/demo/state.json`);
  });

  it("accepts a name with hyphens and digits", () => {
    expect(statePath("batch-01", tmp)).toBe(`${tmp}/batch-01/state.json`);
  });

  it("rejects an empty batch name", () => {
    expect(() => validateBatchName("", tmp)).toThrow(/empty/);
  });

  it("rejects a relative traversal segment", () => {
    expect(() => statePath("../escape", tmp)).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() => statePath("/etc/passwd", tmp)).toThrow(/absolute/);
  });

  it("rejects a nested path with a forward slash", () => {
    expect(() => statePath("a/b", tmp)).toThrow(/separator/);
  });

  it("rejects a backslash-separated path", () => {
    expect(() => statePath("a\\b", tmp)).toThrow(/separator/);
  });

  it("rejects a double-dot name", () => {
    expect(() => statePath("..", tmp)).toThrow(/dot segment/);
  });

  it("rejects a single-dot name", () => {
    expect(() => statePath(".", tmp)).toThrow(/dot segment/);
  });

  it("does not write files when the batch name is rejected", () => {
    const root = mkdtempSync(join(tmp, "no-write-"));
    // Attempt traversal via statePath (throws before any I/O)
    expect(() => statePath("../escape", root)).toThrow();
    // Verify no file was created outside root
    const escapedPath = join(root, "..", "escape", "state.json");
    expect(existsSync(escapedPath)).toBe(false);
  });
});

describe("initState", () => {
  it("seeds every task as queued", () => {
    const state = diamond();
    expect(Object.keys(state.tasks).toSorted()).toEqual(["bottom", "left", "right", "top"]);
    expect(state.tasks.top.status).toBe("queued");
    expect(state.tasks.top.round).toBe(0);
  });
});

describe("updateTask", () => {
  it("applies a patch immutably", () => {
    const state = diamond();
    const next = updateTask(state, "top", { status: "running", implementerAgent: "impl-top" });
    expect(next.tasks.top.status).toBe("running");
    expect(next.tasks.top.implementerAgent).toBe("impl-top");
    expect(state.tasks.top.status).toBe("queued"); // original untouched
  });

  it("throws on an unknown task", () => {
    expect(() => updateTask(diamond(), "ghost", { round: 1 })).toThrow();
  });

  it("rejects a status outside the canonical union", () => {
    expect(() =>
      // Operator typo: "implementing" is not a TaskStatus.
      updateTask(diamond(), "top", { status: "implementing" as TaskStatus }),
    ).toThrow(/Invalid status "implementing"/);
  });
});

describe("isTaskStatus", () => {
  it("accepts canonical statuses and rejects everything else", () => {
    expect(isTaskStatus("running")).toBe(true);
    expect(isTaskStatus("merged")).toBe(true);
    expect(isTaskStatus("implementing")).toBe(false);
    expect(isTaskStatus("")).toBe(false);
    expect(isTaskStatus(null)).toBe(false);
  });
});

describe("statusSince", () => {
  it("initState seeds statusSince", () => {
    expect(typeof diamond().tasks.top.statusSince).toBe("string");
  });

  it("stamps statusSince on a status change with injected now", () => {
    const next = updateTask(diamond(), "top", { status: "running" }, "2026-06-28T00:00:00.000Z");
    expect(next.tasks.top.statusSince).toBe("2026-06-28T00:00:00.000Z");
  });

  it("leaves statusSince untouched on a non-status patch", () => {
    const state = diamond();
    const before = state.tasks.top.statusSince;
    const next = updateTask(state, "top", { round: 2 }, "2026-06-28T00:00:00.000Z");
    expect(next.tasks.top.statusSince).toBe(before);
  });

  it("leaves statusSince untouched when status is unchanged", () => {
    const state = diamond();
    const before = state.tasks.top.statusSince;
    const next = updateTask(state, "top", { status: "queued" }, "2026-06-28T00:00:00.000Z");
    expect(next.tasks.top.statusSince).toBe(before);
  });
});

describe("computeReady", () => {
  it("only the root is ready initially", () => {
    expect(computeReady(diamond())).toEqual(["top"]);
  });

  it("unblocks dependents only when all deps merged", () => {
    let state = updateTask(diamond(), "top", { status: "merged" });
    expect(computeReady(state).toSorted()).toEqual(["left", "right"]);
    state = updateTask(state, "left", { status: "merged" });
    expect(computeReady(state)).toEqual(["right"]); // bottom still needs right merged
    state = updateTask(state, "right", { status: "merged" });
    expect(computeReady(state)).toEqual(["bottom"]);
  });
});

describe("reconcileWithGit", () => {
  it("marks git-merged tasks merged and reports the change", () => {
    const { state, changed } = reconcileWithGit(diamond(), ["top"]);
    expect(changed).toEqual(["top"]);
    expect(state.tasks.top.status).toBe("merged");
  });

  it("is a no-op when already merged", () => {
    const merged = updateTask(diamond(), "top", { status: "merged" });
    const { changed } = reconcileWithGit(merged, ["top"]);
    expect(changed).toEqual([]);
  });
});

describe("propagateBlocks", () => {
  it("blocks transitive dependents of an escalated task", () => {
    const escalated = updateTask(diamond(), "top", { status: "escalated" });
    const { state, blocked } = propagateBlocks(escalated);
    expect(blocked.toSorted()).toEqual(["bottom", "left", "right"]);
    expect(state.tasks.bottom.status).toBe("blocked");
  });
});

describe("resumeSummary", () => {
  it("partitions tasks by lifecycle and surfaces agent handles", () => {
    let state = updateTask(diamond(), "top", { status: "merged" });
    state = updateTask(state, "left", {
      status: "review",
      round: 2,
      implementerAgent: "impl-left",
      reviewerAgent: "rev-left",
      outstandingComments: ["handle the empty case"],
    });
    const summary = resumeSummary(state);
    expect(summary.merged).toEqual(["top"]);
    expect(summary.ready).toEqual(["right"]);
    expect(summary.inFlight).toHaveLength(1);
    expect(summary.inFlight[0]).toMatchObject({
      id: "left",
      reviewerAgent: "rev-left",
      outstandingComments: ["handle the empty case"],
    });
  });
});

describe("write/read roundtrip", () => {
  it("persists and reloads state atomically", () => {
    const path = statePath("demo", tmp);
    const state = updateTask(diamond(), "top", { status: "running" });
    writeState(path, state);
    const reloaded = readState(path);
    expect(reloaded?.tasks.top.status).toBe("running");
    expect(reloaded?.integrationBranch).toBe("wyattjoh/demo");
  });

  it("returns null for a missing journal", () => {
    expect(readState(join(tmp, "nope", "state.json"))).toBeNull();
  });
});

describe("state init command", () => {
  it("writes the initial journal before dashboard startup", () => {
    const root = mkdtempSync(join(tmp, "init-"));
    const manifest = buildManifest([task("00-schema"), task("01-api", ["00-schema"])]);
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = Bun.spawnSync({
      cmd: [
        "bun",
        join(import.meta.dir, "state.ts"),
        "init",
        "batch-one",
        "--manifest",
        manifestPath,
        "--base-branch",
        "main",
        "--integration-branch",
        "wyattjoh/batch-one",
        "--concurrency",
        "2",
        "--root",
        root,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(statePath("batch-one", root))).toBe(true);
    expect(JSON.parse(readFileSync(statePath("batch-one", root), "utf8"))).toMatchObject({
      batch: "batch-one",
      baseBranch: "main",
      integrationBranch: "wyattjoh/batch-one",
      concurrency: 2,
      tasks: {
        "00-schema": { status: "queued" },
        "01-api": { status: "queued" },
      },
    });
  });
});
