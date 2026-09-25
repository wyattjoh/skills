import { dirname, resolve } from "node:path";
import { defaultRuntimeDeps, runRuntimeCommand } from "./lib/runtime-cli.ts";

const skillDir = resolve(dirname(import.meta.path), "..");
const output = await runRuntimeCommand(process.argv.slice(2), defaultRuntimeDeps(skillDir));
process.stdout.write(output.stdout);
process.exitCode = output.exitCode;
