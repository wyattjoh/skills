import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { updateAgreements } from "./lib/agreements.ts";
import { spawnGit } from "./lib/git.ts";
import {
  drainGlobalWarnings,
  ensureRunId,
  globalStateRoot,
  parseStallInterval,
  projectRun,
  publishRun,
  runFilePath,
  type GlobalRunFile,
} from "./lib/global-state.ts";
import { heartbeatStateFile } from "./lib/state-mutation.ts";

const CLI = join(import.meta.dir, "coordinate.ts");
const RUN_ID = "3f0c9a52-5d1e-4b8a-9c7e-2a4b6c8d0e1f";
const REPO = { common_dir: "/repo/.git", base_checkout: "/repo" };
const NOW = "2026-09-23T12:00:00.000Z";

const fullState = `# sample implementation run

Schema version: 1
Run id: ${RUN_ID}

Prefix:          dcs
Base:            main
Base sha:        0123456789abcdef0123456789abcdef01234567
Mode:            parallel
Parallel cap:    3
Stall interval:  15m
Branch template: <prefix>-NN-<slug>

Coordinator ownership:
  generation: 2
  pane: wJE:p1
  harness: claude
  model: fable
  effort: low
  readiness: ready
  marker: coordinator-ready-2-wJE:p1

## Tickets

| NN  | harness | model | effort | rounds | esc | status  | sha     |
| --- | ------- | ----- | ------ | ------ | --- | ------- | ------- |
| 01  | claude  | opus  | high   | 1      | -   | landed  | a1b2c3d |
| 02  | claude  | opus  | high   | 0      | -   | working | -       |
| 03  | -       | -     | -      | -      | -   | queued  | -       |

## Active tickets

### 02

Worktree: /worktrees/dcs-02
Branch: dcs-02-api
Session: dcs-02
Pane: w1:p4
Attempt: 2
Phase: working

## Stall evidence

- Ticket 02 timeout 1 attempt 1: reprompt/mechanical_input; request /run/r1.json; evidence /run/e1.json
- Ticket 02 timeout 2 attempt 1: pause/human_decision; request /run/r2.json; evidence /run/e2.json

## Decisions

## Run outcome

\`\`\`json
{
  "status": "waiting",
  "completed_at": null,
  "summary_path": null
}
\`\`\`
`;

const expectedProjection: GlobalRunFile = {
  kind: "run",
  schema_version: 1,
  run_id: RUN_ID,
  repo: REPO,
  run_folder: "/runs/dcs",
  state_path: "/runs/dcs/RESUME.md",
  prefix: "dcs",
  base: "main",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  mode: "parallel",
  parallel_cap: 3,
  stall_interval_minutes: 15,
  run_status: "waiting",
  summary_path: null,
  tickets: [
    { number: "01", status: "landed", harness: "claude", model: "opus", effort: "high" },
    { number: "02", status: "working", harness: "claude", model: "opus", effort: "high" },
    { number: "03", status: "queued", harness: null, model: null, effort: null },
  ],
  active_runtimes: [
    { ticket: "02", session: "dcs-02", pane: "w1:p4", phase: "working", attempt: 2 },
  ],
  coordinator: { generation: 2, pane: "wJE:p1", readiness: "ready" },
  pauses: [{ ticket: "02", reason: "human_decision", evidence_path: "/run/e2.json" }],
  last_operation: null,
  updated_at: NOW,
  heartbeat_at: null,
};

type JsonType = "string" | "number" | "boolean" | "null" | "object" | "array";

const flatten = (value: unknown, prefix = ""): Record<string, JsonType> => {
  if (value === null) return { [prefix]: "null" };
  if (Array.isArray(value)) {
    return value.reduce<Record<string, JsonType>>(
      (paths, item) => ({ ...paths, ...flatten(item, `${prefix}[]`) }),
      { [prefix]: "array" },
    );
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce<Record<string, JsonType>>(
      (paths, [key, item]) => ({
        ...paths,
        ...flatten(item, prefix === "" ? key : `${prefix}.${key}`),
      }),
      prefix === "" ? {} : { [prefix]: "object" },
    );
  }
  return { [prefix]: typeof value as JsonType };
};

