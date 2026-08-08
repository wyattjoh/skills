import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableSlots,
  buildRoster,
  findCycle,
  propagateBlocks,
  readRoster,
  readyTickets,
  type Roster,
  RosterError,
  rosterPath,
  summarize,
  type TicketSeed,
  updateTicket,
  writeRoster,
} from "./roster.ts";

const NOW = "2026-08-07T00:00:00.000Z";
const LATER = "2026-08-07T01:00:00.000Z";

const meta = {
  batch: "defects",
  coordinatorPeer: "skills-1d",
  workspaceId: "wJE",
  repoRoot: "/repo",
  targetBranch: "main",
  concurrency: 3,
};

const make = (seeds: TicketSeed[], concurrency = 3): Roster =>
  buildRoster(seeds, { ...meta, concurrency }, NOW);

describe("buildRoster", () => {
  it("seeds every ticket as pending", () => {
    const roster = make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]);
    expect(roster.tickets.map((t) => t.status)).toEqual(["pending", "pending"]);
  });

  it("defaults the title to the id and the path to null", () => {
    const roster = make([{ id: "01" }]);
    expect(roster.tickets[0]!.title).toBe("01");
    expect(roster.tickets[0]!.path).toBe(null);
  });

  it("rejects an empty ticket list", () => {
    expect(() => make([])).toThrow("no tickets supplied");
  });

  it("rejects duplicate ids", () => {
    expect(() => make([{ id: "01" }, { id: "01" }])).toThrow("duplicate ticket ids: 01");
  });

  it("rejects a dependency on an unknown ticket", () => {
    expect(() => make([{ id: "01", dependsOn: ["99"] }])).toThrow(
      "ticket '01' depends on unknown ticket '99'",
    );
  });

  it("rejects a self-dependency", () => {
    expect(() => make([{ id: "01", dependsOn: ["01"] }])).toThrow("ticket '01' depends on itself");
  });

  it("rejects a dependency cycle", () => {
    expect(() =>
      make([
        { id: "01", dependsOn: ["02"] },
        { id: "02", dependsOn: ["01"] },
      ]),
    ).toThrow(RosterError);
  });
});

describe("findCycle", () => {
  it("returns null for a valid graph", () => {
    expect(findCycle([{ id: "01" }, { id: "02", dependsOn: ["01"] }])).toBe(null);
  });

  it("names the tickets involved in a cycle", () => {
    const cycle = findCycle([
      { id: "01", dependsOn: ["02"] },
      { id: "02", dependsOn: ["03"] },
      { id: "03", dependsOn: ["01"] },
    ]);
    expect(cycle).toEqual(["01", "02", "03", "01"]);
  });
});

describe("readyTickets", () => {
  it("returns tickets with no dependencies", () => {
    const roster = make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]);
    expect(readyTickets(roster).map((t) => t.id)).toEqual(["01"]);
  });

  it("releases a dependent once its dependency merges", () => {
    const roster = updateTicket(
      make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]),
      "01",
      { status: "merged" },
      LATER,
    );
    expect(readyTickets(roster).map((t) => t.id)).toEqual(["02"]);
  });

  it("keeps a dependent waiting while its dependency is still working", () => {
    const roster = updateTicket(
      make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]),
      "01",
      { status: "working" },
      LATER,
    );
    expect(readyTickets(roster).map((t) => t.id)).toEqual([]);
  });

  it("excludes tickets that already started", () => {
    const roster = updateTicket(make([{ id: "01" }]), "01", { status: "spawning" }, LATER);
    expect(readyTickets(roster)).toEqual([]);
  });
});

