import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claimCoordinator } from "./lib/coordinator.ts";
import { acceptSnapshot } from "./lib/snapshot.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();

const deferred = <Value>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

type CliResult = {
  exitCode: number;
  stdout: unknown;
  stderr: string;
};

const writeCommand = (directory: string, name: string, body: string): void => {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
};

const makeEnvironment = (
  commands: Record<string, string>,
): { env: Record<string, string>; root: string; skillRoot: string } => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-cli-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const skillRoot = join(root, "skills");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(skillRoot, { recursive: true });
  for (const [name, body] of Object.entries(commands)) {
    writeCommand(bin, name, body);
  }
  return {
    root,
    skillRoot,
    env: {
      PATH: bin,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    },
  };
};

const runCli = (request: unknown, env: Record<string, string | undefined>): CliResult => {
  const child = Bun.spawnSync([process.execPath, CLI], {
    env,
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = decoder.decode(child.stdout).trim();
  return {
    exitCode: child.exitCode,
    stdout: JSON.parse(stdout) as unknown,
    stderr: decoder.decode(child.stderr),
  };
};

const completeCommands = (withContextMetrics = true): Record<string, string> => ({
  git: 'console.log("git version 2.45.0")',
  bun: 'console.log("1.4.0")',
  pi: 'console.log("pi 0.80.3")',
  herdr: `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("herdr 9.9.9");
} else if (args.join(" ") === "api schema --json") {
  console.log(JSON.stringify({
    schemas: {
      success_response: {
        $defs: {
          AgentInfo: {
            properties: {
              agent_status: { type: "string" },
              context_used: { type: "integer" },
              ${withContextMetrics ? 'context_limit: { type: "integer" },' : ""}
            },
          },
        },
      },
    },
  }));
} else {
  process.exit(1);
}
`,
});

const preflightRequest = (skillRoot: string, statePath: string | null = null) => ({
  schema_version: 1,
  operation: "preflight",
  input: {
    state_path: statePath,
    skill_roots: [skillRoot],
  },
});

type SnapshotFixture = {
  runPath: string;
  statePath: string;
  manifestPath: string;
};

const LOCAL_REVISION = "sha256:55933530275d4d97bccc3bd2c9a3388a8dd106e6b9892bd75a8d4d92c2b85e1d";
const CHANGED_LOCAL_REVISION =
  "sha256:dfa9676da41bcccd7922dfc22d75b8a0fff7fefe8371a3e990468533e0606245";
const LOCAL_SOURCE = {
  kind: "local",
  tracker: "local-files",
  reference: "file:portable-run",
  tracker_workflow: null,
} as const;
const LOCAL_INPUTS = [
  {
    path: "issues/01-foundation.md",
    source_reference: "file:issues/01-foundation.md",
    sha256: "d873b20c892fc9a528636d6b03fb933df1c86f691b92f56abafa34f59d2b4491",
  },
  {
    path: "issues/02-feature.md",
    source_reference: "file:issues/02-feature.md",
    sha256: "767efc90319d2209db67c349ef6e0b92d8471777bab5736e0e3dfc48f74ce2e3",
  },
  {
    path: "snapshot.json",
    source_reference: "file:portable-run",
    sha256: "811ba654c1ca31b0f62a72c8d5664779e3f66eaff9bdcc7097b0619ef6904b97",
  },
  {
    path: "spec.md",
    source_reference: "file:spec.md",
    sha256: "205c8364541cb5fda3aa2ebf16572a76d836653860cc81fe8e63898d60399880",
  },
];
const CHANGED_LOCAL_INPUTS = [
  ...LOCAL_INPUTS.slice(0, 3),
  {
    path: "spec.md",
    source_reference: "file:spec.md",
    sha256: "5a5c576395cf9e37b1a0ae86d4a747b705b7a6dc73545b27600d08b01b3a782c",
  },
];

const lastStateLine = (statePath: string): string =>
  readFileSync(statePath, "utf8").trimEnd().split("\n").at(-1)!;

const makeSnapshotFixture = (sourceKind: "local" | "remote"): SnapshotFixture => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-snapshot-"));
  const runPath = join(root, "portable-run");
  const issuesPath = join(runPath, "issues");
  mkdirSync(issuesPath, { recursive: true });

  writeFileSync(join(runPath, "spec.md"), "# Agreed design\n\nBuild the portable coordinator.\n");
  writeFileSync(
    join(issuesPath, "01-foundation.md"),
    "# 01: Foundation\n\n**Blocked by:** none\n\n**Status:** ready-for-agent\n\n- [ ] Foundation is complete.\n",
  );
  writeFileSync(
    join(issuesPath, "02-feature.md"),
    "# 02: Feature\n\n**Blocked by:** 01: Foundation.\n\n**Status:** ready-for-agent\n\n- [ ] Feature is complete.\n",
  );

  const remote = sourceKind === "remote";
  const manifest = {
    schema_version: 1,
    source: {
      kind: sourceKind,
      tracker: remote ? "example-tracker" : "local-files",
      reference: remote ? "https://tracker.example/projects/portable" : "file:portable-run",
      tracker_workflow: remote ? "example-tracker-workflow" : null,
    },
    specification: {
      path: "spec.md",
      source_reference: remote ? "tracker:spec:portable" : "file:spec.md",
      agreed: true,
    },
    tickets: [
      {
        number: "01",
        path: "issues/01-foundation.md",
        source_reference: remote ? "tracker:ticket:1" : "file:issues/01-foundation.md",
        blocked_by: [],
      },
      {
        number: "02",
        path: "issues/02-feature.md",
        source_reference: remote ? "tracker:ticket:2" : "file:issues/02-feature.md",
        blocked_by: ["01"],
      },
    ],
  };
  const manifestPath = join(runPath, "snapshot.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const statePath = join(runPath, "RESUME.md");
  writeFileSync(
    statePath,
    "# portable implementation run\n\nSchema version: 1\n\n## Decisions\n\n- 2026-09-18 setup recorded\n",
  );
  return { runPath, statePath, manifestPath };
};

const snapshotRequest = (
  operation: "snapshot.check" | "snapshot.accept",
  fixture: SnapshotFixture,
  writeback: "none" | "final" | "live" | null,
  remoteWrites: "allowed" | "forbidden" = "allowed",
) => ({
  schema_version: 1,
  operation,
  input: {
    run_path: fixture.runPath,
    state_path: fixture.statePath,
    writeback,
    project_remote_writes: remoteWrites,
    accepted_at: operation === "snapshot.accept" ? "2026-09-19T00:00:00Z" : null,
  },
});

const snapshotRecordPattern = /## Snapshot\n\n```json\n([\s\S]*?)\n```/u;

const readSnapshotRecord = (statePath: string): unknown => {
  const markdown = readFileSync(statePath, "utf8");
  const match = snapshotRecordPattern.exec(markdown);
  if (match === null) throw new Error("Snapshot record was not written");
  return JSON.parse(match[1]!) as unknown;
};

const writeSnapshotRecord = (statePath: string, record: unknown): void => {
  const markdown = readFileSync(statePath, "utf8");
  const replacement = `## Snapshot\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``;
  writeFileSync(statePath, markdown.replace(snapshotRecordPattern, replacement));
};

describe("versioned coordinate CLI", () => {
  it("reports a successful capability-based preflight without mutating state", () => {
    const fixture = makeEnvironment(completeCommands());
    const implement = join(fixture.skillRoot, "implement");
    mkdirSync(implement, { recursive: true });
    writeFileSync(join(implement, "SKILL.md"), "---\nname: implement\ndescription: test\n---\n");
    const statePath = join(fixture.root, "RESUME.md");
    const state = "# sample implementation run\n\nSchema version: 1\n";
    writeFileSync(statePath, state);

    const result = runCli(preflightRequest(fixture.skillRoot, statePath), fixture.env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "preflight",
      ok: true,
      result: {
        platform: process.platform,
        capabilities: {
          git: { available: true, version: "git version 2.45.0" },
          bun: { available: true, version: "1.4.0" },
          herdr: {
            available: true,
            version: "herdr 9.9.9",
            normalized_context: true,
          },
        },
        harnesses: [
          { name: "claude", available: false, version: null },
          { name: "pi", available: true, version: "pi 0.80.3" },
        ],
        skills: [{ name: "implement", available: true, path: join(implement, "SKILL.md") }],
        state: { path: statePath, schema_version: 1 },
      },
      errors: [],
    });
    expect(readFileSync(statePath, "utf8")).toBe(state);
  });

  it("reports every missing baseline dependency in one result", () => {
    const fixture = makeEnvironment({});

    const result = runCli(preflightRequest(fixture.skillRoot), fixture.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "preflight",
      ok: false,
      result: {
        platform: process.platform,
        capabilities: {
          git: { available: false, version: null },
          bun: { available: false, version: null },
          herdr: { available: false, version: null, normalized_context: false },
        },
        harnesses: [
          { name: "claude", available: false, version: null },
          { name: "pi", available: false, version: null },
        ],
        skills: [{ name: "implement", available: false, path: null }],
        state: null,
      },
      errors: [
        {
          code: "dependency.git_missing",
          message: "Git is unavailable or `git --version` failed.",
          remediation: "Install Git and ensure `git` is on PATH.",
        },
        {
          code: "dependency.bun_missing",
          message: "Bun is unavailable or `bun --version` failed.",
          remediation: "Install Bun and ensure `bun` is on PATH.",
        },
        {
          code: "dependency.herdr_missing",
          message: "Herdr is unavailable or `herdr --version` failed.",
          remediation: "Install Herdr and ensure `herdr` is on PATH.",
        },
        {
          code: "harness.none_available",
          message: "Neither Pi nor Claude Code is available.",
          remediation:
            "Install at least one supported harness and ensure `pi` or `claude` is on PATH.",
        },
        {
          code: "skill.implement_missing",
          message: "The required Matt Pocock `implement` skill was not found.",
          remediation:
            "Install Matt Pocock's `implement` skill for the selected harness or pass its parent directory in `skill_roots`.",
        },
      ],
    });
  });

  it("rejects Herdr without normalized context-used and context-limit fields", () => {
    const fixture = makeEnvironment(completeCommands(false));
    const implement = join(fixture.skillRoot, "implement");
    mkdirSync(implement, { recursive: true });
    writeFileSync(join(implement, "SKILL.md"), "---\nname: implement\ndescription: test\n---\n");

    const result = runCli(preflightRequest(fixture.skillRoot), fixture.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "preflight",
      ok: false,
      result: {
        platform: process.platform,
        capabilities: {
          git: { available: true, version: "git version 2.45.0" },
          bun: { available: true, version: "1.4.0" },
          herdr: {
            available: true,
            version: "herdr 9.9.9",
            normalized_context: false,
          },
        },
        harnesses: [
          { name: "claude", available: false, version: null },
          { name: "pi", available: true, version: "pi 0.80.3" },
        ],
        skills: [{ name: "implement", available: true, path: join(implement, "SKILL.md") }],
        state: null,
      },
      errors: [
        {
          code: "herdr.context_metrics_missing",
          message:
            "Herdr's machine-readable API does not expose normalized `context_used` and `context_limit` fields.",
          remediation:
            "Install a Herdr release that exposes both normalized context fields in `herdr api schema --json`.",
        },
      ],
    });
  });

  it("ignores normalized context field names on unrelated schema records", () => {
    const commands = completeCommands();
    commands.herdr = `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("herdr 9.9.9");
} else if (args.join(" ") === "api schema --json") {
  console.log(JSON.stringify({
    schemas: {
      success_response: {
        $defs: {
          AgentInfo: { properties: { agent_status: { type: "string" } } },
          UnrelatedMetadata: {
            properties: {
              context_used: { type: "integer" },
              context_limit: { type: "integer" },
            },
          },
        },
      },
    },
  }));
} else {
  process.exit(1);
}
`;
    const fixture = makeEnvironment(commands);
    const implement = join(fixture.skillRoot, "implement");
    mkdirSync(implement, { recursive: true });
    writeFileSync(join(implement, "SKILL.md"), "---\nname: implement\ndescription: test\n---\n");

    const result = runCli(preflightRequest(fixture.skillRoot), fixture.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "preflight",
      ok: false,
      result: {
        platform: process.platform,
        capabilities: {
          git: { available: true, version: "git version 2.45.0" },
          bun: { available: true, version: "1.4.0" },
          herdr: {
            available: true,
            version: "herdr 9.9.9",
            normalized_context: false,
          },
        },
        harnesses: [
          { name: "claude", available: false, version: null },
          { name: "pi", available: true, version: "pi 0.80.3" },
        ],
        skills: [{ name: "implement", available: true, path: join(implement, "SKILL.md") }],
        state: null,
      },
      errors: [
        {
          code: "herdr.context_metrics_missing",
          message:
            "Herdr's machine-readable API does not expose normalized `context_used` and `context_limit` fields.",
          remediation:
            "Install a Herdr release that exposes both normalized context fields in `herdr api schema --json`.",
        },
      ],
    });
  });

  it("accepts a validated local snapshot without requiring a writeback choice", () => {
    const fixture = makeSnapshotFixture("local");

    const result = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: true,
      result: {
        status: "accepted",
        scheduling_allowed: true,
        revision: LOCAL_REVISION,
        accepted_revision: LOCAL_REVISION,
        changed_inputs: [],
        source: LOCAL_SOURCE,
        writeback: "none",
        inputs: LOCAL_INPUTS,
      },
      errors: [],
    });
    expect(readSnapshotRecord(fixture.statePath)).toEqual({
      revision: LOCAL_REVISION,
      accepted_at: "2026-09-19T00:00:00Z",
      source: LOCAL_SOURCE,
      writeback: "none",
      inputs: LOCAL_INPUTS,
    });
    expect(lastStateLine(fixture.statePath)).toBe(
      `- 2026-09-19 snapshot revision ${LOCAL_REVISION} accepted (initial; writeback: none)`,
    );
  });

  it("serializes snapshot acceptance with coordinator ownership mutation", async () => {
    const fixture = makeSnapshotFixture("local");
    const original = readFileSync(fixture.statePath, "utf8");
    writeFileSync(
      fixture.statePath,
      original.replace(
        "## Decisions",
        `Coordinator:
  harness: pi
  model: openai-codex/gpt-5.6-sol
  effort: high

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
  generation: 4
  pane: workspace:p1
  harness: claude
  model: fable
  effort: low
  readiness: ready
  marker: coordinator-ready-4-workspace:p1

## Decisions`,
      ),
    );

    const snapshotRead = deferred<void>();
    const releaseSnapshot = deferred<void>();
    const claimContended = deferred<void>();
    const snapshotPromise = Effect.runPromise(
      acceptSnapshot(
        {
          runPath: fixture.runPath,
          statePath: fixture.statePath,
          writeback: undefined,
          projectRemoteWrites: "allowed",
          acceptedAt: "2026-09-19T00:00:00Z",
        },
        {
          afterRead: async () => {
            snapshotRead.resolve(undefined);
            await releaseSnapshot.promise;
          },
          onLockContended: undefined,
        },
      ),
    );
    await snapshotRead.promise;

    const claimPromise = Effect.runPromise(
      claimCoordinator(
        {
          statePath: fixture.statePath,
          expectedGeneration: 4,
          expectedPredecessorPane: "workspace:p1",
          expectedPredecessorRole: {
            harness: "claude",
            model: "fable",
            effort: "low",
          },
          successorPane: "workspace:p2",
          successorRole: {
            harness: "pi",
            model: "openai-codex/gpt-5.6-sol",
            effort: "high",
          },
        },
        {
          afterRead: undefined,
          onLockContended: async () => {
            claimContended.resolve(undefined);
          },
        },
      ),
    );
    await claimContended.promise;
    releaseSnapshot.resolve(undefined);

    const [snapshot, ownership] = await Promise.all([snapshotPromise, claimPromise]);

    expect(snapshot).toEqual({
      status: "accepted",
      scheduling_allowed: true,
      revision: LOCAL_REVISION,
      accepted_revision: LOCAL_REVISION,
      changed_inputs: [],
      source: LOCAL_SOURCE,
      writeback: "none",
      inputs: LOCAL_INPUTS,
    });
    expect(ownership).toEqual({
      generation: 5,
      pane: "workspace:p2",
      harness: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      readiness: "claiming",
      marker: "coordinator-ready-5-workspace:p2",
    });
    expect(readSnapshotRecord(fixture.statePath)).toEqual({
      revision: LOCAL_REVISION,
      accepted_at: "2026-09-19T00:00:00Z",
      source: LOCAL_SOURCE,
      writeback: "none",
      inputs: LOCAL_INPUTS,
    });
    const state = readFileSync(fixture.statePath, "utf8");
    expect(
      state.includes(
        "Coordinator ownership:\n  generation: 5\n  pane: workspace:p2\n  harness: pi\n  model: openai-codex/gpt-5.6-sol\n  effort: high\n  readiness: claiming",
      ),
    ).toBe(true);
    expect(
      state.includes(
        `- 2026-09-19 snapshot revision ${LOCAL_REVISION} accepted (initial; writeback: none)`,
      ),
    ).toBe(true);
    expect(state.includes("- 2026-09-18 setup recorded")).toBe(true);
  });

  it("allows scheduling when the accepted snapshot is unchanged", () => {
    const fixture = makeSnapshotFixture("local");
    const accepted = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);
    expect(accepted.exitCode).toBe(0);

    const result = runCli(snapshotRequest("snapshot.check", fixture, null), process.env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.check",
      ok: true,
      result: {
        status: "unchanged",
        scheduling_allowed: true,
        revision: LOCAL_REVISION,
        accepted_revision: LOCAL_REVISION,
        changed_inputs: [],
        source: LOCAL_SOURCE,
        writeback: "none",
        inputs: LOCAL_INPUTS,
      },
      errors: [],
    });
  });

  it("pauses scheduling and reports changed snapshot inputs until explicit acceptance", () => {
    const fixture = makeSnapshotFixture("local");
    const accepted = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);
    expect(accepted.exitCode).toBe(0);
    const acceptedState = readFileSync(fixture.statePath, "utf8");
    writeFileSync(join(fixture.runPath, "spec.md"), "# Agreed design\n\nChanged design.\n");

    const changed = runCli(snapshotRequest("snapshot.check", fixture, null), process.env);

    expect(changed.exitCode).toBe(0);
    expect(changed.stderr).toBe("");
    expect((changed.stdout as { result: unknown }).result).toEqual({
      status: "changed",
      scheduling_allowed: false,
      revision: CHANGED_LOCAL_REVISION,
      accepted_revision: LOCAL_REVISION,
      changed_inputs: [{ path: "spec.md", change: "changed" }],
      source: LOCAL_SOURCE,
      writeback: "none",
      inputs: CHANGED_LOCAL_INPUTS,
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(acceptedState);

    const revised = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);
    expect(revised.exitCode).toBe(0);
    expect(
      (revised.stdout as { result: { scheduling_allowed: boolean } }).result.scheduling_allowed,
    ).toBe(true);
    expect(lastStateLine(fixture.statePath)).toBe(
      `- 2026-09-19 snapshot revision ${LOCAL_REVISION} -> ${CHANGED_LOCAL_REVISION} accepted (changed: spec.md; writeback: none)`,
    );
  });

  it("persists each remote tracker writeback mode", () => {
    for (const mode of ["none", "final", "live"] as const) {
      const fixture = makeSnapshotFixture("remote");

      const result = runCli(snapshotRequest("snapshot.accept", fixture, mode), process.env);

      expect(result.exitCode).toBe(0);
      expect((result.stdout as { result: { writeback: string } }).result.writeback).toBe(mode);
      expect((readSnapshotRecord(fixture.statePath) as { writeback: string }).writeback).toBe(mode);
    }
  });

  it("preserves remote writeback until an explicit policy change", () => {
    const fixture = makeSnapshotFixture("remote");
    const accepted = runCli(snapshotRequest("snapshot.accept", fixture, "final"), process.env);
    expect(accepted.exitCode).toBe(0);

    const resumed = runCli(snapshotRequest("snapshot.check", fixture, null), process.env);
    expect(resumed.exitCode).toBe(0);
    const resumedPolicy = resumed.stdout as {
      result: { status: string; writeback: string };
    };
    expect(resumedPolicy.result.status).toBe("unchanged");
    expect(resumedPolicy.result.writeback).toBe("final");

    const changed = runCli(snapshotRequest("snapshot.accept", fixture, "live"), process.env);
    expect(changed.exitCode).toBe(0);
    expect((readSnapshotRecord(fixture.statePath) as { writeback: string }).writeback).toBe("live");
    expect(lastStateLine(fixture.statePath)).toBe(
      "- 2026-09-19 snapshot writeback final -> live accepted for revision sha256:0a3a12c46678f9e5b171918bcd7e164e1f1c946ef4d16244c8432d45863529de",
    );
  });

  it("requires a writeback decision for a non-local source", () => {
    const fixture = makeSnapshotFixture("remote");
    const inspection = runCli(snapshotRequest("snapshot.check", fixture, null), process.env);
    expect(inspection.exitCode).toBe(0);
    const initial = inspection.stdout as {
      result: { status: string; scheduling_allowed: boolean; writeback: string | null };
    };
    expect(initial.result.status).toBe("unaccepted");
    expect(initial.result.scheduling_allowed).toBe(false);
    expect(initial.result.writeback).toBe(null);

    const result = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.writeback_required",
          message:
            "Non-local snapshot sources require a `none`, `final`, or `live` writeback decision.",
          remediation: "Choose a writeback mode explicitly, then retry snapshot acceptance.",
        },
      ],
    });
  });

  it("rejects remote writeback forbidden by project authority", () => {
    const fixture = makeSnapshotFixture("remote");
    const originalState = readFileSync(fixture.statePath, "utf8");

    const result = runCli(
      snapshotRequest("snapshot.accept", fixture, "live", "forbidden"),
      process.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.writeback_forbidden",
          message:
            "Project authority forbids remote writes, so writeback mode `live` cannot be used.",
          remediation: "Use writeback mode `none` or change the authoritative project policy.",
        },
      ],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(originalState);
  });

  it("blocks a persisted remote writeback when project authority changes", () => {
    const fixture = makeSnapshotFixture("remote");
    const accepted = runCli(snapshotRequest("snapshot.accept", fixture, "final"), process.env);
    expect(accepted.exitCode).toBe(0);
    const acceptedState = readFileSync(fixture.statePath, "utf8");

    const result = runCli(
      snapshotRequest("snapshot.check", fixture, null, "forbidden"),
      process.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.check",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.writeback_forbidden",
          message:
            "Project authority forbids remote writes, so writeback mode `final` cannot be used.",
          remediation: "Use writeback mode `none` or change the authoritative project policy.",
        },
      ],
    });
    expect(readFileSync(fixture.statePath, "utf8")).toBe(acceptedState);
  });

  it("rejects a snapshot input symlink that resolves outside the run folder", () => {
    const fixture = makeSnapshotFixture("local");
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
      specification: { path: string; source_reference: string };
    };
    manifest.specification.path = "linked-spec.md";
    manifest.specification.source_reference = "file:linked-spec.md";
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const outsidePath = join(dirname(fixture.runPath), "outside-spec.md");
    writeFileSync(outsidePath, "# Outside design\n\nMust not be hashed.\n");
    symlinkSync(outsidePath, join(fixture.runPath, "linked-spec.md"));

    const result = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.invalid",
          message: "Snapshot input linked-spec.md resolves outside the run folder",
          remediation:
            "Repair snapshot.json and its referenced files so the specification and every ticket are complete and consistent.",
        },
      ],
    });
  });

  it("rejects snapshot.json as the specification path", () => {
    const fixture = makeSnapshotFixture("local");
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
      specification: { path: string };
    };
    manifest.specification.path = "snapshot.json";
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.invalid",
          message: "Snapshot input snapshot.json is duplicated",
          remediation:
            "Repair snapshot.json and its referenced files so the specification and every ticket are complete and consistent.",
        },
      ],
    });
  });

  it("rejects a normalized snapshot with an unknown blocking edge", () => {
    const fixture = makeSnapshotFixture("local");
    const invalidManifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as {
      tickets: Array<{ blocked_by: string[] }>;
    };
    invalidManifest.tickets[1]!.blocked_by = ["99"];
    writeFileSync(fixture.manifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`);

    const result = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.invalid",
          message: "Snapshot ticket 02 references unknown blocker 99",
          remediation:
            "Repair snapshot.json and its referenced files so the specification and every ticket are complete and consistent.",
        },
      ],
    });
  });

  it("rejects a normalized ticket without acceptance criteria", () => {
    const fixture = makeSnapshotFixture("local");
    writeFileSync(
      join(fixture.runPath, "issues/02-feature.md"),
      "# 02: Feature\n\n**Blocked by:** 01: Foundation.\n\n**Status:** ready-for-agent\n",
    );

    const result = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.invalid",
          message: "Snapshot ticket 02 has no acceptance criteria",
          remediation:
            "Repair snapshot.json and its referenced files so the specification and every ticket are complete and consistent.",
        },
      ],
    });
  });

  it("rejects malformed persisted Snapshot record invariants", () => {
    const cases: Array<{
      name: string;
      mutate: (record: Record<string, unknown>) => void;
    }> = [
      {
        name: "impossible acceptance time",
        mutate: (record) => {
          record.accepted_at = "2026-99-99T99:99:99Z";
        },
      },
      {
        name: "local tracker workflow",
        mutate: (record) => {
          (record.source as Record<string, unknown>).tracker_workflow = "remote-workflow";
        },
      },
      {
        name: "duplicate inputs",
        mutate: (record) => {
          const inputs = record.inputs as Array<Record<string, unknown>>;
          inputs.push({ ...inputs[0]! });
        },
      },
      {
        name: "unsorted inputs",
        mutate: (record) => {
          const inputs = record.inputs as Array<Record<string, unknown>>;
          [inputs[0], inputs[1]] = [inputs[1]!, inputs[0]!];
        },
      },
      {
        name: "unsafe input path",
        mutate: (record) => {
          const inputs = record.inputs as Array<Record<string, unknown>>;
          inputs[0]!.path = "../outside.md";
        },
      },
      {
        name: "revision inconsistent with inputs",
        mutate: (record) => {
          record.revision = `sha256:${"0".repeat(64)}`;
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = makeSnapshotFixture("local");
      const accepted = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);
      expect(accepted.exitCode).toBe(0);
      const record = structuredClone(readSnapshotRecord(fixture.statePath)) as Record<
        string,
        unknown
      >;
      testCase.mutate(record);
      writeSnapshotRecord(fixture.statePath, record);

      const result = runCli(snapshotRequest("snapshot.check", fixture, null), process.env);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toEqual({
        schema_version: 1,
        operation: "snapshot.check",
        ok: false,
        result: null,
        errors: [
          {
            code: "snapshot.state_invalid",
            message: "RESUME.md has an invalid accepted Snapshot record.",
            remediation: "Repair the Snapshot section in RESUME.md manually, then retry.",
          },
        ],
      });
    }
  });

  it("rejects duplicate persisted Snapshot sections", () => {
    const fixture = makeSnapshotFixture("local");
    const accepted = runCli(snapshotRequest("snapshot.accept", fixture, null), process.env);
    expect(accepted.exitCode).toBe(0);
    const markdown = readFileSync(fixture.statePath, "utf8");
    const section = snapshotRecordPattern.exec(markdown)?.[0];
    if (section === undefined) throw new Error("Snapshot section was not written");
    writeFileSync(fixture.statePath, `${markdown.trimEnd()}\n\n${section}\n`);

    const result = runCli(snapshotRequest("snapshot.check", fixture, null), process.env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.check",
      ok: false,
      result: null,
      errors: [
        {
          code: "snapshot.state_invalid",
          message: "RESUME.md contains more than one Snapshot section.",
          remediation: "Repair the Snapshot section in RESUME.md manually, then retry.",
        },
      ],
    });
  });

  it("rejects impossible snapshot acceptance timestamps", () => {
    const fixture = makeSnapshotFixture("local");
    const request = snapshotRequest("snapshot.accept", fixture, null);
    request.input.accepted_at = "2026-99-99T99:99:99Z";

    const result = runCli(request, process.env);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "snapshot.accept",
      ok: false,
      result: null,
      errors: [
        {
          code: "request.invalid",
          message:
            "`snapshot.accept` requires input.accepted_at as a valid UTC ISO-8601 timestamp.",
          remediation: "Send one JSON request matching the documented schema-version-1 contract.",
        },
      ],
    });
  });

  it("accepts schema version 1 Markdown state", () => {
    const fixture = makeEnvironment({});
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, "# sample implementation run\n\nSchema version: 1\n");

    const result = runCli(
      {
        schema_version: 1,
        operation: "state.validate",
        input: { state_path: statePath },
      },
      fixture.env,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "state.validate",
      ok: true,
      result: { state: { path: statePath, schema_version: 1 } },
      errors: [],
    });
  });

  it("rejects state with no schema marker", () => {
    const fixture = makeEnvironment({});
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, "# sample implementation run\n");

    const result = runCli(
      {
        schema_version: 1,
        operation: "state.validate",
        input: { state_path: statePath },
      },
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "state.validate",
      ok: false,
      result: null,
      errors: [
        {
          code: "state.schema_missing",
          message: "RESUME.md is missing the required `Schema version:` field.",
          remediation: "Repair the state manually. Automatic state migration is not supported.",
        },
      ],
    });
  });

  it("rejects malformed state without rewriting it", () => {
    const fixture = makeEnvironment({});
    const statePath = join(fixture.root, "RESUME.md");
    const state = "# sample implementation run\n\nSchema version: one\n";
    writeFileSync(statePath, state);

    const result = runCli(
      {
        schema_version: 1,
        operation: "state.validate",
        input: { state_path: statePath },
      },
      fixture.env,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEqual({
      schema_version: 1,
      operation: "state.validate",
      ok: false,
      result: null,
      errors: [
        {
          code: "state.schema_malformed",
          message: "RESUME.md has a malformed `Schema version:` value; expected an integer.",
          remediation: "Repair the state manually. Automatic state migration is not supported.",
        },
      ],
    });
    expect(readFileSync(statePath, "utf8")).toBe(state);
  });

  it("rejects unsupported request and state schema versions", () => {
    const fixture = makeEnvironment({});
    const statePath = join(fixture.root, "RESUME.md");
    writeFileSync(statePath, "# sample implementation run\n\nSchema version: 2\n");

    const stateResult = runCli(
      {
        schema_version: 1,
        operation: "state.validate",
        input: { state_path: statePath },
      },
      fixture.env,
    );
    expect(stateResult.exitCode).toBe(1);
    expect(stateResult.stdout).toEqual({
      schema_version: 1,
      operation: "state.validate",
      ok: false,
      result: null,
      errors: [
        {
          code: "state.schema_unsupported",
          message: "RESUME.md uses unsupported schema version 2; this helper supports version 1.",
          remediation:
            "Use a helper that supports this state schema or recover the run manually. Automatic state migration is not supported.",
        },
      ],
    });

    const requestResult = runCli(
      { schema_version: 2, operation: "preflight", input: {} },
      fixture.env,
    );
    expect(requestResult.exitCode).toBe(2);
    expect(requestResult.stdout).toEqual({
      schema_version: 1,
      operation: "preflight",
      ok: false,
      result: null,
      errors: [
        {
          code: "request.schema_unsupported",
          message: "Unsupported request schema version 2; this helper supports version 1.",
          remediation: "Invoke the helper with a schema-version-1 request.",
        },
      ],
    });
  });
});
