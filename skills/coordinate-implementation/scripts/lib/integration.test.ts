import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "./git.ts";
import {
  bindIntegration,
  commitPatchIds,
  IntegrationError,
  type IntegrationRecord,
  isAppendedFix,
  type ObservedIntegration,
  parseIntegration,
  recordRebase,
  ticketPatchId,
  writeIntegration,
} from "./integration.ts";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sha = (character: string): string => character.repeat(40);

const observed = (overrides: Partial<ObservedIntegration> = {}): ObservedIntegration => ({
  base_sha: sha("1"),
  ticket_sha: sha("2"),
  commit_count: 1,
  patch_id: sha("a"),
  commit_patch_ids: [sha("b")],
  ...overrides,
});

const options = { minimumCycle: 0, commitShapeValid: true, gateCount: 1, completedAt: "t1" };

const reviewedRecord = (): IntegrationRecord => ({
  ...bindIntegration(undefined, observed(), options),
  phase: "rebase-required",
  reviewed_head: sha("2"),
  reviewed_patch_id: sha("a"),
  reviewed_commit_patch_ids: [sha("b")],
  standards_evidence_path: "/run/standards.json",
  spec_evidence_path: "/run/spec.json",
  self_review_path: "/run/self-review.md",
});

describe("append-only fix rule", () => {
  test("accepts reviewed commit patch ids followed by new commits", () => {
    expect(isAppendedFix([sha("a")], [sha("a"), sha("b")])).toBe(true);
  });

  test("refuses rewritten, reordered, or unchanged commit lists", () => {
    expect(isAppendedFix([sha("a")], [sha("c"), sha("b")])).toBe(false);
    expect(isAppendedFix([sha("a"), sha("b")], [sha("b"), sha("a"), sha("c")])).toBe(false);
    expect(isAppendedFix([sha("a")], [sha("a")])).toBe(false);
  });
});

describe("rebase recording", () => {
  test("keeps both reviews and clears gates when the patch id is unchanged", () => {
    const next = recordRebase(
      reviewedRecord(),
      observed({ base_sha: sha("3"), ticket_sha: sha("4") }),
      { ...options, completedAt: "t2" },
    );

    expect(next).toEqual({
      cycle: 1,
      phase: "gates",
      base_sha: sha("3"),
      ticket_sha: sha("4"),
      review_range: `${sha("3")}..${sha("4")}`,
      commit_count: 1,
      patch_id: sha("a"),
      commit_patch_ids: [sha("b")],
      passed_gates: [],
      reviewed_head: sha("2"),
      reviewed_patch_id: sha("a"),
      reviewed_commit_patch_ids: [sha("b")],
      standards_evidence_path: "/run/standards.json",
      spec_evidence_path: "/run/spec.json",
      self_review_path: "/run/self-review.md",
      completed_at: "t2",
    });
  });

  test("is ready to land immediately when reviews are kept and no gate is configured", () => {
    expect(
      recordRebase(reviewedRecord(), observed({ ticket_sha: sha("4") }), {
        ...options,
        gateCount: 0,
      }).phase,
    ).toBe("ready-to-land");
  });

  test("clears both reviews when the patch id changed", () => {
    const next = recordRebase(reviewedRecord(), observed({ patch_id: sha("c") }), options);

    expect(next).toMatchObject({
      cycle: 1,
      phase: "gates",
      reviewed_head: null,
      reviewed_patch_id: null,
      reviewed_commit_patch_ids: null,
      standards_evidence_path: null,
      spec_evidence_path: null,
      self_review_path: null,
    });
  });
});

describe("Integration field persistence", () => {
  const markdown = `## Active tickets\n\n### 07\n\nWorktree: /w\nPhase: working\nLast diagnostic: none\n\n### 08\n\nWorktree: /x\n\n## Decisions\n`;

  test("writes and reads one ticket's record without touching others", () => {
    const record = bindIntegration(undefined, observed(), options);
    const written = writeIntegration(markdown, "07", record, "gates");

    expect(parseIntegration(written, "07")).toEqual(record);
    expect(parseIntegration(written, "08")).toBe(undefined);
    expect(written).toContain("Phase: gates\nLast diagnostic: none\nIntegration: {");
  });

  test("refuses a malformed record", () => {
    let failure: unknown;
    try {
      parseIntegration(markdown.replace("Phase: working", "Integration: {}"), "07");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(IntegrationError);
    expect((failure as IntegrationError).issue.code).toBe("integration.malformed");
  });
});

describe("patch identity", () => {
  test("keeps ticket and commit patch ids stable across a clean rebase", () => {
    const repository = mkdtempSync(join(tmpdir(), "coordinate-integration-"));
    created.push(repository);
    const git = (...args: string[]): string => {
      const result = spawnGit(["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], {
        cwd: repository,
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    const write = (path: string, contents: string, message: string): void => {
      writeFileSync(join(repository, path), contents);
      git("add", path);
      git("commit", "-q", "-m", message);
    };
    git("init", "-q", "-b", "main");
    write("base.txt", "base\n", "base");
    git("checkout", "-q", "-b", "ticket");
    write("one.txt", "one\n", "one");
    write("two.txt", "two\n", "two");
    const ticketId = ticketPatchId(repository, "main");
    const commitIds = commitPatchIds(repository, "main");
    git("checkout", "-q", "main");
    write("landed.txt", "landed\n", "landed");
    git("checkout", "-q", "ticket");
    git("rebase", "-q", "main");

    expect(commitIds).toHaveLength(2);
    expect(ticketPatchId(repository, "main")).toBe(ticketId);
    expect(commitPatchIds(repository, "main")).toEqual(commitIds);
  });
});
