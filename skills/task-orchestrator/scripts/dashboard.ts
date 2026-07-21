#!/usr/bin/env bun
import { Command } from "commander";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import {
  DAEMON_APP_SIGNATURE,
  REAP_INTERVAL_MS,
  ZERO_REGISTRY_GRACE_MS,
  adoptHints,
  computeVersionHash,
  decodeRegistry,
  encodeRegistry,
  planEnsure,
  isPlausibleLeasePid,
  repoFromJournalPath,
  shouldReap,
  type DaemonRegistryEntry,
  type HealthzResult,
} from "./daemon.ts";
import { readState, type OrchestratorState, type TaskState, type TaskStatus } from "./state.ts";

type TaskTotals = {
  taskCount: number;
  merged: number;
  active: number;
  queued: number;
  escalated: number;
  blocked: number;
};

type TaskActivity = "queued" | "waiting" | "ready" | "active" | "merged" | "stopped";

type AgentBadge = {
  role: "impl" | "review";
  handle: string;
  status: TaskStatus;
};

type DashboardGraphRow = {
  taskId: string;
  lane: number;
  row: number;
};

type DashboardGraphEdge = {
  fromTaskId: string;
  toTaskId: string;
  sourceRow: number;
  targetRow: number;
  sourceLane: number;
  targetLane: number;
  activity: TaskActivity;
};

type DashboardGraph = {
  rows: DashboardGraphRow[];
  maxLane: number;
  edges: DashboardGraphEdge[];
  elidedEdges: DashboardGraphEdge[];
};

/**
 * A single task row rendered by the browser dashboard.
 */
export type DashboardTask = {
  id: string;
  title: string;
  status: TaskStatus;
  phaseLabel: string;
  activity: TaskActivity;
  dependencies: string[];
  blockedBy: string[];
  remainingPhases: string[];
  round: number;
  worktree: string | null;
  branch: string | null;
  implementerAgent: string | null;
  reviewerAgent: string | null;
  agentBadges: AgentBadge[];
  lastVerdict: "approved" | "changes_requested" | null;
  outstandingComments: string[];
  mergedSha: string | null;
  statusSince: string | null;
};

/**
 * Summary payload sent to the dashboard browser over SSE.
 */
export type DashboardSnapshot = {
  batch: string;
  baseBranch: string;
  integrationBranch: string;
  concurrency: number;
  updatedAt: string;
  totals: TaskTotals;
  tasks: DashboardTask[];
  graph: DashboardGraph;
};

/**
 * Error payload used when a registered state journal cannot be read.
 */
export type DashboardPanelError = {
  error: string;
  path: string;
};

/**
 * Snapshot payload for a registered dashboard panel.
 */
export type DashboardPanelSnapshot = DashboardSnapshot | DashboardPanelError;

/**
 * One registered batch rendered as a dashboard panel.
 */
export type BatchPanel = {
  key: string;
  repo: string;
  snapshot: DashboardPanelSnapshot;
};

/**
 * Whole-dashboard payload sent to the browser over SSE.
 */
export type DashboardBroadcast = {
  batches: BatchPanel[];
};

/**
 * Options for the shared dashboard daemon server.
 */
export type DashboardServeOptions = {
  host: string;
  port: number;
  registryPath: string;
  reapIntervalMs: number;
  zeroRegistryGraceMs: number;
  open: boolean;
};

/**
 * Running shared dashboard daemon handle.
 */
export type RunningDashboardServer = {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
};

type SseClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
};

type RegisteredWatcher = {
  watcher: FSWatcher;
  journals: Set<string>;
  resurrectionTimer: ReturnType<typeof setInterval> | null;
};

const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "running",
  "review",
  "rebasing",
  "verifying",
]);

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  review: "Review",
  rebasing: "Rebase",
  verifying: "Verify",
  merged: "Merged",
  escalated: "Escalated",
  blocked: "Blocked",
};

const PHASE_LABELS: Record<TaskStatus, string[]> = {
  queued: ["Run", "Review", "Rebase", "Verify", "Merge"],
  running: ["Review", "Rebase", "Verify", "Merge"],
  review: ["Rebase", "Verify", "Merge"],
  rebasing: ["Verify", "Merge"],
  verifying: ["Merge"],
  merged: [],
  escalated: [],
  blocked: [],
};

/**
 * Interval between SSE keep-alive comments sent to connected dashboards.
 */
export const SSE_KEEP_ALIVE_INTERVAL_MS = 5_000;

const WATCHER_RESURRECT_INTERVAL_MS = 2_000;

/**
 * Builds the browser-facing view model from the durable orchestrator state.
 *
 * @param state The existing `.claude/task-orchestrator/<batch>/state.json` data.
 * @returns A status dashboard snapshot ordered by the manifest task order.
 */
export function buildDashboardSnapshot(state: OrchestratorState): DashboardSnapshot {
  const tasks = state.manifest.tasks.map((task) => {
    const taskState = state.tasks[task.id] ?? freshUnknownTask();
    const blockedBy = task.dependsOn.filter((dep) => state.tasks[dep]?.status !== "merged");
    return {
      id: task.id,
      title: task.title,
      status: taskState.status,
      // The journal is untrusted runtime data: a status outside the canonical
      // union (e.g. an operator typo) must degrade, not crash the SSE server.
      // Fall back to the raw status as its own label and an empty phase list.
      phaseLabel: STATUS_LABELS[taskState.status] ?? taskState.status,
      activity: taskActivity(taskState.status, blockedBy.length > 0),
      dependencies: task.dependsOn,
      blockedBy,
      remainingPhases: [...(PHASE_LABELS[taskState.status] ?? [])],
      round: taskState.round,
      worktree: taskState.worktree,
      branch: taskState.branch,
      implementerAgent: taskState.implementerAgent,
      reviewerAgent: taskState.reviewerAgent,
      agentBadges: agentBadges(taskState),
      lastVerdict: taskState.lastVerdict,
      outstandingComments: [...taskState.outstandingComments],
      mergedSha: taskState.mergedSha,
      statusSince: taskState.statusSince ?? null,
    } satisfies DashboardTask;
  });

  return {
    batch: state.batch,
    baseBranch: state.baseBranch,
    integrationBranch: state.integrationBranch,
    concurrency: state.concurrency,
    updatedAt: new Date().toISOString(),
    totals: {
      taskCount: tasks.length,
      merged: tasks.filter((task) => task.status === "merged").length,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      queued: tasks.filter((task) => task.status === "queued").length,
      escalated: tasks.filter((task) => task.status === "escalated").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
    },
    tasks,
    graph: buildDashboardGraph(state),
  };
}

function taskActivity(status: TaskStatus, waitingOnDependencies = false): TaskActivity {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (status === "queued") return waitingOnDependencies ? "waiting" : "queued";
  if (status === "merged") return "merged";
  return "stopped";
}

function taskFullyUnblocked(state: OrchestratorState, taskId: string): boolean {
  const task = state.manifest.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return false;
  return task.dependsOn.every((dep) => state.tasks[dep]?.status === "merged");
}

function edgeActivity(
  state: OrchestratorState,
  dependency: string,
  dependent: string,
): TaskActivity {
  const dependencyStatus = state.tasks[dependency]?.status ?? "blocked";
  // The prerequisite is not finished, so this link is still waiting on it.
  if (dependencyStatus !== "merged") return "waiting";
  const dependentStatus = state.tasks[dependent]?.status ?? "blocked";
  if (ACTIVE_STATUSES.has(dependentStatus)) return "active";
  if (dependentStatus === "merged") return "merged";
  // The prerequisite is satisfied. The edge only reads as "ready" (up next) once
  // every prerequisite of the dependent has merged; while other prerequisites are
  // still pending it shows as a satisfied (merged) link rather than queued gray.
  if (dependentStatus === "queued") {
    return taskFullyUnblocked(state, dependent) ? "ready" : "merged";
  }
  return "stopped";
}

function agentBadges(task: TaskState): AgentBadge[] {
  const badges: AgentBadge[] = [];
  if (task.implementerAgent) {
    badges.push({ role: "impl", handle: task.implementerAgent, status: task.status });
  }
  if (task.reviewerAgent) {
    badges.push({ role: "review", handle: task.reviewerAgent, status: task.status });
  }
  return badges;
}

/**
 * Reports whether the direct edge (from, to) is implied by a longer path
 * from -> ... -> to of length >= 2 already present in the dependency graph.
 * Such edges are redundant under transitive reduction (unique for a DAG).
 */
function isRedundant(from: string, to: string, adj: Map<string, Set<string>>): boolean {
  const seen = new Set<string>();
  // Start from successors of `from` excluding the direct hop to `to`, so only
  // paths of length >= 2 can reach `to`.
  const queue = [...(adj.get(from) ?? [])].filter((next) => next !== to);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) queue.push(next);
  }
  return false;
}

