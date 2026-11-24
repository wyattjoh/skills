import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import { tempDir } from "./fixture.ts";
import { filesPath, filesStore } from "./state-files.ts";
import { storeConformance } from "./state-store-conformance.ts";
import { keys, type StateKey } from "./state-store.ts";

storeConformance("files", async () => {
  const stateDir = tempDir("coordinate-store-");
  return {
    store: filesStore(stateDir),
    interfere: async (key, value) => {
      const path = filesPath(stateDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    },
  };
});

describe("files store", () => {
  const written = async (key: StateKey, value: unknown) => {
    const stateDir = tempDir("coordinate-store-");
    const store = filesStore(stateDir);
    await Effect.runPromise(
      Effect.flatMap(store.read(key), (current) => store.write(key, value, current.version)),
    );
    return readFileSync(filesPath(stateDir, key), "utf8");
  };

  test("keeps each document's bytes on disk as they have always been", async () => {
    const value = { a: [1] };
    expect(
      await Promise.all([
        written(keys.backlog("app"), value),
        written(keys.policy(), value),
        written(keys.queue("app"), value),
        written(keys.ended("s-1"), value),
        written(keys.session("s-1"), value),
        written(keys.lint("app"), value),
      ]),
    ).toEqual([
      '{\n  "a": [\n    1\n  ]\n}\n',
      '{\n  "a": [\n    1\n  ]\n}\n',
      '{\n  "a": [\n    1\n  ]\n}\n',
      '{\n "a": [\n  1\n ]\n}\n',
      '{\n "a": [\n  1\n ]\n}\n',
      '{"a":[1]}\n',
    ]);
  });

  test("keeps every document at its path under the state directory", () => {
    expect(
      [
        keys.backlog("app"),
        keys.policy(),
        keys.queue("app"),
        keys.ended("s-1"),
        keys.session("s-1"),
        keys.lint("app"),
      ].map((key) => filesPath("/state", key)),
    ).toEqual([
      "/state/backlogs/app.json",
      "/state/delegate-harness-policy.json",
      "/state/capacity/app.json",
      "/state/ended/s-1.json",
      "/state/sessions/s-1.json",
      "/state/wiki-lint/app.json",
    ]);
  });
});