type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

const schemaPaths = (node: SchemaNode, prefix = ""): Record<string, string[]> => {
  const types = node.type === undefined ? [] : [node.type].flat();
  const own = prefix === "" ? {} : { [prefix]: types };
  const properties = Object.entries(node.properties ?? {}).reduce<Record<string, string[]>>(
    (paths, [key, child]) => ({
      ...paths,
      ...schemaPaths(child, prefix === "" ? key : `${prefix}.${key}`),
    }),
    {},
  );
  const items = node.items === undefined ? {} : schemaPaths(node.items, `${prefix}[]`);
  return { ...own, ...properties, ...items };
};

const readSchema = (name: string): SchemaNode =>
  JSON.parse(
    readFileSync(join(import.meta.dir, "..", "references", "schemas", name), "utf8"),
  ) as SchemaNode;

describe("global state root", () => {
  it("prefers an absolute XDG_STATE_HOME", () => {
    expect(globalStateRoot({ XDG_STATE_HOME: "/state", HOME: "/home/u" })).toBe(
      "/state/coordinate-implementation",
    );
  });

  it("falls back to HOME when XDG_STATE_HOME is unset or relative", () => {
    expect(globalStateRoot({ HOME: "/home/u" })).toBe(
      "/home/u/.local/state/coordinate-implementation",
    );
    expect(globalStateRoot({ XDG_STATE_HOME: "relative", HOME: "/home/u" })).toBe(
      "/home/u/.local/state/coordinate-implementation",
    );
  });

  it("is sandboxed by the test preload", () => {
    expect(globalStateRoot(process.env).startsWith(tmpdir().replace(/\/$/u, ""))).toBe(true);
  });
});

describe("run projection", () => {
  it("projects every curated field from a complete RESUME.md", () => {
    expect(projectRun(fullState, "/runs/dcs/RESUME.md", REPO, NOW)).toEqual(expectedProjection);
  });

  it("projects unparseable sections as nulls and empty lists", () => {
    const partial = `Schema version: 1\nRun id: ${RUN_ID}\nStall interval: 90m\n`;
    expect(projectRun(partial, "/runs/x/RESUME.md", REPO, NOW)).toEqual({
      ...expectedProjection,
      run_folder: "/runs/x",
      state_path: "/runs/x/RESUME.md",
      prefix: null,
      base: null,
      base_sha: null,
      mode: null,
      parallel_cap: null,
      stall_interval_minutes: null,
      run_status: "active",
      tickets: [],
      active_runtimes: [],
      coordinator: { generation: null, pane: null, readiness: null },
      pauses: [],
    });
  });

  it("returns null without a valid run id", () => {
    expect(projectRun("Schema version: 1\nRun id: nope\n", "/r/RESUME.md", REPO, NOW)).toBe(null);
  });

  it("defaults and bounds the stall interval", () => {
    expect([
      parseStallInterval("Schema version: 1\n"),
      parseStallInterval("Stall interval: 2m\n"),
      parseStallInterval("Stall interval: 60m\n"),
      parseStallInterval("Stall interval: 1m\n"),
      parseStallInterval("Stall interval: 10\n"),
    ]).toEqual([10, 2, 60, null, null]);
  });

  it("backfills the run id directly after the schema marker only once", () => {
    const backfilled = ensureRunId("# run\n\nSchema version: 1\n\nPrefix: dcs\n", () => RUN_ID);
    expect(backfilled).toBe(`# run\n\nSchema version: 1\nRun id: ${RUN_ID}\n\nPrefix: dcs\n`);
    expect(ensureRunId(backfilled, () => "other")).toBe(backfilled);
  });
});