function buildDashboardGraph(state: OrchestratorState): DashboardGraph {
  const taskOrder = new Map(state.manifest.tasks.map((task, index) => [task.id, index]));
  const tasksById = new Map(state.manifest.tasks.map((task) => [task.id, task]));
  const childrenById = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const task of state.manifest.tasks) {
    childrenById.set(task.id, []);
    indegree.set(task.id, task.dependsOn.length);
  }
  for (const [dependency, dependent] of state.manifest.edges) {
    childrenById.get(dependency)?.push(dependent);
  }
  for (const [id, children] of childrenById.entries()) {
    childrenById.set(
      id,
      children.toSorted((a, b) => {
        const aDeps = tasksById.get(a)?.dependsOn.length ?? 0;
        const bDeps = tasksById.get(b)?.dependsOn.length ?? 0;
        const depOrder = Number(aDeps > 1) - Number(bDeps > 1);
        if (depOrder !== 0) return depOrder;
        return (taskOrder.get(a) ?? 0) - (taskOrder.get(b) ?? 0);
      }),
    );
  }

  let ready = state.manifest.tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.id);
  const ordered: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    ordered.push(id);
    for (const child of childrenById.get(id) ?? []) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready = ready.toSorted((a, b) => (taskOrder.get(a) ?? 0) - (taskOrder.get(b) ?? 0));
      }
    }
  }

  const rowIndexById = new Map(ordered.map((id, index) => [id, index]));

  // Lane assignment follows git-log-style rails: lane 0 is the base branch
  // trunk, roots reuse lane 1 once the previous component closes, one child
  // continues each parent's mainline, and sibling branches get temporary side
  // lanes for the parent's fan-out span. That avoids both false single-line
  // histories and unbounded rightward drift across independent root groups.
  // Assignment depends only on manifest topology, never on task status, so lanes
  // stay stable across live SSE updates.
  const laneById = new Map<string, number>();
  const laneEndRow = new Map<number, number>();
  const laneOwner = new Map<number, string>();
  const continuationChildById = new Map<string, string>();
  for (const [id, children] of childrenById.entries()) {
    const continuation = children[0];
    if (continuation) continuationChildById.set(id, continuation);
  }
  const minTaskLane = 1;
  let maxLane = 0;

  const furthestChildRow = (id: string): number => {
    const ownRow = rowIndexById.get(id) ?? 0;
    let furthest = ownRow;
    for (const child of childrenById.get(id) ?? []) {
      furthest = Math.max(furthest, rowIndexById.get(child) ?? ownRow);
    }
    return furthest;
  };

  // A lane is available to a node at its row when no rail is still in flight, or
  // when the in-flight owner selected this node as its mainline continuation.
  // That second check is what keeps the first child on the parent's rail while
  // forcing later siblings to branch visually instead of stacking on top of it.
  const laneAvailable = (lane: number, row: number, id: string): boolean => {
    const endRow = laneEndRow.get(lane);
    if (endRow == null || endRow < row) return true;
    const owner = laneOwner.get(lane);
    return owner != null && continuationChildById.get(owner) === id;
  };

  const nearestAvailableLane = (preferred: number, row: number, id: string): number => {
    if (laneAvailable(preferred, row, id)) return preferred;
    for (let offset = 1; ; offset++) {
      const left = preferred - offset;
      if (left >= minTaskLane && laneAvailable(left, row, id)) return left;
      if (laneAvailable(preferred + offset, row, id)) return preferred + offset;
    }
  };

  const incomingBranchEndRow = (id: string, deps: string[]): number => {
    const row = rowIndexById.get(id) ?? 0;
    let end = row;
    for (const dep of deps) {
      if (continuationChildById.get(dep) === id) continue;
      end = Math.max(end, furthestChildRow(dep));
    }
    return end;
  };

  for (const id of ordered) {
    const row = rowIndexById.get(id) ?? 0;
    const deps = tasksById.get(id)?.dependsOn ?? [];
    const parentLanes = deps
      .map((dep) => laneById.get(dep))
      .filter((lane): lane is number => lane != null)
      .toSorted((a, b) => a - b);

    // Roots start from lane 1, keeping lane 0 reserved for the base branch. A
    // single parent continues straight down its lane when this task is that
    // parent's selected mainline; multiple parents prefer the median lane
    // (Eades-Wormald median heuristic) to reduce fan-in crossings.
    const preferred =
      parentLanes.length === 0
        ? minTaskLane
        : parentLanes.length === 1
          ? parentLanes[0]
          : parentLanes[Math.floor(parentLanes.length / 2)];

    const lane = nearestAvailableLane(preferred, row, id);
    laneById.set(id, lane);
    laneOwner.set(lane, id);
    laneEndRow.set(
      lane,
      Math.max(laneEndRow.get(lane) ?? row, furthestChildRow(id), incomingBranchEndRow(id, deps)),
    );
    maxLane = Math.max(maxLane, lane);
  }
  const unroutedEdges = state.manifest.edges
    .map(([dependency, dependent]) => {
      const sourceRow = rowIndexById.get(dependency);
      const targetRow = rowIndexById.get(dependent);
      const sourceLane = laneById.get(dependency);
      const targetLane = laneById.get(dependent);
      if (
        sourceRow == null ||
        targetRow == null ||
        sourceLane == null ||
        targetLane == null ||
        sourceRow >= targetRow
      ) {
        return null;
      }
      return {
        fromTaskId: dependency,
        toTaskId: dependent,
        sourceRow,
        targetRow,
        sourceLane,
        targetLane,
        activity: edgeActivity(state, dependency, dependent),
      };
    })
    .filter((edge): edge is DashboardGraphEdge => edge != null)
    .toSorted((a, b) => {
      const sourceOrder = a.sourceRow - b.sourceRow;
      if (sourceOrder !== 0) return sourceOrder;
      const targetOrder = a.targetRow - b.targetRow;
      if (targetOrder !== 0) return targetOrder;
      return a.targetLane - b.targetLane;
    });

  // Transitive reduction: an edge implied by a longer path is redundant and is
  // moved to elidedEdges (kept so hover closure stays complete and so it can
  // render as a faint ghost rail). The reduction is unique for a DAG.
  const adjacency = new Map<string, Set<string>>();
  for (const [dependency, dependent] of state.manifest.edges) {
    const dependents = adjacency.get(dependency) ?? new Set<string>();
    dependents.add(dependent);
    adjacency.set(dependency, dependents);
  }
  const edges: DashboardGraphEdge[] = [];
  const elidedEdges: DashboardGraphEdge[] = [];
  for (const edge of unroutedEdges) {
    if (isRedundant(edge.fromTaskId, edge.toTaskId, adjacency)) {
      elidedEdges.push(edge);
      continue;
    }
    edges.push(edge);
  }

  return {
    maxLane,
    edges,
    elidedEdges,
    rows: ordered.map((id, index) => {
      return {
        taskId: id,
        lane: laneById.get(id) ?? 0,
        row: index,
      };
    }),
  };
}

/**
 * Encodes one server-sent event frame.
 *
 * @param event The SSE event name.
 * @param data JSON-serializable data for the event.
 * @returns A complete event-stream frame.
 */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Encodes one server-sent event comment frame.
 *
 * @param comment Comment text to send without dispatching a browser event.
 * @returns A complete event-stream comment frame.
 */
export function formatSseComment(comment: string): string {
  return comment
    .split(/\r?\n/)
    .map((line) => `: ${line}`)
    .join("\n")
    .concat("\n\n");
}

/**
 * Checks whether an fs.watch event should trigger a dashboard refresh.
 *
 * @param eventType The fs.watch event type.
 * @param filename The filename reported by fs.watch.
 * @returns True when the event could represent a state journal rewrite.
 */
export function shouldBroadcastForWatchEvent(
  eventType: string,
  filename: string | Buffer | null,
): boolean {
  if (eventType !== "rename" && eventType !== "change") return false;
  if (!filename) return true;
  return String(filename).startsWith("state.json");
}

function freshUnknownTask(): TaskState {
  return {
    status: "blocked",
    round: 0,
    worktree: null,
    branch: null,
    implementerAgent: null,
    reviewerAgent: null,
    lastVerdict: null,
    outstandingComments: ["Task is present in the manifest but missing from state.json"],
    mergedSha: null,
    statusSince: null,
  };
}

function readDashboardPayload(path: string): DashboardPanelSnapshot {
  const state = readState(path);
  if (!state) return { error: "State journal is not readable yet", path };
  return buildDashboardSnapshot(state);
}

function sendEvent(client: SseClient, event: string, data: unknown): void {
  const encoder = new TextEncoder();
  client.controller.enqueue(encoder.encode(formatSseEvent(event, data)));
}

function sendComment(client: SseClient, comment: string): void {
  const encoder = new TextEncoder();
  client.controller.enqueue(encoder.encode(formatSseComment(comment)));
}

/**
 * Computes BFS hop distances from a focused task walking ONLY upstream, to the
 * task's dependencies (the nodes rendered above it). Edges are `dependency ->
 * dependent`, so the walk follows them in reverse (`toTaskId -> fromTaskId`).
 * Dependents (downstream) are deliberately excluded: focusing a node highlights
 * what it waits on, not what waits on it. Both direct and elided edges are
 * walked so distances match the true dependency graph. The returned map only
 * contains the focus and its transitive dependencies; the focus is at 0.
 *
 * Exported for unit testing and embedded verbatim into the browser script via
 * `ancestorDistances.toString()`, so it must stay self-contained (no outside refs).
 *
 * @param taskId The focused task id.
 * @param edges The direct dependency edges (`fromTaskId` depends-upon by `toTaskId`).
 * @param elidedEdges The transitively reduced edges retained from Stage 1.
 * @returns A map of the focus and each transitive dependency to its hop distance.
 */
export function ancestorDistances(
  taskId: string,
  edges: ReadonlyArray<{ fromTaskId: string; toTaskId: string }>,
  elidedEdges: ReadonlyArray<{ fromTaskId: string; toTaskId: string }>,
): Map<string, number> {
  // Map each dependent to its dependencies so we can walk upstream from the focus.
  const parents = new Map<string, string[]>();
  const link = (dependent: string, dependency: string): void => {
    const list = parents.get(dependent);
    if (list) {
      list.push(dependency);
      return;
    }
    parents.set(dependent, [dependency]);
  };
  for (const edge of [...edges, ...elidedEdges]) {
    link(edge.toTaskId, edge.fromTaskId);
  }
  const distances = new Map<string, number>([[taskId, 0]]);
  let frontier = [taskId];
  let hop = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependency of parents.get(id) ?? []) {
        if (distances.has(dependency)) continue;
        distances.set(dependency, hop + 1);
        next.push(dependency);
      }
    }
    frontier = next;
    hop += 1;
  }
  return distances;
}

/**
 * Builds a 4-segment staircase SVG path for one edge, strictly monotone-down (y
 * never decreases along the path), with rounded corners at the single horizontal
 * bend. When the source and target x line up, it returns a pure vertical path so
 * straight rails stay crisp. The corner radius is clamped so it never exceeds
 * half of either vertical run.
 *
 * Exported for unit testing and embedded verbatim into the browser script via
 * `routeEdge.toString()`, so it must stay self-contained (no outside refs).
 *
 * @param sx Source x (node lane center).
 * @param sy Source y.
 * @param bendY The y of the horizontal segment (must sit between sy and ty).
 * @param tx Target x (node lane center).
 * @param ty Target y.
 * @param r Maximum corner radius.
 * @returns An SVG path `d` string.
 */
export function routeEdge(
  sx: number,
  sy: number,
  bendY: number,
  tx: number,
  ty: number,
  r = 5,
): string {
  if (Math.abs(sx - tx) < 0.5) return "M " + sx + " " + sy + " V " + ty;
  const radius = Math.min(r, Math.abs(bendY - sy) / 2, Math.abs(ty - bendY) / 2);
  const dir = tx > sx ? 1 : -1;
  return (
    "M " +
    sx +
    " " +
    sy +
    " V " +
    (bendY - radius) +
    " Q " +
    sx +
    " " +
    bendY +
    " " +
    (sx + dir * radius) +
    " " +
    bendY +
    " H " +
    (tx - dir * radius) +
    " Q " +
    tx +
    " " +
    bendY +
    " " +
    tx +
    " " +
    (bendY + radius) +
    " V " +
    ty
  );
}

/**
 * Assigns each edge its horizontal-bend y. A fork (an edge that leaves its
 * source lane while a sibling edge from the same source keeps that lane going
 * straight) bends EARLY, just below the source row, so the branch drops into its
 * own lane instead of hugging the source lane all the way down. Every other edge
 * (merges and straight rails) keeps the LATE bend just above the target row via
 * `computeChannelTracks`. Both bands are nudged so edges sharing a row get
 * distinct tracks, and every bend stays between its source and target so the
 * path remains monotone-down.
 *
 * Returns the bend y keyed by `fromTaskId + ">" + toTaskId`. Exported for unit
 * testing and embedded verbatim into the browser script via
 * `computeBendTracks.toString()`, so it must stay self-contained (it may only
 * call `computeChannelTracks`, which is embedded alongside it).
 *
 * @param edges The routable edges with their rendered source and target rows.
 * @param rowHeight The pixel height of one task row.
 * @returns A map of edge key to bend y.
 */
