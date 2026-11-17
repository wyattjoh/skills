import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_SCRIPT, parseListing } from "./model.ts";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Run the listing script the way the panel's exec does, with a bound.
const list = (folder: string) => {
  const ran = Bun.spawnSync(["sh", "-c", LIST_SCRIPT, "coordinate-panel", folder], {
    env: process.env,
    timeout: 10_000,
  });
  return { code: ran.exitCode, names: parseListing(ran.stdout.toString()) };
};

test("lists each domain document in a backlogs folder, sorted, skipping everything else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinate-panel-"));
  temps.push(dir);
  await Promise.all([
    writeFile(join(dir, "beta.json"), "{}"),
    writeFile(join(dir, "alpha.json"), "{}"),
    writeFile(join(dir, "my domain.json"), "{}"),
    writeFile(join(dir, ".0f3a.tmp"), "{}"),
    writeFile(join(dir, "alpha.archive.jsonl"), "{}"),
    mkdir(join(dir, "alpha.lock")),
    mkdir(join(dir, "folder.json")),
  ]);
  expect(list(dir)).toEqual({ code: 0, names: ["alpha", "beta"] });
});

test("fails, naming the folder, when the backlogs folder can't be read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinate-panel-"));
  temps.push(dir);
  const backlogs = join(dir, "backlogs");
  await mkdir(backlogs);
  await writeFile(join(backlogs, "alpha.json"), "{}");
  await chmod(backlogs, 0o000);
  const ran = Bun.spawnSync(["sh", "-c", LIST_SCRIPT, "coordinate-panel", backlogs], {
    env: process.env,
    timeout: 10_000,
  });
  await chmod(backlogs, 0o700);
  expect([ran.exitCode, ran.stdout.toString(), ran.stderr.toString()]).toEqual([
    1,
    "",
    `cannot read ${backlogs}\n`,
  ]);
});

test("lists nothing, successfully, when the backlogs folder is missing or empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinate-panel-"));
  temps.push(dir);
  expect([list(dir), list(join(dir, "backlogs"))]).toEqual([
    { code: 0, names: [] },
    { code: 0, names: [] },
  ]);
});