describe("global run file versioning", () => {
  it("keeps every v1 field with its declared type", () => {
    const declared = schemaPaths(readSchema("run.v1.schema.json"));
    const emitted = flatten({
      ...expectedProjection,
      last_operation: "snapshot.accept",
      heartbeat_at: NOW,
      summary_path: "/runs/dcs/SUMMARY.md",
    });
    const nullable = flatten(
      projectRun(
        "Schema version: 1\nRun id: " + RUN_ID,
        "/r/RESUME.md",
        { common_dir: null, base_checkout: null },
        NOW,
      ),
    );
    const undeclared = [...Object.keys(emitted), ...Object.keys(nullable)].filter(
      (path) => declared[path] === undefined,
    );
    const mistyped = [...Object.entries(nullable), ...Object.entries(emitted)].filter(
      ([path, type]) => !(declared[path] ?? []).includes(type),
    );
    const missing = Object.keys(declared).filter((path) => emitted[path] === undefined);

    expect(undeclared).toEqual([]);
    expect(mistyped).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("declares every v1 agreements field", () => {
    const declared = schemaPaths(readSchema("agreements.v1.schema.json"));
    expect(Object.keys(declared).toSorted()).toEqual([
      "common_dir",
      "kind",
      "merge_order",
      "merge_order[]",
      "owner_run_id",
      "schema_version",
      "shared_files",
      "shared_files[]",
      "shared_files[].owner_prefix",
      "shared_files[].path",
      "updated_at",
    ]);
  });
});

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "coordinate-global-"));
  const run = join(root, "run");
  mkdirSync(run);
  return { env: { XDG_STATE_HOME: join(root, "state") }, statePath: join(run, "RESUME.md") };
};

const agreementsInput = (statePath: string, transfer = false) => ({
  statePath,
  mergeOrder: ["dcs", "abc"],
  sharedFiles: [{ path: "src/api.ts", ownerPrefix: "dcs" }],
  transferOwnership: transfer,
  userAuthorized: transfer,
});

describe("publishing", () => {
  it("keeps the heartbeat on mutation and the mutation time on heartbeat", async () => {
    const { env, statePath } = sandbox();
    const path = runFilePath(globalStateRoot(env), RUN_ID);

    await Effect.runPromise(publishRun(statePath, fullState, "heartbeat", env));
    const beat = JSON.parse(readFileSync(path, "utf8")) as GlobalRunFile;
    await Effect.runPromise(publishRun(statePath, fullState, "mutation", env));
    const mutated = JSON.parse(readFileSync(path, "utf8")) as GlobalRunFile;
    await Effect.runPromise(publishRun(statePath, fullState, "heartbeat", env));
    const beatAgain = JSON.parse(readFileSync(path, "utf8")) as GlobalRunFile;

    expect(mutated.heartbeat_at).toBe(beat.heartbeat_at);
    expect(beatAgain.updated_at).toBe(mutated.updated_at);
    expect(readdirSync(join(globalStateRoot(env), "runs"))).toEqual([`${RUN_ID}.json`]);
    expect(drainGlobalWarnings()).toEqual([]);
  });

  it("records a warning instead of failing when the root is unwritable", async () => {
    const { env, statePath } = sandbox();
    // A regular file blocks the root even for uid 0, which bypasses mode bits.
    writeFileSync(env.XDG_STATE_HOME, "");

    await Effect.runPromise(publishRun(statePath, fullState, "mutation", env));

    expect(drainGlobalWarnings().map((issue) => issue.code)).toEqual(["global_state.write_failed"]);
  });

  it("heartbeats an older run by backfilling its run id", async () => {
    const { statePath } = sandbox();
    writeFileSync(statePath, fullState.replace(`Run id: ${RUN_ID}\n`, ""));

    await Effect.runPromise(heartbeatStateFile(statePath));

    const runId = /^Run id: (\S+)$/mu.exec(readFileSync(statePath, "utf8"))![1]!;
    const file = JSON.parse(
      readFileSync(runFilePath(globalStateRoot(process.env), runId), "utf8"),
    ) as GlobalRunFile;
    expect(file.heartbeat_at).toBe(file.updated_at);
    expect(file.prefix).toBe("dcs");
    expect(drainGlobalWarnings()).toEqual([]);
  });
});

