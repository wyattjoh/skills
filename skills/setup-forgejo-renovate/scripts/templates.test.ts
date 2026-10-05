import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const skillRoot = resolve(import.meta.dir, "..");
const templateRoot = join(skillRoot, "references", "templates");
const temporaryRoots: string[] = [];
const bindings: Record<string, string> = {
  FORGEJO_ORIGIN: "https://forgejo.example",
  REPOSITORY: "team/rust-project",
  DEFAULT_BRANCH: "develop",
  AUTHORIZED_ACTOR: "maintainer",
  BOT_LOGIN: "dependency-bot",
  RUNNER_LABEL: "ubuntu-latest",
  TIMEZONE: "Etc/UTC",
  WEEKLY_CRON: "37 4 * * 1",
};

function render(name: string, values = bindings): string {
  const template = readFileSync(join(templateRoot, name), "utf8");
  return template.replace(/__([A-Z][A-Z0-9_]*)__/g, (_, marker: string) => {
    const value = values[marker];
    if (value === undefined) throw new Error(`Missing template binding: ${marker}`);
    return value;
  });
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "forgejo-renovate-template-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".forgejo", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, ".forgejo", "workflows", "renovate.yml"), render("renovate.yml"));
  writeFileSync(join(root, "renovate.json5"), render("renovate.json5"));
  writeFileSync(
    join(root, "scripts", "renovate-workflow.test.ts"),
    render("renovate-workflow.test.ts.txt"),
  );
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("skill metadata stays user-invoked and all direct reference links resolve", () => {
  const source = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(Boolean(frontmatter)).toBe(true);
  const metadata = Bun.YAML.parse(frontmatter![1]) as Record<string, unknown>;
  expect(metadata.name).toBe("setup-forgejo-renovate");
  expect(metadata["disable-model-invocation"]).toBe(true);
  const codex = Bun.YAML.parse(readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8")) as {
    policy: { allow_implicit_invocation: boolean };
  };
  expect(codex.policy.allow_implicit_invocation).toBe(false);
  const links = [...source.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  expect(links.length).toBe(6);
  for (const link of links) expect(existsSync(join(skillRoot, link))).toBe(true);
});

test("workflow bindings reach endpoint, identity, branch, schedule, and runner data", () => {
  const source = render("renovate.yml");
  expect(source.match(/__[A-Z][A-Z0-9_]*__/g)).toBeNull();
  const workflow = Bun.YAML.parse(source) as {
    on: {
      schedule: { cron: string; timezone: string }[];
      pull_request_target: { types: string[]; branches: string[] };
    };
    permissions: Record<string, never>;
    jobs: {
      renovate: {
        if: string;
        "runs-on": string;
        env: Record<string, string>;
        steps: { run: string }[];
      };
    };
  };
  expect(workflow.on.schedule).toEqual([
    { cron: bindings.WEEKLY_CRON, timezone: bindings.TIMEZONE },
  ]);
  expect(workflow.on.pull_request_target).toEqual({
    types: ["edited"],
    branches: [bindings.DEFAULT_BRANCH],
  });
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.renovate["runs-on"]).toBe(bindings.RUNNER_LABEL);
  expect(workflow.jobs.renovate.env.RENOVATE_ENDPOINT).toBe("https://forgejo.example/api/v1");
  expect(workflow.jobs.renovate.env.RENOVATE_REPOSITORY).toBe(bindings.REPOSITORY);
  expect(workflow.jobs.renovate.env.RENOVATE_TOKEN).toBe("${{ secrets.RENOVATE_TOKEN }}");
  expect(workflow.jobs.renovate.env.RENOVATE_GITHUB_COM_TOKEN).toBe(
    "${{ secrets.RENOVATE_GITHUB_COM_TOKEN }}",
  );
  expect(workflow.jobs.renovate.if.includes("maintainer")).toBe(true);
  expect(workflow.jobs.renovate.if.includes("dependency-bot")).toBe(true);
  expect(workflow.jobs.renovate.steps[0].run.includes('exec renovate "$RENOVATE_REPOSITORY"')).toBe(
    true,
  );
});

test("dependency policy stays review-only and limits managers without universal crate exclusions", () => {
  const source = render("renovate.json5");
  // Evaluate only our trusted static template, not an external repository's config.
  const config = JSON.parse(
    JSON.stringify(runInNewContext(`(${source})`, {}, { timeout: 100 })),
  ) as {
    enabledManagers: string[];
    automerge: boolean;
    timezone: string;
    lockFileMaintenance: { enabled: boolean };
    packageRules: { matchManagers: string[] }[];
  };
  expect(config.enabledManagers).toEqual(["cargo", "github-actions"]);
  expect(config.automerge).toBe(false);
  expect(config.lockFileMaintenance.enabled).toBe(false);
  expect(config.timezone).toBe(bindings.TIMEZONE);
  expect(config.packageRules.map((rule) => rule.matchManagers)).toEqual([
    ["cargo"],
    ["cargo"],
    ["github-actions"],
  ]);
});

test("copyable regression tests pass for a differently named forge, bot, maintainer, and default branch", () => {
  const root = fixture();
  const result = spawnSync(process.execPath, ["test", "./scripts/renovate-workflow.test.ts"], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 10_000, // Pure event fixtures need seconds, not the runner's model/build budget.
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stderr.includes("6 pass")).toBe(true);
  expect(result.stderr.includes("0 fail")).toBe(true);
});

test("a missing binding fails explicitly rather than producing a partial template", () => {
  expect(() => render("renovate.yml", {})).toThrow("Missing template binding: WEEKLY_CRON");
});
