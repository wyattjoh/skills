import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument } from "./backlog-doc.ts";
import { resolveConfig } from "./config.ts";
import {
  HarnessPolicyError,
  LEGACY_HARNESS_SELECTION,
  harnessPolicyPath,
  requireRecordedHarnessEnabled,
  resetHarnessPolicy,
  resolveEffectiveHarnessPolicy,
  resolveHarnessForLaunch,
  setHarnessPolicy,
  showHarnessPolicy,
  type HarnessSelection,
} from "./harness-policy.ts";
import { Refused } from "./fleet.ts";
import { tempDir } from "./fixture.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const path of dirs) rmSync(path, { recursive: true, force: true });
});

const setup = async () => {
  const stateDir = tempDir("coordinate-harness-policy-");
  dirs.push(stateDir);
  const config = await Effect.runPromise(
    resolveConfig({ state_dir: stateDir }, join(stateDir, "config.json")),
  );
  return { config, stateDir, path: harnessPolicyPath(stateDir) };
};

const selection = (
  enabled: HarnessSelection["enabled"],
  defaultHarness: HarnessSelection["default"],
): HarnessSelection => ({
  enabled,
  default: defaultHarness,
});

const readView = async (config: Awaited<ReturnType<typeof setup>>["config"], domain?: string) =>
  JSON.parse((await Effect.runPromise(showHarnessPolicy(config, domain, true)))[0] ?? "null");

const failureOf = async <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.flip));

