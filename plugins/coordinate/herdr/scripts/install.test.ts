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

const keysJson = () => Bun.file(join(home, "keys.json")).json();

test("copies every staged mod into the home and adds cmd-alt-b to the person's keys", async () => {
  await Bun.write(
    join(home, "keys.json"),
    JSON.stringify({ global: { "cmd-q": "app.quit" }, terminal: { "cmd-c": "terminal.copy" } }),
  );

  expect(await installStage(stage, home, { replace: false, backups })).toEqual([
    "coordinate-panel",
    "coordinate-toggle",
  ]);

  expect(await Bun.file(join(home, "mods/coordinate-toggle/main.js")).text()).toBe(
    "// coordinate-toggle build\n",
  );
  expect(await Bun.file(join(home, "mods/coordinate-panel/main.js")).text()).toBe(
    "// coordinate-panel build\n",
  );
  expect(await keysJson()).toEqual({
    global: { "cmd-q": "app.quit", "cmd-alt-b": "coordinate-toggle.toggle" },
    terminal: { "cmd-c": "terminal.copy" },
  });
});

test("creates keys.json when the home has none", async () => {
  await installStage(stage, home, { replace: false, backups });

  expect(await keysJson()).toEqual({ global: { "cmd-alt-b": "coordinate-toggle.toggle" } });
});

test("refuses, writing nothing, when cmd-alt-b already does something else", async () => {
  const live = JSON.stringify({ global: { "cmd-alt-b": "layout.toggle:sidebar" } });
  await Bun.write(join(home, "keys.json"), live);

  await expect(installStage(stage, home, { replace: false, backups })).rejects.toThrow(
    'keys.json global "cmd-alt-b" is "layout.toggle:sidebar"; rebind it before installing',
  );
  expect(await Bun.file(join(home, "keys.json")).text()).toBe(live);
  expect(await readdir(home)).toEqual(["keys.json"]);
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

test("check never installs: it runs only test, typecheck and the staged build", async () => {
  const justfile = await Bun.file(join(import.meta.dir, "../justfile")).text();
  const recipes = justfile.split("\n").filter((line) => /^[a-z][\w-]*( [^:]*)?:/.test(line));

  expect(recipes).toEqual([
    "default:",
    "test:",
    "typecheck:",
    "build:",
    "install *args:",
    "check: test typecheck build",
  ]);
});