export function computeBendTracks(
  edges: ReadonlyArray<{
    fromTaskId: string;
    toTaskId: string;
    sourceLane: number;
    targetLane: number;
    sourceRow: number;
    targetRow: number;
  }>,
  rowHeight: number,
): Map<string, number> {
  const isFork = (edge: (typeof edges)[number]): boolean =>
    edge.fromTaskId !== "" &&
    edge.sourceLane !== edge.targetLane &&
    edges.some(
      (other) =>
        other !== edge &&
        other.fromTaskId !== "" &&
        other.fromTaskId === edge.fromTaskId &&
        other.targetLane === edge.sourceLane,
    );

  const bends = new Map<string, number>();

  // Merges and straight rails keep the late bend just above their target row.
  const others = edges.filter((edge) => !isFork(edge));
  for (const [edgeKey, bendY] of computeChannelTracks(others, rowHeight)) {
    bends.set(edgeKey, bendY);
  }

  // Forks bend early, nudged across the band just below their source row.
  const forkGroups = new Map<number, (typeof edges)[number][]>();
  for (const edge of edges.filter(isFork)) {
    const group = forkGroups.get(edge.sourceRow);
    if (group) group.push(edge);
    else forkGroups.set(edge.sourceRow, [edge]);
  }
  for (const [sourceRow, group] of forkGroups) {
    group.sort(
      (a, b) =>
        a.targetLane - b.targetLane ||
        (a.toTaskId < b.toTaskId ? -1 : a.toTaskId > b.toTaskId ? 1 : 0),
    );
    const k = group.length;
    const bandTop = rowHeight / 2 + sourceRow * rowHeight;
    group.forEach((edge, index) => {
      bends.set(
        edge.fromTaskId + ">" + edge.toTaskId,
        bandTop + (rowHeight * (index + 1)) / (k + 1),
      );
    });
  }
  return bends;
}

/**
 * Assigns each edge a distinct horizontal-segment y inside the inter-row channel
 * directly above its target row, so edges that share a `(sourceLane, targetLane)`
 * pair stop drawing on top of each other. Edges entering the same target row are
 * sorted by `(sourceLane, targetLane)` and spread evenly across the channel band
 * (the row-height gap above the target row), strictly inside it so no horizontal
 * segment touches a node row. The band starts at the y of the row directly above
 * the target, which is the earliest a source can sit, so every bend stays below
 * its source and the path remains monotone-down.
 *
 * Returns the bend y keyed by `fromTaskId + ">" + toTaskId`. Exported for unit
 * testing and embedded verbatim into the browser script via
 * `computeChannelTracks.toString()`, so it must stay self-contained.
 *
 * @param edges The routable edges with their rendered target row.
 * @param rowHeight The pixel height of one task row.
 * @returns A map of edge key to bend y.
 */
export function computeChannelTracks(
  edges: ReadonlyArray<{
    fromTaskId: string;
    toTaskId: string;
    sourceLane: number;
    targetLane: number;
    targetRow: number;
  }>,
  rowHeight: number,
): Map<string, number> {
  const groups = new Map<number, (typeof edges)[number][]>();
  for (const edge of edges) {
    const group = groups.get(edge.targetRow);
    if (group) group.push(edge);
    else groups.set(edge.targetRow, [edge]);
  }
  const tracks = new Map<string, number>();
  for (const [targetRow, group] of groups) {
    group.sort(
      (a, b) =>
        a.sourceLane - b.sourceLane ||
        a.targetLane - b.targetLane ||
        (a.fromTaskId < b.fromTaskId ? -1 : a.fromTaskId > b.fromTaskId ? 1 : 0) ||
        (a.toTaskId < b.toTaskId ? -1 : a.toTaskId > b.toTaskId ? 1 : 0),
    );
    const k = group.length;
    const channelTop = rowHeight / 2 + targetRow * rowHeight - rowHeight;
    group.forEach((edge, index) => {
      tracks.set(
        edge.fromTaskId + ">" + edge.toTaskId,
        channelTop + (rowHeight * (index + 1)) / (k + 1),
      );
    });
  }
  return tracks;
}

