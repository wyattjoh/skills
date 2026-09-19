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
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
};
