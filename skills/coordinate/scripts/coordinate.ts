#!/usr/bin/env bun
import { Command, Option } from "commander";
import { Cause, Effect, Exit } from "effect";
import {
  boundaryAdd,
  boundaryRm,
  findingAdd,
  findingClose,
  focusSet,
  itemAdd,
  itemClose,
  itemUpdate,
  showBacklog,
  standingAdd,
} from "./lib/backlog-doc.ts";
import { ITEM_STATUSES, type ItemStatus } from "./lib/backlog-store/schema.ts";
import { loadConfig, type Config } from "./lib/config.ts";
import {
  answerDomain,
  coordinatorDomain,
  domainOfCaller,
  Refused,
  resolveDomain,
} from "./lib/fleet.ts";
import type { FirstMessage, Harness, ImplementSkill } from "./lib/harness.ts";
import { attachDelegate, detachDelegate } from "./lib/attach.ts";
import { watcherBanner } from "./lib/banner.ts";
import {
  delegate,
  endDelegate,
  listIdle,
  NEXT_STATUSES,
  notifyCoordinator,
  resumeDelegate,
  sendTo,
  start,
} from "./lib/lifecycle.ts";
import { Proc } from "./lib/proc.ts";
import { domainRepos, domainStatus } from "./lib/status.ts";
import { renameDomain } from "./lib/rename.ts";
import { watch } from "./lib/watch.ts";
import { context, pruneBranches, pruneEnded, removeMany, renderRows, report } from "./lib/sweep.ts";
import { mainCheckout } from "./lib/git.ts";
import { resolve } from "node:path";

/**
 * Run one command at the CLI boundary: print its lines, exit 0; a `Refused` exits 1; anything else exits 2.
 * From a coordinator's terminal it first prints the watcher-down banner to stderr, whatever the
 * outcome, unless `banner` is false (`watch`, `item answer`, and `status`, which prints it itself).
 * @param build The command, given the config.
 * @param banner Check for the watcher-down banner.
 */
