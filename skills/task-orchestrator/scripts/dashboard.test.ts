import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildManifest, type TaskInput } from "./plan-graph.ts";
import { initState, type OrchestratorState, updateTask, writeState } from "./state.ts";
import {
  ancestorDistances,
  buildDashboardSnapshot,
  computeBendTracks,
  computeChannelTracks,
  computeLocalVersionHash,
  SSE_KEEP_ALIVE_INTERVAL_MS,
  dashboardHtml,
  formatSseComment,
  formatSseEvent,
  renderDashboardBroadcast,
  routeEdge,
  serveDashboard,
  shouldBroadcastForWatchEvent,
  type DashboardBroadcast,
} from "./dashboard.ts";
import {
  DAEMON_APP_SIGNATURE,
  decodeRegistry,
  LEASE_MIN_AGE_MS,
  encodeRegistry,
  repoFromJournalPath,
} from "./daemon.ts";

const plausibleProcessFacts = () => ({
  pidAlive: true,
  pidStartMs: 0,
  now: LEASE_MIN_AGE_MS,
});

// Extracts the ordered y coordinates touched by an SVG path so a test can assert
// the path never moves upward.
function pathYs(d: string): number[] {
  const tokens = d.trim().split(/\s+/);
  const ys: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M") {
      i++;
      ys.push(Number(tokens[i++]));
    } else if (command === "V") {
      ys.push(Number(tokens[i++]));
    } else if (command === "H") {
      i++;
    } else if (command === "Q") {
      i++;
      ys.push(Number(tokens[i++]));
      i++;
      ys.push(Number(tokens[i++]));
    } else {
      i++;
    }
  }
  return ys;
}

function depEdge(fromTaskId: string, toTaskId: string): { fromTaskId: string; toTaskId: string } {
  return { fromTaskId, toTaskId };
}

function task(id: string, dependsOn: string[] = [], title = id): TaskInput {
  return { id, planPath: null, dependsOn, title };
}

function stateFixture(): OrchestratorState {
  const manifest = buildManifest([
    task("00-schema", [], "Schema migration"),
    task("01-api", ["00-schema"], "API surface"),
    task("02-ui", ["01-api"], "Dashboard UI"),
  ]);

  let state = initState({
    batch: "demo",
    baseBranch: "main",
    integrationBranch: "wyattjoh/demo",
    concurrency: 2,
    manifest,
  });

  state = updateTask(state, "00-schema", {
    status: "merged",
    mergedSha: "abc123",
  });
  state = updateTask(state, "01-api", {
    status: "review",
    round: 2,
    branch: "task/01-api",
    worktree: ".claude/worktrees/demo/01-api",
    implementerAgent: "impl-01-api",
    reviewerAgent: "rev-01-api",
    outstandingComments: ["handle empty responses"],
  });

  return state;
}