describe("delegate harness policy store", () => {
  it("shows the actual legacy parser behavior without writing state", async () => {
    const { config, path } = await setup();
    const global = await readView(config);
    expect(global).toEqual({
      schemaVersion: 1,
      revision: 0,
      path,
      global: { source: "legacy", policy: LEGACY_HARNESS_SELECTION, reenabledBy: [] },
      domain: null,
    });
    expect(await readView(config, "app")).toEqual({
      ...global,
      domain: {
        name: "app",
        mode: "inherit",
        override: null,
        effective: LEGACY_HARNESS_SELECTION,
        reenabled: [],
      },
    });
  });

  it("resolves explicit legacy choices and only defaults an omitted launch when configured", async () => {
    const { config } = await setup();
    expect((await Effect.runPromise(resolveEffectiveHarnessPolicy(config, "app"))).source).toBe(
      "legacy",
    );
    expect(await Effect.runPromise(resolveHarnessForLaunch(config, "app", "pi", false))).toBe("pi");
    const missing = await failureOf(resolveHarnessForLaunch(config, "app", undefined, false));
    expect(missing instanceof Refused).toBe(true);

    await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "global",
        domain: undefined,
        selection: selection(["claude"], "claude"),
        expectedRevision: 0,
        json: true,
      }),
    );
    expect(await Effect.runPromise(resolveHarnessForLaunch(config, "app", undefined, false))).toBe(
      "claude",
    );
    const disabled = await failureOf(resolveHarnessForLaunch(config, "app", "pi", false));
    expect(disabled instanceof Refused).toBe(true);
    await Effect.runPromise(requireRecordedHarnessEnabled(config, "app", "claude", "review"));
    const disabledResume = await failureOf(
      requireRecordedHarnessEnabled(config, "app", "pi", "review"),
    );
    expect(disabledResume instanceof Refused).toBe(true);
  });

  it("replaces global and domain selections, then resets the domain to inheritance", async () => {
    const { config, path } = await setup();
    await Effect.runPromise(createDocument(config, "app"));

    const globalSelection = selection(["claude"], "claude");
    await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "global",
        domain: undefined,
        selection: globalSelection,
        expectedRevision: 0,
        json: true,
      }),
    );
    expect(await readView(config, "app")).toEqual({
      schemaVersion: 1,
      revision: 1,
      path,
      global: { source: "configured", policy: globalSelection, reenabledBy: [] },
      domain: {
        name: "app",
        mode: "inherit",
        override: null,
        effective: globalSelection,
        reenabled: [],
      },
    });

    const override = selection(["pi", "claude"], null);
    await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "domain",
        domain: "app",
        selection: override,
        expectedRevision: 1,
        json: true,
      }),
    );
    const replaced = await readView(config, "app");
    expect(replaced.revision).toBe(2);
    expect(replaced.domain).toEqual({
      name: "app",
      mode: "replace",
      override,
      effective: override,
      reenabled: ["pi"],
    });
    expect(replaced.global.reenabledBy).toEqual([{ domain: "app", harnesses: ["pi"] }]);

    await Effect.runPromise(resetHarnessPolicy(config, "app", 2, true));
    expect((await readView(config, "app")).domain).toEqual({
      name: "app",
      mode: "inherit",
      override: null,
      effective: globalSelection,
      reenabled: [],
    });
    expect((await readView(config)).revision).toBe(3);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("warns when a domain replacement enables a harness global disables, and names it on a global save", async () => {
    const { config, path } = await setup();
    await Effect.runPromise(createDocument(config, "app"));
    await Effect.runPromise(createDocument(config, "web"));
    await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "domain",
        domain: "app",
        selection: selection(["pi", "claude"], "pi"),
        expectedRevision: 0,
        json: true,
      }),
    );
    await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "domain",
        domain: "web",
        selection: selection(["claude"], "claude"),
        expectedRevision: 1,
        json: true,
      }),
    );

    const globalSave = await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "global",
        domain: undefined,
        selection: selection(["claude"], "claude"),
        expectedRevision: 2,
        json: false,
      }),
    );
    expect(globalSave).toEqual([
      `harness policy revision 3 (${path})`,
      "global (configured): enabled claude; default claude",
      "note: app keeps pi via its replacement; reset with coordinate harness-policy domain-reset app --expected-revision 3",
    ]);

    expect(await Effect.runPromise(showHarnessPolicy(config, "app", false))).toEqual([
      `harness policy revision 3 (${path})`,
      "global (configured): enabled claude; default claude",
      "domain app (replace): enabled pi, claude; default pi",
      "  replacement: enabled pi, claude; default pi",
      "  warning: domain override enables pi, which global policy disables; reset with coordinate harness-policy domain-reset app --expected-revision 3",
    ]);
    expect(await Effect.runPromise(showHarnessPolicy(config, "web", false))).toEqual([
      `harness policy revision 3 (${path})`,
      "global (configured): enabled claude; default claude",
      "domain web (replace): enabled claude; default claude",
      "  replacement: enabled claude; default claude",
    ]);
    expect((await readView(config, "app")).domain.reenabled).toEqual(["pi"]);
    expect(
      (await Effect.runPromise(resolveEffectiveHarnessPolicy(config, "app"))).reenabled,
    ).toEqual(["pi"]);
  });

  it("rejects stale revisions without overwriting newer state", async () => {
    const { config } = await setup();
    await Effect.runPromise(
      setHarnessPolicy(config, {
        scope: "global",
        domain: undefined,
        selection: selection(["pi"], "pi"),
        expectedRevision: 0,
        json: true,
      }),
    );
    const error = await failureOf(
      setHarnessPolicy(config, {
        scope: "global",
        domain: undefined,
        selection: selection(["claude"], "claude"),
        expectedRevision: 0,
        json: true,
      }),
    );
    expect(error instanceof Refused).toBe(true);
    expect((await readView(config)).global.policy).toEqual(selection(["pi"], "pi"));
  });

  it("serializes concurrent edits and permits only one writer for a revision", async () => {
    const { config } = await setup();
    const attempts = await Promise.allSettled([
      Effect.runPromise(
        setHarnessPolicy(config, {
          scope: "global",
          domain: undefined,
          selection: selection(["pi"], "pi"),
          expectedRevision: 0,
          json: true,
        }),
      ),
      Effect.runPromise(
        setHarnessPolicy(config, {
          scope: "global",
          domain: undefined,
          selection: selection(["claude"], "claude"),
          expectedRevision: 0,
          json: true,
        }),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason instanceof Refused).toBe(true);
    expect((await readView(config)).revision).toBe(1);
  });

  it("refuses a domain replacement unless the domain already exists", async () => {
    const { config } = await setup();
    const error = await failureOf(
      setHarnessPolicy(config, {
        scope: "domain",
        domain: "missing",
        selection: selection(["pi"], null),
        expectedRevision: 0,
        json: true,
      }),
    );
    expect(error instanceof Refused).toBe(true);
    expect((await readView(config)).revision).toBe(0);
  });

  it("refuses malformed, unsupported, or semantically invalid policy documents", async () => {
    const invalid = [
      { schemaVersion: 2, revision: 1, domains: {} },
      { schemaVersion: 1, revision: 1, domains: {}, surprise: true },
      { schemaVersion: 1, revision: 1, global: { enabled: ["codex"], default: null }, domains: {} },
      {
        schemaVersion: 1,
        revision: 1,
        global: { enabled: ["pi"], default: "claude" },
        domains: {},
      },
      {
        schemaVersion: 1,
        revision: 1,
        global: { enabled: ["pi", "pi"], default: null },
        domains: {},
      },
    ];
    for (const value of invalid) {
      const { config, path } = await setup();
      const text = JSON.stringify(value);
      writeFileSync(path, text);
      const error = await failureOf(showHarnessPolicy(config, undefined, true));
      expect(error instanceof HarnessPolicyError).toBe(true);
      if (error instanceof HarnessPolicyError) {
        expect(error.path).toBe(path);
        expect(error.message).toContain(path);
      }
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("does not replace an invalid policy when an edit is requested", async () => {
    const { config, path } = await setup();
    const text = JSON.stringify({ schemaVersion: 9, revision: 1, domains: {} });
    writeFileSync(path, text);
    const error = await failureOf(
      setHarnessPolicy(config, {
        scope: "global",
        domain: undefined,
        selection: selection(["pi"], "pi"),
        expectedRevision: 0,
        json: true,
      }),
    );
    expect(error instanceof HarnessPolicyError).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});