const main = async <E extends { message: string }>(
  build: (config: Config) => Effect.Effect<readonly string[], E, Proc>,
  banner = true,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    loadConfig().pipe(
      Effect.flatMap((config) =>
        build(config).pipe(
          Effect.ensuring(
            banner
              ? Effect.map(watcherBanner(config), (line) => {
                  if (line) console.error(line);
                })
              : Effect.void,
          ),
        ),
      ),
      Effect.provide(Proc.layer),
    ),
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
    "label this terminal as the domain's coordinator, create the backlog document if missing, then print status",
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
  .option(
    "--item <id>",
    "item to file the delegate under (required from a coordinator, refused from a delegate)",
  )
  .description(
    "create the worktree, start a pi or Claude Code delegate in its own Herdr space, record it on the item",
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
        item?: string;
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
          item: options.item,
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
  .command("notify")
  .argument("<text>", 'one line, such as "<name>: done, report at <path>"')
  .description(
    "from a delegate: wake its coordinator with one line, as send does; with no live coordinator, prints and exits 0",
  )
  .action((text: string) => main(() => notifyCoordinator(text)));

program
  .command("end")
  .argument("[target]", "delegate name or address")
  .option("--now", "end it even while working")
  .addOption(
    new Option(
      "--item-status <status>",
      "when it was the item's last live delegate, set the item's next status",
    ).choices(NEXT_STATUSES),
  )
  .option("--list-idle", "list delegates settled for quiet_hours, each with its end command")
  .option("--domain <domain>", "domain for --list-idle (default: this coordinator's label)")
  .description("end a settled delegate, keeping its worktree, branch and session for resume")
  .action(
    (
      target: string | undefined,
      options: { now?: boolean; listIdle?: boolean; domain?: string; itemStatus?: ItemStatus },
    ) =>
      main((config) => {
        if (options.listIdle)
          return Effect.flatMap(resolveDomain(options.domain), (domain) =>
            listIdle(config, domain, Date.now()),
          );
        if (!target) return Effect.succeed(["give a delegate name, or --list-idle"]);
        return endDelegate(config, target, options.now === true, options.itemStatus);
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
  .option("--resume", "also print the rendered backlog and the watcher state")
  .description("delegates, ended delegates and PRs (GitHub and Forgejo), with who acts next")
  .action((options: { domain?: string; resume?: boolean }) =>
    main(
      (config) =>
        Effect.gen(function* () {
          const domain = yield* resolveDomain(options.domain);
          const lines = yield* domainStatus(config, domain, options.resume === true, Date.now());
          const line = yield* watcherBanner(config);
          return line ? [line, ...lines] : lines;
        }),
      false,
    ),
  );

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const backlog = program
  .command("backlog")
  .description("read and edit the domain's structured backlog (the CLI is its only writer)");

backlog
  .command("show")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the document instead of Markdown")
  .description("render the backlog as Markdown, including the legacy Markdown pointer")
  .action((options: { domain?: string; json?: boolean }) =>
    main((config) =>
      Effect.flatMap(resolveDomain(options.domain), (domain) =>
        showBacklog(config, domain, options.json === true),
      ),
    ),
  );

backlog
  .command("rename")
  .argument("<new>", "new domain name (lowercase letters, digits, . _ -)")
  .option("--domain <domain>", "domain to rename (default: this coordinator's label)")
  .option("--json", "print what moved as JSON")
  .description(
    "rename the domain: its backlog, archive, watcher snapshot, ended-delegate records and fleet.domain labels; refused while it has a live delegate or watcher",
  )
  .action((to: string, options: { domain?: string; json?: boolean }) =>
    main((config) =>
      renameDomain(config, { to, domain: options.domain, json: options.json === true }),
    ),
  );

const boundary = backlog
  .command("boundary")
  .description(
    "owned and adjacent repos and folders; only owned ones feed status, watch and sweep",
  );

for (const [verb, run, help] of [
  ["add", boundaryAdd, "add an existing path (~ expands) to the owned Boundary, or --adjacent"],
  ["rm", boundaryRm, "remove a path from the owned Boundary, or --adjacent"],
] as const)
  boundary
    .command(verb)
    .argument("<path>", "repo or folder path")
    .option("--adjacent", "the adjacent list: read freely, change only with the user's yes")
    .option("--domain <domain>", "domain (default: this coordinator's label)")
    .option("--json", "print the Boundary as JSON")
    .description(help)
    .action((path: string, options: { adjacent?: boolean; domain?: string; json?: boolean }) =>
      main((config) =>
        Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
          run(config, domain, {
            path,
            adjacent: options.adjacent === true,
            json: options.json === true,
          }),
        ),
      ),
    );

backlog
  .command("standing")
  .description("standing approvals, in the user's words")
  .command("add")
  .argument("<text>", "the approval, verbatim, on one line")
  .option("--at <date>", "date it was given, YYYY-MM-DD (default: today)")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the entry as JSON")
  .description("record a standing yes with its date")
  .action((text: string, options: { at?: string; domain?: string; json?: boolean }) =>
    main((config) =>
      Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
        standingAdd(config, domain, {
          text,
          at: options.at,
          json: options.json === true,
          now: new Date().toISOString(),
        }),
      ),
    ),
  );

backlog
  .command("focus")
  .argument("[text]", "one line on what the domain is doing now")
  .option("--clear", "clear the focus line")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the focus as JSON")
  .description("set the domain's focus line, or clear it with --clear")
  .action(
    (text: string | undefined, options: { clear?: boolean; domain?: string; json?: boolean }) => {
      if ((text === undefined) === (options.clear !== true)) {
        console.error("refused: pass exactly one of <text> or --clear");
        process.exit(1);
      }
      return main((config) =>
        Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
          focusSet(config, domain, { focus: text ?? null, json: options.json === true }),
        ),
      );
    },
  );

const item = program.command("item").description("add, update and close backlog items");

item
  .command("add")
  .argument("<title>", "one-line title")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the new item as JSON")
  .description("add an open item; prints its short id (i1, i2, ...)")
  .action((title: string, options: { domain?: string; json?: boolean }) =>
    main((config) =>
      Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
        itemAdd(config, domain, {
          title,
          json: options.json === true,
          now: new Date().toISOString(),
        }),
      ),
    ),
  );

item
  .command("update")
  .argument("<id>", "item id, such as i3")
  .addOption(new Option("--status <status>", "set the status").choices(ITEM_STATUSES))
  .option("--outcome <text>", "one line on how it ended (with --status done or dismissed)")
  .option("--decided <text>", "append a decision, dated today (repeatable)", collect, [])
  .option("--touch <repo>", "record a repo the item touches (repeatable)", collect, [])
  .option("--untouch <repo>", "remove a touched repo (repeatable)", collect, [])
  .option("--due <date>", "due date, YYYY-MM-DD")
  .option("--no-due", "clear the due date")
  .option("--ask <question>", "attach a question for the user, replacing any ask")
  .option("--context <text>", "why the ask is asked (with --ask)")
  .option("--option <text>", "an answer choice (with --ask, repeatable)", collect, [])
  .option("--rec <option>", "the recommended option, one of --option (with --ask)")
  .option("--why <reason>", "why the recommended option (with --rec)")
  .option("--answer <text>", "the user's answer: clears the ask and appends it as a decision")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the updated item as JSON")
  .description(
    "change an item's status, decisions, touched repos, due date or ask; waiting-user needs an ask or a decision, delegated needs a delegate",
  )
  .action(
    (
      id: string,
      options: {
        status?: ItemStatus;
        outcome?: string;
        decided: string[];
        touch: string[];
        untouch: string[];
        due?: string | false;
        ask?: string;
        context?: string;
        option: string[];
        rec?: string;
        why?: string;
        answer?: string;
        domain?: string;
        json?: boolean;
      },
    ) =>
      main((config) =>
        Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
          itemUpdate(config, domain, {
            id,
            status: options.status,
            outcome: options.outcome,
            decided: options.decided,
            touch: options.touch,
            untouch: options.untouch,
            due: options.due === false ? null : options.due,
            ask: options.ask,
            context: options.context,
            options: options.option,
            rec: options.rec,
            why: options.why,
            answer: options.answer,
            json: options.json === true,
            now: new Date().toISOString(),
          }),
        ),
      ),
  );

