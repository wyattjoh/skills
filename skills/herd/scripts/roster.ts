#!/usr/bin/env bun
import { Command } from "commander";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The durable record of one herd run.
//
// Workers live in separate OS processes, so the coordinator's context is not the
// source of truth for the batch: if it compacts or the session restarts, the
// only way to tell a still-working worker from an orphaned pane is a file that
// survives both. Every peer name, tab id and worktree path is written here the
// moment it exists, because those are precisely the values that cannot be
// re-derived afterwards.

export type TicketStatus =
  | "pending"
  | "spawning"
  | "working"
  | "reported"
  | "verifying"
  | "merged"
  | "escalated"
  | "blocked"
  | "failed";

export const TERMINAL_STATUSES: readonly TicketStatus[] = [
  "merged",
  "escalated",
  "blocked",
  "failed",
];

export interface Ticket {
  id: string;
  title: string;
  path: string | null;
  dependsOn: string[];
  status: TicketStatus;
  statusSince: string;
  peerName: string | null;
  kind: "claude" | "pi" | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  tabId: string | null;
  paneId: string | null;
  worktree: string | null;
  branch: string | null;
  lastReport: string | null;
  mergedSha: string | null;
}

export interface Roster {
  batch: string;
  createdAt: string;
  coordinatorPeer: string;
  workspaceId: string;
  repoRoot: string;
  targetBranch: string;
  concurrency: number;
  tickets: Ticket[];
}

export class RosterError extends Error {}

export interface TicketSeed {
  id: string;
  title?: string;
  path?: string;
  dependsOn?: string[];
}

export function rosterPath(repoRoot: string, batch: string): string {
  return join(repoRoot, ".herd", batch, "roster.json");
}

// Rejects the graph problems that only surface as a deadlock later: a task that
// waits on something that never runs, a duplicate id whose updates would
// overwrite each other, or a cycle where nothing ever becomes ready.
export function buildRoster(
  seeds: readonly TicketSeed[],
  meta: Omit<Roster, "tickets" | "createdAt">,
  now: string,
): Roster {
  if (seeds.length === 0) throw new RosterError("no tickets supplied");

  const ids = seeds.map((s) => s.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new RosterError(`duplicate ticket ids: ${[...new Set(duplicates)].join(", ")}`);
  }

  const known = new Set(ids);
  for (const seed of seeds) {
    for (const dep of seed.dependsOn ?? []) {
      if (!known.has(dep)) {
        throw new RosterError(`ticket '${seed.id}' depends on unknown ticket '${dep}'`);
      }
      if (dep === seed.id) throw new RosterError(`ticket '${seed.id}' depends on itself`);
    }
  }

  const cycle = findCycle(seeds);
  if (cycle) throw new RosterError(`dependency cycle: ${cycle.join(" -> ")}`);

  return {
    ...meta,
    createdAt: now,
    tickets: seeds.map((seed) => ({
      id: seed.id,
      title: seed.title ?? seed.id,
      path: seed.path ?? null,
      dependsOn: seed.dependsOn ?? [],
      status: "pending" as const,
      statusSince: now,
      peerName: null,
      kind: null,
      agent: null,
      model: null,
      effort: null,
      tabId: null,
      paneId: null,
      worktree: null,
      branch: null,
      lastReport: null,
      mergedSha: null,
    })),
  };
}

export function findCycle(seeds: readonly TicketSeed[]): string[] | null {
  const deps = new Map(seeds.map((s) => [s.id, s.dependsOn ?? []]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const seed of seeds) {
    const found = visit(seed.id);
    if (found) return found;
  }
  return null;
}

// A ticket is ready when every dependency has merged. Dependencies that ended in
// any other terminal state deliberately do not unblock: shipping a dependent on
// top of an escalated parent is how a batch produces a branch nobody reviewed.
export function readyTickets(roster: Roster): Ticket[] {
  const merged = new Set(roster.tickets.filter((t) => t.status === "merged").map((t) => t.id));
  return roster.tickets.filter(
    (t) => t.status === "pending" && t.dependsOn.every((dep) => merged.has(dep)),
  );
}

export function activeTickets(roster: Roster): Ticket[] {
  return roster.tickets.filter(
    (t) =>
      t.status === "spawning" ||
      t.status === "working" ||
      t.status === "reported" ||
      t.status === "verifying",
  );
}

// How many more workers may start right now. Written as a function because the
// coordinator asks after every transition and an off-by-one here either starves
// the batch or blows past the cap the user approved.
export function availableSlots(roster: Roster): number {
  return Math.max(0, roster.concurrency - activeTickets(roster).length);
}

// A dependency that will never merge blocks its dependents permanently. Marking
// them keeps the coordinator from reporting "still pending" for work that can
// no longer start.
export function propagateBlocks(roster: Roster, now: string): Roster {
  const failed = new Set(
    roster.tickets
      .filter((t) => t.status === "escalated" || t.status === "blocked" || t.status === "failed")
      .map((t) => t.id),
  );
  if (failed.size === 0) return roster;

  let changed = true;
  const tickets = roster.tickets.map((t) => ({ ...t }));
  while (changed) {
    changed = false;
    for (const ticket of tickets) {
      if (ticket.status !== "pending") continue;
      if (ticket.dependsOn.some((dep) => failed.has(dep))) {
        ticket.status = "blocked";
        ticket.statusSince = now;
        failed.add(ticket.id);
        changed = true;
      }
    }
  }
  return { ...roster, tickets };
}

export function updateTicket(
  roster: Roster,
  id: string,
  patch: Partial<Omit<Ticket, "id">>,
  now: string,
): Roster {
  const index = roster.tickets.findIndex((t) => t.id === id);
  if (index === -1) throw new RosterError(`unknown ticket '${id}'`);
  const existing = roster.tickets[index]!;
  // statusSince drives "how long has this been stuck" reporting, so it must only
  // move when the status actually changes, not on every unrelated field write.
  const statusChanged = patch.status !== undefined && patch.status !== existing.status;
  const updated: Ticket = {
    ...existing,
    ...patch,
    statusSince: statusChanged ? now : existing.statusSince,
  };
  const tickets = [...roster.tickets];
  tickets[index] = updated;
  return { ...roster, tickets };
}

export function readRoster(path: string): Roster {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Roster).tickets)) {
    throw new RosterError(`${path} is not a roster document`);
  }
  return raw as Roster;
}