describe("cross-run agreements", () => {
  const repository = () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-agreements-"));
    expect(spawnGit(["init", "-q", "-b", "main"], { cwd: root }).exitCode).toBe(0);
    const run = (runId: string) => {
      const folder = join(root, ".scratch", runId.slice(0, 4));
      mkdirSync(folder, { recursive: true });
      const statePath = join(folder, "RESUME.md");
      writeFileSync(statePath, fullState.replace(RUN_ID, runId));
      return statePath;
    };
    return { env: { XDG_STATE_HOME: join(root, "state") }, run };
  };
  const OTHER_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const attempt = (statePath: string, env: Record<string, string>, transfer = false) =>
    Effect.runPromise(
      Effect.result(updateAgreements(agreementsInput(statePath, transfer), env)).pipe(
        Effect.map((result) =>
          Result.isFailure(result)
            ? { code: result.failure.issue.code, owner: null, previous: null }
            : {
                code: "ok",
                owner: result.success.agreements.owner_run_id,
                previous: result.success.previous_owner_run_id,
              },
        ),
      ),
    );

  it("lets only the owner write until the user authorizes a transfer", async () => {
    const { env, run } = repository();
    const owner = run(RUN_ID);
    const other = run(OTHER_ID);

    expect([
      await attempt(owner, env),
      await attempt(other, env),
      await attempt(owner, env),
      await attempt(other, env, true),
    ]).toEqual([
      { code: "ok", owner: RUN_ID, previous: null },
      { code: "agreements.not_owner", owner: null, previous: null },
      { code: "ok", owner: RUN_ID, previous: RUN_ID },
      { code: "ok", owner: OTHER_ID, previous: RUN_ID },
    ]);
    const files = readdirSync(join(env.XDG_STATE_HOME, "coordinate-implementation", "agreements"));
    expect(files.filter((name) => name.endsWith(".json")).length).toBe(1);
  });
});

describe("helper integration", () => {
  it("publishes after a CLI mutation and surfaces write failures as warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "coordinate-global-cli-"));
    const statePath = join(root, "RESUME.md");
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "");
    const state = (attempt: number) =>
      fullState
        .replace(`Run id: ${RUN_ID}\n`, "")
        .replace(
          "Phase: working",
          `Implementor: {"harness":"claude","model":"opus","effort":"high"}\nImplement skill: /skills/implement/SKILL.md\nTab: implement 02\nArtifact: /run/briefs/launch-02.json\nRetry: ${attempt - 1} of 3\nPhase: working\nLast diagnostic: none`,
        )
        .replace("Attempt: 2", `Attempt: ${attempt}`);
    const run = (env: Record<string, string | undefined>) => {
      const child = Bun.spawnSync([process.execPath, CLI], {
        env,
        stdin: Buffer.from(
          JSON.stringify({
            schema_version: 1,
            operation: "infrastructure.retry.record",
            input: {
              state_path: statePath,
              ticket: "02",
              attempt: 1,
              failure: "launch",
              diagnostic: "x",
            },
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: child.exitCode,
        body: JSON.parse(child.stdout.toString()) as Record<string, unknown>,
      };
    };

    writeFileSync(statePath, state(1));
    const published = run(process.env);
    const runId = /^Run id: (\S+)$/mu.exec(readFileSync(statePath, "utf8"))![1]!;
    const file = JSON.parse(
      readFileSync(runFilePath(globalStateRoot(process.env), runId), "utf8"),
    ) as GlobalRunFile;

    writeFileSync(statePath, state(1));
    const warned = run({ ...process.env, XDG_STATE_HOME: blocked });

    expect(published.exitCode).toBe(0);
    expect(published.body.warnings).toBe(undefined);
    expect(file.last_operation).toBe("infrastructure.retry.record");
    expect(file.active_runtimes).toEqual([
      { ticket: "02", session: "dcs-02", pane: "w1:p4", phase: "retry waiting", attempt: 1 },
    ]);
    expect(warned.exitCode).toBe(0);
    expect((warned.body.warnings as Array<{ code: string }>).map((issue) => issue.code)).toEqual([
      "global_state.write_failed",
    ]);
  });
});
