// Bundle every mod into a fresh stage under .scratch/ and run herdr-app check on each with that
// stage as HERDR_APP_HOME, so validation never reads or writes the live Herdr home. Installing
// is a separate, explicit step.
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./tools.ts";

/**
 * Every deployed mod: its folder name, bundle entry and manifest.
 */
export const MODS = [
  { name: "coordinate-panel", entry: "src/mods/panel/index.ts", manifest: "panel.mod.json" },
  { name: "coordinate-toggle", entry: "src/mods/toggle/index.ts", manifest: "toggle.mod.json" },
] as const;

const FLAGS = [
  "--format",
  "esm",
  "--target",
  "browser",
  "--external",
  "gpui-kit",
  "--external",
  "gpui-base",
  "--external",
  "herdr",
];

/**
 * The bun the panel runs the coordinate CLI with, baked into the bundle as `COORDINATE_BUN`. A
 * mod's exec runs with the app's environment, whose PATH (often only /usr/bin:/bin:/usr/sbin:
 * /sbin) has no bun, so the build resolves it from its own PATH: whoever runs `just install`
 * installs the panel with the bun they use. Rebuild after moving bun.
 * @returns The define flags.
 */
const bunDefine = (): string[] => {
  const bun = Bun.which("bun");
  if (bun === null) throw new Error("bun is not on PATH, so the panel cannot bake its path");
  return ["--define", `COORDINATE_BUN=${JSON.stringify(bun)}`];
};

/**
 * Bundle and check every mod in a fresh stage.
 * @returns The stage folder, laid out like a Herdr home (mods/<name>/).
 */
export const build = async (): Promise<string> => {
  const scratch = join(root, ".scratch");
  await mkdir(scratch, { recursive: true });
  const stage = await mkdtemp(join(scratch, "stage-"));
  for (const mod of MODS) {
    const folder = join(stage, "mods", mod.name);
    await mkdir(folder, { recursive: true });
    await copyFile(join(root, mod.manifest), join(folder, "mod.json"));
    const built = await run([
      "bun",
      "build",
      mod.entry,
      "--outfile",
      join(folder, "main.js"),
      ...FLAGS,
      ...bunDefine(),
    ]);
    if (built !== 0) throw new Error(`Bundling ${mod.name} failed (${built})`);
  }
  for (const mod of MODS) {
    const checked = await run(["herdr-app", "check", join(stage, "mods", mod.name)], {
      ...process.env,
      HERDR_APP_HOME: stage,
    });
    if (checked !== 0)
      throw new Error(`herdr-app check failed for ${mod.name}; stage kept at ${stage}`);
  }
  return stage;
};

if (import.meta.main) {
  build().then(
    (stage) => console.log(`Checked stage: ${stage}`),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
