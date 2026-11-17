#!/usr/bin/env bun
import { Command, Option } from "commander";
import { Cause, Effect, Exit } from "effect";
import { loadConfig, type Config } from "./lib/config.ts";
import { Refused, resolveDomain } from "./lib/fleet.ts";
import type { FirstMessage, Harness, ImplementSkill } from "./lib/harness.ts";
import { delegate, endDelegate, listIdle, resumeDelegate, sendTo, start } from "./lib/lifecycle.ts";
import { Proc } from "./lib/proc.ts";
import { domainRepos, domainStatus } from "./lib/status.ts";
import { context, pruneBranches, pruneEnded, removeMany, renderRows, report } from "./lib/sweep.ts";
import { mainCheckout } from "./lib/git.ts";
import { resolve } from "node:path";

/**
 * Run one command at the CLI boundary: print its lines, exit 0; a `Refused` exits 1; anything else exits 2.
 * @param build The command, given the config.
 */
const main = async <E extends { message: string }>(
  build: (config: Config) => Effect.Effect<readonly string[], E, Proc>,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    loadConfig().pipe(Effect.flatMap(build), Effect.provide(Proc.layer)),
  );
  if (Exit.isSuccess(exit)) {
    if (exit.value.length > 0) console.log(exit.value.join("\n"));
    return;
  }
  const failure: { message: string } | undefined = exit.cause.reasons.find(
    Cause.isFailReason,
  )?.error;
  if (failure instanceof Refused) {
    console.error(`refused: ${failure.message}`);
    process.exit(1);
  }
  console.error(
    `could not check: ${failure ? `${failure.constructor.name}: ${failure.message}` : Cause.pretty(exit.cause)}`,
  );
  process.exit(2);
};

const program = new Command("coordinate")
  .description(
    "Coordinate one domain's delegates in Herdr. Exit 0 done, 1 refused (act on the message), 2 could not check.",
  )
  .showHelpAfterError();

program
  .command("start")
  .argument("<domain>", "domain name, also the backlog's file name")
  .description(
    "label this terminal as the domain's coordinator, create the backlog if missing, then print status",
  )
  .action((domain: string) =>
    main((config) =>
      Effect.gen(function* () {
        const lines = [...(yield* start(config, domain))];
        lines.push("", ...(yield* domainStatus(config, domain, false, Date.now())));
        lines.push(
          "",
          "sweep:",
          ...renderRows(
            yield* report(config, yield* domainRepos(config, domain), {
              bases: [],
              keep: [],
              sizes: false,
              nowMs: Date.now(),
            }),
          ),
        );
        lines.push("", ...(yield* listIdle(config, domain, Date.now())));
        return lines;
      }),
    ),
  );

program
  .command("delegate")
  .argument("<name>", "terminal and session name (a-z 0-9 - _), also the worktree folder")
  .requiredOption("--task <task>", "a few words; the tab label")
  .option(
    "--repo <path>",
    "repository: creates <repo>/.claude/worktrees/<name> on <branch_prefix><name>",
  )
  .option("--cwd <path>", "folder for work with no repo (no worktree is made)")
  .option("--base <ref>", "base for the new branch (default: the main checkout's branch)")
  .addOption(
    new Option("--harness <harness>", "agent harness")
      .choices(["pi", "claude"])
      .makeOptionMandatory(),
  )
  .option("--model <model>", "model (pi: provider/id; claude: opus, sonnet, ...)")
  .option("--effort <level>", "claude --effort, or pi --thinking")
  .option("--brief <path>", "brief to copy to <worktree>/.scratch/BRIEF.md")
  .addOption(
    new Option("--skill <skill>", "start with an implement skill instead of a brief").choices([
      "implement",
      "implement-spec",
    ]),
  )
  .option("--args <text>", "arguments after the skill prefix", "")
  .option("--no-space", "open a tab in the coordinator's space instead of a new space")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .description(
    "create the worktree, start a pi or Claude Code delegate in its own Herdr space, print its handle",
  )
  .action(
    (
      name: string,
      options: {
        task: string;
        repo?: string;
        cwd?: string;
        base?: string;
        harness: Harness;
        model?: string;
        effort?: string;
        brief?: string;
        skill?: ImplementSkill;
        args: string;
        space: boolean;
        domain?: string;
      },
    ) => {
      if ((options.brief === undefined) === (options.skill === undefined)) {
        console.error(
          "refused: pass exactly one of --brief <path> or --skill <implement|implement-spec>",
        );
        process.exit(1);
      }
      const message: FirstMessage =
        options.skill === undefined
          ? { kind: "brief", path: options.brief ?? "" }
          : { kind: "skill", skill: options.skill, args: options.args };
      return main((config) =>
        delegate(config, {
          name,
          task: options.task,
          repo: options.repo,
          cwd: options.cwd,
          base: options.base,
          harness: options.harness,
          model: options.model,
          effort: options.effort,
          message,
          space: options.space,
          domain: options.domain,
        }),
      );
    },
  );

program
  .command("send")
  .argument("<target>", "delegate name or address")
  .argument("<text>", "message")
  .description(
    "send a delegate a message; refuses a terminal blocked on a dialog, waits for the user's draft",
  )
  .action((target: string, text: string) => main(() => sendTo(target, text)));

