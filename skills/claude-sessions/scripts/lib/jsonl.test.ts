import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonl } from "./jsonl.ts";

async function withTempFile(content: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jsonl-test-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, content);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("readJsonl", () => {
  it("parses well-formed lines", async () => {
    const content = '{"a":1}\n{"a":2}\n{"a":3}\n';
    await withTempFile(content, async (path) => {
      const result = await readJsonl(path);
      expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
      expect(result.malformedCount).toBe(0);
      expect(result.lastLineNumber).toBe(3);
    });
  });

  it("skips and counts malformed lines", async () => {
    const content = '{"a":1}\nnot json\n{"a":3}\n';
    await withTempFile(content, async (path) => {
      const result = await readJsonl(path);
      expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }, { a: 3 }]);
      expect(result.malformedCount).toBe(1);
      expect(result.lastLineNumber).toBe(3);
    });
  });

  it("skips blank lines without counting them as malformed", async () => {
    const content = '{"a":1}\n\n{"a":2}\n';
    await withTempFile(content, async (path) => {
      const result = await readJsonl(path);
      expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }, { a: 2 }]);
      expect(result.malformedCount).toBe(0);
      expect(result.lastLineNumber).toBe(3);
    });
  });

  it("leaves a trailing line with no newline unparsed", async () => {
    const content = '{"a":1}\n{"a":2}';
    await withTempFile(content, async (path) => {
      const result = await readJsonl(path);
      expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }]);
      expect(result.lastLineNumber).toBe(1);
    });
  });

  it("resumes from a given line number, skipping earlier lines", async () => {
    const content = '{"a":1}\n{"a":2}\n{"a":3}\n';
    await withTempFile(content, async (path) => {
      const result = await readJsonl(path, { fromLine: 1 });
      expect(result.lines.map((l) => l.value)).toEqual([{ a: 2 }, { a: 3 }]);
      expect(result.lastLineNumber).toBe(3);
    });
  });

  it("returns records plus the byte offset of a growing tail", async () => {
    const content = '{"a":1}\n{"a":2}\n';
    await withTempFile(content, async (path) => {
      const first = await readJsonl(path);
      expect(first.lines.map((l) => l.value)).toEqual([{ a: 1 }, { a: 2 }]);
      expect(first.lastLineNumber).toBe(2);

      await appendFile(path, '{"a":3}\n');

      const second = await readJsonl(path, { fromLine: first.lastLineNumber });
      expect(second.lines.map((l) => l.value)).toEqual([{ a: 3 }]);
      expect(second.lastLineNumber).toBe(3);
    });
  });

  it("returns an empty result for an empty file", async () => {
    await withTempFile("", async (path) => {
      const result = await readJsonl(path);
      expect(result.lines).toEqual([]);
      expect(result.malformedCount).toBe(0);
      expect(result.lastLineNumber).toBe(0);
      expect(result.lastLineEndOffset).toBe(0);
    });
  });
});
