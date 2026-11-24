import { afterAll, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { tempDir } from "./fixture.ts";
import { realProc } from "./proc.ts";

const dir = tempDir("coordinate-proc-hc-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Two programs that print who they are: one named hc on a PATH, one at an absolute path.
const program = (path: string, name: string) => {
  writeFileSync(path, `#!/bin/sh\nprintf '%s %s' '${name}' "$*"\n`);
  chmodSync(path, 0o755);
};
const onPath = join(dir, "bin");
Bun.spawnSync(["mkdir", "-p", onPath]);
program(join(onPath, "hc"), "path-hc");
const baked = join(dir, "baked-hc");
program(baked, "baked-hc");

const stdout = async (env: Record<string, string>) =>
  (await Effect.runPromise(realProc.run(["hc", "server", "status"], { env }))).stdout;

test("runs hc from PATH when COORDINATE_HC is unset", async () => {
  expect(await stdout({ PATH: `${onPath}:/usr/bin:/bin` })).toBe("path-hc server status");
});

test("runs the hc COORDINATE_HC names, with the same arguments", async () => {
  expect(await stdout({ PATH: `${onPath}:/usr/bin:/bin`, COORDINATE_HC: baked })).toBe(
    "baked-hc server status",
  );
});

test("leaves other programs alone when COORDINATE_HC is set", async () => {
  const ran = await Effect.runPromise(
    realProc.run(["sh", "-c", "printf ok"], {
      env: { PATH: "/usr/bin:/bin", COORDINATE_HC: baked },
    }),
  );
  expect(ran.stdout).toBe("ok");
});
