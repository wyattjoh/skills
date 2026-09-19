import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "coordinate.ts");
const decoder = new TextDecoder();

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

const runCli = (request: unknown, env: Record<string, string>): CliResult => {
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