function escapeDashboardText(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function renderMetricHtml(key: keyof TaskTotals, label: string, totals: TaskTotals): string {
  return (
    '<div class="metric"><b>' +
    escapeDashboardText(totals[key]) +
    "</b><span>" +
    escapeDashboardText(label) +
    "</span></div>"
  );
}

function renderMetricStrip(totals: TaskTotals): string {
  const labels: [keyof TaskTotals, string][] = [
    ["taskCount", "Tasks"],
    ["merged", "Merged"],
    ["active", "Active"],
    ["queued", "Queued"],
    ["escalated", "Escalated"],
    ["blocked", "Blocked"],
  ];
  return labels.map(([key, label]) => renderMetricHtml(key, label, totals)).join("");
}

function renderEmptyState(hidden: boolean): string {
  return (
    '<section id="empty-state" class="empty-state" data-empty-state' +
    (hidden ? " hidden" : "") +
    ">No active batches</section>"
  );
}

function renderBatchPanelShell(batch: BatchPanel): string {
  const snapshot = batch.snapshot;
  if ("error" in snapshot) {
    return (
      '<section class="batch-panel" data-batch-key="' +
      escapeDashboardText(batch.key) +
      '">' +
      '<div class="panel-header">' +
      '<div class="panel-title">' +
      "<h2>" +
      escapeDashboardText(batch.repo) +
      "</h2>" +
      '<div class="panel-meta">' +
      "<span>" +
      escapeDashboardText(snapshot.error) +
      "</span>" +
      "<span><code>" +
      escapeDashboardText(snapshot.path) +
      "</code></span>" +
      "</div>" +
      "</div>" +
      "</div>" +
      '<section class="task-graph panel-graph panel-error" data-panel-error>' +
      "State journal is not readable." +
      "</section>" +
      "</section>"
    );
  }

  return (
    '<section class="batch-panel" data-batch-key="' +
    escapeDashboardText(batch.key) +
    '">' +
    '<div class="panel-header">' +
    '<div class="panel-title">' +
    "<h2>" +
    escapeDashboardText(batch.repo) +
    "</h2>" +
    '<div class="panel-meta">' +
    "<span>Batch <code>" +
    escapeDashboardText(snapshot.batch) +
    "</code></span>" +
    "<span>Integration <code>" +
    escapeDashboardText(snapshot.integrationBranch) +
    "</code></span>" +
    "</div>" +
    "</div>" +
    '<section class="summary panel-summary" aria-label="Batch totals">' +
    renderMetricStrip(snapshot.totals) +
    "</section>" +
    "</div>" +
    '<section class="task-graph panel-graph" data-panel-graph></section>' +
    "</section>"
  );
}

/**
 * Renders the whole-dashboard broadcast into static panel markup.
 *
 * @param payload The broadcast payload received by the browser.
 * @returns An HTML fragment with the empty state and panels in payload order.
 */
export function renderDashboardBroadcast(payload: DashboardBroadcast): string {
  const hasBatches = payload.batches.length > 0;
  return (
    renderEmptyState(hasBatches) +
    '<section id="panels" class="batch-panels" data-batch-panels' +
    (hasBatches ? "" : " hidden") +
    ">" +
    payload.batches.map(renderBatchPanelShell).join("") +
    "</section>"
  );
}

/**
 * Renders the dashboard document shell.
 *
 * @returns The complete browser dashboard HTML.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Task Orchestrator Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #010409;
        --panel: #0d1117;
        --panel-2: #111821;
        --text: #e6edf3;
        --muted: #7d8590;
        --faint: #30363d;
        --border: #21262d;
        --line: #58a6ff;
        --active: #58a6ff;
        --queued: #6e7681;
        --warn: #f0883e;
        --bad: #f85149;
        --good: #3fb950;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.45 "Space Grotesk", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 24px auto 40px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--panel);
        padding: 22px 28px 28px;
      }

      .dashboard-header {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 16px;
        align-items: end;
        margin-bottom: 20px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: 0;
      }

      .subtle {
        color: var(--muted);
      }

      .status-line {
        text-align: right;
        color: var(--muted);
      }

      .batch-panels {
        display: grid;
        gap: 16px;
      }

      .batch-panel {
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
        background: #0b1017;
      }

      .panel-header {
        display: grid;
        grid-template-columns: minmax(220px, 0.7fr) minmax(0, 1fr);
        gap: 16px;
        align-items: start;
        padding: 16px;
        border-bottom: 1px solid var(--border);
        background: var(--panel-2);
      }

      .panel-title {
        min-width: 0;
      }

      .panel-title h2 {
        margin: 0 0 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 18px;
        line-height: 1.2;
        letter-spacing: 0;
      }

      .panel-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 12px;
        color: var(--muted);
        font-size: 12px;
      }

      .panel-meta span {
        min-width: 0;
      }

      .panel-meta code {
        color: var(--text);
      }

      .empty-state {
        border: 1px dashed var(--border);
        border-radius: 8px;
        padding: 28px;
        color: var(--muted);
        text-align: center;
        background: #0b1017;
      }

      .summary {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 18px;
      }

      .panel-summary {
        margin-bottom: 0;
      }

      .metric {
        border: 1px solid var(--border);
        background: #0d1117;
        border-radius: 8px;
        padding: 10px;
        min-height: 68px;
      }

      .metric b {
        display: block;
        font-size: 20px;
        line-height: 1.1;
      }

      .metric span {
        color: var(--muted);
        font-size: 12px;
      }

      .task-graph {
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
        background: #0b1017;
      }

      .graph-body {
        position: relative;
      }

      .graph-svg {
        position: absolute;
        inset: 0 auto 0 0;
        z-index: 2;
        pointer-events: auto;
        overflow: visible;
      }

      .graph-edge,
      .root-edge {
        fill: none;
        stroke: var(--edge-color);
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
        pointer-events: none;
      }

      .graph-edge-active,
      .root-edge-active {
        opacity: 0.95;
        stroke-width: 2.75;
        stroke-dasharray: 4 5;
        animation: dependency-flow 0.9s linear infinite;
      }

      .graph-edge-queued,
      .root-edge-queued {
        opacity: 0.22;
      }

      .graph-edge-waiting,
      .root-edge-waiting {
        opacity: 0.56;
        stroke-dasharray: 4 5;
        animation: dependency-flow 0.9s linear infinite;
      }

      .graph-edge-ready,
      .root-edge-ready {
        opacity: 0.9;
        stroke-dasharray: 4 5;
        animation: dependency-flow 0.9s linear infinite;
      }

      .graph-edge-merged,
      .root-edge-merged {
        opacity: 0.65;
      }

      .graph-edge-stopped,
      .root-edge-stopped {
        opacity: 0.28;
        stroke-dasharray: 0 0;
      }

      .graph-edge-elided {
        opacity: 0.1;
        stroke-dasharray: 2 8;
        pointer-events: stroke;
      }

      .graph-node {
        fill: var(--node-color);
        stroke: #0d1117;
        stroke-width: 2;
        cursor: pointer;
        pointer-events: auto;
      }

      .graph-node-base {
        fill: #0d1117;
        stroke: #6e7681;
      }

      .base-row,
      .task-row {
        display: flex;
        align-items: center;
        /* Keep in sync with rowHeight in renderGraph: the SVG positions each node
           at this row's vertical center, so a mismatch drifts the dots. */
        height: 46px;
        position: relative;
      }

      .task-row {
        background: var(--row-bg);
        transition: background-color 0.12s ease;
      }

      .task-row:hover {
        background: var(--row-hover);
      }

      .lane {
        flex: none;
        align-self: stretch;
      }

      .graph-spinner {
        animation: spin 1s linear infinite;
        transform-box: view-box;
        pointer-events: none;
      }

      .graph-node-queued {
        fill: #30363d;
        stroke: #161b22;
      }

      .graph-node-waiting {
        fill: #3b2c20;
        stroke: #f0883e;
      }

      /* Per-phase "traffic light" revealed on hover of an active node. It is an
         overlay drawn in the node's own coordinate space, so it never shifts the
         row layout or the edge routing. pointer-events stay off (even when shown)
         so the dot beneath keeps driving the hover, avoiding focus flicker. */
      .node-group .traffic-light {
        opacity: 0;
        pointer-events: none;
        /* Collapsed onto the dot at rest; expands out from it on hover. The
           transform-origin (set inline at the node center) anchors the growth to
           the dot, and the overshoot easing gives it a slight pop. */
        transform: scale(0.2);
        transition:
          opacity 0.16s ease,
          transform 0.26s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .node-group:hover .traffic-light,
      .node-group.tl-open .traffic-light {
        opacity: 1;
        transform: scale(1);
      }

      .tl-bg {
        fill: #0d1117;
        stroke: var(--border);
        stroke-width: 1;
        filter: drop-shadow(0 1px 3px rgba(1, 4, 9, 0.7));
      }

      .tl-lamp circle {
        stroke-width: 1.5;
      }

      .tl-pending circle {
        fill: transparent;
        stroke: var(--faint);
      }

      .tl-active circle {
        fill: var(--active);
        stroke: var(--active);
        animation: tl-pulse 1.1s ease-in-out infinite;
      }

      .tl-done circle {
        fill: var(--good);
        stroke: var(--good);
      }

      /* The active lamp escalates colour with the attempt: blue (1) is the
         default; amber on attempt 2; red on the final attempt. */
      .tl-active.tl-attempt-2 circle {
        fill: var(--warn);
        stroke: var(--warn);
      }

      .tl-active.tl-attempt-final circle {
        fill: var(--bad);
        stroke: var(--bad);
      }

      /* The stage that requested changes and bounced the task back. */
      .tl-rejected circle {
        fill: color-mix(in srgb, var(--bad) 20%, transparent);
        stroke: var(--bad);
      }

      .tl-cross {
        fill: none;
        stroke: var(--bad);
        stroke-width: 1.5;
        stroke-linecap: round;
      }

      .tl-check {
        fill: none;
        stroke: #0d1117;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      @keyframes tl-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.5;
        }
      }

      .graph-body.is-focusing .graph-edge:not(.is-focus),
      .graph-body.is-focusing .root-edge:not(.is-focus) {
        opacity: 0.08;
      }

      .graph-body.is-focusing .graph-node:not(.is-focus),
      .graph-body.is-focusing .graph-spinner:not(.is-focus) {
        opacity: 0.16;
      }

      .graph-body.is-focusing .task-row:not(.is-focus) {
        opacity: 0.38;
      }

      .graph-edge.is-focus,
      .root-edge.is-focus {
        opacity: 1;
        stroke-width: 3;
      }

      .graph-edge.is-focus:not(.graph-edge-waiting):not(.graph-edge-ready):not(.graph-edge-active),
      .root-edge.is-focus:not(.root-edge-waiting):not(.root-edge-ready):not(.root-edge-active) {
        stroke-dasharray: 0 0;
      }

      .graph-edge-waiting.is-focus,
      .root-edge-waiting.is-focus,
      .graph-edge-ready.is-focus,
      .root-edge-ready.is-focus,
      .graph-edge-active.is-focus,
      .root-edge-active.is-focus {
        animation-duration: 0.65s;
        stroke-dasharray: 4 5;
      }

      .graph-node.is-focus {
        opacity: 1;
        stroke-width: 3;
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--node-color) 70%, transparent));
      }

      .task-row.is-focus {
        background: color-mix(in srgb, var(--row-hover) 75%, transparent) !important;
      }

      .label {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding-right: 12px;
        font: 600 14px/1.35 ui-sans-serif, system-ui, sans-serif;
        position: relative;
        z-index: 3;
      }

      .task-copy {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 1px;
      }

      .task-headline {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .task-title {
        color: var(--text);
        font: 700 14px/1.3 ui-sans-serif, system-ui, sans-serif;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 80px;
      }

      .task-id {
        color: var(--muted);
        font: 600 12px/1.3 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 80px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        flex: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 1px 6px;
        font: 650 11px/1.3 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        white-space: nowrap;
      }

      .badge[data-status="running"],
      .badge[data-status="review"],
      .badge[data-status="rebasing"],
      .badge[data-status="verifying"] {
        color: var(--active);
      }

      .badge .attempt {
        margin-left: 4px;
        color: var(--muted);
        font-weight: 600;
      }

      .badge .attempt.final {
        color: var(--warn);
      }

      .timer {
        flex: none;
        color: var(--muted);
        font: 600 11px/1.3 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .badge[data-status="merged"] {
        color: var(--good);
      }

      .badge[data-status="escalated"] {
        color: var(--warn);
      }

      .badge[data-status="blocked"] {
        color: var(--bad);
      }

      code {
        font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        font-size: 12px;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @keyframes dependency-flow {
        from {
          stroke-dashoffset: 0;
        }
        to {
          stroke-dashoffset: -9;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .graph-edge-waiting,
        .root-edge-waiting,
        .graph-edge-ready,
        .root-edge-ready,
        .graph-edge-active,
        .root-edge-active,
        .graph-spinner,
        .tl-active circle {
          animation: none;
        }

        .node-group .traffic-light {
          transition: none;
          transform: none;
        }
      }

      @media (max-width: 760px) {
        main {
          width: min(100vw - 20px, 1180px);
          padding-top: 14px;
        }

        .dashboard-header,
        .panel-header,
        .summary {
          grid-template-columns: 1fr;
        }

        .status-line {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="dashboard-header">
        <div>
          <h1>Task Orchestrator</h1>
        </div>
        <div id="connection" class="status-line">Connecting</div>
      </header>
      ${renderDashboardBroadcast({ batches: [] })}
    </main>
    <script>
      const emptyState = document.getElementById("empty-state");
      const panels = document.getElementById("panels");
      const connection = document.getElementById("connection");

      // Max review->fix attempts before a task escalates (matches the orchestrator
      // loop cap). The pill shows "attempt N/ROUND_CAP" for in-progress tasks.
      const ROUND_CAP = 3;
      const ATTEMPT_PHASES = new Set(["running", "review", "rebasing", "verifying"]);

      // Terminal statuses freeze: no live timer once a task is done one way or another.
      const TERMINAL_STATUSES = new Set(["merged", "escalated", "blocked"]);

      // Compact two-unit elapsed, zero-padded secondary unit so the ticking text
      // keeps a stable width: 12s, 1m05s, 1h05m, 2d03h.
      function formatElapsed(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        if (total < 60) return total + "s";
        const pad = (n) => String(n).padStart(2, "0");
        const minutes = Math.floor(total / 60);
        if (minutes < 60) return minutes + "m" + pad(total % 60) + "s";
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + "h" + pad(minutes % 60) + "m";
        const days = Math.floor(hours / 24);
        return days + "d" + pad(hours % 24) + "h";
      }

      function updateTimers() {
        const now = Date.now();
        for (const chip of panels.querySelectorAll(".timer[data-since]")) {
          chip.textContent = formatElapsed(now - new Date(chip.dataset.since).getTime());
        }
      }

      function escapeText(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]);
      }

      ${escapeDashboardText.toString()}

      ${renderMetricHtml.toString()}

      ${renderMetricStrip.toString()}

      ${renderBatchPanelShell.toString()}

      function taskColor(task) {
        if (task.activity === "stopped" && task.status === "blocked") return "#f85149";
        return activityColor(task.activity);
      }

      function activityColor(activity) {
        if (activity === "queued") return "#6e7681";
        if (activity === "waiting") return "#f0883e";
        if (activity === "merged") return "#3fb950";
        if (activity === "stopped") return "#f85149";
        return "#58a6ff";
      }

      function activityRank(activity) {
        if (activity === "queued") return 0;
        if (activity === "waiting") return 1;
        if (activity === "stopped") return 2;
        if (activity === "merged") return 3;
        if (activity === "ready") return 4;
        return 5;
      }

      // Edge color from the always-satisfied base node to a root task. A queued
      // root has no prerequisites, so it reads as "ready" (up next) rather than
      // the queued gray; running roots are solid blue and merged ones green.
      function rootEdgeActivity(task) {
        if (task.status === "merged") return "merged";
        if (task.status === "queued") return task.blockedBy.length === 0 ? "ready" : "waiting";
        if (task.activity === "active") return "active";
        return "stopped";
      }

      // A comet-trail spinner drawn behind a running node: eight dots on a tight
      // ring, fading to a tail, in the node color. The group rotates via the
      // .graph-spinner CSS animation (origin set inline to the node center).
      function spinnerSvg(cx, cy, color, taskId) {
        const radius = 8.5;
        let dots = "";
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const dx = (cx + radius * Math.cos(angle)).toFixed(2);
          const dy = (cy + radius * Math.sin(angle)).toFixed(2);
          dots += '<circle cx="' + dx + '" cy="' + dy + '" r="1.8" fill="' + color + '" opacity="' + ((i + 1) / 8).toFixed(2) + '"></circle>';
        }
        return '<g class="graph-spinner" data-task-id="' + escapeText(taskId) + '" style="transform-origin:' + cx + 'px ' + cy + 'px;">' + dots + '</g>';
      }

      // The active lifecycle in order. A task's status marks the lamp currently
      // lit; earlier lamps are done (check mark), later ones are pending.
      const TL_PHASES = [
        ["running", "Run"],
        ["review", "Review"],
        ["rebasing", "Rebase"],
        ["verifying", "Verify"],
      ];

      const TL_PITCH = 15; // px between adjacent lamp centers
      const TL_PAD_X = 8; // backing-pill padding beyond the end lamps
      // How far a centered strip reaches to each side of its node center. The
      // graph gutters reserve this plus a gap (see renderGraph) so a strip never
      // collides with the panel edge on the left or the row text on the right.
      const TL_HALF = (TL_PITCH * (TL_PHASES.length - 1)) / 2 + TL_PAD_X;
      const TL_GUTTER = TL_HALF + 16; // strip half-width + breathing room

      // A horizontal strip of phase lamps anchored at the node center (cx, cy),
      // expanding rightward. Drawn inside the node group so CSS reveals it on
      // hover; it overlays edges and neighbours without altering any layout.
      function trafficLightSvg(cx, cy, task) {
        const idx = TL_PHASES.findIndex((phase) => phase[0] === task.status);
        const round = task.round;
        const lampR = 5.2;
        const halfH = 9;
        const span = TL_PITCH * (TL_PHASES.length - 1);
        // Center the strip on the node: the dot sits at the strip's midpoint
        // rather than at its left edge.
        const startX = cx - span / 2;
        const rectX = (startX - TL_PAD_X).toFixed(2);
        const rectW = (span + TL_PAD_X * 2).toFixed(2);
        // The active lamp escalates colour with the attempt number.
        const attemptClass = round >= ROUND_CAP ? " tl-attempt-final" : round >= 2 ? " tl-attempt-2" : "";
        const REVIEW_INDEX = 1; // review is where a changes-requested verdict bounces from
        let lamps = "";
        for (let i = 0; i < TL_PHASES.length; i++) {
          const [, label] = TL_PHASES[i];
          const lx = startX + i * TL_PITCH;
          let state = i < idx ? "done" : i === idx ? "active" : "pending";
          // A task bounced back to the start after review requested changes
          // keeps the rejection on the review lamp until it re-reaches review.
          if (i === REVIEW_INDEX && idx < REVIEW_INDEX && task.lastVerdict === "changes_requested") {
            state = "rejected";
          }
          let word;
          let mark = "";
          if (state === "active") {
            word = "in progress (attempt " + round + "/" + ROUND_CAP + ")";
          } else if (state === "done") {
            word = "passed";
            const d = "M " + (lx - 2.3).toFixed(2) + " " + (cy + 0.2).toFixed(2)
              + " L " + (lx - 0.6).toFixed(2) + " " + (cy + 1.9).toFixed(2)
              + " L " + (lx + 2.5).toFixed(2) + " " + (cy - 2.1).toFixed(2);
            mark = '<path class="tl-check" d="' + d + '"></path>';
          } else if (state === "rejected") {
            word = "changes requested, sent back";
            const d = "M " + (lx - 2).toFixed(2) + " " + (cy - 2).toFixed(2)
              + " L " + (lx + 2).toFixed(2) + " " + (cy + 2).toFixed(2)
              + " M " + (lx + 2).toFixed(2) + " " + (cy - 2).toFixed(2)
              + " L " + (lx - 2).toFixed(2) + " " + (cy + 2).toFixed(2);
            mark = '<path class="tl-cross" d="' + d + '"></path>';
          } else {
            word = "pending";
          }
          const cls = "tl-lamp tl-" + state + (state === "active" ? attemptClass : "");
          lamps += '<g class="' + cls + '">'
            + '<title>' + escapeText(label + " — " + word) + '</title>'
            + '<circle cx="' + lx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + lampR + '"></circle>'
            + mark
            + '</g>';
        }
        // transform-origin at the node center so the strip grows out FROM the dot
        // (see the .traffic-light scale transition in the stylesheet).
        const origin = "transform-origin:" + cx + "px " + cy + "px;transform-box:view-box;";
        return '<g class="traffic-light" style="' + origin + '">'
          + '<rect class="tl-bg" x="' + rectX + '" y="' + (cy - halfH).toFixed(2) + '" width="' + rectW + '" height="' + (halfH * 2) + '" rx="' + halfH + '"></rect>'
          + lamps
          + '</g>';
      }

      function nodeX(lane, pad, laneWidth) {
        return pad + lane * laneWidth;
      }

      function rowY(row, rowHeight) {
        return rowHeight / 2 + row * rowHeight;
      }

      // Routing helpers shared with the server module so the rendered paths match
      // the tested helpers exactly. Embedded verbatim, so each stays self-contained.
      ${routeEdge.toString()}

      ${computeChannelTracks.toString()}

      ${computeBendTracks.toString()}

      function renderGraphSvg(snapshot, tasksById, layout) {
        // Build one routable descriptor per drawn edge across every category (root
        // edges from the base node, direct edges, and faint elided ghost edges) so
        // the bend pass routes fork branches and merge fan-in consistently. Root
        // edges use an empty source id so they anchor at the shared base node lane 0.
        const routable = [];
        const rootRows = snapshot.graph.rows.filter((row) => {
          const task = tasksById[row.taskId];
          return task && task.dependencies.length === 0;
        });
        for (const row of rootRows) {
          routable.push({
            kind: "root",
            fromTaskId: "",
            toTaskId: row.taskId,
            sourceLane: 0,
            targetLane: row.lane,
            sourceRenderRow: 0,
            targetRenderRow: row.row + 1,
            activity: rootEdgeActivity(tasksById[row.taskId]),
          });
        }
        for (const edge of snapshot.graph.elidedEdges) {
          routable.push({
            kind: "elided",
            fromTaskId: edge.fromTaskId,
            toTaskId: edge.toTaskId,
            sourceLane: edge.sourceLane,
            targetLane: edge.targetLane,
            sourceRenderRow: edge.sourceRow + 1,
            targetRenderRow: edge.targetRow + 1,
            activity: edge.activity,
          });
        }
        for (const edge of snapshot.graph.edges) {
          routable.push({
            kind: "edge",
            fromTaskId: edge.fromTaskId,
            toTaskId: edge.toTaskId,
            sourceLane: edge.sourceLane,
            targetLane: edge.targetLane,
            sourceRenderRow: edge.sourceRow + 1,
            targetRenderRow: edge.targetRow + 1,
            activity: edge.activity,
          });
        }

        const bends = computeBendTracks(
          routable.map((e) => ({
            fromTaskId: e.fromTaskId,
            toTaskId: e.toTaskId,
            sourceLane: e.sourceLane,
            targetLane: e.targetLane,
            sourceRow: e.sourceRenderRow,
            targetRow: e.targetRenderRow,
          })),
          layout.rowHeight,
        );

        const pathFor = (e) => {
          const key = e.fromTaskId + ">" + e.toTaskId;
          const sx = nodeX(e.sourceLane, layout.pad, layout.nodeLaneWidth);
          const sy = rowY(e.sourceRenderRow, layout.rowHeight);
          const tx = nodeX(e.targetLane, layout.pad, layout.nodeLaneWidth);
          const ty = rowY(e.targetRenderRow, layout.rowHeight);
          const bendY = bends.get(key) ?? (sy + ty) / 2;
          return routeEdge(sx, sy, bendY, tx, ty);
        };

        let html = '<svg class="graph-svg" width="' + layout.laneAreaWidth + '" height="' + layout.totalHeight + '" viewBox="0 0 ' + layout.laneAreaWidth + " " + layout.totalHeight + '" aria-hidden="true">';
        for (const e of routable) {
          if (e.kind !== "root") continue;
          const color = activityColor(e.activity);
          html += '<path class="root-edge root-edge-' + escapeText(e.activity) + '" data-to="' + escapeText(e.toTaskId) + '" style="--edge-color:' + color + ';" d="' + pathFor(e) + '"></path>';
        }

        for (const e of routable) {
          if (e.kind !== "elided") continue;
          const color = activityColor(e.activity);
          html += '<path class="graph-edge graph-edge-elided" data-from="' + escapeText(e.fromTaskId) + '" data-to="' + escapeText(e.toTaskId) + '" style="--edge-color:' + color + ';" d="' + pathFor(e) + '"></path>';
        }

        // Paint solid edges last and in activity z-order so live rails sit above
        // queued and merged ones.
        const solidEdges = routable
          .filter((e) => e.kind === "edge")
          .sort((a, b) => activityRank(a.activity) - activityRank(b.activity));
        for (const e of solidEdges) {
          const color = activityColor(e.activity);
          html += '<path class="graph-edge graph-edge-' + escapeText(e.activity) + '" data-from="' + escapeText(e.fromTaskId) + '" data-to="' + escapeText(e.toTaskId) + '" style="--edge-color:' + color + ';" d="' + pathFor(e) + '"></path>';
        }

        html += '<circle class="graph-node graph-node-base" cx="' + nodeX(0, layout.pad, layout.nodeLaneWidth) + '" cy="' + rowY(0, layout.rowHeight) + '" r="6"></circle>';
        for (const row of snapshot.graph.rows) {
          const task = tasksById[row.taskId];
          if (!task) continue;
          const x = nodeX(row.lane, layout.pad, layout.nodeLaneWidth);
          const y = rowY(row.row + 1, layout.rowHeight);
          const color = taskColor(task);
          const dot = '<circle class="graph-node graph-node-' + escapeText(task.activity) + '" data-task-id="' + escapeText(row.taskId) + '" style="--node-color:' + color + ';" cx="' + x + '" cy="' + y + '" r="6"></circle>';
          // Active tasks get a spinning comet trail behind the dot plus a
          // hover-revealed per-phase traffic light, grouped with the dot so
          // hovering the node shows the overlay. Merged, waiting, queued, and
          // stopped nodes render a bare dot.
          if (task.activity === "active") {
            html += spinnerSvg(x, y, color, row.taskId);
            html += '<g class="node-group" data-task-id="' + escapeText(row.taskId) + '">'
              + dot
              + trafficLightSvg(x, y, task)
              + '</g>';
          } else {
            html += dot;
          }
        }
        html += '</svg>';
        return html;
      }

      // Shared with the server module so the focus distance metric matches the
      // tested helper exactly. Embedded verbatim, so it stays self-contained.
      ${ancestorDistances.toString()}

      // Distance-of-interest opacity: hop 0 full, then graduated fade so direct
      // blockers pop and distant ancestors recede (van Ham and Perer 2009).
      function focusOpacity(distance) {
        if (distance <= 0) return 1;
        if (distance === 1) return 0.85;
        if (distance === 2) return 0.6;
        return 0.35;
      }

      function setFocusOpacity(element, distance) {
        if (distance == null) {
          // Out of closure: let the is-focusing CSS apply the dimmed default.
          element.classList.remove("is-focus");
          element.style.opacity = "";
          return;
        }
        // Keep the is-focus stroke and glow for hop 0 and 1 only; everything
        // else is graduated purely by inline opacity.
        element.classList.toggle("is-focus", distance <= 1);
        element.style.opacity = String(focusOpacity(distance));
      }

      const pinnedTaskIds = new Map();

      function applyFocus(taskId, snapshot, graphElement) {
        const body = graphElement.querySelector(".graph-body");
        if (!body) return;
        // Upstream only: the focus and the dependencies it waits on (rendered
        // above it), never its dependents below.
        const distances = ancestorDistances(taskId, snapshot.graph.edges, snapshot.graph.elidedEdges);
        body.classList.add("is-focusing");
        for (const row of body.querySelectorAll(".task-row[data-task-id]")) {
          setFocusOpacity(row, distances.get(row.dataset.taskId));
        }
        for (const node of body.querySelectorAll(".graph-node[data-task-id]")) {
          setFocusOpacity(node, distances.get(node.dataset.taskId));
        }
        for (const spinner of body.querySelectorAll(".graph-spinner[data-task-id]")) {
          setFocusOpacity(spinner, distances.get(spinner.dataset.taskId));
        }
        for (const edge of body.querySelectorAll(".graph-edge[data-from][data-to]")) {
          const from = distances.get(edge.dataset.from);
          const to = distances.get(edge.dataset.to);
          // An edge takes the min distance of its two endpoints.
          setFocusOpacity(edge, from == null || to == null ? undefined : Math.min(from, to));
        }
        for (const edge of body.querySelectorAll(".root-edge[data-to]")) {
          setFocusOpacity(edge, distances.get(edge.dataset.to));
        }
      }

      function clearFocus(graphElement) {
        const body = graphElement.querySelector(".graph-body");
        if (!body) return;
        body.classList.remove("is-focusing");
        for (const element of body.querySelectorAll(".task-row, .graph-node, .graph-spinner, .graph-edge, .root-edge")) {
          element.classList.remove("is-focus");
          element.style.opacity = "";
        }
      }

      function bindGraphFocus(snapshot, graphElement, panelKey) {
        // Transient hover focus only when nothing is pinned; on leave, restore the
        // pin or drop the focus. Shared by the dot and the whole row.
        const enterFocus = (id) => {
          if (!pinnedTaskIds.get(panelKey)) applyFocus(id, snapshot, graphElement);
        };
        const leaveFocus = () => {
          const pinnedTaskId = pinnedTaskIds.get(panelKey);
          if (pinnedTaskId) applyFocus(pinnedTaskId, snapshot, graphElement);
          else clearFocus(graphElement);
        };
        for (const node of graphElement.querySelectorAll(".graph-node[data-task-id]")) {
          const id = node.dataset.taskId;
          node.addEventListener("mouseenter", () => enterFocus(id));
          node.addEventListener("mouseleave", leaveFocus);
          node.addEventListener("click", () => {
            if (pinnedTaskIds.get(panelKey) === id) {
              pinnedTaskIds.delete(panelKey);
              clearFocus(graphElement);
              return;
            }
            pinnedTaskIds.set(panelKey, id);
            applyFocus(id, snapshot, graphElement);
          });
        }
        // Hovering anywhere on a row (not only its dot) drives the same upstream
        // highlight, and on active rows also opens that row's traffic light.
        for (const row of graphElement.querySelectorAll(".task-row[data-task-id]")) {
          const id = row.dataset.taskId;
          const group = graphElement.querySelector('.node-group[data-task-id="' + CSS.escape(id) + '"]');
          row.addEventListener("mouseenter", () => {
            enterFocus(id);
            if (group) group.classList.add("tl-open");
          });
          row.addEventListener("mouseleave", () => {
            leaveFocus();
            if (group) group.classList.remove("tl-open");
          });
        }
      }

      function renderGraph(snapshot, graphElement, panelKey) {
        const tasksById = Object.fromEntries(snapshot.tasks.map((task) => [task.id, task]));
        const rowHeight = 46; // keep in sync with the .task-row height in CSS
        // Reserve a traffic-light's half-width plus a gap in both gutters, so the
        // (centered) strip clears the panel edge on the left and the row text on
        // the right whether or not it is currently shown.
        const pad = TL_GUTTER;
        const nodeLaneWidth = 26;
        const laneAreaWidth = pad + snapshot.graph.maxLane * nodeLaneWidth + TL_GUTTER;
        const totalHeight = (snapshot.graph.rows.length + 1) * rowHeight;
        const layout = { rowHeight, pad, nodeLaneWidth, laneAreaWidth, totalHeight };
        let html = '<div class="graph-body" style="--lane-width:' + laneAreaWidth + 'px;">';
        html += renderGraphSvg(snapshot, tasksById, layout);
        html += '<div class="base-row">';
        html += '<div class="lane" style="width:' + laneAreaWidth + 'px;"></div>';
        html += '<div class="label"><span class="task-main">' + escapeText(snapshot.baseBranch) + '</span></div>';
        html += '</div>';
        html += snapshot.graph.rows.map((row) => {
          const task = tasksById[row.taskId];
          if (!task) return "";
          const tint = task.activity === "active" ? "rgba(88, 166, 255, 0.1)" : task.activity === "waiting" ? "rgba(240, 136, 62, 0.06)" : task.activity === "queued" ? "rgba(110, 118, 129, 0.04)" : task.activity === "merged" ? "rgba(63, 185, 80, 0.07)" : "rgba(248, 81, 73, 0.07)";
          const hover = task.activity === "active" ? "rgba(88, 166, 255, 0.16)" : "rgba(110, 118, 129, 0.08)";
          let statusBadge = "";
          if (task.status !== "queued") {
            let inner = escapeText(task.phaseLabel);
            if (ATTEMPT_PHASES.has(task.status) && task.round >= 1) {
              // "attempt N/3" counts retries toward the escalation cap; the final
              // attempt turns amber to flag that one more failure escalates.
              const final = task.round >= ROUND_CAP ? " final" : "";
              inner += '<span class="attempt' + final + '">· attempt ' + task.round + "/" + ROUND_CAP + '</span>';
            }
            statusBadge = '<span class="badge" data-status="' + escapeText(task.status) + '">' + inner + '</span>';
          }
          // Non-terminal rows get a live chip; terminal rows (merged/escalated/
          // blocked) show none so the elapsed time does not grow forever.
          const timerChip =
            !TERMINAL_STATUSES.has(task.status) && task.statusSince
              ? '<span class="timer" data-since="' + escapeText(task.statusSince) + '"></span>'
              : "";
          return '<div class="task-row" data-task-id="' + escapeText(task.id) + '" style="--row-bg:' + tint + ';--row-hover:' + hover + ';">'
            + '<div class="lane" style="width:' + laneAreaWidth + 'px;"></div>'
            + '<div class="label">'
            + '<span class="task-copy"><span class="task-headline"><span class="task-title">' + escapeText(task.title) + '</span>' + statusBadge + timerChip + '</span><span class="task-id">' + escapeText(task.id) + '</span></span>'
            + '</div>'
            + '</div>';
        }).join("");
        html += '</div>';
        graphElement.innerHTML = html;
        bindGraphFocus(snapshot, graphElement, panelKey);
      }

      function renderPanels(batches) {
        const existing = new Map(
          Array.from(panels.querySelectorAll(".batch-panel[data-batch-key]")).map((panel) => [
            panel.dataset.batchKey,
            panel,
          ]),
        );
        const seen = new Set();
        for (const batch of batches) {
          const key = String(batch.key);
          seen.add(key);
          const wrapper = document.createElement("div");
          wrapper.innerHTML = renderBatchPanelShell(batch);
          const freshPanel = wrapper.firstElementChild;
          if (!freshPanel) continue;
          let panel = existing.get(key);
          if (panel) {
            panel.innerHTML = freshPanel.innerHTML;
          } else {
            panel = freshPanel;
          }
          panels.appendChild(panel);
          if (batch.snapshot.error) continue;
          const graphElement = panel.querySelector("[data-panel-graph]");
          if (!graphElement) continue;
          renderGraph(batch.snapshot, graphElement, key);
          const pinnedTaskId = pinnedTaskIds.get(key);
          if (!pinnedTaskId) continue;
          if (batch.snapshot.tasks.some((task) => task.id === pinnedTaskId)) {
            applyFocus(pinnedTaskId, batch.snapshot, graphElement);
          } else {
            pinnedTaskIds.delete(key);
          }
        }
        for (const [key, panel] of existing) {
          if (seen.has(key)) continue;
          pinnedTaskIds.delete(key);
          panel.remove();
        }
      }

      function render(payload) {
        if (payload.error) {
          connection.textContent = payload.error + ": " + payload.path;
          return;
        }
        const batches = Array.isArray(payload.batches) ? payload.batches : [];
        const latestUpdatedAt = batches
          .map((batch) => batch.snapshot.updatedAt)
          .filter(Boolean)
          .sort()
          .at(-1);
        connection.textContent = latestUpdatedAt
          ? "Live, updated " + new Date(latestUpdatedAt).toLocaleTimeString()
          : "Live";
        emptyState.hidden = batches.length > 0;
        panels.hidden = batches.length === 0;
        renderPanels(batches);
        updateTimers();
        renderedOnce = true;
      }

      // Escape clears every pinned focus across panels.
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || pinnedTaskIds.size === 0) return;
        pinnedTaskIds.clear();
        for (const graphElement of panels.querySelectorAll("[data-panel-graph]")) {
          clearFocus(graphElement);
        }
      });

      let renderedOnce = false;
      const events = new EventSource("/events");
      events.addEventListener("state", (event) => render(JSON.parse(event.data)));
      events.addEventListener("open", () => {
        connection.textContent = "Connected";
      });
      events.onerror = () => {
        connection.textContent = renderedOnce ? "Live, reconnecting" : "Connecting";
      };
      setInterval(updateTimers, 1000);
    </script>
  </body>