// Temp-file plus rename: the coordinator rewrites this on every transition, and
// a partial write would leave the run unresumable.
export function writeRoster(path: string, roster: Roster): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(roster, null, 2)}\n`);
  renameSync(temp, path);
}

export function summarize(roster: Roster): string {
  const lines: string[] = [
    `batch ${roster.batch} -> ${roster.targetBranch} (concurrency ${roster.concurrency})`,
    `coordinator ${roster.coordinatorPeer} in workspace ${roster.workspaceId}`,
    "",
  ];
  for (const ticket of roster.tickets) {
    const peer = ticket.peerName ? ` peer=${ticket.peerName}` : "";
    const tab = ticket.tabId ? ` tab=${ticket.tabId}` : "";
    const deps = ticket.dependsOn.length > 0 ? ` after=${ticket.dependsOn.join(",")}` : "";
    lines.push(`${ticket.status.padEnd(10)} ${ticket.id}${deps}${peer}${tab}`);
  }
  const ready = readyTickets(roster).map((t) => t.id);
  lines.push(
    "",
    `ready: ${ready.length > 0 ? ready.join(", ") : "(none)"}`,
    `slots: ${availableSlots(roster)}`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const program = new Command().name("roster").description("Manage a herd run's durable state");

  program
    .command("init")
    .requiredOption("--repo-root <dir>")
    .requiredOption("--batch <name>")
    .requiredOption("--tickets <file>", "JSON array of { id, title?, path?, dependsOn? }")
    .requiredOption("--coordinator-peer <name>")
    .requiredOption("--workspace <id>")
    .requiredOption("--target <branch>")
    .option("--concurrency <n>", "maximum simultaneous workers", "3")
    .action((opts: Record<string, string>) => {
      const seeds = JSON.parse(readFileSync(opts.tickets!, "utf8")) as TicketSeed[];
      const path = rosterPath(opts.repoRoot!, opts.batch!);
      const roster = buildRoster(
        seeds,
        {
          batch: opts.batch!,
          coordinatorPeer: opts.coordinatorPeer!,
          workspaceId: opts.workspace!,
          repoRoot: opts.repoRoot!,
          targetBranch: opts.target!,
          concurrency: Number(opts.concurrency),
        },
        new Date().toISOString(),
      );
      writeRoster(path, roster);
      console.log(path);
    });

  program
    .command("set")
    .requiredOption("--repo-root <dir>")
    .requiredOption("--batch <name>")
    .requiredOption("--id <ticket>")
    .requiredOption("--patch <json>", "JSON object of ticket fields to update")
    .action((opts: Record<string, string>) => {
      const path = rosterPath(opts.repoRoot!, opts.batch!);
      const now = new Date().toISOString();
      const patch = JSON.parse(opts.patch!) as Partial<Ticket>;
      const updated = propagateBlocks(updateTicket(readRoster(path), opts.id!, patch, now), now);
      writeRoster(path, updated);
      console.log(summarize(updated));
    });

  program
    .command("summary")
    .requiredOption("--repo-root <dir>")
    .requiredOption("--batch <name>")
    .option("--json")
    .action((opts: Record<string, string | boolean>) => {
      const roster = readRoster(rosterPath(opts.repoRoot as string, opts.batch as string));
      if (opts.json) {
        console.log(
          JSON.stringify(
            { roster, ready: readyTickets(roster), slots: availableSlots(roster) },
            null,
            2,
          ),
        );
      } else {
        console.log(summarize(roster));
      }
    });

  program.parse();
}
