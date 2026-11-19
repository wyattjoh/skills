// Install the staged mods into a Herdr home. This is the only script that writes a Herdr home,
// and only `just install` runs it: validation (`just check`) stops at the staged build.
import { existsSync } from "node:fs";
import { cp, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MODS, build } from "./build.ts";
import { root } from "./tools.ts";

type Keys = Record<string, Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readKeys = async (path: string): Promise<Keys> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const parsed: unknown = await file.json();
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  const keys: Keys = {};
  for (const [section, bindings] of Object.entries(parsed)) {
    if (!isRecord(bindings)) throw new Error(`${path} section "${section}" is not an object`);
    keys[section] = bindings;
  }
  return keys;
};

// The person's keys with ours added, or undefined when they already have every one. A key they
// bind to something else is refused rather than replaced. With an empty keys.json, the person's
// key file is left unchanged.
const mergeKeys = (live: Keys, ours: Keys): Keys | undefined => {
  let changed = false;
  const merged: Keys = { ...live };
  for (const [section, bindings] of Object.entries(ours))
    for (const [key, action] of Object.entries(bindings)) {
      const current = live[section]?.[key];
      if (current === action) continue;
      if (current !== undefined)
        throw new Error(
          `keys.json ${section} "${key}" is ${JSON.stringify(current)}; rebind it before installing`,
        );
      merged[section] = { ...merged[section], [key]: action };
      changed = true;
    }
  return changed ? merged : undefined;
};

/**
 * Copy every mod from a checked stage into a Herdr home, and merge this project's key bindings
 * into the home's keys.json. Everything is checked before anything is written.
 * @param stage A stage from build(), laid out as mods/<name>/.
 * @param home The Herdr home to install into.
 * @param options replace: move matching mods already installed to backups first, instead of
 * refusing; backups: where replaced mods and the previous keys.json go.
 * @returns The installed mod names.
 */
export const installStage = async (
  stage: string,
  home: string,
  options: { replace: boolean; backups: string },
): Promise<string[]> => {
  const keysPath = join(home, "keys.json");
  const live = await readKeys(keysPath);
  const keys = mergeKeys(live, await readKeys(join(root, "keys.json")));
  const installed = MODS.map((mod) => mod.name).filter((name) =>
    existsSync(join(home, "mods", name)),
  );
  if (installed.length > 0 && !options.replace)
    throw new Error(
      `Already installed: ${installed.join(", ")}. Run just install --replace to back them up and replace them.`,
    );
  if (installed.length > 0 || (keys !== undefined && (await Bun.file(keysPath).exists())))
    await mkdir(options.backups, { recursive: true });
  for (const name of installed) await rename(join(home, "mods", name), join(options.backups, name));
  for (const mod of MODS)
    await cp(join(stage, "mods", mod.name), join(home, "mods", mod.name), { recursive: true });
  if (keys !== undefined) {
    if (await Bun.file(keysPath).exists()) await cp(keysPath, join(options.backups, "keys.json"));
    const temp = `${keysPath}.coordinate-${process.pid}`;
    await Bun.write(temp, `${JSON.stringify(keys, null, 2)}\n`);
    await rename(temp, keysPath);
  }
  return MODS.map((mod) => mod.name);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.every((arg) => arg === "--replace")) {
    console.error("Usage: just install [--replace]");
    process.exit(2);
  }
  const home = resolve(process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app"));
  const backups = join(root, ".scratch", `backups-${Date.now()}`);
  build()
    .then((stage) => installStage(stage, home, { replace: args.includes("--replace"), backups }))
    .then(
      (names) => console.log(`Installed ${names.join(", ")} into ${join(home, "mods")}`),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      },
    );
}
