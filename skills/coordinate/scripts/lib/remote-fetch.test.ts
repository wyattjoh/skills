import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveConfig } from "./config.ts";
import { failureOf, tempDir } from "./fixture.ts";
import { fakeProc } from "./proc.ts";
import { copyBackSettled } from "./remote-fetch.ts";

describe("copyBackSettled", () => {
  it("refuses a terminal address that names no other machine, calling nothing", async () => {
    const state = tempDir();
    try {
      const config = await Effect.runPromise(
        resolveConfig({ state_dir: state, backlog_dir: join(state, "backlogs") }, "/c"),
      );
      const fake = fakeProc(() => ({ exitCode: 1, stdout: "", stderr: "unexpected" }));
      const failure = await failureOf(
        copyBackSettled(config, "app", {
          address: "t5",
          name: "fix-a",
          cwd: "/w/fix-a",
          parent: undefined,
          live: true,
          turn: 1,
          statusMs: undefined,
          status: "idle",
          app: "claude",
          labels: {},
          argv: [],
          pid: undefined,
        }),
        fake.layer,
      );
      expect(failure).toEqual(
        expect.objectContaining({
          _tag: "Refused",
          message: "t5 runs on this machine; there is no remote .scratch to copy back",
        }),
      );
      expect(fake.calls).toEqual([]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
