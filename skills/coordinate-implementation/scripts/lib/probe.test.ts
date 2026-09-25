import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCommand } from "../test-fixtures.ts";
import { runProbe } from "./probe.ts";

const bin = (): string => mkdtempSync(join(tmpdir(), "coordinate-probe-"));

describe("bounded probes", () => {
  it("returns the command's output", () => {
    const command = writeCommand(bin(), "tool", 'console.log("tool 1.0")');

    expect(runProbe([command, "--version"])).toEqual({
      exitCode: 0,
      stdout: "tool 1.0\n",
      stderr: "",
    });
  });

  it("kills a wedged command and reports a timeout instead of blocking", () => {
    const command = writeCommand(
      bin(),
      "stuck",
      "await new Promise(() => setInterval(() => {}, 1000));",
    );

    expect(runProbe([command], 300)).toEqual({
      exitCode: 124,
      stdout: "",
      stderr: "timed out after 300ms",
    });
  });

  it("reports a command that cannot start", () => {
    expect(runProbe([join(bin(), "missing")]).exitCode).toBe(127);
  });
});
