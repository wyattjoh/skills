import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAdrs, inventoryAdrs, journalSwitches, parseAdr } from "./compact.ts";
import { spawnGit } from "./git-env.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const git = (dir: string, ...args: string[]): void => {
  const result = spawnGit([
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    ...args,
  ]);
  expect(result.exitCode).toBe(0);
};

const makeHub = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "workspaces-compact-"));
  created.push(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
};

const commitAll = (dir: string, message: string): void => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
};

describe("parseAdr", () => {
  it("parses number, slug, title, frontmatter status, and references", () => {
    const record = parseAdr(
      "0002-event-sourcing.md",
      "---\nstatus: superseded by ADR-5\n---\n# Event sourcing for the write model\n\nSee ADR-1 and adr/5.\n",
    );
    expect(record).toEqual({
      number: 2,
      slug: "event-sourcing",
      file: "0002-event-sourcing.md",
      title: "Event sourcing for the write model",
      status: "superseded by ADR-5",
      references: [1, 5],
    });
  });

  it("falls back to slug and null status for a bare ADR", () => {
    const record = parseAdr("0001-monorepo.md", "# Adopt a monorepo\n\nOne repo, many packages.\n");
    expect(record.number).toBe(1);
    expect(record.title).toBe("Adopt a monorepo");
    expect(record.status).toBeNull();
    expect(record.references).toEqual([]);
  });

  it("reads an inline Status line when there is no frontmatter", () => {
    const record = parseAdr("0003-rest.md", "# Use REST\n\n**Status:** accepted\n");
    expect(record.status).toBe("accepted");
  });
});

describe("inventoryAdrs", () => {
  it("orders by number and skips the archive dir and README", () => {
    const hub = makeHub();
    mkdirSync(join(hub, "docs/adr/archive"), { recursive: true });
    writeFileSync(join(hub, "docs/adr/0002-b.md"), "# B\n");
    writeFileSync(join(hub, "docs/adr/0001-a.md"), "# A\n");
    writeFileSync(join(hub, "docs/adr/README.md"), "# not an ADR\n");
    writeFileSync(join(hub, "docs/adr/archive/0009-old.md"), "# Old\n");
    expect(inventoryAdrs(hub).map((adr) => adr.file)).toEqual(["0001-a.md", "0002-b.md"]);
  });

  it("returns an empty list when docs/adr is absent", () => {
    const hub = makeHub();
    expect(inventoryAdrs(hub)).toEqual([]);
  });
});

describe("journalSwitches", () => {
  it("extracts only Deviation and Scope change entries with their dates and links", () => {
    const hub = makeHub();
    writeFileSync(
      join(hub, "JOURNAL.md"),
      [
        "# Journal",
        "",
        "## 2026-07-20",
        "",
        "### Decision: Adopt squash merges",
        "",
        "### Deviation: Dropped the sync API",
        "",
        "**Links:** adr/0003, phase 1",
        "",
        "## 2026-07-10",
        "",
        "### Scope change: Added billing member",
        "",
      ].join("\n"),
    );
    expect(journalSwitches(hub)).toEqual([
      {
        date: "2026-07-20",
        category: "Deviation",
        title: "Dropped the sync API",
        links: ["adr/0003", "phase 1"],
      },
      {
        date: "2026-07-10",
        category: "Scope change",
        title: "Added billing member",
        links: [],
      },
    ]);
  });

  it("returns an empty list when the journal is absent", () => {
    const hub = makeHub();
    expect(journalSwitches(hub)).toEqual([]);
  });
});

describe("archiveAdrs", () => {
  it("moves live ADRs into docs/adr/archive and returns the mapping", () => {
    const hub = makeHub();
    mkdirSync(join(hub, "docs/adr"), { recursive: true });
    writeFileSync(join(hub, "docs/adr/0001-a.md"), "# A\n");
    writeFileSync(join(hub, "docs/adr/0002-b.md"), "# B\n");
    commitAll(hub, "seed");

    const archived = Effect.runSync(archiveAdrs(hub));
    expect(archived).toEqual([
      { number: 1, slug: "a", file: "0001-a.md" },
      { number: 2, slug: "b", file: "0002-b.md" },
    ]);
    expect(existsSync(join(hub, "docs/adr/archive/0001-a.md"))).toBe(true);
    expect(existsSync(join(hub, "docs/adr/0001-a.md"))).toBe(false);
    expect(readFileSync(join(hub, "docs/adr/archive/0002-b.md"), "utf8")).toBe("# B\n");
  });

  it("refuses to run when the hub work tree is dirty", () => {
    const hub = makeHub();
    mkdirSync(join(hub, "docs/adr"), { recursive: true });
    writeFileSync(join(hub, "docs/adr/0001-a.md"), "# A\n");
    commitAll(hub, "seed");
    writeFileSync(join(hub, "docs/adr/0001-a.md"), "# A edited\n");

    const result = Effect.runSyncExit(archiveAdrs(hub));
    expect(Exit.isFailure(result)).toBe(true);
  });

  it("fails when there are no ADRs to archive", () => {
    const hub = makeHub();
    mkdirSync(join(hub, "docs/adr"), { recursive: true });
    const result = Effect.runSyncExit(archiveAdrs(hub));
    expect(Exit.isFailure(result)).toBe(true);
  });
});