describe("availableSlots", () => {
  it("reports the full concurrency when nothing is running", () => {
    expect(availableSlots(make([{ id: "01" }, { id: "02" }], 2))).toBe(2);
  });

  it("counts every in-flight status against the cap", () => {
    let roster = make([{ id: "01" }, { id: "02" }, { id: "03" }], 3);
    roster = updateTicket(roster, "01", { status: "spawning" }, LATER);
    roster = updateTicket(roster, "02", { status: "working" }, LATER);
    roster = updateTicket(roster, "03", { status: "verifying" }, LATER);
    expect(availableSlots(roster)).toBe(0);
  });

  it("frees a slot once a ticket merges", () => {
    let roster = make([{ id: "01" }, { id: "02" }], 1);
    roster = updateTicket(roster, "01", { status: "working" }, LATER);
    expect(availableSlots(roster)).toBe(0);
    roster = updateTicket(roster, "01", { status: "merged" }, LATER);
    expect(availableSlots(roster)).toBe(1);
  });
});

describe("updateTicket", () => {
  it("stamps statusSince when the status changes", () => {
    const roster = updateTicket(make([{ id: "01" }]), "01", { status: "working" }, LATER);
    expect(roster.tickets[0]!.statusSince).toBe(LATER);
  });

  it("leaves statusSince alone when only other fields change", () => {
    const roster = updateTicket(make([{ id: "01" }]), "01", { peerName: "herd-x-01" }, LATER);
    expect(roster.tickets[0]!.statusSince).toBe(NOW);
    expect(roster.tickets[0]!.peerName).toBe("herd-x-01");
  });

  it("leaves statusSince alone when the status is rewritten to itself", () => {
    const roster = updateTicket(make([{ id: "01" }]), "01", { status: "pending" }, LATER);
    expect(roster.tickets[0]!.statusSince).toBe(NOW);
  });

  it("throws for an unknown ticket", () => {
    expect(() => updateTicket(make([{ id: "01" }]), "99", { status: "merged" }, LATER)).toThrow(
      "unknown ticket '99'",
    );
  });
});

describe("propagateBlocks", () => {
  it("blocks a dependent of an escalated ticket", () => {
    const roster = propagateBlocks(
      updateTicket(
        make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]),
        "01",
        { status: "escalated" },
        LATER,
      ),
      LATER,
    );
    expect(roster.tickets[1]!.status).toBe("blocked");
  });

  it("blocks transitively down a dependency chain", () => {
    const roster = propagateBlocks(
      updateTicket(
        make([{ id: "01" }, { id: "02", dependsOn: ["01"] }, { id: "03", dependsOn: ["02"] }]),
        "01",
        { status: "failed" },
        LATER,
      ),
      LATER,
    );
    expect(roster.tickets.map((t) => t.status)).toEqual(["failed", "blocked", "blocked"]);
  });

  it("leaves independent tickets running", () => {
    const roster = propagateBlocks(
      updateTicket(make([{ id: "01" }, { id: "02" }]), "01", { status: "escalated" }, LATER),
      LATER,
    );
    expect(roster.tickets[1]!.status).toBe("pending");
  });

  it("returns the roster unchanged when nothing failed", () => {
    const roster = make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]);
    expect(propagateBlocks(roster, LATER)).toBe(roster);
  });
});

describe("writeRoster and readRoster", () => {
  it("round-trips a roster through disk", () => {
    const root = mkdtempSync(join(tmpdir(), "herd-roster-"));
    const path = rosterPath(root, "defects");
    const roster = updateTicket(
      make([{ id: "01" }, { id: "02", dependsOn: ["01"] }]),
      "01",
      { status: "working", peerName: "herd-defects-01", tabId: "wJE:t4" },
      LATER,
    );
    writeRoster(path, roster);
    expect(readRoster(path)).toEqual(roster);
  });

  it("places the roster under .herd/<batch>/", () => {
    expect(rosterPath("/repo", "defects")).toBe("/repo/.herd/defects/roster.json");
  });
});

describe("summarize", () => {
  it("lists the ready set and remaining slots", () => {
    const roster = make([{ id: "01" }, { id: "02", dependsOn: ["01"] }], 2);
    const text = summarize(roster);
    expect(text).toContain("ready: 01");
    expect(text).toContain("slots: 2");
  });
});