</html>`;
}

const DAEMON_RUNTIME_SOURCE_FILES = ["dashboard.ts", "daemon.ts", "state.ts"] as const;

function readLocalSource(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Computes the version identity for every local source module loaded by the daemon.
 *
 * @param readSource Source reader used by production and injected by tests.
 * @returns A content hash that changes when any daemon runtime module changes.
 */
export function computeLocalVersionHash(
  readSource: (path: string) => string = readLocalSource,
): string {
  const sourceText = DAEMON_RUNTIME_SOURCE_FILES.map((file) => {
    const source = readSource(join(import.meta.dir, file));
    return `${file.length}:${file}:${source.length}:${source}`;
  }).join("");
  return computeVersionHash(sourceText);
}

function processFactsForPid(pid: number): {
  pidAlive: boolean;
  pidStartMs: number;
  now: number;
} {
  const now = Date.now();
  let pidAlive = false;
  try {
    process.kill(pid, 0);
    pidAlive = true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      pidAlive = error.code === "EPERM";
    }
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const startedAt = Date.parse(result.stdout.trim());
  return {
    pidAlive,
    pidStartMs: Number.isFinite(startedAt) ? startedAt : Number.NaN,
    now,
  };
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  } catch {
    return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  }
}

function dashboardBroadcastForEntries(entries: Iterable<DaemonRegistryEntry>): DashboardBroadcast {
  return {
    batches: [...entries].map((entry) => ({
      key: entry.journalPath,
      repo: entry.repo,
      snapshot: readDashboardPayload(entry.journalPath),
    })),
  };
}

function closeSseClient(clients: Set<SseClient>, client: SseClient): void {
  clients.delete(client);
  if (client.keepAliveTimer) clearInterval(client.keepAliveTimer);
  client.keepAliveTimer = null;
  try {
    client.controller.close();
  } catch {
    // The stream may already be closed by the browser.
  }
}

/**
 * Starts the shared machine-local dashboard daemon.
 *
 * @param options Bind address, registry hint path, and future reap tuning.
 * @returns A handle that can stop the server and release active watchers.
 */
export function serveDashboard(options: DashboardServeOptions): RunningDashboardServer {
  const registry = new Map<string, DaemonRegistryEntry>();
  const watchers = new Map<string, RegisteredWatcher>();
  const clients = new Set<SseClient>();
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let reapTimer: ReturnType<typeof setInterval> | undefined = undefined;
  let zeroRegistryGraceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let stopped = false;

  const broadcast = (): void => {
    const payload = currentBroadcast();
    for (const client of clients) sendEvent(client, "state", payload);
  };

  const scheduleBroadcast = (): void => {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      broadcast();
    }, 25);
  };

  const refreshMissingWatchers = (): void => {
    for (const entry of registry.values()) {
      if (existsSync(dirname(entry.journalPath))) continue;
      markWatcherMissing(dirname(entry.journalPath));
    }
  };

  const currentBroadcast = (): DashboardBroadcast => {
    refreshMissingWatchers();
    return dashboardBroadcastForEntries(registry.values());
  };

  const persistRegistry = (): void => {
    mkdirSync(dirname(options.registryPath), { recursive: true });
    writeFileSync(options.registryPath, encodeRegistry(Object.fromEntries(registry)), "utf8");
  };

  const clearZeroRegistryGrace = (): void => {
    if (!zeroRegistryGraceTimer) return;
    clearTimeout(zeroRegistryGraceTimer);
    zeroRegistryGraceTimer = undefined;
  };

  const scheduleZeroRegistryGrace = (): void => {
    if (registry.size > 0) {
      clearZeroRegistryGrace();
      return;
    }
    if (zeroRegistryGraceTimer) return;
    zeroRegistryGraceTimer = setTimeout(() => {
      zeroRegistryGraceTimer = undefined;
      stop();
    }, options.zeroRegistryGraceMs);
  };

  const noteRegistryChanged = (): void => {
    persistRegistry();
    scheduleZeroRegistryGrace();
    scheduleBroadcast();
  };

  const markWatcherMissing = (stateDir: string): void => {
    const watched = watchers.get(stateDir);
    if (!watched) return;
    if (watched.resurrectionTimer) return;
    watched.watcher.close();
    watched.resurrectionTimer = setInterval(() => {
      if (!existsSync(stateDir)) return;
      const journals = [...watched.journals];
      watchers.delete(stateDir);
      clearInterval(watched.resurrectionTimer!);
      watched.resurrectionTimer = null;
      for (const journalPath of journals) {
        ensureWatcher(journalPath);
      }
      scheduleBroadcast();
    }, WATCHER_RESURRECT_INTERVAL_MS);
    scheduleBroadcast();
  };

  const ensureWatcher = (journalPath: string): Response | null => {
    const stateDir = dirname(journalPath);
    const existing = watchers.get(stateDir);
    if (existing) {
      existing.journals.add(journalPath);
      return null;
    }

    try {
      const watched: RegisteredWatcher = {
        watcher: watch(stateDir, (eventType, filename) => {
          if (!existsSync(stateDir)) {
            markWatcherMissing(stateDir);
            return;
          }
          if (!shouldBroadcastForWatchEvent(eventType, filename)) return;
          scheduleBroadcast();
        }),
        journals: new Set([journalPath]),
        resurrectionTimer: null,
      };
      watched.watcher.on("error", () => {
        markWatcherMissing(stateDir);
      });
      watchers.set(stateDir, watched);
      return null;
    } catch (error) {
      return Response.json(
        {
          error: "Unable to watch state journal directory",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      );
    }
  };

  const removeWatcherReference = (journalPath: string): void => {
    const stateDir = dirname(journalPath);
    const watched = watchers.get(stateDir);
    if (!watched) return;
    watched.journals.delete(journalPath);
    if (watched.journals.size > 0) return;
    if (watched.resurrectionTimer) clearInterval(watched.resurrectionTimer);
    watched.watcher.close();
    watchers.delete(stateDir);
  };

  const cleanupRuntime = (): void => {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    if (reapTimer) clearInterval(reapTimer);
    clearZeroRegistryGrace();
    for (const watched of watchers.values()) {
      if (watched.resurrectionTimer) clearInterval(watched.resurrectionTimer);
      watched.watcher.close();
    }
    watchers.clear();
    while (clients.size > 0) {
      const client = clients.values().next().value;
      if (!client) break;
      closeSseClient(clients, client);
    }
  };

  let server: ReturnType<typeof Bun.serve> | undefined = undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cleanupRuntime();
    server?.stop(true);
  };

  const reapDeadLeases = (): void => {
    const reapedJournalPaths: string[] = [];
    for (const [journalPath, entry] of registry.entries()) {
      const facts = processFactsForPid(entry.pid);
      if (!shouldReap(entry, facts.pidAlive, facts.now)) continue;
      reapedJournalPaths.push(journalPath);
    }
    for (const journalPath of reapedJournalPaths) {
      registry.delete(journalPath);
      removeWatcherReference(journalPath);
    }
    if (reapedJournalPaths.length > 0) noteRegistryChanged();
  };

  const adoptRegistryHints = (): void => {
    const text = existsSync(options.registryPath)
      ? readFileSync(options.registryPath, "utf8")
      : null;
    const hinted = Object.values(decodeRegistry(text));
    const pidAliveByPid = new Map<number, boolean>();
    const journalReadableByPath = new Map<string, boolean>();
    for (const entry of hinted) {
      if (!pidAliveByPid.has(entry.pid)) {
        pidAliveByPid.set(entry.pid, processFactsForPid(entry.pid).pidAlive);
      }
      journalReadableByPath.set(entry.journalPath, readState(entry.journalPath) !== null);
    }

    const adopted = adoptHints(hinted, pidAliveByPid, journalReadableByPath).toSorted((a, b) => {
      const registrationOrder = a.registeredAt.localeCompare(b.registeredAt);
      return registrationOrder || a.journalPath.localeCompare(b.journalPath);
    });
    for (const entry of adopted) {
      const watchError = ensureWatcher(entry.journalPath);
      if (watchError) continue;
      registry.set(entry.journalPath, entry);
    }
    persistRegistry();
    scheduleZeroRegistryGrace();
  };

  try {
    server = Bun.serve({
      hostname: options.host,
      port: options.port,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/") {
          return new Response(dashboardHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/healthz" && request.method === "GET") {
          return Response.json({
            app: DAEMON_APP_SIGNATURE,
            versionHash: computeLocalVersionHash(),
            pid: process.pid,
          });
        }
        if (url.pathname === "/state" && request.method === "GET") {
          return Response.json(currentBroadcast());
        }
        if (url.pathname === "/events" && request.method === "GET") {
          let client: SseClient | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              client = {
                controller,
                keepAliveTimer: setInterval(() => {
                  if (client) sendComment(client, "keep-alive");
                }, SSE_KEEP_ALIVE_INTERVAL_MS),
              };
              clients.add(client);
              sendEvent(client, "state", currentBroadcast());
            },
            cancel() {
              if (!client) return;
              closeSseClient(clients, client);
              client = undefined;
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        if (url.pathname === "/register" && request.method === "POST") {
          const body = await parseJsonObject(request);
          if (body instanceof Response) return body;
          const { journalPath, pid } = body;
          if (typeof journalPath !== "string" || !isAbsolute(journalPath)) {
            return Response.json({ error: "journalPath must be absolute" }, { status: 400 });
          }
          if (typeof pid !== "number") {
            return Response.json({ error: "pid must be a number" }, { status: 400 });
          }
          const facts = processFactsForPid(pid);
          if (!isPlausibleLeasePid(pid, facts.pidAlive, facts.pidStartMs, facts.now)) {
            return Response.json({ error: "pid is not a plausible live lease" }, { status: 400 });
          }
          const watchError = ensureWatcher(journalPath);
          if (watchError) return watchError;

          const entry: DaemonRegistryEntry = {
            journalPath,
            pid,
            repo: repoFromJournalPath(journalPath),
            registeredAt: new Date().toISOString(),
          };
          registry.delete(journalPath);
          registry.set(journalPath, entry);
          noteRegistryChanged();
          return Response.json({ ok: true, entry });
        }
        if (url.pathname === "/unregister" && request.method === "POST") {
          const body = await parseJsonObject(request);
          if (body instanceof Response) return body;
          const { journalPath } = body;
          if (typeof journalPath !== "string" || !isAbsolute(journalPath)) {
            return Response.json({ error: "journalPath must be absolute" }, { status: 400 });
          }
          if (registry.delete(journalPath)) {
            removeWatcherReference(journalPath);
            noteRegistryChanged();
          }
          return Response.json({ ok: true });
        }
        if (url.pathname === "/shutdown" && request.method === "POST") {
          setTimeout(stop, 0);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    adoptRegistryHints();
    reapTimer = setInterval(reapDeadLeases, options.reapIntervalMs);
  } catch (error) {
    cleanupRuntime();
    server?.stop(true);
    throw error;
  }

  const boundServer = server;
  if (!boundServer) throw new Error("Dashboard daemon did not start");

  const url = `http://${boundServer.hostname}:${boundServer.port}/`;
  process.stdout.write(`Task orchestrator dashboard daemon: ${url}\n`);
  if (options.open) spawn("open", [url], { stdio: "ignore", detached: true }).unref();

  return { url, server: boundServer, stop };
}

