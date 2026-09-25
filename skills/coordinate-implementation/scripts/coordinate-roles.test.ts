import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliInProcess } from "./test-cli.ts";

const CLI = join(import.meta.dir, "coordinate.ts");

type CliResult = {
  exitCode: number;
  stdout: Record<string, unknown>;
  stderr: string;
};

const writeCommand = (directory: string, name: string, body: string): void => {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
};

const makeEnvironment = (): { env: Record<string, string>; root: string } => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-roles-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeCommand(
    bin,
    "pi",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("pi 0.80.3");
else if (args[0] === "--help") console.log("--thinking <level>  Set thinking level: off, minimal, low, medium, high, xhigh, max");
else if (args[0] === "--list-models") console.log("provider      model       context\\nopenai-codex  gpt-5.6-sol 272K\\nstrix         Muse-30B    131K");
else process.exit(1);
`,
  );
  writeCommand(
    bin,
    "claude",
    `
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("Claude Code 2.1.80");
else if (args[0] === "--help") console.log("--effort <level>  Effort level (low, medium, high, xhigh, max)");
else process.exit(1);
`,
  );
  return {
    root,
    env: {
      PATH: bin,
      HOME: join(root, "home"),
    },
  };
};

const runCli = async (request: unknown, env: Record<string, string>): Promise<CliResult> => {
  const child = await runCliInProcess(request, env);
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(child.stdout) as Record<string, unknown>,
    stderr: child.stderr,
  };
};

/**
 * Spawns a real CLI process, for tests that exercise cross-process locking.
 */
const runCliProcess = async (request: unknown, env: Record<string, string>): Promise<CliResult> => {
  const child = Bun.spawn([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stdout: JSON.parse(stdout) as Record<string, unknown>,
    stderr,
  };
};

const request = (operation: string, input: Record<string, unknown>) => ({
  schema_version: 1,
  operation,
  input,
});

const roleState = (
  pane = "workspace:p1",
  generation = 4,
  ownershipHarness: "claude" | "pi" = "pi",
): string => `# sample implementation run

Schema version: 2

Coordinator:
  harness: pi
  model: openai-codex/gpt-5.6-sol
  effort: high
  handoff: yes
  threshold: 200000
  unattended: block

Implementor:
  harness: claude
  model: opus
  effort: high
  skills: [implement]

Reviewer:
  harness: claude
  model: sonnet
  effort: medium

Coordinator ownership:
  generation: ${generation}
  pane: ${pane}
  harness: ${ownershipHarness}
  model: ${ownershipHarness === "claude" ? "fable" : "openai-codex/gpt-5.6-sol"}
  effort: ${ownershipHarness === "claude" ? "low" : "high"}
  readiness: ready
  marker: coordinator-ready-${generation}-${pane}

## Decisions

- Existing decision remains intact.
`;

const piCoordinator = {
  harness: "pi",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
};

describe("role discovery and validation", () => {
  it("discovers installed harness models and effort values", async () => {
    const fixture = makeEnvironment();

    const result = await runCli(request("roles.discover", {}), fixture.env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "roles.discover",
      ok: true,
      result: {
        harnesses: [
          {
            name: "claude",
            available: true,
            version: "Claude Code 2.1.80",
            models: {
              source: "aliases-plus-custom",
              values: ["fable", "opus", "sonnet"],
              custom: true,
            },
            efforts: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            name: "pi",
            available: true,
            version: "pi 0.80.3",
            models: {
              source: "installed-catalog",
              values: ["openai-codex/gpt-5.6-sol", "strix/Muse-30B"],
              custom: false,
            },
            efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          },
        ],
      },
      errors: [],
    });
  });

  it("validates a quoted harness, model, and effort triple without substitution", async () => {
    const fixture = makeEnvironment();

    const result = await runCli(
      request("role.validate", {
        role: "coordinator",
        triple: "pi openai-codex/gpt-5.6-sol high",
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "role.validate",
      ok: true,
      result: {
        role: "coordinator",
        record: piCoordinator,
      },
      errors: [],
    });
  });

  it("accepts Claude aliases and custom model input from a structured record", async () => {
    const fixture = makeEnvironment();

    const alias = await runCli(
      request("role.validate", {
        role: "reviewer",
        record: { harness: "claude", model: "sonnet", effort: "medium" },
      }),
      fixture.env,
    );
    const custom = await runCli(
      request("role.validate", {
        role: "implementor",
        record: { harness: "claude", model: "claude-fable-5-1", effort: "xhigh" },
      }),
      fixture.env,
    );

    expect(alias.exitCode).toBe(0);
    expect(alias.stdout.result).toEqual({
      role: "reviewer",
      record: { harness: "claude", model: "sonnet", effort: "medium" },
    });
    expect(custom.exitCode).toBe(0);
    expect(custom.stdout.result).toEqual({
      role: "implementor",
      record: { harness: "claude", model: "claude-fable-5-1", effort: "xhigh" },
    });
  });

  it("normalizes an agreeing model effort suffix and rejects a conflict", async () => {
    const fixture = makeEnvironment();

    const agreeing = await runCli(
      request("role.validate", {
        role: "implementor",
        triple: "pi openai-codex/gpt-5.6-sol:high high",
      }),
      fixture.env,
    );
    const conflict = await runCli(
      request("role.validate", {
        role: "implementor",
        triple: "pi openai-codex/gpt-5.6-sol:low high",
      }),
      fixture.env,
    );

    expect(agreeing.exitCode).toBe(0);
    expect(agreeing.stdout.result).toEqual({
      role: "implementor",
      record: piCoordinator,
    });
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stdout.errors).toEqual([
      {
        code: "role.effort_conflict",
        message: "Model effort suffix `low` conflicts with role effort `high`.",
        remediation: "Choose one effort and make the model suffix and explicit effort agree.",
      },
    ]);
  });

  it("rejects unavailable harnesses, Pi models, and invalid effort combinations", async () => {
    const fixture = makeEnvironment();

    const invalidHarness = await runCli(
      request("role.validate", {
        role: "coordinator",
        triple: "codex gpt-5.6-sol high",
      }),
      fixture.env,
    );
    const missingModel = await runCli(
      request("role.validate", {
        role: "implementor",
        triple: "pi openai-codex/not-installed high",
      }),
      fixture.env,
    );
    const invalidEffort = await runCli(
      request("role.validate", {
        role: "reviewer",
        triple: "claude sonnet minimal",
      }),
      fixture.env,
    );

    expect(invalidHarness.exitCode).toBe(1);
    expect(invalidHarness.stdout.errors).toEqual([
      {
        code: "role.triple_invalid",
        message: "Role triple must contain exactly `harness model effort`.",
        remediation: "Pass one quoted triple such as `pi openai-codex/gpt-5.6-sol high`.",
      },
    ]);
    expect(missingModel.exitCode).toBe(1);
    expect(missingModel.stdout.errors).toEqual([
      {
        code: "role.model_unavailable",
        message:
          "Model `openai-codex/not-installed` is not present in Pi's installed model catalog.",
        remediation:
          "Choose an exact model returned by `roles.discover`; no substitute was selected.",
      },
    ]);
    expect(invalidEffort.exitCode).toBe(1);
    expect(invalidEffort.stdout.errors).toEqual([
      {
        code: "role.effort_invalid",
        message: "Effort `minimal` is not accepted by the installed claude harness.",
        remediation:
          "Choose an exact effort returned for claude by `roles.discover`; no substitute was selected.",
      },
    ]);
  });
});

describe("role documentation contract", () => {
  it("documents all three quoted role flags and durable ownership fields", async () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const resume = readFileSync(
      join(import.meta.dir, "..", "references", "resume-format.md"),
      "utf8",
    );

    expect(
      skill.includes("`--coordinator`, `--implementor`, and `--reviewer` each accept one quoted"),
    ).toBe(true);
    expect(
      skill.includes("Collect every missing startup value in one structured interaction"),
    ).toBe(true);
    expect(resume.includes("Reviewer:\n  harness: claude\n  model:   sonnet")).toBe(true);
    expect(
      resume.includes(
        "Coordinator ownership:\n  generation: 0\n  pane: wJE:p1\n  harness: claude\n  model: fable\n  effort: low\n  readiness: ready",
      ),
    ).toBe(true);
  });
});

describe("coordinator ownership", () => {
  it("claims cross-harness ownership, marks readiness, and verifies the observed marker", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, roleState("workspace:p1", 4, "claude"));

    const invoking = await runCli(
      request("role.validate", {
        role: "coordinator",
        triple: "claude fable low",
      }),
      fixture.env,
    );
    const selected = await runCli(
      request("role.validate", {
        role: "coordinator",
        triple: "pi openai-codex/gpt-5.6-sol high",
      }),
      fixture.env,
    );
    expect(invoking.stdout.result).toEqual({
      role: "coordinator",
      record: { harness: "claude", model: "fable", effort: "low" },
    });
    expect(selected.stdout.result).toEqual({ role: "coordinator", record: piCoordinator });
    expect([
      (invoking.stdout.result as { record: { harness: string } }).record.harness,
      (selected.stdout.result as { record: { harness: string } }).record.harness,
    ]).toEqual(["claude", "pi"]);

    const claim = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 4,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: {
          harness: "claude",
          model: "fable",
          effort: "low",
        },
        successor_pane: "workspace:p2",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );
    const marker = "coordinator-ready-5-workspace:p2";
    expect(claim.exitCode).toBe(0);
    expect(claim.stdout.result).toEqual({
      ownership: {
        generation: 5,
        pane: "workspace:p2",
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        readiness: "claiming",
        marker,
      },
    });

    const ready = await runCli(
      request("coordinator.ready", {
        state_path: statePath,
        generation: 5,
        pane: "workspace:p2",
        marker,
      }),
      fixture.env,
    );
    expect(ready.exitCode).toBe(0);
    expect(ready.stdout.result).toEqual({
      ownership: {
        generation: 5,
        pane: "workspace:p2",
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        readiness: "ready",
        marker,
      },
    });

    const verified = await runCli(
      request("coordinator.verify", {
        state_path: statePath,
        generation: 5,
        pane: "workspace:p2",
        observed_marker: marker,
      }),
      fixture.env,
    );
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout.result).toEqual({
      verified: true,
      ownership: {
        generation: 5,
        pane: "workspace:p2",
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        readiness: "ready",
        marker,
      },
    });

    const state = readFileSync(statePath, "utf8");
    expect(state.includes("readiness: ready")).toBe(true);
    expect(state.includes("- Existing decision remains intact.")).toBe(true);
    expect(state.includes("Reviewer:\n  harness: claude\n  model: sonnet\n  effort: medium")).toBe(
      true,
    );
  });

  it("allows exactly one of two concurrent claims", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, roleState());
    const baseInput = {
      state_path: statePath,
      expected_generation: 4,
      expected_predecessor_pane: "workspace:p1",
      expected_predecessor_role: piCoordinator,
      successor_role: piCoordinator,
    };

    const results = await Promise.all([
      runCliProcess(
        request("coordinator.claim", { ...baseInput, successor_pane: "workspace:p2" }),
        fixture.env,
      ),
      runCliProcess(
        request("coordinator.claim", { ...baseInput, successor_pane: "workspace:p3" }),
        fixture.env,
      ),
    ]);

    expect(results.map((result) => result.exitCode).toSorted()).toEqual([0, 1]);
    const failures = results.filter((result) => result.exitCode === 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stdout.errors).toEqual([
      {
        code: "coordinator.claim_stale",
        message:
          "Coordinator ownership changed before this claim; expected generation 4, predecessor pane `workspace:p1`, and role pi/openai-codex/gpt-5.6-sol/high.",
        remediation:
          "Re-read RESUME.md and restart takeover from the current owner; do not retry with stale values.",
      },
    ]);
    const state = readFileSync(statePath, "utf8");
    const successorCount = ["workspace:p2", "workspace:p3"].filter((pane) =>
      state.includes(`pane: ${pane}`),
    ).length;
    expect(successorCount).toBe(1);
  });

  it("rejects a stale generation without changing state", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    const original = roleState();
    writeFileSync(statePath, original);

    const result = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 3,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: piCoordinator,
        successor_pane: "workspace:p2",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "coordinator.claim_stale",
        message:
          "Coordinator ownership changed before this claim; expected generation 3, predecessor pane `workspace:p1`, and role pi/openai-codex/gpt-5.6-sol/high.",
        remediation:
          "Re-read RESUME.md and restart takeover from the current owner; do not retry with stale values.",
      },
    ]);
    expect(readFileSync(statePath, "utf8")).toBe(original);
  });

  it("keeps the predecessor open when a claimed successor never becomes ready", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, roleState());
    const marker = "coordinator-ready-5-workspace:p2";

    const claim = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 4,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: piCoordinator,
        successor_pane: "workspace:p2",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );
    const verify = await runCli(
      request("coordinator.verify", {
        state_path: statePath,
        generation: 5,
        pane: "workspace:p2",
        observed_marker: marker,
      }),
      fixture.env,
    );

    expect(claim.exitCode).toBe(0);
    expect(verify.exitCode).toBe(1);
    expect(verify.stdout.errors).toEqual([
      {
        code: "coordinator.not_ready",
        message: "Successor `workspace:p2` has not recorded readiness for generation 5.",
        remediation:
          "Keep the predecessor pane open. Recover or replace the successor before attempting verification again.",
      },
    ]);
    expect(readFileSync(statePath, "utf8").includes("readiness: claiming")).toBe(true);
  });

  it("rejects a readiness marker not observed from the successor pane", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, roleState("workspace:p2", 5));

    const result = await runCli(
      request("coordinator.verify", {
        state_path: statePath,
        generation: 5,
        pane: "workspace:p2",
        observed_marker: "coordinator-ready-5-another-pane",
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "coordinator.marker_mismatch",
        message:
          "The readiness marker observed in Herdr does not match the current ownership record.",
        remediation:
          "Keep the predecessor pane open and verify the marker from the recorded successor pane.",
      },
    ]);
  });

  it("rejects claiming ownership from the already-current pane", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    const original = roleState();
    writeFileSync(statePath, original);

    const result = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 4,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: piCoordinator,
        successor_pane: "workspace:p1",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "coordinator.same_pane",
        message: "Pane `workspace:p1` already owns this run; takeover is unnecessary.",
        remediation: "Continue in the current pane without changing the ownership generation.",
      },
    ]);
    expect(readFileSync(statePath, "utf8")).toBe(original);
  });

  it("rejects pane identifiers that could inject Markdown fields", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    const original = roleState();
    writeFileSync(statePath, original);

    const result = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 4,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: piCoordinator,
        successor_pane: "workspace:p2\n  readiness: ready",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout.errors).toEqual([
      {
        code: "request.invalid",
        message:
          "`coordinator.claim` requires state_path, a non-negative expected_generation, expected_predecessor_pane, expected_predecessor_role, successor_pane, and successor_role.",
        remediation: "Send one JSON request matching the documented schema-version-1 contract.",
      },
    ]);
    expect(readFileSync(statePath, "utf8")).toBe(original);
  });

  it("does not steal an old lock from a live claimant", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, roleState());
    const lockPath = `${statePath}.state-lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "live-claim",
        created_at: "2026-09-18T00:00:00.000Z",
      })}\n`,
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    const result = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 4,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: piCoordinator,
        successor_pane: "workspace:p2",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.errors).toEqual([
      {
        code: "coordinator.lock_busy",
        message: "Coordinator ownership is being updated by another process.",
        remediation:
          "Wait briefly, re-read RESUME.md, and retry with its current generation and pane.",
      },
    ]);
    expect(readFileSync(statePath, "utf8")).toBe(roleState());
  });

  it("recovers a stale ownership lock before claiming", async () => {
    const fixture = makeEnvironment();
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, roleState());
    const lockPath = `${statePath}.state-lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "abandoned-claim",
        created_at: "2026-09-18T00:00:00.000Z",
      })}\n`,
    );
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);

    const result = await runCli(
      request("coordinator.claim", {
        state_path: statePath,
        expected_generation: 4,
        expected_predecessor_pane: "workspace:p1",
        expected_predecessor_role: piCoordinator,
        successor_pane: "workspace:p2",
        successor_role: piCoordinator,
      }),
      fixture.env,
    );

    expect(result.exitCode).toBe(0);
    expect(
      (result.stdout.result as { ownership: { generation: number } }).ownership.generation,
    ).toBe(5);
    expect(statSync(statePath).isFile()).toBe(true);
  });
});
