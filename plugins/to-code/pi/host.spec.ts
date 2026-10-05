import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertFleetHost } from "./host.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const entry = async (name: string, version: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "to-code-host-"));
  directories.push(directory);
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }));
  const filename = join(directory, "dist", "cli.js");
  await writeFile(filename, "");
  return filename;
};

test("async flag host checks the actual CLI package, not its plugin dev dependency", async () => {
  assertFleetHost(await entry("@earendil-works/pi-coding-agent", "1.0.2"));
  assertFleetHost(await entry("@earendil-works/pi-coding-agent", "1.1.0"));
  const old = await entry("@earendil-works/pi-coding-agent", "1.0.1");
  expect(() => assertFleetHost(old)).toThrow("agent_before_settle");
  const unknown = await entry("embedding-app", "1.0.2");
  expect(() => assertFleetHost(unknown)).toThrow("Cannot verify");
});