type RegisterCommandOptions = {
  host: string;
  port: number;
  pid: number;
  registry: string;
  log: string;
  reapIntervalMs: number;
  zeroRegistryGraceMs: number;
  open: boolean;
};

type ClientCommandOptions = {
  host: string;
  port: number;
  registry: string;
};

type DashboardClientOptions = {
  host: string;
  port: number;
  registryPath: string;
};

type DashboardSpawnOptions = DashboardClientOptions & {
  logPath: string;
  reapIntervalMs: number;
  zeroRegistryGraceMs: number;
  open: boolean;
};

type HealthyHealthzResult = Extract<HealthzResult, { kind: "healthy" }>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3837;
const DEFAULT_REGISTRY_PATH = join(homedir(), ".claude/task-orchestrator/registry.json");
const DEFAULT_DAEMON_LOG_PATH = join(homedir(), ".claude/task-orchestrator/daemon.log");
const DAEMON_READY_TIMEOUT_MS = 5_000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 3_000;
const DAEMON_POLL_INTERVAL_MS = 100;

async function main(): Promise<void> {
  const program = new Command()
    .name("dashboard")
    .description("Task-orchestrator dashboard daemon client")
    .addHelpCommand(false)
    .showHelpAfterError();

  program
    .command("register")
    .description("Ensure the dashboard daemon is running and register a state journal")
    .argument("<journal-path>", "Absolute or relative path to a state.json journal")
    .requiredOption("--pid <pid>", "Foreground process id holding the dashboard lease", parsePid)
    .option("--host <host>", "Host to bind or contact", DEFAULT_HOST)
    .option("--port <port>", "Port to bind or contact", parseClientPort, DEFAULT_PORT)
    .option("--registry <path>", "Registry hint file location", DEFAULT_REGISTRY_PATH)
    .option("--log <path>", "Detached daemon log file", DEFAULT_DAEMON_LOG_PATH)
    .option(
      "--reap-interval-ms <ms>",
      "Registry reap interval",
      parseMilliseconds,
      REAP_INTERVAL_MS,
    )
    .option(
      "--zero-registry-grace-ms <ms>",
      "Grace period before exiting with no registry entries",
      parseMilliseconds,
      ZERO_REGISTRY_GRACE_MS,
    )
    .option("--open", "Open the dashboard URL with the platform browser", false)
    .action(async (journalPath: string, opts: RegisterCommandOptions) => {
      await registerDashboard(journalPath, normalizeRegisterOptions(opts));
    });

  program
    .command("unregister")
    .description("Unregister a state journal from the dashboard daemon")
    .argument("<journal-path>", "Absolute or relative path to a state.json journal")
    .option("--host <host>", "Host to contact", DEFAULT_HOST)
    .option("--port <port>", "Port to contact", parseClientPort, DEFAULT_PORT)
    .option("--registry <path>", "Registry hint file location", DEFAULT_REGISTRY_PATH)
    .action(async (journalPath: string, opts: ClientCommandOptions) => {
      await unregisterDashboard(journalPath, normalizeClientOptions(opts));
    });

  program
    .command("serve")
    .description("Serve the shared task-orchestrator dashboard daemon")
    .option("--host <host>", "Host to bind", DEFAULT_HOST)
    .option("--port <port>", "Port to bind, use 0 for an ephemeral port", parsePort, DEFAULT_PORT)
    .option("--registry <path>", "Registry hint file location", DEFAULT_REGISTRY_PATH)
    .option(
      "--reap-interval-ms <ms>",
      "Registry reap interval",
      parseMilliseconds,
      REAP_INTERVAL_MS,
    )
    .option(
      "--zero-registry-grace-ms <ms>",
      "Grace period before exiting with no registry entries",
      parseMilliseconds,
      ZERO_REGISTRY_GRACE_MS,
    )
    .option("--open", "Open the dashboard URL with the platform browser", false)
    .action(
      (opts: {
        host: string;
        port: number;
        registry: string;
        reapIntervalMs: number;
        zeroRegistryGraceMs: number;
        open: boolean;
      }) => {
        startServeCommand(opts);
      },
    );

  program
    .command("status")
    .description("Print dashboard daemon health and registered batches")
    .option("--host <host>", "Host to contact", DEFAULT_HOST)
    .option("--port <port>", "Port to contact", parseClientPort, DEFAULT_PORT)
    .option("--registry <path>", "Registry hint file location", DEFAULT_REGISTRY_PATH)
    .action(async (opts: ClientCommandOptions) => {
      await printDashboardStatus(normalizeClientOptions(opts));
    });

  await program.parseAsync();
}