item
  .command("answer")
  .argument("<id>", "item id, such as i3")
  .argument(
    "<answer>",
    "the user's answer, one line (put -- before the arguments if it starts with -)",
  )
  .option(
    "--domain <domain>",
    "domain (default: this coordinator's label; required outside a terminal)",
  )
  .option("--json", "print the updated item as JSON")
  .description(
    "record the user's answer to an item's ask, as item update --answer does; the one change allowed outside a Herdr terminal, such as from the Backlog panel",
  )
  .action((id: string, answer: string, options: { domain?: string; json?: boolean }) =>
    main(
      (config) =>
        Effect.flatMap(answerDomain(options.domain), (domain) =>
          itemUpdate(config, domain, {
            id,
            status: undefined,
            outcome: undefined,
            decided: [],
            touch: [],
            untouch: [],
            due: undefined,
            ask: undefined,
            context: undefined,
            options: [],
            rec: undefined,
            why: undefined,
            answer,
            json: options.json === true,
            now: new Date().toISOString(),
          }),
        ),
      false,
    ),
  );

item
  .command("close")
  .argument("<id>", "item id, such as i3")
  .option("--outcome <text>", "one line on how it ended (required)", "")
  .option("--dismissed", "close as dismissed instead of done")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the closed item as JSON")
  .description("close an item as done (or dismissed) with an outcome")
  .action(
    (
      id: string,
      options: { outcome: string; dismissed?: boolean; domain?: string; json?: boolean },
    ) =>
      main((config) =>
        Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
          itemClose(config, domain, {
            id,
            outcome: options.outcome,
            dismissed: options.dismissed === true,
            json: options.json === true,
            now: new Date().toISOString(),
          }),
        ),
      ),
  );

const delegateArgument = [
  "<delegate>",
  "delegate name or Herdr terminal address (detach also takes a session id)",
] as const;

item
  .command("attach")
  .argument("<id>", "item id, such as i3")
  .argument(...delegateArgument)
  .option(
    "--session <id>",
    "the agent's session id, when Herdr sees none (Claude Code shows it in /status)",
  )
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the updated item as JSON")
  .description(
    "file an already-running agent session under an item, as delegate --item would; labels a hand-started one so status, watch, end and resume track it",
  )
  .action(
    (id: string, target: string, options: { session?: string; domain?: string; json?: boolean }) =>
      main((config) =>
        attachDelegate(config, {
          id,
          target,
          domain: options.domain,
          json: options.json === true,
          session: options.session,
        }),
      ),
  );

