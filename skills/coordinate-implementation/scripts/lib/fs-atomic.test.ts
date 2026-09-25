import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImmutableContentConflict, replaceFileAtomically, writeImmutable } from "./fs-atomic.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "coordinate-fs-atomic-"));

describe("atomic file writes", () => {
  it("replaces content through a temporary file it cleans up", async () => {
    const root = dir();
    const path = join(root, "nested", "value.json");

    await replaceFileAtomically(path, "first\n");
    await replaceFileAtomically(path, "second\n");

    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(readdirSync(join(root, "nested"))).toEqual(["value.json"]);
  });

  it("writes immutable evidence once and accepts an identical repeat", async () => {
    const path = join(dir(), "evidence.json");

    const created = await writeImmutable(path, "same\n");
    const repeated = await writeImmutable(path, "same\n");
    const conflict = await writeImmutable(path, "other\n").catch((error: unknown) => error);

    expect([created, repeated]).toEqual([true, false]);
    expect(conflict).toBeInstanceOf(ImmutableContentConflict);
    expect(readFileSync(path, "utf8")).toBe("same\n");
  });
});