async function registerDashboard(
  journalPathInput: string,
  options: DashboardSpawnOptions & { pid: number },
): Promise<void> {
  const journalPath = resolve(journalPathInput);
  const baseUrl = daemonBaseUrl(options);
  const localHash = computeLocalVersionHash();
  const decision = planEnsure(await probeHealthz(baseUrl), localHash);

  if (decision.action === "foreign-port-error") {
    throw new Error(foreignPortMessage(options.port, decision.app));
  }

  if (decision.action === "shutdown-and-spawn") {
    await postJson(baseUrl, "/shutdown", {});
    await waitForHealthz(
      baseUrl,
      (healthz) => healthz.kind === "absent",
      DAEMON_SHUTDOWN_TIMEOUT_MS,
    );
  }

  if (decision.action === "spawn" || decision.action === "shutdown-and-spawn") {
    spawnDashboardDaemon(options);
    await waitForHealthyDaemon(baseUrl, localHash);
  }

  const response = await postJson(baseUrl, "/register", { journalPath, pid: options.pid });
  if (!response.ok) throw new Error(await responseError(response, "register failed"));
  if (options.open) openDashboardUrl(baseUrl);
  process.stdout.write(`Registered ${journalPath} with dashboard daemon at ${baseUrl}\n`);
}

async function unregisterDashboard(
  journalPathInput: string,
  options: DashboardClientOptions,
): Promise<void> {
  const journalPath = resolve(journalPathInput);
  const baseUrl = daemonBaseUrl(options);
  const healthz = await probeHealthz(baseUrl);
  if (healthz.kind === "absent") {
    process.stdout.write("Dashboard daemon is not running; unregister skipped.\n");
    return;
  }
  if (healthz.kind === "foreign" || healthz.app !== DAEMON_APP_SIGNATURE) {
    throw new Error(foreignPortMessage(options.port, healthz.app));
  }

  try {
    const response = await postJson(baseUrl, "/unregister", { journalPath });
    if (!response.ok) throw new Error(await responseError(response, "unregister failed"));
    process.stdout.write(`Unregistered ${journalPath} from dashboard daemon at ${baseUrl}\n`);
  } catch (error) {
    if ((await probeHealthz(baseUrl)).kind === "absent") {
      process.stdout.write(
        "Dashboard daemon stopped before unregister completed; unregister skipped.\n",
      );
      return;
    }
    throw error;
  }
}

