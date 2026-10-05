import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { gitEnvironment } from "../pi/platform.ts";

const repository = await realpath(process.cwd());
const output = resolve(process.argv[2] ?? join(repository, ".scratch", "fleet-state-machine.html"));
const ignored = Bun.spawnSync(["git", "check-ignore", "--quiet", output], {
  cwd: repository,
  env: gitEnvironment(process.env),
});
if (ignored.exitCode !== 0) throw new Error(`Demo output must be Git-ignored: ${output}`);
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "client.ts")],
  target: "browser",
  minify: true,
});
if (!build.success) throw new AggregateError(build.logs, "Browser bundle failed");
const bundle = await build.outputs[0]!.text();
const template = await Bun.file(join(import.meta.dir, "template.html")).text();
await mkdir(dirname(output), { recursive: true });
await Bun.write(
  output,
  template.replace("/* FLEET_BUNDLE */", () => bundle.replaceAll("</script", "<\\/script")),
);
console.log(`Offline production-Machine simulator: ${output}`);