describe("buildDashboardSnapshot", () => {
  it("carries statusSince onto each dashboard task", () => {
    const manifest = buildManifest([task("top")]);
    let state = initState({
      batch: "demo",
      baseBranch: "main",
      integrationBranch: "wyattjoh/demo",
      concurrency: 1,
      manifest,
    });
    state = updateTask(state, "top", { status: "running" }, "2026-06-28T00:00:00.000Z");
    const snapshot = buildDashboardSnapshot(state);
    expect(snapshot.tasks.find((t) => t.id === "top")?.statusSince).toBe(
      "2026-06-28T00:00:00.000Z",
    );
  });

  it("degrades instead of crashing on a status outside the canonical union", () => {
    const manifest = buildManifest([task("top", [], "Top task")]);
    const state = initState({
      batch: "demo",
      baseBranch: "main",
      integrationBranch: "wyattjoh/demo",
      concurrency: 1,
      manifest,
    });
    // Simulate a hand-edited journal that bypassed updateTask's validation.
    state.tasks.top.status = "implementing" as never;
    const snapshot = buildDashboardSnapshot(state);
    const top = snapshot.tasks.find((t) => t.id === "top");
    expect(top?.phaseLabel).toBe("implementing");
    expect(top?.remainingPhases).toEqual([]);
    expect(top?.activity).toBe("stopped");
  });

  it("projects the existing state journal into task progress rows", () => {
    const snapshot = buildDashboardSnapshot(stateFixture());

    expect(snapshot).toMatchObject({
      batch: "demo",
      baseBranch: "main",
      integrationBranch: "wyattjoh/demo",
      concurrency: 2,
      totals: {
        taskCount: 3,
        merged: 1,
        active: 1,
        queued: 1,
        escalated: 0,
        blocked: 0,
      },
    });

    expect(snapshot.tasks.map((t) => t.id)).toEqual(["00-schema", "01-api", "02-ui"]);
    expect(snapshot.tasks[0]).toMatchObject({
      id: "00-schema",
      title: "Schema migration",
      status: "merged",
      phaseLabel: "Merged",
      dependencies: [],
      remainingPhases: [],
      mergedSha: "abc123",
    });
    expect(snapshot.tasks[1]).toMatchObject({
      id: "01-api",
      title: "API surface",
      status: "review",
      phaseLabel: "Review",
      activity: "active",
      dependencies: ["00-schema"],
      branch: "task/01-api",
      worktree: ".claude/worktrees/demo/01-api",
      round: 2,
      agentBadges: [
        { role: "impl", handle: "impl-01-api", status: "review" },
        { role: "review", handle: "rev-01-api", status: "review" },
      ],
      outstandingComments: ["handle empty responses"],
    });
    expect(snapshot.tasks[1].remainingPhases).toEqual(["Rebase", "Verify", "Merge"]);
    expect(snapshot.tasks[2]).toMatchObject({
      id: "02-ui",
      status: "queued",
      activity: "waiting",
      dependencies: ["01-api"],
      blockedBy: ["01-api"],
    });
    expect(snapshot.graph.rows.map((row) => row.taskId)).toEqual(["00-schema", "01-api", "02-ui"]);
  });

  it("treats escalated and blocked tasks as terminal exceptions", () => {
    let state = stateFixture();
    state = updateTask(state, "01-api", { status: "escalated" });
    state = updateTask(state, "02-ui", { status: "blocked" });

    const snapshot = buildDashboardSnapshot(state);

    expect(snapshot.totals).toMatchObject({ escalated: 1, blocked: 1 });
    expect(snapshot.tasks.find((t) => t.id === "01-api")?.remainingPhases).toEqual([]);
    expect(snapshot.tasks.find((t) => t.id === "02-ui")?.remainingPhases).toEqual([]);
  });

  it("creates fixed-row lane and edge-route metadata for forked task dependencies", () => {
    const manifest = buildManifest([
      task("00-root"),
      task("01-primary", ["00-root"]),
      task("02-side", ["00-root"]),
      task("03-join", ["01-primary", "02-side"]),
    ]);
    const state = initState({
      batch: "forked",
      baseBranch: "main",
      integrationBranch: "wyattjoh/forked",
      concurrency: 2,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);

    expect(snapshot.graph.maxLane).toBe(2);
    // Lane 0 is reserved for the base branch trunk. The root chain starts on
    // lane 1, forks 02-side to lane 2, then the median of the join's parent
    // lanes ([1, 2], index floor(2 / 2) = 1) lands 03-join on lane 2.
    expect(snapshot.graph.rows).toEqual([
      { taskId: "00-root", lane: 1, row: 0 },
      { taskId: "01-primary", lane: 1, row: 1 },
      { taskId: "02-side", lane: 2, row: 2 },
      { taskId: "03-join", lane: 2, row: 3 },
    ]);
    expect(
      snapshot.graph.edges.map((edge) => ({
        fromTaskId: edge.fromTaskId,
        toTaskId: edge.toTaskId,
        sourceRow: edge.sourceRow,
        targetRow: edge.targetRow,
        sourceLane: edge.sourceLane,
        targetLane: edge.targetLane,
        activity: edge.activity,
      })),
    ).toEqual([
      {
        fromTaskId: "00-root",
        toTaskId: "01-primary",
        sourceRow: 0,
        targetRow: 1,
        sourceLane: 1,
        targetLane: 1,
        activity: "waiting",
      },
      {
        fromTaskId: "00-root",
        toTaskId: "02-side",
        sourceRow: 0,
        targetRow: 2,
        sourceLane: 1,
        targetLane: 2,
        activity: "waiting",
      },
      {
        fromTaskId: "01-primary",
        toTaskId: "03-join",
        sourceRow: 1,
        targetRow: 3,
        sourceLane: 1,
        // 03-join now sits on lane 2 (median of its parent lanes), so the merge
        // back from the lane-1 chain ends on lane 2.
        targetLane: 2,
        activity: "waiting",
      },
      {
        fromTaskId: "02-side",
        toTaskId: "03-join",
        sourceRow: 2,
        targetRow: 3,
        sourceLane: 2,
        // 02-side and 03-join share lane 2, so this edge is a straight rail.
        targetLane: 2,
        activity: "waiting",
      },
    ]);
  });

  it("reuses the root lane for independent root groups", () => {
    const manifest = buildManifest([
      task("00-a-root"),
      task("01-a-child", ["00-a-root"]),
      task("02-b-root"),
      task("03-c-root"),
    ]);
    const state = initState({
      batch: "root-groups",
      baseBranch: "main",
      integrationBranch: "wyattjoh/root-groups",
      concurrency: 3,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);
    const rowById = Object.fromEntries(snapshot.graph.rows.map((row) => [row.taskId, row]));

    expect(rowById["00-a-root"].lane).toBe(1);
    expect(rowById["01-a-child"].lane).toBe(1);
    expect(rowById["02-b-root"].lane).toBe(1);
    expect(rowById["03-c-root"].lane).toBe(1);
    expect(snapshot.graph.maxLane).toBe(1);
  });

  it("branches sibling children instead of stacking them on their parent lane", () => {
    const manifest = buildManifest([
      task("00-root"),
      task("01-mainline", ["00-root"]),
      task("02-sibling", ["00-root"]),
    ]);
    const state = initState({
      batch: "sibling-branches",
      baseBranch: "main",
      integrationBranch: "wyattjoh/sibling-branches",
      concurrency: 2,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);
    const rowById = Object.fromEntries(snapshot.graph.rows.map((row) => [row.taskId, row]));

    expect(rowById["00-root"].lane).toBe(1);
    expect(rowById["01-mainline"].lane).toBe(1);
    expect(rowById["02-sibling"].lane).toBe(2);
  });

  it("moves transitively implied edges into elidedEdges while keeping direct edges", () => {
    const manifest = buildManifest([task("a"), task("b", ["a"]), task("c", ["a", "b"])]);
    const state = initState({
      batch: "transitive",
      baseBranch: "main",
      integrationBranch: "wyattjoh/transitive",
      concurrency: 2,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);

    expect(snapshot.graph.edges.map((edge) => `${edge.fromTaskId}->${edge.toTaskId}`)).toEqual([
      "a->b",
      "b->c",
    ]);
    expect(
      snapshot.graph.elidedEdges.map((edge) => `${edge.fromTaskId}->${edge.toTaskId}`),
    ).toEqual(["a->c"]);
  });

  it("leaves elidedEdges empty for a diamond with no transitive shortcut", () => {
    const manifest = buildManifest([
      task("a"),
      task("b", ["a"]),
      task("c", ["a"]),
      task("d", ["b", "c"]),
    ]);
    const state = initState({
      batch: "diamond",
      baseBranch: "main",
      integrationBranch: "wyattjoh/diamond",
      concurrency: 2,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);

    expect(snapshot.graph.elidedEdges).toEqual([]);
    expect(snapshot.graph.edges.map((edge) => `${edge.fromTaskId}->${edge.toTaskId}`)).toEqual([
      "a->b",
      "a->c",
      "b->d",
      "c->d",
    ]);
  });

  it("orders every edge from an earlier row to a later row for monotone routing", () => {
    const manifest = buildManifest([
      task("00-root"),
      task("01-side-a", ["00-root"]),
      task("02-side-b", ["00-root"]),
      task("03-join-a", ["00-root", "01-side-a"]),
      task("04-join-b", ["00-root", "02-side-b"]),
    ]);
    const state = initState({
      batch: "overlaps",
      baseBranch: "main",
      integrationBranch: "wyattjoh/overlaps",
      concurrency: 2,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);

    for (const edge of snapshot.graph.edges) {
      expect(edge.sourceRow).toBeLessThan(edge.targetRow);
    }
  });

  it("keeps an active single-root child on its dependency lane when another root is not merged", () => {
    const manifest = buildManifest([
      task("01-schema"),
      task("02-access"),
      task("03-browser", ["02-access"]),
      task("04-join", ["01-schema", "02-access"]),
      task("05-review-store", ["01-schema"]),
    ]);
    let state = initState({
      batch: "real-ish",
      baseBranch: "main",
      integrationBranch: "wyattjoh/real-ish",
      concurrency: 2,
      manifest,
    });
    state = updateTask(state, "01-schema", { status: "merged" });
    state = updateTask(state, "02-access", { status: "review" });
    state = updateTask(state, "05-review-store", { status: "running" });

    const snapshot = buildDashboardSnapshot(state);
    const rowById = Object.fromEntries(snapshot.graph.rows.map((row) => [row.taskId, row]));

    // Lane 0 is reserved for the base branch trunk. 01-schema is the first root
    // on lane 1; 02-access is the second root and falls onto lane 2 while
    // 01-schema's component is still open. 05-review-store is a single-dependency
    // child of 01-schema and continues straight down its parent's lane 1.
    expect(rowById["01-schema"].lane).toBe(1);
    expect(rowById["02-access"].lane).toBe(2);
    expect(rowById["05-review-store"].lane).toBe(1);
    expect(
      snapshot.tasks.find((snapshotTask) => snapshotTask.id === "05-review-store"),
    ).toMatchObject({
      status: "running",
      dependencies: ["01-schema"],
      blockedBy: [],
    });
  });

  it("reclaims old rails after a branch span closes", () => {
    // Two stacked diamonds. The first side branch (02-c) opens lane 1. The second
    // side branch (05-f) can reclaim lane 1 once the first diamond has closed,
    // preventing unbounded rightward drift across independent branch spans.
    const manifest = buildManifest([
      task("00-a"),
      task("01-b", ["00-a"]),
      task("02-c", ["00-a"]),
      task("03-d", ["01-b", "02-c"]),
      task("04-e", ["03-d"]),
      task("05-f", ["03-d"]),
      task("06-g", ["04-e", "05-f"]),
    ]);
    const state = initState({
      batch: "reuse",
      baseBranch: "main",
      integrationBranch: "wyattjoh/reuse",
      concurrency: 2,
      manifest,
    });

    const snapshot = buildDashboardSnapshot(state);
    const rowById = Object.fromEntries(snapshot.graph.rows.map((row) => [row.taskId, row]));

    expect(snapshot.graph.maxLane).toBe(2);
    expect(rowById["00-a"].lane).toBe(1);
    expect(rowById["02-c"].lane).toBe(2);
    expect(rowById["05-f"].lane).toBe(1);
  });
});

describe("dashboardHtml", () => {
  it("renders a generic shell with an empty-state placeholder", () => {
    const html = dashboardHtml();

    expect(html).toContain("<h1>Task Orchestrator</h1>");
    expect(html).toContain("No active batches");
  });
});

describe("computeLocalVersionHash", () => {
  it("changes when any daemon runtime source changes", () => {
    const sourcePaths = ["dashboard.ts", "daemon.ts", "state.ts"].map((file) =>
      join(import.meta.dir, file),
    );
    const sources = new Map(sourcePaths.map((path) => [path, `${path}:original`]));
    const readSource = (path: string): string => {
      const source = sources.get(path);
      if (!source) throw new Error(`Unexpected daemon source path: ${path}`);
      return source;
    };
    const originalHash = computeLocalVersionHash(readSource);
    const changedHashes: string[] = [];

    for (const path of sourcePaths) {
      const originalSource = sources.get(path);
      if (!originalSource) throw new Error(`Missing test source: ${path}`);
      sources.set(path, `${originalSource}:changed`);
      changedHashes.push(computeLocalVersionHash(readSource));
      sources.set(path, originalSource);
    }

    expect(new Set([originalHash, ...changedHashes]).size).toBe(sourcePaths.length + 1);
  });
});

describe("renderDashboardBroadcast", () => {
  it("animates active blue graph edges with the dependency flow", () => {
    const html = dashboardHtml();

    expect(html).toContain(`.graph-edge-active,
      .root-edge-active {
        opacity: 0.95;
        stroke-width: 2.75;
        stroke-dasharray: 4 5;
        animation: dependency-flow 0.9s linear infinite;`);
  });

  it("renders one panel per batch in broadcast order", () => {
    const first = buildDashboardSnapshot(stateFixture());
    const second = buildDashboardSnapshot({
      ...stateFixture(),
      batch: "second-batch",
      integrationBranch: "wyattjoh/second-batch",
    });
    const broadcast: DashboardBroadcast = {
      batches: [
        { key: "one", repo: "wyattjoh/first-repo", snapshot: first },
        { key: "two", repo: "wyattjoh/second-repo", snapshot: second },
      ],
    };

    const html = renderDashboardBroadcast(broadcast);
    const firstIndex = html.indexOf('data-batch-key="one"');
    const secondIndex = html.indexOf('data-batch-key="two"');

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(html).toContain("wyattjoh/first-repo");
    expect(html).toContain("demo");
    expect(html).toContain("wyattjoh/demo");
    expect(html).toContain("wyattjoh/second-repo");
    expect(html).toContain("second-batch");
    expect(html).toContain("wyattjoh/second-batch");
  });

  it("renders the empty state and no panels when no batches are active", () => {
    const html = renderDashboardBroadcast({ batches: [] });

    expect(html).toContain("No active batches");
    expect(html.match(/class="batch-panel"/g) ?? []).toHaveLength(0);
  });
});

describe("serveDashboard", () => {
  it("reports health and keeps register idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    writeState(journalPath, stateFixture());
    const running = serveDashboard(
      {
        host: "127.0.0.1",
        port: 0,
        registryPath: join(dir, "registry.json"),
        reapIntervalMs: 1,
        zeroRegistryGraceMs: 10_000,
        open: false,
      },
      plausibleProcessFacts,
    );

    try {
      const health = (await (await fetch(`${running.url}healthz`)).json()) as {
        app: string;
        versionHash: string;
        pid: number;
      };
      expect(health.app).toBe(DAEMON_APP_SIGNATURE);
      expect(health.versionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(health.pid).toBe(process.pid);

      const registerBody = JSON.stringify({ journalPath, pid: process.pid });
      const firstRegister = await fetch(`${running.url}register`, {
        method: "POST",
        body: registerBody,
        headers: { "content-type": "application/json" },
      });
      expect(firstRegister.status).toBe(200);
      const secondRegister = await fetch(`${running.url}register`, {
        method: "POST",
        body: registerBody,
        headers: { "content-type": "application/json" },
      });
      expect(secondRegister.status).toBe(200);

      const state = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
      expect(state.batches).toHaveLength(1);
      expect(state.batches[0].key).toBe(journalPath);
      expect(state.batches[0].repo).toBe(join(dir, "repo"));
      if ("error" in state.batches[0].snapshot) throw new Error(state.batches[0].snapshot.error);
      expect(state.batches[0].snapshot.batch).toBe("demo");

      const unregister = await fetch(`${running.url}unregister`, {
        method: "POST",
        body: JSON.stringify({ journalPath }),
        headers: { "content-type": "application/json" },
      });
      expect(unregister.status).toBe(200);
      const emptyState = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
      expect(emptyState.batches).toEqual([]);
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists registry hints on register and unregister", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const registryPath = join(dir, "registry.json");
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    writeState(journalPath, stateFixture());
    const running = serveDashboard(
      {
        host: "127.0.0.1",
        port: 0,
        registryPath,
        reapIntervalMs: 10_000,
        zeroRegistryGraceMs: 10_000,
        open: false,
      },
      plausibleProcessFacts,
    );

    try {
      const register = await fetch(`${running.url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: process.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);

      const persisted = decodeRegistry(readFileSync(registryPath, "utf8"));
      expect(persisted[journalPath]).toMatchObject({
        journalPath,
        pid: process.pid,
        repo: join(dir, "repo"),
      });

      const unregister = await fetch(`${running.url}unregister`, {
        method: "POST",
        body: JSON.stringify({ journalPath }),
        headers: { "content-type": "application/json" },
      });
      expect(unregister.status).toBe(200);
      expect(decodeRegistry(readFileSync(registryPath, "utf8"))).toEqual({});
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts only live readable registry hints on startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const registryPath = join(dir, "registry.json");
    const liveJournalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    const missingJournalPath = join(dir, "repo", ".claude/task-orchestrator/missing/state.json");
    writeState(liveJournalPath, stateFixture());
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(
      registryPath,
      encodeRegistry({
        [liveJournalPath]: {
          journalPath: liveJournalPath,
          pid: process.pid,
          repo: repoFromJournalPath(liveJournalPath),
          registeredAt: "2026-06-28T00:00:00.000Z",
        },
        [missingJournalPath]: {
          journalPath: missingJournalPath,
          pid: process.pid,
          repo: repoFromJournalPath(missingJournalPath),
          registeredAt: "2026-06-28T00:00:00.000Z",
        },
      }),
      "utf8",
    );

    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath,
      reapIntervalMs: 10_000,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const state = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
      expect(state.batches.map((batch) => batch.key)).toEqual([liveJournalPath]);
      expect(decodeRegistry(readFileSync(registryPath, "utf8"))).toEqual({
        [liveJournalPath]: {
          journalPath: liveJournalPath,
          pid: process.pid,
          repo: repoFromJournalPath(liveJournalPath),
          registeredAt: "2026-06-28T00:00:00.000Z",
        },
      });
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores adopted registry hints in registration order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const registryPath = join(dir, "registry.json");
    const firstJournalPath = join(dir, "z-repo", ".claude/task-orchestrator/demo/state.json");
    const secondJournalPath = join(dir, "a-repo", ".claude/task-orchestrator/demo/state.json");
    writeState(firstJournalPath, stateFixture());
    writeState(secondJournalPath, stateFixture());
    writeFileSync(
      registryPath,
      encodeRegistry({
        [firstJournalPath]: {
          journalPath: firstJournalPath,
          pid: process.pid,
          repo: repoFromJournalPath(firstJournalPath),
          registeredAt: "2026-06-28T00:00:00.000Z",
        },
        [secondJournalPath]: {
          journalPath: secondJournalPath,
          pid: process.pid,
          repo: repoFromJournalPath(secondJournalPath),
          registeredAt: "2026-06-28T00:01:00.000Z",
        },
      }),
      "utf8",
    );

    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath,
      reapIntervalMs: 10_000,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const state = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
      expect(state.batches.map((batch) => batch.key)).toEqual([
        firstJournalPath,
        secondJournalPath,
      ]);
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaps exited lease pids and rewrites the registry hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const registryPath = join(dir, "registry.json");
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    writeState(journalPath, stateFixture());
    const lease = spawn("sleep", ["30"], { stdio: "ignore" });
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath,
      reapIntervalMs: 20,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      if (lease.pid == null) throw new Error("Lease process did not start");
      await sleep(3_100);
      const register = await fetch(`${running.url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: lease.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);
      lease.kill("SIGTERM");
      await childExited(lease);

      await waitUntil(async () => {
        const state = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
        return state.batches.length === 0;
      });
      expect(decodeRegistry(readFileSync(registryPath, "utf8"))).toEqual({});
    } finally {
      lease.kill("SIGKILL");
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels zero-registry grace when a batch registers and exits after unregister", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    writeState(journalPath, stateFixture());
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 10_000,
      zeroRegistryGraceMs: 120,
      open: false,
    });

    try {
      await sleep(30);
      const register = await fetch(`${running.url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: process.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);
      await sleep(160);
      expect((await fetch(`${running.url}healthz`)).status).toBe(200);

      const unregister = await fetch(`${running.url}unregister`, {
        method: "POST",
        body: JSON.stringify({ journalPath }),
        headers: { "content-type": "application/json" },
      });
      expect(unregister.status).toBe(200);
      await waitUntil(async () => !(await responds(running.url)));
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks missing journal directories and resurrects their watchers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    const stateDir = dirname(journalPath);
    let state = stateFixture();
    writeState(journalPath, state);
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 10_000,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const register = await fetch(`${running.url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: process.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);

      rmSync(stateDir, { recursive: true, force: true });
      await waitUntil(async () => {
        const payload = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
        return "error" in payload.batches[0].snapshot;
      });

      writeState(journalPath, state);
      await sleep(2_200);
      const events = await fetch(`${running.url}events`);
      const reader = events.body?.getReader();
      if (!reader) throw new Error("SSE response did not include a readable body");
      await readStateEvent(reader);

      state = updateTask(state, "02-ui", { status: "blocked" });
      writeState(journalPath, state);
      const update = await readStateEvent(reader);
      await reader.cancel();

      const snapshot = update.batches[0].snapshot;
      if ("error" in snapshot) throw new Error(snapshot.error);
      expect(snapshot.tasks.find((dashboardTask) => dashboardTask.id === "02-ui")?.status).toBe(
        "blocked",
      );
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("broadcasts a missing journal directory transition only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    const stateDir = dirname(journalPath);
    writeState(journalPath, stateFixture());
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 10_000,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const register = await fetch(`${running.url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: process.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);
      await sleep(40);

      const events = await fetch(`${running.url}events`);
      reader = events.body?.getReader();
      if (!reader) throw new Error("SSE response did not include a readable body");
      await readStateEvent(reader);

      rmSync(stateDir, { recursive: true, force: true });
      await fetch(`${running.url}state`);
      expect(await receivesStateEventWithin(reader, 1_000)).toBe(true);
      expect(await receivesStateEventWithin(reader, 150)).toBe(false);
    } finally {
      await reader?.cancel().catch(() => undefined);
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders refreshed registrations by the refreshed registration time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const firstJournalPath = join(dir, "first", ".claude/task-orchestrator/demo/state.json");
    const secondJournalPath = join(dir, "second", ".claude/task-orchestrator/demo/state.json");
    writeState(firstJournalPath, stateFixture());
    writeState(secondJournalPath, {
      ...stateFixture(),
      batch: "second-demo",
      integrationBranch: "wyattjoh/second-demo",
    });
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 1,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      for (const journalPath of [firstJournalPath, secondJournalPath, firstJournalPath]) {
        const register = await fetch(`${running.url}register`, {
          method: "POST",
          body: JSON.stringify({ journalPath, pid: process.pid }),
          headers: { "content-type": "application/json" },
        });
        expect(register.status).toBe(200);
        await sleep(5);
      }

      const state = (await (await fetch(`${running.url}state`)).json()) as DashboardBroadcast;
      expect(state.batches.map((batch) => batch.key)).toEqual([
        secondJournalPath,
        firstJournalPath,
      ]);
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("broadcasts every registered batch after a journal change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    let state = stateFixture();
    writeState(journalPath, state);
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 1,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const register = await fetch(`${running.url}register`, {
        method: "POST",
        body: JSON.stringify({ journalPath, pid: process.pid }),
        headers: { "content-type": "application/json" },
      });
      expect(register.status).toBe(200);
      await sleep(40);

      const events = await fetch(`${running.url}events`);
      const reader = events.body?.getReader();
      if (!reader) throw new Error("SSE response did not include a readable body");
      await readStateEvent(reader);

      state = updateTask(state, "02-ui", { status: "blocked" });
      writeState(journalPath, state);
      const update = await readStateEvent(reader);
      await reader.cancel();

      expect(update.batches).toHaveLength(1);
      const snapshot = update.batches[0].snapshot;
      if ("error" in snapshot) throw new Error(snapshot.error);
      expect(snapshot.tasks.find((dashboardTask) => dashboardTask.id === "02-ui")?.status).toBe(
        "blocked",
      );
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the server through the shutdown endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 1,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const shutdown = await fetch(`${running.url}shutdown`, { method: "POST" });
      expect(shutdown.status).toBe(200);
      await sleep(20);
      await expect(
        fetch(`${running.url}healthz`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws EADDRINUSE when the daemon port mutex is already held", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-daemon-"));
    const first = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 1,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const occupiedPort = first.server.port;
      if (occupiedPort == null) throw new Error("First daemon did not bind a port");
      expect(() =>
        serveDashboard({
          host: "127.0.0.1",
          port: occupiedPort,
          registryPath: join(dir, "registry-2.json"),
          reapIntervalMs: 1,
          zeroRegistryGraceMs: 10_000,
          open: false,
        }),
      ).toThrow(/EADDRINUSE|Failed to start server/);
    } finally {
      first.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dashboard CLI", () => {
  it("registers idempotently, reports status, and unregisters through a detached daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-cli-"));
    const port = allocatePort();
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    const registryPath = join(dir, "registry.json");
    const logPath = join(dir, "daemon.log");
    writeState(journalPath, stateFixture());

    try {
      const registerArgs = [
        "register",
        journalPath,
        "--pid",
        String(process.pid),
        "--port",
        String(port),
        "--registry",
        registryPath,
        "--log",
        logPath,
        "--zero-registry-grace-ms",
        "10000",
      ];
      const first = await runDashboardCli(registerArgs);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain(`Registered ${journalPath}`);

      const health = await daemonHealth(port);
      const state = (await (
        await fetch(`http://127.0.0.1:${port}/state`)
      ).json()) as DashboardBroadcast;
      expect(state.batches.map((batch) => batch.key)).toEqual([journalPath]);

      await sleep(5);
      const second = await runDashboardCli(registerArgs);
      expect(second.exitCode).toBe(0);
      const refreshedHealth = await daemonHealth(port);
      expect(refreshedHealth.pid).toBe(health.pid);

      const status = await runDashboardCli([
        "status",
        "--port",
        String(port),
        "--registry",
        registryPath,
      ]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Dashboard daemon: running");
      expect(status.stdout).toContain(`- ${journalPath}`);

      const unregister = await runDashboardCli([
        "unregister",
        journalPath,
        "--port",
        String(port),
        "--registry",
        registryPath,
      ]);
      expect(unregister.exitCode).toBe(0);
      const emptyState = (await (
        await fetch(`http://127.0.0.1:${port}/state`)
      ).json()) as DashboardBroadcast;
      expect(emptyState.batches).toEqual([]);
    } finally {
      await shutdownDaemon(port);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shuts down a stale daemon before spawning the current version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-cli-stale-"));
    const port = allocatePort();
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    const registryPath = join(dir, "registry.json");
    const logPath = join(dir, "daemon.log");
    let shutdownReceived = false;
    let staleServer: ReturnType<typeof Bun.serve> | undefined = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          return Response.json({
            app: DAEMON_APP_SIGNATURE,
            versionHash: "old-version",
            pid: process.pid,
          });
        }
        if (url.pathname === "/shutdown" && request.method === "POST") {
          shutdownReceived = true;
          setTimeout(() => {
            staleServer?.stop(true);
            staleServer = undefined;
          }, 0);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeState(journalPath, stateFixture());

    try {
      const result = await runDashboardCli([
        "register",
        journalPath,
        "--pid",
        String(process.pid),
        "--port",
        String(port),
        "--registry",
        registryPath,
        "--log",
        logPath,
        "--zero-registry-grace-ms",
        "10000",
      ]);
      expect(result.exitCode).toBe(0);
      expect(shutdownReceived).toBe(true);
      const health = await daemonHealth(port);
      expect(health.versionHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      staleServer?.stop(true);
      await shutdownDaemon(port);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when a foreign process answers the daemon port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-cli-foreign-"));
    const port = allocatePort();
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    writeState(journalPath, stateFixture());
    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch() {
        return Response.json({ app: "other-app" });
      },
    });

    try {
      const result = await runDashboardCli([
        "register",
        journalPath,
        "--pid",
        String(process.pid),
        "--port",
        String(port),
        "--registry",
        join(dir, "registry.json"),
        "--log",
        join(dir, "daemon.log"),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("port override");
    } finally {
      foreign.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when a raw TCP listener occupies the daemon port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-cli-raw-"));
    const raw = await startRawTcpServer();
    const port = serverPort(raw);
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    writeState(journalPath, stateFixture());

    try {
      const result = await runDashboardCli([
        "register",
        journalPath,
        "--pid",
        String(process.pid),
        "--port",
        String(port),
        "--registry",
        join(dir, "registry.json"),
        "--log",
        join(dir, "daemon.log"),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("port override");
      expect(result.stderr.match(/Timed out/g) ?? []).toHaveLength(0);
    } finally {
      await closeServer(raw);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens the dashboard after register reuses an existing daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-cli-open-"));
    const binDir = join(dir, "bin");
    const openLog = join(dir, "open.log");
    const journalPath = join(dir, "repo", ".claude/task-orchestrator/demo/state.json");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "open"),
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$DASHBOARD_OPEN_LOG"\n',
      "utf8",
    );
    chmodSync(join(binDir, "open"), 0o755);
    writeState(journalPath, stateFixture());
    const running = serveDashboard({
      host: "127.0.0.1",
      port: 0,
      registryPath: join(dir, "registry.json"),
      reapIntervalMs: 10_000,
      zeroRegistryGraceMs: 10_000,
      open: false,
    });

    try {
      const port = running.server.port;
      if (port == null) throw new Error("Daemon did not bind a port");
      const result = await runDashboardCli(
        [
          "register",
          journalPath,
          "--pid",
          String(process.pid),
          "--port",
          String(port),
          "--registry",
          join(dir, "registry.json"),
          "--open",
        ],
        {
          env: {
            DASHBOARD_OPEN_LOG: openLog,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      await waitUntil(async () => existsSync(openLog));
      expect(readFileSync(openLog, "utf8").trim()).toBe(running.url);
    } finally {
      running.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats unregister against a dead daemon as nonfatal", async () => {
    const port = allocatePort();
    const result = await runDashboardCli([
      "unregister",
      "/tmp/missing/.claude/task-orchestrator/demo/state.json",
      "--port",
      String(port),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unregister skipped");
  });

  it("rejects the removed positional single-batch mode", async () => {
    const result = await runDashboardCli(["demo"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });

  it("lists exactly the supported subcommands in help", async () => {
    const result = await runDashboardCli(["--help"]);

    expect(result.exitCode).toBe(0);
    const commands = commandNamesFromHelp(result.stdout);
    expect(commands).toEqual(["register", "unregister", "serve", "status"]);
  });
});

async function readStateEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<DashboardBroadcast> {
  let buffer = "";
  for (;;) {
    const chunk = await Promise.race([reader.read(), sleep(1_000).then(() => null)]);
    if (!chunk) throw new Error("Timed out waiting for SSE frame");
    if (chunk.done) throw new Error("SSE stream ended before a state frame arrived");
    buffer += new TextDecoder().decode(chunk.value);
    const frameEnd = buffer.indexOf("\n\n");
    if (frameEnd === -1) continue;
    const frame = buffer.slice(0, frameEnd);
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    return JSON.parse(dataLine.slice("data: ".length)) as DashboardBroadcast;
  }
}

async function receivesStateEventWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    readStateEvent(reader).then(
      () => true,
      () => false,
    ),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

async function responds(url: string): Promise<boolean> {
  try {
    await fetch(`${url}healthz`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}

async function childExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

function edgeActivityFor(state: OrchestratorState, from: string, to: string): string | undefined {
  const snapshot = buildDashboardSnapshot(state);
  const all = [...snapshot.graph.edges, ...snapshot.graph.elidedEdges];
  return all.find((edge) => edge.fromTaskId === from && edge.toTaskId === to)?.activity;
}

function edgeActivityDiamond(): OrchestratorState {
  const manifest = buildManifest([
    task("00-root"),
    task("01-a", ["00-root"]),
    task("02-b", ["00-root"]),
    task("03-c", ["01-a", "02-b"]),
  ]);
  return initState({
    batch: "edge-activity",
    baseBranch: "main",
    integrationBranch: "wyattjoh/edge-activity",
    concurrency: 2,
    manifest,
  });
}

const DASHBOARD_SCRIPT = join(import.meta.dir, "dashboard.ts");

type CliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type HealthzBody = {
  app: string;
  versionHash: string;
  pid: number;
};

type CliRunOptions = {
  timeoutMs?: number | undefined;
  env?: Record<string, string> | undefined;
};

function allocatePort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  const port = server.port;
  server.stop(true);
  if (port == null) throw new Error("Unable to allocate a port");
  return port;
}

async function runDashboardCli(args: string[], options: CliRunOptions = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [DASHBOARD_SCRIPT, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out running dashboard CLI: ${args.join(" ")}`));
    }, options.timeoutMs ?? 8_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return { exitCode, stdout, stderr };
}

async function startRawTcpServer(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function serverPort(server: Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Server did not bind an inet address");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function daemonHealth(port: number): Promise<HealthzBody> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`daemon health failed: ${response.status}`);
  return (await response.json()) as HealthzBody;
}

async function shutdownDaemon(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(500),
    });
  } catch {
    // The daemon may already be stopped.
  }
}

function commandNamesFromHelp(help: string): string[] {
  const lines = help.split("\n");
  const commandStart = lines.findIndex((line) => line.trim() === "Commands:");
  if (commandStart === -1) return [];
  const commands: string[] = [];
  for (const line of lines.slice(commandStart + 1)) {
    if (!line.startsWith("  ")) break;
    if (!/^  \S/.test(line)) continue;
    const command = line.trim().split(/\s+/)[0];
    if (command) commands.push(command);
  }
  return commands;
}

describe("edge activity colors", () => {
  it("marks an edge waiting only while its own prerequisite is unfinished", () => {
    let state = edgeActivityDiamond();
    state = updateTask(state, "00-root", { status: "merged" });
    state = updateTask(state, "01-a", { status: "merged" });
    // 02-b is still queued, 03-c is queued and blocked by 02-b.

    // 01-a is merged, so its edge into the still-blocked 03-c is a satisfied
    // (merged/green) link, not gray queued.
    expect(edgeActivityFor(state, "01-a", "03-c")).toBe("merged");
    // 02-b is not merged, so its edge into 03-c is still waiting (orange).
    expect(edgeActivityFor(state, "02-b", "03-c")).toBe("waiting");
  });

  it("marks every edge into a fully unblocked queued task as ready", () => {
    let state = edgeActivityDiamond();
    state = updateTask(state, "00-root", { status: "merged" });
    state = updateTask(state, "01-a", { status: "merged" });
    state = updateTask(state, "02-b", { status: "merged" });
    // 03-c is now queued with all prerequisites merged: up next.

    expect(edgeActivityFor(state, "01-a", "03-c")).toBe("ready");
    expect(edgeActivityFor(state, "02-b", "03-c")).toBe("ready");
  });

  it("keeps an edge active while its dependent is running", () => {
    let state = edgeActivityDiamond();
    state = updateTask(state, "00-root", { status: "merged" });
    state = updateTask(state, "01-a", { status: "merged" });
    state = updateTask(state, "02-b", { status: "merged" });
    state = updateTask(state, "03-c", { status: "running" });

    expect(edgeActivityFor(state, "01-a", "03-c")).toBe("active");
  });
});

describe("formatSseEvent", () => {
  it("formats event-stream frames with JSON data", () => {
    expect(formatSseEvent("state", { ok: true })).toBe('event: state\ndata: {"ok":true}\n\n');
  });
});

describe("formatSseComment", () => {
  it("keeps SSE connections alive every five seconds", () => {
    expect(SSE_KEEP_ALIVE_INTERVAL_MS).toBe(5_000);
  });

  it("formats keep-alive comments without dispatching browser events", () => {
    expect(formatSseComment("keep-alive")).toBe(": keep-alive\n\n");
  });

  it("formats multiline comments as separate SSE comment lines", () => {
    expect(formatSseComment("first\nsecond")).toBe(": first\n: second\n\n");
  });
});

describe("ancestorDistances", () => {
  it("graduates hop distance up the dependency chain from the focus", () => {
    // a -> b -> c (c depends on b depends on a). Focusing c reaches its
    // dependencies upstream: b at 1, a at 2.
    const distances = ancestorDistances("c", [depEdge("a", "b"), depEdge("b", "c")], []);

    expect(distances.get("c")).toBe(0);
    expect(distances.get("b")).toBe(1);
    expect(distances.get("a")).toBe(2);
  });

  it("walks upstream only, excluding dependents below the focus", () => {
    const distances = ancestorDistances("b", [depEdge("a", "b"), depEdge("b", "c")], []);

    expect(distances.get("b")).toBe(0);
    expect(distances.get("a")).toBe(1);
    // c depends on b (it is downstream); it must not be highlighted.
    expect(distances.has("c")).toBe(false);
  });

  it("ignores dependents entirely when focusing a root task", () => {
    // a is a root (nothing above it); focusing it reaches only itself.
    const distances = ancestorDistances("a", [depEdge("a", "b"), depEdge("b", "c")], []);

    expect([...distances.entries()]).toEqual([["a", 0]]);
  });

  it("includes elided edges so distances match the true dependency graph", () => {
    // a -> b -> c with an elided a -> c shortcut: from c, a is one hop upstream.
    const distances = ancestorDistances(
      "c",
      [depEdge("a", "b"), depEdge("b", "c")],
      [depEdge("a", "c")],
    );

    expect(distances.get("c")).toBe(0);
    expect(distances.get("b")).toBe(1);
    expect(distances.get("a")).toBe(1);
  });

  it("returns only the focus when it has no edges", () => {
    const distances = ancestorDistances("solo", [depEdge("a", "b")], []);

    expect([...distances.entries()]).toEqual([["solo", 0]]);
  });
});

describe("routeEdge", () => {
  it("returns a pure vertical path when source and target x line up", () => {
    expect(routeEdge(40, 20, 50, 40, 80)).toBe("M 40 20 V 80");
    // Sub-pixel x drift still collapses to a straight rail.
    expect(routeEdge(40, 20, 50, 40.3, 80)).toBe("M 40 20 V 80");
  });

  it("produces a monotone-down staircase when the lanes differ", () => {
    const d = routeEdge(40, 20, 60, 88, 100);
    const ys = pathYs(d);

    expect(ys.length).toBeGreaterThan(2);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
    }
    // The path starts at the source y and ends at the target y.
    expect(ys[0]).toBe(20);
    expect(ys[ys.length - 1]).toBe(100);
  });

  it("clamps the corner radius so it never exceeds half of a short vertical run", () => {
    // With only 2px between source and bend, the 5px default radius must shrink.
    const d = routeEdge(40, 20, 22, 80, 100, 5);
    const ys = pathYs(d);

    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
    }
  });
});

describe("computeBendTracks", () => {
  it("bends a fork early (below its source) and a merge late (above its target)", () => {
    const edges = [
      // 01 keeps lane 0 going straight to 02, so 01 -> 06 is a fork off lane 0.
      {
        fromTaskId: "01",
        toTaskId: "02",
        sourceLane: 0,
        targetLane: 0,
        sourceRow: 1,
        targetRow: 2,
      },
      {
        fromTaskId: "01",
        toTaskId: "06",
        sourceLane: 0,
        targetLane: 2,
        sourceRow: 1,
        targetRow: 6,
      },
      // 04 has no sibling continuing lane 0, so 04 -> 07 is a plain merge.
      {
        fromTaskId: "04",
        toTaskId: "07",
        sourceLane: 0,
        targetLane: 1,
        sourceRow: 4,
        targetRow: 7,
      },
    ];

    const bends = computeBendTracks(edges, 40);

    // Fork bends in the band just below source row 1 (rowY(1)=60): 60 + 40/2 = 80,
    // far above the midpoint of its 5-row span, so it drops into lane 2 immediately.
    expect(bends.get("01>06")).toBeCloseTo(80);
    // Merge bends in the channel just above target row 7 (rowY(7)=300): 280.
    expect(bends.get("04>07")).toBeCloseTo(280);
    // The fork's bend hugs its source; the merge's bend hugs its target.
    expect((bends.get("01>06") ?? 0) - 60).toBeLessThan((bends.get("04>07") ?? 0) - 180);
  });

  it("nudges sibling forks from one source onto distinct early tracks", () => {
    const edges = [
      {
        fromTaskId: "01",
        toTaskId: "02",
        sourceLane: 0,
        targetLane: 0,
        sourceRow: 1,
        targetRow: 2,
      },
      {
        fromTaskId: "01",
        toTaskId: "05",
        sourceLane: 0,
        targetLane: 1,
        sourceRow: 1,
        targetRow: 5,
      },
      {
        fromTaskId: "01",
        toTaskId: "06",
        sourceLane: 0,
        targetLane: 2,
        sourceRow: 1,
        targetRow: 6,
      },
    ];

    const bends = computeBendTracks(edges, 40);

    // Both forks share source row 1 (band 60..100), sorted by target lane.
    const first = bends.get("01>05") ?? 0;
    const second = bends.get("01>06") ?? 0;
    expect(first).toBeCloseTo(60 + 40 / 3);
    expect(second).toBeCloseTo(60 + (40 * 2) / 3);
    expect(first).toBeLessThan(second);
    expect(first).toBeGreaterThan(60);
    expect(second).toBeLessThan(100);
  });

  it("treats a lane-changing edge with no continuing sibling as a late merge", () => {
    const edges = [
      { fromTaskId: "a", toTaskId: "b", sourceLane: 0, targetLane: 1, sourceRow: 0, targetRow: 2 },
    ];

    const bends = computeBendTracks(edges, 40);

    // No sibling keeps lane 0, so this bends late, just above target row 2 (=80),
    // not early near source row 0 (rowY(0)=20).
    expect(bends.get("a>b")).toBeCloseTo(80);
  });
});

describe("computeChannelTracks", () => {
  it("places same-row edges on distinct bend tracks inside the channel", () => {
    const edges = [
      { fromTaskId: "a", toTaskId: "z", sourceLane: 1, targetLane: 0, targetRow: 2 },
      { fromTaskId: "b", toTaskId: "z", sourceLane: 0, targetLane: 0, targetRow: 2 },
    ];

    const tracks = computeChannelTracks(edges, 40);

    // Channel band for target row 2 spans (60, 100); sorted by source lane, the
    // lane-0 edge gets the upper track and the lane-1 edge the lower one.
    const upper = tracks.get("b>z") ?? 0;
    const lower = tracks.get("a>z") ?? 0;
    expect(upper).toBeCloseTo(60 + 40 / 3);
    expect(lower).toBeCloseTo(60 + (40 * 2) / 3);
    expect(upper).toBeLessThan(lower);
    expect(upper).toBeGreaterThan(60);
    expect(lower).toBeLessThan(100);
  });

  it("centers a lone edge in its channel", () => {
    const edges = [{ fromTaskId: "a", toTaskId: "b", sourceLane: 0, targetLane: 0, targetRow: 1 }];

    const tracks = computeChannelTracks(edges, 40);

    // Channel band for target row 1 spans (20, 60); the single track sits at the
    // midpoint, strictly below the source row above it for monotone routing.
    expect(tracks.get("a>b")).toBeCloseTo(40);
  });
});

describe("shouldBroadcastForWatchEvent", () => {
  it("accepts atomic state writes that only report the temp filename", () => {
    expect(shouldBroadcastForWatchEvent("rename", "state.json.tmp")).toBe(true);
  });

  it("ignores unrelated files in the state directory", () => {
    expect(shouldBroadcastForWatchEvent("rename", "dashboard.log")).toBe(false);
  });
});