item
  .command("detach")
  .argument("<id>", "item id, such as i3")
  .argument(...delegateArgument)
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the updated item as JSON")
  .description("remove a delegate from an item; an item left with no delegates goes back to open")
  .action((id: string, target: string, options: { domain?: string; json?: boolean }) =>
    main((config) =>
      detachDelegate(config, {
        id,
        target,
        domain: options.domain,
        json: options.json === true,
        session: undefined,
      }),
    ),
  );

const finding = program
  .command("finding")
  .description("record and close issues and opportunities noticed outside an item's scope");

finding
  .command("add")
  .argument("<title>", "one-line title")
  .addOption(
    new Option("--kind <kind>", "what was noticed")
      .choices(["issue", "opportunity"])
      .makeOptionMandatory(),
  )
  .option("--detail <text>", "more detail")
  .option("--path <path>", "file or folder it concerns")
  .option("--from <item>", "item it was noticed while working on, such as i3")
  .option(
    "--domain <domain>",
    "domain (default: this terminal's fleet.domain label, coordinator or delegate)",
  )
  .option("--json", "print the new finding as JSON")
  .description("add an open finding; delegates may run this. Prints its short id (f1, f2, ...)")
  .action(
    (
      title: string,
      options: {
        kind: "issue" | "opportunity";
        detail?: string;
        path?: string;
        from?: string;
        domain?: string;
        json?: boolean;
      },
    ) =>
      main((config) =>
        Effect.flatMap(domainOfCaller(options.domain), (domain) =>
          findingAdd(config, domain, {
            kind: options.kind,
            title,
            detail: options.detail,
            path: options.path,
            from: options.from,
            json: options.json === true,
          }),
        ),
      ),
  );

finding
  .command("close")
  .argument("<id>", "finding id, such as f2")
  .option("--outcome <text>", "one line on what was done (required)", "")
  .option("--dismissed", "close as dismissed instead of acted")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--json", "print the closed finding as JSON")
  .description("close a finding as acted (or dismissed) with an outcome")
  .action(
    (
      id: string,
      options: { outcome: string; dismissed?: boolean; domain?: string; json?: boolean },
    ) =>
      main((config) =>
        Effect.flatMap(coordinatorDomain(options.domain), (domain) =>
          findingClose(config, domain, {
            id,
            outcome: options.outcome,
            dismissed: options.dismissed === true,
            json: options.json === true,
            now: new Date().toISOString(),
          }),
        ),
      ),
  );

program
  .command("watch")
  .option("--domain <domain>", "domain (default: this coordinator's label)")
  .option("--interval <seconds>", "herdr-core poll interval", "5")
  .option("--forge-interval <seconds>", "GitHub/Forgejo and due-date poll interval", "90")
  .option(
    "--max-minutes <minutes>",
    "exit with an alive line after this long without events",
    "110",
  )
  .option("--replace", "stop a running watcher for the domain and take over")
  .option(
    "--follow",
    "keep running and print each event line as it happens (no alive line, no time limit); exits after blind or owner gone",
  )
  .description(
    "wait until a delegate settles, blocks, errors or goes, a PR merges, closes, fails checks or gets a review, a due date arrives or an ask is answered; print one line per event and exit (or keep printing with --follow)",
  )
  .action(
    (options: {
      domain?: string;
      interval: string;
      forgeInterval: string;
      maxMinutes: string;
      replace?: boolean;
      follow?: boolean;
    }) =>
      main(
        (config) =>
          Effect.flatMap(resolveDomain(options.domain), (domain) =>
            watch(config, {
              domain,
              intervalMs: Number(options.interval) * 1000,
              forgeIntervalMs: Number(options.forgeInterval) * 1000,
              maxMs: Number(options.maxMinutes) * 60_000,
              owner: process.env.HC_TERMINAL_ID,
              replace: options.replace === true,
              today: () => new Date().toISOString().slice(0, 10),
              follow: options.follow === true,
              emit: (line) => console.log(line),
            }),
          ),
        false,
      ),
  );

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