program
  .command("end")
  .argument("[target]", "delegate name or address")
  .option("--now", "end it even while working")
  .option("--list-idle", "list delegates settled for quiet_hours, each with its end command")
  .option("--domain <domain>", "domain for --list-idle (default: this coordinator's label)")
  .description("end a settled delegate, keeping its worktree, branch and session for resume")
  .action(
    (target: string | undefined, options: { now?: boolean; listIdle?: boolean; domain?: string }) =>
      main((config) => {
        if (options.listIdle)
          return Effect.flatMap(resolveDomain(options.domain), (domain) =>
            listIdle(config, domain, Date.now()),
          );
        if (!target) return Effect.succeed(["give a delegate name, or --list-idle"]);
        return endDelegate(config, target, options.now === true);
      }),
  );

program
  .command("resume")
  .argument("<name>", "ended delegate's name")
  .option("--space", "give it its own space")
  .option("--no-space", "open it as a tab in the coordinator's space")
  .description("start an ended delegate's session again, same name, labels and session id")
  .action((name: string, options: { space?: boolean }) =>
    main((config) => resumeDelegate(config, name, options.space)),
  );

program
  .command("status")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--resume", "also print the backlog's Open section and the watcher state")
  .description("delegates, ended delegates and PRs (GitHub and Forgejo), with who acts next")
  .action((options: { domain?: string; resume?: boolean }) =>
    main((config) =>
      Effect.flatMap(resolveDomain(options.domain), (domain) =>
        domainStatus(config, domain, options.resume === true, Date.now()),
      ),
    ),
  );

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/**
 * Main checkouts from explicit paths, else the domain's repos.
 * @param paths Paths given on the command line.
 * @param domain `--domain`.
 * @param config Config.
 * @returns Main checkouts.
 */
const reposFor = (paths: readonly string[], domain: string | undefined, config: Config) =>
  Effect.gen(function* () {
    if (paths.length === 0) return yield* domainRepos(config, yield* resolveDomain(domain));
    const repos: string[] = [];
    for (const path of paths) {
      const checkout = yield* mainCheckout(resolve(path));
      if (checkout && !repos.includes(checkout)) repos.push(checkout);
      if (!checkout) return yield* new Refused({ message: `${path} is not a Git checkout` });
    }
    return repos;
  });

const sweep = program
  .command("sweep")
  .description("find finished worktrees, branches and records, and remove the safe ones");

sweep
  .command("report")
  .argument("[repos...]", "checkouts (default: the domain's repos)")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--base <ref>", "extra base ref (repeatable)", collect, [])
  .option("--keep <path>", "folder never removed (repeatable)", collect, [])
  .option("--sizes", "show sizes of non-KEEP worktrees")
  .description("one verdict per item, changing nothing: SAFE, CLOSE, ASK, KEEP, INFO")
  .action(
    (
      repos: string[],
      options: { domain?: string; base: string[]; keep: string[]; sizes?: boolean },
    ) =>
      main((config) =>
        Effect.gen(function* () {
          const found = yield* reposFor(repos, options.domain, config);
          return renderRows(
            yield* report(config, found, {
              bases: options.base,
              keep: options.keep,
              sizes: options.sizes === true,
              nowMs: Date.now(),
            }),
          );
        }),
      ),
  );

sweep
  .command("remove")
  .argument("[worktrees...]", "worktrees to remove")
  .option("--all-safe", "remove every SAFE worktree of the domain's repos (or --repo)")
  .option("--repo <path>", "repo for --all-safe (repeatable)", collect, [])
  .option("--domain <domain>", "domain for --all-safe")
  .option("--base <ref>", "extra base ref (repeatable)", collect, [])
  .description(
    "re-check each worktree and remove it only when SAFE: park .scratch/, drop the rest, git branch -d",
  )
  .action(
    (
      paths: string[],
      options: { allSafe?: boolean; repo: string[]; domain?: string; base: string[] },
    ) =>
      main((config) =>
        Effect.gen(function* () {
          const targets = paths.map((path) => resolve(path));
          const repos: string[] = [];
          for (const path of targets) {
            const repo = yield* mainCheckout(path);
            if (repo && !repos.includes(repo)) repos.push(repo);
          }
          if (options.allSafe)
            for (const repo of yield* reposFor(options.repo, options.domain, config))
              if (!repos.includes(repo)) repos.push(repo);
          const ctx = yield* context(config, repos, options.base, []);
          if (options.allSafe) {
            const rows = yield* report(config, repos, {
              bases: options.base,
              keep: [],
              sizes: false,
              nowMs: Date.now(),
            });
            for (const row of rows)
              if (
                row.verdict === "SAFE" &&
                row.text.startsWith("worktree ") &&
                row.path &&
                !targets.includes(row.path)
              )
                targets.push(row.path);
          }
          if (targets.length === 0) return ["no worktree to remove"];
          return yield* removeMany(config, targets, ctx);
        }),
      ),
  );

sweep
  .command("prune-branches")
  .argument("<repo>", "checkout")
  .argument("[branches...]", "landed branches to delete with git branch -d")
  .option("--list", "list landed branches")
  .option("--base <ref>", "extra base ref (repeatable)", collect, [])
  .description("list or delete local branches whose work is on a base or whose PR merged")
  .action((repoPath: string, branches: string[], options: { list?: boolean; base: string[] }) =>
    main((config) =>
      Effect.gen(function* () {
        const [repo] = yield* reposFor([repoPath], undefined, config);
        const ctx = yield* context(config, [repo ?? repoPath], options.base, []);
        return yield* pruneBranches(
          repo ?? repoPath,
          branches,
          options.list === true || branches.length === 0,
          ctx,
        );
      }),
    ),
  );

sweep
  .command("prune-ended")
  .description("delete ended-delegate records whose worktree folder is gone")
  .action(() => main((config) => pruneEnded(config)));

await program.parseAsync();
