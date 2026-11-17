// Type-check against Herdr's installed declarations without launching Herdr or writing to its
// home: both files are copied into a project-local cache, which tsconfig.json maps.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { root, run, tscPath } from "./tools.ts";

const herdrHome = resolve(process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app"));
const typesHome = process.env.HERDR_TYPES_DIR ? resolve(process.env.HERDR_TYPES_DIR) : herdrHome;
const sources = ["herdr.d.ts", "gpui-kit.d.ts"].map((name) => join(typesHome, name));

const missing: string[] = [];
for (const path of sources) if (!(await Bun.file(path).exists())) missing.push(path);
if (missing.length > 0) {
  console.error(
    `Missing Herdr host declarations:\n${missing.map((path) => `  ${path}`).join("\n")}\nHerdr writes both into its home when it starts. HERDR_APP_HOME selects that home; HERDR_TYPES_DIR names another folder holding both files.`,
  );
  process.exit(1);
}

// Read both before writing, so HERDR_TYPES_DIR may point at the cache itself.
const [host, kit] = await Promise.all(sources.map((path) => Bun.file(path).arrayBuffer()));
const cache = join(root, "node_modules/.cache/coordinate-herdr");
await Bun.write(join(cache, "herdr.d.ts"), host!);
await Bun.write(join(cache, "gpui-kit.d.ts"), kit!);
process.exit(await run([tscPath(), "-p", join(root, "tsconfig.json")]));
