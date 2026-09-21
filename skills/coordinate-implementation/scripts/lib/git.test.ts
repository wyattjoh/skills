import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "./git.ts";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spawnGit disables inherited commit signing for fixture commits", () => {
  const scratch = mkdtempSync(join(tmpdir(), "coordinate-git-signing-"));
  created.push(scratch);
  const fixture = join(scratch, "fixture");
  mkdirSync(fixture);
  const signingEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "gpg.program",
    GIT_CONFIG_VALUE_1: join(scratch, "missing-gpg"),
  };

  expect(spawnGit(["init", "-q", "-b", "main"], { cwd: fixture, env: signingEnv }).exitCode).toBe(
    0,
  );
  writeFileSync(join(fixture, "fixture.txt"), "fixture\n");
  expect(spawnGit(["add", "fixture.txt"], { cwd: fixture, env: signingEnv }).exitCode).toBe(0);
  expect(
    spawnGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-q",
        "-m",
        "unsigned fixture",
      ],
      { cwd: fixture, env: signingEnv },
    ).exitCode,
  ).toBe(0);
  expect(spawnGit(["log", "-1", "--format=%G?"], { cwd: fixture }).stdout.trim()).toBe("N");
});