async function printDashboardStatus(options: DashboardClientOptions): Promise<void> {
  const baseUrl = daemonBaseUrl(options);
  const healthz = await probeHealthz(baseUrl);
  if (healthz.kind === "absent") {
    process.stdout.write(`Dashboard daemon: not running at ${baseUrl}\n`);
    return;
  }
  if (healthz.kind === "foreign" || healthz.app !== DAEMON_APP_SIGNATURE) {
    throw new Error(foreignPortMessage(options.port, healthz.app));
  }

  const stateResponse = await fetch(new URL("/state", baseUrl), {
    signal: AbortSignal.timeout(1_000),
  });
  if (!stateResponse.ok) throw new Error(await responseError(stateResponse, "state fetch failed"));
  const state = (await stateResponse.json()) as DashboardBroadcast;

  process.stdout.write(`Dashboard daemon: running at ${baseUrl}\n`);
  process.stdout.write(
    `Health: app=${healthz.app} pid=${healthz.pid} version=${healthz.versionHash}\n`,
  );
  process.stdout.write(`Registered batches: ${state.batches.length}\n`);
  for (const batch of state.batches) {
    process.stdout.write(`- ${batch.key}\n`);
    process.stdout.write(`  repo: ${batch.repo}\n`);
    if ("error" in batch.snapshot) {
      process.stdout.write(`  error: ${batch.snapshot.error}\n`);
    } else {
      process.stdout.write(`  batch: ${batch.snapshot.batch}\n`);
      process.stdout.write(`  tasks: ${batch.snapshot.totals.taskCount}\n`);
    }
  }
}

function startServeCommand(opts: {
  host: string;
  port: number;
  registry: string;
  reapIntervalMs: number;
  zeroRegistryGraceMs: number;
  open: boolean;
}): void {
  try {
    const running = serveDashboard({
      host: opts.host,
      port: opts.port,
      registryPath: expandHomePath(opts.registry),
      reapIntervalMs: opts.reapIntervalMs,
      zeroRegistryGraceMs: opts.zeroRegistryGraceMs,
      open: opts.open,
    });
    attachStopSignals(running);
  } catch (error) {
    if (isAddressInUseError(error)) {
      process.stderr.write(`EADDRINUSE: dashboard daemon port ${opts.port} is already in use\n`);
      process.exit(1);
    }
    throw error;
  }
}

function spawnDashboardDaemon(options: DashboardSpawnOptions): void {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, "a");
  try {
    const args = [
      import.meta.path,
      "serve",
      "--host",
      options.host,
      "--port",
      String(options.port),
      "--registry",
      options.registryPath,
      "--reap-interval-ms",
      String(options.reapIntervalMs),
      "--zero-registry-grace-ms",
      String(options.zeroRegistryGraceMs),
    ];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

async function probeHealthz(baseUrl: string): Promise<HealthzResult> {
  const portOpen = await probeTcpPort(baseUrl);
  if (!portOpen) return { kind: "absent" };

  try {
    const response = await fetch(new URL("/healthz", baseUrl), {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return { kind: "foreign", app: null };
    const body = (await response.json()) as unknown;
    if (!isHealthzBody(body)) {
      return { kind: "foreign", app: healthzApp(body) };
    }
    return {
      kind: "healthy",
      app: body.app,
      versionHash: body.versionHash,
      pid: body.pid,
    };
  } catch {
    return { kind: "foreign", app: null };
  }
}

async function probeTcpPort(baseUrl: string): Promise<boolean> {
  const url = new URL(baseUrl);
  const port = Number(url.port);
  if (!Number.isInteger(port)) return false;

  return await new Promise((done) => {
    const socket = createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      done(true);
    }, 500);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      done(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

function openDashboardUrl(url: string): void {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

async function waitForHealthyDaemon(
  baseUrl: string,
  localHash: string,
): Promise<HealthyHealthzResult> {
  const healthz = await waitForHealthz(
    baseUrl,
    (result) =>
      result.kind === "healthy" &&
      result.app === DAEMON_APP_SIGNATURE &&
      result.versionHash === localHash,
    DAEMON_READY_TIMEOUT_MS,
  );
  if (healthz.kind !== "healthy") throw new Error("Dashboard daemon did not report healthy");
  return healthz;
}

async function waitForHealthz(
  baseUrl: string,
  predicate: (healthz: HealthzResult) => boolean,
  timeoutMs: number,
): Promise<HealthzResult> {
  const startedAt = Date.now();
  let lastHealthz: HealthzResult = { kind: "absent" };
  while (Date.now() - startedAt < timeoutMs) {
    lastHealthz = await probeHealthz(baseUrl);
    if (predicate(lastHealthz)) return lastHealthz;
    await sleep(DAEMON_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for dashboard daemon at ${baseUrl}: ${describeHealthz(lastHealthz)}`,
  );
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return await fetch(new URL(path, baseUrl), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(1_000),
  });
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  return text ? `${fallback}: ${response.status} ${text}` : `${fallback}: ${response.status}`;
}

function normalizeRegisterOptions(
  opts: RegisterCommandOptions,
): DashboardSpawnOptions & { pid: number } {
  return {
    ...normalizeClientOptions(opts),
    pid: opts.pid,
    logPath: expandHomePath(opts.log),
    reapIntervalMs: opts.reapIntervalMs,
    zeroRegistryGraceMs: opts.zeroRegistryGraceMs,
    open: opts.open,
  };
}

function normalizeClientOptions(opts: ClientCommandOptions): DashboardClientOptions {
  return {
    host: opts.host,
    port: opts.port,
    registryPath: expandHomePath(opts.registry),
  };
}

function daemonBaseUrl(options: DashboardClientOptions): string {
  return `http://${options.host}:${options.port}/`;
}

function isHealthzBody(value: unknown): value is {
  app: string;
  versionHash: string;
  pid: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "app" in value &&
    typeof value.app === "string" &&
    "versionHash" in value &&
    typeof value.versionHash === "string" &&
    "pid" in value &&
    typeof value.pid === "number"
  );
}

function healthzApp(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("app" in value)) return null;
  return typeof value.app === "string" ? value.app : null;
}

function describeHealthz(healthz: HealthzResult): string {
  if (healthz.kind === "absent") return "absent";
  if (healthz.kind === "foreign") return `foreign app=${healthz.app ?? "unknown"}`;
  return `app=${healthz.app} pid=${healthz.pid} version=${healthz.versionHash}`;
}

function foreignPortMessage(port: number, app: string | null): string {
  return `Port ${port} is already answered by ${app ?? "a foreign process"}. Stop it or pass a port override with --port.`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

function attachStopSignals(running: RunningDashboardServer): void {
  const stop = (): void => {
    running.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port "${value}"`);
  }
  return port;
}

function parseClientPort(value: string): number {
  const port = parsePort(value);
  if (port === 0) {
    throw new Error("Client commands require a fixed port");
  }
  return port;
}

function parsePid(value: string): number {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid "${value}"`);
  }
  return pid;
}

function parseMilliseconds(value: string): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`Invalid milliseconds "${value}"`);
  }
  return ms;
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
