import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODS } from "./build.ts";
import { installStage } from "./install.ts";

let dir: string;
let stage: string;
let home: string;
let backups: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coordinate-install-"));
  stage = join(dir, "stage");
  home = join(dir, "home");
  backups = join(dir, "backups");
  for (const mod of MODS) {
    await mkdir(join(stage, "mods", mod.name), { recursive: true });
    await Bun.write(join(stage, "mods", mod.name, "main.js"), `// ${mod.name} build\n`);
    await Bun.write(join(stage, "mods", mod.name, "mod.json"), "{}\n");
  }
  await mkdir(home, { recursive: true });
});

afterEach(() => rm(dir, { recursive: true, force: true }));

test("copies the coordinate-panel mod and preserves existing key bindings", async () => {
  const live = JSON.stringify({
    global: { "cmd-q": "app.quit", "cmd-alt-b": "layout.toggle:sidebar" },
    terminal: { "cmd-c": "terminal.copy" },
  });
  await Bun.write(join(home, "keys.json"), live);

  expect(await installStage(stage, home, { replace: false, backups })).toEqual([
    "coordinate-panel",
  ]);

  expect(await Bun.file(join(home, "mods/coordinate-panel/main.js")).text()).toBe(
    "// coordinate-panel build\n",
  );
  expect(await Bun.file(join(home, "keys.json")).text()).toBe(live);
});

test("does not create keys.json when this plugin has no key bindings", async () => {
  await installStage(stage, home, { replace: false, backups });

  expect(await readdir(home)).toEqual(["mods"]);
});

test("leaves installed mods outside its build list untouched", async () => {
  const unmanaged = join(home, "mods/unmanaged-mod");
  await mkdir(unmanaged, { recursive: true });
  await Bun.write(join(unmanaged, "main.js"), "// not managed by this build\n");

  await installStage(stage, home, { replace: true, backups });

  expect(await Bun.file(join(unmanaged, "main.js")).text()).toBe("// not managed by this build\n");
});

test("refuses an installed mod without --replace, and backs it up with it", async () => {
  await mkdir(join(home, "mods/coordinate-panel"), { recursive: true });
  await Bun.write(join(home, "mods/coordinate-panel/main.js"), "// older\n");

  await expect(installStage(stage, home, { replace: false, backups })).rejects.toThrow(
    "Already installed: coordinate-panel. Run just install --replace to back them up and replace them.",
  );
  expect(await readdir(join(home, "mods"))).toEqual(["coordinate-panel"]);
  expect(await Bun.file(join(home, "mods/coordinate-panel/main.js")).text()).toBe("// older\n");

  await installStage(stage, home, { replace: true, backups });
  expect(await Bun.file(join(home, "mods/coordinate-panel/main.js")).text()).toBe(
    "// coordinate-panel build\n",
  );
  expect(await Bun.file(join(backups, "coordinate-panel/main.js")).text()).toBe("// older\n");
});

test("check never installs: it runs tests, typecheck, render-sync and the staged build", async () => {
  const justfile = await Bun.file(join(import.meta.dir, "../justfile")).text();
  const recipes = justfile.split("\n").filter((line) => /^[a-z][\w-]*( [^:]*)?:/.test(line));

  expect(recipes).toEqual([
    "default:",
    "test:",
    "typecheck:",
    "render-sync:",
    "build:",
    "install *args:",
    "check: test typecheck render-sync build",
  ]);
});
