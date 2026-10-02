import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG,
  bootstrapCi,
  forgejoForge,
  githubForge,
  tokenPlan,
  type BootstrapConfig,
  type BootstrapDependencies,
  type CatalogEntry,
  type Forge,
  type RunCommand,
} from "./bootstrap-ci.ts";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const tokenId = "c".repeat(32);
const now = new Date("2026-10-02T00:00:00.848Z");
const key = "GLOBAL_KEY_NOT_REAL_FIXTURE";
const value = "SCOPED_TOKEN_NOT_REAL_FIXTURE";

const config: BootstrapConfig = {
  tokenPrefix: "fixture-ci",
  forge: { kind: "forgejo", host: "git.example.test", repo: "owner/fixture" },
  accountGroups: ["Account Settings Read", "Workers Scripts Write"],
  zone: { hostname: "fixture.test", groups: ["Zone Read"] },
};

const catalog: CatalogEntry[] = [
  { id: "1".repeat(32), name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
  { id: "2".repeat(32), name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
  { id: "3".repeat(32), name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
];

const includes = (haystack: string, needle: string) => haystack.includes(needle);

function harness() {
  const requests: { path: string; method: string; body: unknown; bearer: boolean }[] = [];
  const installed = new Map<string, string>();
  const logs: string[] = [];
  const settings = {
    names: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as string[],
    confirmed: true,
    existingTokens: [] as unknown[],
    transform: (_path: string, result: unknown): unknown => result,
    install: (name: string, secret: string) => {
      installed.set(name, secret);
    },
  };
  const plan = tokenPlan(config, accountId, zoneId, catalog, 90, now);
  const forge: Forge = {
    describe: "fixture forge",
    ensureReady: () => {},
    secretNames: () => new Set(settings.names),
    installSecret: (name, secret) => settings.install(name, secret),
  };
  const deps: BootstrapDependencies = {
    credentials: async () => ({ email: "operator@example.com", key, accountId }),
    now: () => now,
    confirm: async () => settings.confirmed,
    log: (line) => logs.push(line),
    forge,
    fetch: (async (address: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(address));
      expect(url.origin).toBe("https://api.cloudflare.com");
      expect(init.redirect).toBe("error");
      const path = url.pathname.replace("/client/v4", "");
      const headers = init.headers as Record<string, string>;
      requests.push({
        path,
        method: String(init.method),
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        bearer: headers.Authorization === `Bearer ${value}`,
      });
      let result: unknown;
      if (path === `/accounts/${accountId}`) result = { id: accountId };
      else if (path === "/zones")
        result = [
          { id: zoneId, name: "fixture.test", status: "active", account: { id: accountId } },
        ];
      else if (path === "/user/tokens/permission_groups") result = catalog;
      else if (path === "/user/tokens/verify") result = { id: tokenId, status: "active" };
      else if (path === `/user/tokens/${tokenId}`)
        result = { ...plan, id: tokenId, status: "active" };
      else if (path === "/user/tokens" && init.method === "POST")
        result = { ...plan, id: tokenId, value };
      else if (path === "/user/tokens") result = settings.existingTokens;
      else throw new Error(`Unexpected Cloudflare endpoint ${path}`);
      return Response.json({ success: true, result: settings.transform(path, result) });
    }) as typeof fetch,
  };
  const writes = () => requests.filter((request) => request.method === "POST").length;
  return { deps, settings, requests, installed, logs, writes };
}

describe("tokenPlan", () => {
  it("builds account and zone policies from the live catalog with a whole-second expiry", () => {
    expect(tokenPlan(config, accountId, zoneId, catalog, 90, now)).toEqual({
      name: "fixture-ci-2026-10-02T00-00-00-848Z",
      expires_on: "2026-12-31T00:00:00Z",
      policies: [
        {
          effect: "allow",
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          permission_groups: [{ id: "1".repeat(32) }, { id: "2".repeat(32) }],
        },
        {
          effect: "allow",
          resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
          permission_groups: [{ id: "3".repeat(32) }],
        },
      ],
    });
  });

  it("omits the zone policy when no zone is configured", () => {
    const plan = tokenPlan({ ...config, zone: undefined }, accountId, undefined, catalog, 1, now);
    expect(plan.policies).toHaveLength(1);
  });

  it.each([
    [
      "a group missing from the catalog",
      { ...config, accountGroups: ["Account Settings Read", "D1 Write"] },
      /"D1 Write" is not uniquely available/,
    ],
    [
      "no account read grant",
      { ...config, accountGroups: ["Workers Scripts Write"] },
      /Account Settings Read/,
    ],
    [
      "a zone without Zone Read",
      { ...config, zone: { hostname: "fixture.test", groups: [] } },
      /Zone Read/,
    ],
  ] as const)("rejects %s", (_label, candidate, message) => {
    expect(() => tokenPlan(candidate, accountId, zoneId, catalog, 90, now)).toThrow(message);
  });

  it.each([0, 366, 90.5])("rejects a %p-day lifetime", (days) => {
    expect(() => tokenPlan(config, accountId, zoneId, catalog, days, now)).toThrow(
      /between 1 and 365/,
    );
  });
});

describe("bootstrapCi", () => {
  it("rotates to the exact plan, verifies with the new token, and installs both secrets", async () => {
    const h = harness();
    expect(await bootstrapCi(config, { rotate: true, days: 90 }, h.deps)).toEqual({
      kind: "installed",
      tokenId,
      expiresOn: "2026-12-31T00:00:00Z",
    });
    expect([...h.installed]).toEqual([
      ["CLOUDFLARE_ACCOUNT_ID", accountId],
      ["CLOUDFLARE_API_TOKEN", value],
    ]);
    expect(h.requests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      tokenPlan(config, accountId, zoneId, catalog, 90, now),
    ]);
    expect(h.requests.filter((r) => r.bearer).map((r) => r.path)).toEqual([
      "/user/tokens/verify",
      `/accounts/${accountId}`,
      "/zones",
    ]);
    expect(includes(h.logs.join("\n"), key)).toBe(false);
    expect(includes(h.logs.join("\n"), value)).toBe(false);
  });

  it("installs on a first run when the secrets and prior CI tokens are absent", async () => {
    const h = harness();
    h.settings.names = [];
    expect((await bootstrapCi(config, { rotate: false, days: 90 }, h.deps)).kind).toBe("installed");
    expect(h.installed.size).toBe(2);
  });

  it("leaves a complete installation unchanged without collecting credentials", async () => {
    const h = harness();
    h.deps.credentials = async () => {
      throw new Error("Unexpected credential collection");
    };
    expect(await bootstrapCi(config, { rotate: false, days: 90 }, h.deps)).toEqual({
      kind: "unchanged",
    });
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a partial installation without explicit rotation", async () => {
    const h = harness();
    h.settings.names = ["CLOUDFLARE_ACCOUNT_ID"];
    await expect(bootstrapCi(config, { rotate: false, days: 90 }, h.deps)).rejects.toThrow(
      /partially configured/,
    );
    expect(h.requests).toHaveLength(0);
  });

  it("refuses to mint a duplicate after a prior partial run", async () => {
    const h = harness();
    h.settings.names = [];
    h.settings.existingTokens = [
      { name: "fixture-ci-earlier", id: tokenId, status: "active", policies: [] },
    ];
    await expect(bootstrapCi(config, { rotate: false, days: 90 }, h.deps)).rejects.toThrow(
      /no duplicate minted/,
    );
    expect(h.writes()).toBe(0);
  });

  it("mints nothing when confirmation is declined", async () => {
    const h = harness();
    h.settings.confirmed = false;
    await expect(bootstrapCi(config, { rotate: true, days: 90 }, h.deps)).rejects.toThrow(
      /Confirmation declined/,
    );
    expect(h.writes()).toBe(0);
    expect(h.installed.size).toBe(0);
  });

  it.each(["foreign account", "inactive zone", "renamed zone", "missing catalog group"])(
    "refuses a %s before minting",
    async (failure) => {
      const h = harness();
      h.settings.transform = (path, result) => {
        if (path === "/user/tokens/permission_groups")
          return failure === "missing catalog group" ? catalog.slice(1) : result;
        if (path !== "/zones") return result;
        return [
          {
            id: zoneId,
            name: failure === "renamed zone" ? "elsewhere.test" : "fixture.test",
            status: failure === "inactive zone" ? "pending" : "active",
            account: { id: failure === "foreign account" ? "d".repeat(32) : accountId },
          },
        ];
      };
      let message = "";
      try {
        await bootstrapCi(config, { rotate: true, days: 90 }, h.deps);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/no token minted/);
      expect(h.writes()).toBe(0);
    },
  );

  it.each(["broad scope", "missing expiry", "inactive token"])(
    "installs nothing when the new token has an unexpected %s",
    async (failure) => {
      const h = harness();
      h.settings.transform = (path, result) => {
        if (path !== `/user/tokens/${tokenId}`) return result;
        const metadata = result as Record<string, unknown>;
        if (failure === "missing expiry") return { ...metadata, expires_on: undefined };
        if (failure === "inactive token") return { ...metadata, status: "disabled" };
        return {
          ...metadata,
          policies: [
            {
              effect: "allow",
              resources: { "com.cloudflare.api.account.*": "*" },
              permission_groups: [],
            },
          ],
        };
      };
      let message = "";
      try {
        await bootstrapCi(config, { rotate: true, days: 90 }, h.deps);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/exact requested policy and expiry/);
      expect(h.writes()).toBe(1);
      expect(h.installed.size).toBe(0);
    },
  );

  it("stops after a failed install without retrying, reminting, or leaking the token", async () => {
    const h = harness();
    h.settings.install = (name, secret) => {
      if (name === "CLOUDFLARE_API_TOKEN") throw new Error("install failed");
      h.installed.set(name, secret);
    };
    let message = "";
    try {
      await bootstrapCi(config, { rotate: true, days: 90 }, h.deps);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("install failed");
    expect([...h.installed.keys()]).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
    expect(h.writes()).toBe(1);
    expect(includes(h.logs.join("\n"), value)).toBe(false);
  });

  it("withholds network error details", async () => {
    const h = harness();
    h.deps.fetch = Object.assign(
      async () => {
        throw new Error(key);
      },
      { preconnect: () => {} },
    );
    let message = "";
    try {
      await bootstrapCi(config, { rotate: true, days: 90 }, h.deps);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "Cloudflare request failed or timed out; details withheld. No alternate credential used.",
    );
  });
});

const recorder = (
  respond: (args: readonly string[], input?: string) => { exitCode: number; stdout: string },
) => {
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  const run: RunCommand = (command, args, input) => {
    calls.push({ command, args, input });
    return respond(args, input);
  };
  return { calls, run };
};

const json = (body: unknown) => ({ exitCode: 0, stdout: JSON.stringify(body) });

const page = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${n}_${i}` }));

describe("forgejoForge", () => {
  const target = { kind: "forgejo", host: "git.example.test", repo: "owner/fixture" } as const;

  it("lists secret names across pages", () => {
    const { calls, run } = recorder((args) =>
      json({
        status: "success",
        result: {
          body: JSON.stringify(args.some((a) => a.includes("page=1&")) ? page(50) : page(1)),
        },
      }),
    );
    expect(forgejoForge(target, run).secretNames().size).toBe(51);
    expect(calls).toHaveLength(2);
  });

  it("installs a secret through one approval round trip with the value on stdin", () => {
    const { calls, run } = recorder((args) =>
      args.includes("--approve")
        ? json({ status: "success" })
        : json({
            status: "error",
            error: { code: "approval.required" },
            next_steps: [{ action: "approve", grant: "g1" }],
          }),
    );
    forgejoForge(target, run).installSecret("CLOUDFLARE_API_TOKEN", value);
    expect(calls.map((call) => call.args.at(-1))).toEqual(["-", "g1"]);
    expect(calls.map((call) => call.input)).toEqual([
      JSON.stringify({ data: value }),
      JSON.stringify({ data: value }),
    ]);
    expect(calls.flatMap((call) => call.args).filter((arg) => arg === value)).toEqual([]);
  });

  it("stops on an ambiguous approval", () => {
    const { run } = recorder(() =>
      json({
        status: "error",
        error: { code: "approval.required" },
        next_steps: [
          { action: "approve", grant: "one" },
          { action: "approve", grant: "two" },
        ],
      }),
    );
    expect(() => forgejoForge(target, run).installSecret("CLOUDFLARE_API_TOKEN", value)).toThrow(
      /ambiguous/,
    );
  });
});

describe("githubForge", () => {
  const target = { kind: "github", host: "github.com", repo: "owner/fixture" } as const;

  it("lists secret names and installs with the value on stdin", () => {
    const { calls, run } = recorder((args) =>
      args[1] === "list" ? json([{ name: "CLOUDFLARE_ACCOUNT_ID" }]) : { exitCode: 0, stdout: "" },
    );
    const forge = githubForge(target, run);
    expect([...forge.secretNames()]).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
    forge.installSecret("CLOUDFLARE_API_TOKEN", value);
    expect(calls.at(-1)).toEqual({
      command: "gh",
      args: [
        "secret",
        "set",
        "CLOUDFLARE_API_TOKEN",
        "--repo",
        "github.com/owner/fixture",
        "--app",
        "actions",
      ],
      input: value,
    });
  });

  it("reports an unauthenticated CLI", () => {
    const { run } = recorder(() => ({ exitCode: 1, stdout: "" }));
    expect(() => githubForge(target, run).ensureReady()).toThrow(/authentication is not ready/);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-ci-cli-"));
  const log = join(dir, "calls.jsonl");
  const script = join(import.meta.dirname, "bootstrap-ci.ts");
  // A fake `gh` that records whether Cloudflare credentials reached its environment.
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), leaked: Object.keys(process.env).some((k) => k.startsWith("CLOUDFLARE_")) }) + "\\n");
if (process.argv[3] === "list") console.log(process.env.FIXTURE_EMPTY ? "[]" : JSON.stringify([{ name: "CLOUDFLARE_ACCOUNT_ID" }, { name: "CLOUDFLARE_API_TOKEN" }]));
`,
  );
  chmodSync(join(dir, "gh"), 0o700);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("bun", [script, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CLOUDFLARE_EMAIL: "",
        CLOUDFLARE_API_KEY: key,
        CLOUDFLARE_API_TOKEN: value,
        CLOUDFLARE_ACCOUNT_ID: "",
        ...extra,
      },
    });

  it("prints help naming the configured target and flags", () => {
    const out = run(["--help"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("--rotate");
    expect(out.stdout).toContain(`${CONFIG.forge.host}/${CONFIG.forge.repo}`);
  });

  it.each(["0", "366", "90.5", "not-a-number"])("rejects a lifetime of %s", (days) => {
    const out = run(["--days", days]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("Token lifetime");
  });

  it("rejects unknown arguments without echoing them", () => {
    const out = run([`--unknown=${key}`]);
    expect(out.status).toBe(1);
    expect(out.stderr.trim()).toBe(
      "Invalid bootstrap:ci arguments; use --help. Argument values withheld.",
    );
  });

  it("leaves configured secrets alone and keeps Cloudflare credentials out of the forge CLI", () => {
    const out = run([]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("already exist");
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.leaked)).toEqual(calls.map(() => false));
    expect(includes(out.stdout + out.stderr, key)).toBe(false);
  });

  it("requires a terminal when credentials are missing", () => {
    const out = run([], { FIXTURE_EMPTY: "1" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("interactive terminal");
    expect(includes(out.stdout + out.stderr, key)).toBe(false);
  });
});
