import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import { tempDir } from "./fixture.ts";
import { readEnded, removeEnded, writeEnded } from "./fleet.ts";
import { countResume, markSettled } from "./sessions.ts";
import { lastLint, markLint } from "./wiki.ts";
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
    offline: undefined,
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

describe("files store over a corrupt file", () => {
  const corrupt = (key: StateKey) => {
    const stateDir = tempDir("coordinate-store-");
    const path = filesPath(stateDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{");
    return { stateDir, path };
  };
  const record = {
    name: "fix-a",
    task: "fix a",
    domain: "app",
    tab_label: "fix-a",
    session: "s-1",
    program: "claude",
    model: null,
    effort: null,
    cwd: "/tmp",
    repo: null,
    branch: null,
    base_sha: null,
    ended_at: "2026-11-23T00:00:00.000Z",
    quiet_since: null,
    space: false,
    verdict: null,
  };

  test("an ended record is rewritten over a truncated one", async () => {
    const { stateDir, path } = corrupt(keys.ended("s-1"));
    await Effect.runPromise(writeEnded(stateDir, record));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
  });

  test("a truncated ended record can be removed", async () => {
    const { stateDir, path } = corrupt(keys.ended("s-1"));
    expect((await Effect.runPromise(readEnded(stateDir))).skipped).toEqual(["s-1.json"]);
    await Effect.runPromise(removeEnded(stateDir, "s-1"));
    expect(existsSync(path)).toBe(false);
  });

  test("a session state starts fresh over a truncated one", async () => {
    const { stateDir, path } = corrupt(keys.session("s-1"));
    await Effect.runPromise(countResume(stateDir, "s-1"));
    await Effect.runPromise(markSettled(stateDir, "s-1", undefined));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      session: "s-1",
      resumes: 1,
      verdict: null,
      counted: true,
    });
  });

  test("the lint clock is recorded over a truncated one", async () => {
    const { stateDir } = corrupt(keys.lint("app"));
    const config = await Effect.runPromise(resolveConfig({ state_dir: stateDir }, "config.json"));
    await Effect.runPromise(markLint(config, "app", "2026-11-23"));
    expect(await Effect.runPromise(lastLint(config, "app"))).toBe("2026-11-23");
  });
});
