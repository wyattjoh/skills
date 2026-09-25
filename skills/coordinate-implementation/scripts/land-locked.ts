#!/usr/bin/env bun
/**
 * Critical section of a coordinated landing, run only while holding the shared land lock:
 *
 *   flock -w 110 <git-common-dir>/land-local.lock bun land-locked.ts <base-checkout> <base> <branch>
 *
 * Mirrors Phase 4 of the land-local skill so coordinators and `/land-local` callers serialize on
 * the same lock. Exit codes match land-local: 0 landed, 3 precondition error, 4 base checkout
 * dirty, 5 rebase required, 6 fast-forward failed. `flock` itself exits 1 on timeout, so this
 * script never exits 1.
 */
import { spawnGit } from "./lib/git.ts";

const fail = (code: number, message: string): never => {
  console.log(message);
  process.exit(code);
};

const [checkout, base, branch] = Bun.argv.slice(2);
if (checkout === undefined || base === undefined || branch === undefined) {
  fail(3, "ERROR: usage: land-locked.ts <base-checkout> <base> <branch>");
}

const current = spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: checkout });
if (current.exitCode !== 0 || current.stdout.trim() !== base) {
  fail(3, `ERROR: ${checkout} does not have ${base!} checked out`);
}

const status = spawnGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: checkout });
if (status.exitCode !== 0) fail(3, `ERROR: git status failed: ${status.stderr.trim()}`);
if (status.stdout !== "") {
  fail(
    4,
    `REJECTED: ${base!} worktree has uncommitted changes at ${checkout!}:\n${status.stdout.trimEnd()}`,
  );
}

const ancestor = spawnGit(["merge-base", "--is-ancestor", base!, branch!], { cwd: checkout });
if (ancestor.exitCode === 1) fail(5, `REBASE_REQUIRED: ${base!} advanced; rebase and retry`);
if (ancestor.exitCode !== 0) fail(3, `ERROR: ancestry check failed: ${ancestor.stderr.trim()}`);

const before = spawnGit(["rev-parse", "--short", base!], { cwd: checkout }).stdout.trim();
const merged = spawnGit(["merge", "--ff-only", branch!], { cwd: checkout });
if (merged.exitCode !== 0) {
  fail(6, `ERROR: fast-forward merge failed unexpectedly\n${merged.stderr.trim()}`);
}
const after = spawnGit(["rev-parse", "--short", base!], { cwd: checkout }).stdout.trim();
console.log(`LANDED: ${base!} ${before} -> ${after} (${branch!})`);
