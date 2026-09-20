import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Creates a fake Herdr executable whose live panes come from HERDR_TEST_LIVE_PANES.
 *
 * @returns An isolated process environment suitable for synchronous CLI tests.
 */
export const createFakeHerdrEnv = (): Record<string, string | undefined> => {
  const bin = mkdtempSync(join(tmpdir(), "coordinate-fake-herdr-"));
  const executable = join(bin, "herdr");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
const [group, command, paneId] = process.argv.slice(2);
if (group !== "pane" || command !== "get" || paneId === undefined) {
  console.error(JSON.stringify({ error: { code: "unsupported", message: "unsupported fake Herdr command" } }));
  process.exit(2);
}
const live = JSON.parse(process.env.HERDR_TEST_LIVE_PANES ?? "[]");
if (Array.isArray(live) && live.includes(paneId)) {
  console.log(JSON.stringify({ id: "cli:pane:get", result: { type: "pane_info", pane: { pane_id: paneId } } }));
  process.exit(0);
}
console.error(JSON.stringify({ id: "cli:pane:get", error: { code: "pane_not_found", message: \`pane \${paneId} not found\` } }));
process.exit(1);
`,
  );
  chmodSync(executable, 0o755);

  const harnessScript = `#!/usr/bin/env bun
const harness = process.argv[1]?.split("/").at(-1);
const [command] = process.argv.slice(2);
if (command === "--version") {
  console.log(harness === "pi" ? "pi 0.0.0-test" : "claude 0.0.0-test");
  process.exit(0);
}
if (command === "--help") {
  console.log(harness === "pi" ? "--thinking level: low, medium, high" : "--effort level: low, medium, high");
  process.exit(0);
}
if (harness === "pi" && command === "--list-models") {
  console.log("provider model");
  console.log("openai test");
  process.exit(0);
}
process.exit(2);
`;
  for (const harness of ["pi", "claude"]) {
    const path = join(bin, harness);
    writeFileSync(path, harnessScript);
    chmodSync(path, 0o755);
  }

  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
};
