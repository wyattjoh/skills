import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  addFinding,
  addPolicy,
  closeFinding,
  closeItem,
  emptyBacklog,
  replacePolicy,
  setFocus,
  updateItem,
  type ItemUpdate,
} from "./backlog-store/ops.ts";
import { renderBacklog } from "./backlog-store/render.ts";
import { prose, validateBacklog, type Backlog, type Item } from "./backlog-store/schema.ts";
import { resolveConfig } from "./config.ts";
import { cliEnv, runWith, tempDir } from "./fixture.ts";
import { start } from "./lifecycle.ts";
import { fakeProc, ok } from "./proc.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const made of dirs) rmSync(made, { recursive: true, force: true });
});
const NOW = "2026-11-23T10:00:00.000Z";

const item = (fields: Partial<Item> = {}): Item => ({
  id: "i1",
  title: "pick a store",
  status: "open",
  touches: [],
  decided: [],
  ask: null,
  answered: [],
  due: null,
  delegates: [],
  createdAt: NOW,
  closedAt: null,
  outcome: null,
  ...fields,
});
const doc = (items: Item[] = [item()]): Backlog => ({
  ...emptyBacklog("app", null),
  items,
  nextId: items.length + 1,
});
const update = (fields: Partial<ItemUpdate>): ItemUpdate => ({
  id: "i1",
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
  answer: undefined,
  now: NOW,
  ...fields,
});
const reason = (result: { ok: true } | { ok: false; reason: string }): string =>
  result.ok ? "ok" : result.reason;
const ask = {
  questionMarkdown: "Which `store`?",
  context: null,
  contextMarkdown: "We need **one**.",
  options: ["json", "sqlite"],
  rec: "json",
  recReason: null,
  discuss: null,
};

describe("prose", () => {
  it("prefers the Markdown sibling, then the text, then nothing", () => {
    expect(prose("plain", "**md**")).toEqual({ markdown: true, value: "**md**" });
    expect(prose("plain", undefined)).toEqual({ markdown: false, value: "plain" });
    expect(prose(null, undefined)).toBe(null);
  });
});

describe("Markdown siblings in item update", () => {
  it("writes each Markdown flag to its sibling and leaves the text field empty", () => {
    const asked = updateItem(
      doc(),
      update({
        status: "waiting-user",
        askMarkdown: "Which `store`?",
        contextMarkdown: "We need **one**.\n\n- fast\n- local",
        optionsMarkdown: ["json :: Plain `JSON`\n\n- no deps", "sqlite"],
        rec: "json",
        whyMarkdown: "It is _simple_.",
        decidedMarkdown: ["- one\n- two"],
      }),
    );
    if (!asked.ok) throw new Error(asked.reason);
    expect(asked.value.ask).toEqual({
      questionMarkdown: "Which `store`?",
      context: null,
      contextMarkdown: "We need **one**.\n\n- fast\n- local",
      options: ["json", "sqlite"],
      optionDetailsMarkdown: ["Plain `JSON`\n\n- no deps", ""],
      rec: "json",
      recReason: null,
      recReasonMarkdown: "It is _simple_.",
      discuss: null,
    });
    expect(asked.value.decided).toEqual([{ markdown: "- one\n- two", at: "2026-11-23" }]);
    expect(validateBacklog(asked.backlog)).toEqual({ ok: true, backlog: asked.backlog });

    const answered = updateItem(
      asked.backlog,
      update({ answerMarkdown: "use `json` now", noteMarkdown: "because\n\n- safe" }),
    );
    if (!answered.ok) throw new Error(answered.reason);
    expect(
      answered.value.answered.map(({ answer, answerMarkdown, note, noteMarkdown }) => ({
        answer,
        answerMarkdown,
        note,
        noteMarkdown,
      })),
    ).toEqual([
      {
        answer: undefined,
        answerMarkdown: "use `json` now",
        note: null,
        noteMarkdown: "because\n\n- safe",
      },
    ]);
    expect(answered.value.decided.at(-1)).toEqual({
      text: 'Re "Which `store`?": use `json` now. Note: because - safe',
      at: "2026-11-23",
    });

    const closed = updateItem(
      answered.backlog,
      update({ status: "done", outcomeMarkdown: "Shipped.\n\n```sh\nbun test\n```" }),
    );
    if (!closed.ok) throw new Error(closed.reason);
    expect([closed.value.outcome, closed.value.outcomeMarkdown]).toEqual([
      null,
      "Shipped.\n\n```sh\nbun test\n```",
    ]);
    const reopened = updateItem(closed.backlog, update({ status: "open" }));
    if (!reopened.ok) throw new Error(reopened.reason);
    expect([reopened.value.outcome, reopened.value.outcomeMarkdown]).toEqual([null, undefined]);
  });

  it("keeps a Discuss request plain and puts a Markdown note on the discussion", () => {
    const asked = doc([item({ status: "waiting-user", ask })]);
    const discussed = updateItem(
      asked,
      update({ answer: "Discuss: why", noteMarkdown: "- a\n- b" }),
    );
    if (!discussed.ok) throw new Error(discussed.reason);
    expect(discussed.value.ask?.discuss).toEqual({
      note: "",
      noteMarkdown: "why\n\n- a\n- b",
      at: "2026-11-23",
    });
    expect(validateBacklog(discussed.backlog).ok).toBe(true);
    expect(reason(updateItem(asked, update({ answerMarkdown: "Discuss: why" })))).toBe(
      "a Discuss request is plain: pass it with --answer",
    );
    expect(reason(updateItem(asked, update({ answerMarkdown: "json" })))).toBe(
      "json is an option label: pass it with --answer",
    );
  });

  it("refuses a text flag beside its Markdown form, and multi-line inline Markdown", () => {
    const open = doc();
    const asked = doc([item({ status: "waiting-user", ask })]);
    expect(
      [
        updateItem(open, update({ ask: "a", askMarkdown: "b" })),
        updateItem(open, update({ askMarkdown: "a", context: "b", contextMarkdown: "c" })),
        updateItem(open, update({ askMarkdown: "a", options: ["x"], optionsMarkdown: ["y"] })),
        updateItem(
          open,
          update({ askMarkdown: "a", options: ["x"], rec: "x", why: "b", whyMarkdown: "c" }),
        ),
        updateItem(open, update({ status: "done", outcome: "a", outcomeMarkdown: "b" })),
        updateItem(asked, update({ answer: "json", answerMarkdown: "json" })),
        updateItem(asked, update({ answer: "json", note: "a", noteMarkdown: "b" })),
        updateItem(open, update({ askMarkdown: "two\nlines" })),
        updateItem(asked, update({ answerMarkdown: "two\nlines" })),
        updateItem(open, update({ decidedMarkdown: ["  "] })),
        updateItem(open, update({ askMarkdown: "a", optionsMarkdown: ["two\nlines :: detail"] })),
        updateItem(open, update({ contextMarkdown: "c" })),
      ].map(reason),
    ).toEqual([
      "--ask and --ask-md cannot be combined",
      "--context and --context-md cannot be combined",
      "--option and --option-md cannot be combined",
      "--why and --why-md cannot be combined",
      "--outcome and --outcome-md cannot be combined",
      "--answer and --answer-md cannot be combined",
      "--note and --note-md cannot be combined",
      "--ask-md must be one line",
      "--answer-md must be one line",
      "--decided-md is empty",
      "option-md must be one line",
      "--context, --option, --rec and --why need --ask",
    ]);
  });
});

describe("Markdown siblings in the other writes", () => {
  it("writes finding detail and outcome, item close, policies and focus as Markdown", () => {
    const added = addFinding(doc(), {
      kind: "issue",
      title: "slow",
      detail: undefined,
      detailMarkdown: "Takes **9s**.\n\n- cold start",
      path: undefined,
      from: undefined,
      source: undefined,
      now: NOW,
    });
    if (!added.ok) throw new Error(added.reason);
    expect([added.value.detail, added.value.detailMarkdown]).toEqual([
      null,
      "Takes **9s**.\n\n- cold start",
    ]);
    const acted = closeFinding(added.backlog, {
      id: added.value.id,
      outcome: "",
      outcomeMarkdown: "Fixed in `abc123`.",
      dismissed: false,
      now: NOW,
    });
    if (!acted.ok) throw new Error(acted.reason);
    expect([acted.value.outcome, acted.value.outcomeMarkdown]).toEqual([
      null,
      "Fixed in `abc123`.",
    ]);
    const closed = closeItem(acted.backlog, {
      id: "i1",
      outcome: "",
      outcomeMarkdown: "Done:\n\n- a",
      dismissed: false,
      now: NOW,
    });
    if (!closed.ok) throw new Error(closed.reason);
    expect([closed.value.outcome, closed.value.outcomeMarkdown]).toEqual([null, "Done:\n\n- a"]);
    const policy = addPolicy(closed.backlog, {
      text: undefined,
      markdown: "Ship **only** green.",
      at: "2026-11-23",
      wiki: undefined,
    });
    if (!policy.ok) throw new Error(policy.reason);
    expect(policy.value).toEqual({ id: "p1", markdown: "Ship **only** green.", at: "2026-11-23" });
    const replaced = replacePolicy(policy.backlog, { id: "p1", text: "plain", at: "2026-11-24" });
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.value).toEqual({ id: "p1", text: "plain", at: "2026-11-24" });
    const focused = setFocus(replaced.backlog, { focus: null, markdown: "Ship `v2`" });
    if (!focused.ok) throw new Error(focused.reason);
    expect([focused.backlog.focus, focused.backlog.focusMarkdown]).toEqual([null, "Ship `v2`"]);
    const cleared = setFocus(focused.backlog, { focus: null });
    if (!cleared.ok) throw new Error(cleared.reason);
    expect([cleared.backlog.focus, cleared.backlog.focusMarkdown]).toEqual([null, undefined]);
    expect(validateBacklog(focused.backlog).ok).toBe(true);
  });

  it("refuses both forms and multi-line inline focus", () => {
    const finding = {
      kind: "issue" as const,
      title: "slow",
      path: undefined,
      from: undefined,
      source: undefined,
      now: NOW,
    };
    expect(
      [
        addFinding(doc(), { ...finding, detail: "a", detailMarkdown: "b" }),
        closeItem(doc(), {
          id: "i1",
          outcome: "a",
          outcomeMarkdown: "b",
          dismissed: false,
          now: NOW,
        }),
        addPolicy(doc(), { text: "a", markdown: "b", at: "2026-11-23", wiki: undefined }),
        setFocus(doc(), { focus: "a", markdown: "b" }),
        setFocus(doc(), { focus: null, markdown: "two\nlines" }),
      ].map(reason),
    ).toEqual([
      "--detail and --detail-md cannot be combined",
      "--outcome and --outcome-md cannot be combined",
      "pass the policy as text or --md, not both",
      "pass the focus as text or --md, not both",
      "focus must be one line",
    ]);
  });
});

describe("validateBacklog with Markdown siblings", () => {
  it("rejects a record that holds both a text field and its Markdown sibling", () => {
    const closed = item({ status: "done", closedAt: NOW, outcome: "a", outcomeMarkdown: "b" });
    const both = {
      ...doc([
        closed,
        item({
          id: "i2",
          status: "waiting-user",
          decided: [{ text: "a", markdown: "b", at: "2026-11-23" } as never],
          ask: {
            question: "q",
            questionMarkdown: "q",
            context: "c",
            contextMarkdown: "c",
            options: ["x"],
            optionDetails: ["d"],
            optionDetailsMarkdown: ["d"],
            rec: "x",
            recReason: "r",
            recReasonMarkdown: "r",
            discuss: { note: "n", noteMarkdown: "n", at: "2026-11-23" },
          },
          answered: [
            {
              ...ask,
              answer: "a",
              answerMarkdown: "a",
              note: "n",
              noteMarkdown: "n",
              answeredAt: "2026-11-23",
            },
          ],
        }),
      ]),
      focus: "f",
      focusMarkdown: "f",
      policies: [{ id: "p1", text: "t", markdown: "t", at: "2026-11-23" } as never],
      findings: [
        {
          id: "f3",
          kind: "issue" as const,
          title: "t",
          detail: "d",
          detailMarkdown: "d",
          path: null,
          from: null,
          status: "acted" as const,
          closedAt: NOW,
          outcome: "o",
          outcomeMarkdown: "o",
        },
      ],
      nextId: 4,
      nextPolicyId: 2,
    };
    expect(validateBacklog(both)).toEqual({
      ok: false,
      errors: [
        "the document cannot have both focus and focusMarkdown",
        "policies[0] cannot have both text and markdown",
        "items[0] cannot have both outcome and outcomeMarkdown",
        "items[1].decided[0] cannot have both text and markdown",
        "items[1].ask cannot have both question and questionMarkdown",
        "items[1].ask cannot have both context and contextMarkdown",
        "items[1].ask cannot have both optionDetails and optionDetailsMarkdown",
        "items[1].ask cannot have both recReason and recReasonMarkdown",
        "items[1].ask.discuss cannot have both note and noteMarkdown",
        "items[1].answered[0] cannot have both answer and answerMarkdown",
        "items[1].answered[0] cannot have both note and noteMarkdown",
        "findings[0] cannot have both detail and detailMarkdown",
        "findings[0] cannot have both outcome and outcomeMarkdown",
      ],
    });
  });

  it("accepts Markdown in place of required text and rejects multi-line inline Markdown", () => {
    const markdownOnly = doc([
      item({
        status: "done",
        closedAt: NOW,
        outcomeMarkdown: "Done.",
        decided: [{ markdown: "**yes**", at: "2026-11-23" }],
        answered: [{ ...ask, answerMarkdown: "use `x`", note: null, answeredAt: "2026-11-23" }],
      }),
    ]);
    expect(validateBacklog(markdownOnly).ok).toBe(true);
    expect(
      validateBacklog({
        ...markdownOnly,
        focusMarkdown: "two\nlines",
        items: [item({ status: "waiting-user", ask: { ...ask, questionMarkdown: "a\nb" } })],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "the document.focusMarkdown must be one line",
        "items[0].ask.questionMarkdown must be one line",
      ],
    });
  });
});

describe("renderBacklog with Markdown", () => {
  it("indents multi-line Markdown under its bullet and keeps one-line Markdown inline", () => {
    const backlog: Backlog = {
      ...doc([
        item({
          status: "waiting-user",
          ask: {
            ...ask,
            contextMarkdown: "Two parts:\n\n- speed\n- size",
            optionDetailsMarkdown: ["```json\n{}\n```", "one line"],
            recReasonMarkdown: "Simple.\n\nNo deps.",
          },
          decided: [
            { markdown: "## Plan\n\n1. a\n2. b", at: "2026-11-23" },
            { markdown: "**short**", at: "2026-11-23" },
          ],
        }),
        item({
          id: "i2",
          status: "done",
          closedAt: NOW,
          outcomeMarkdown: "Shipped.\n\n- tests green",
        }),
      ]),
      focusMarkdown: "Ship `v2`",
      policies: [
        { id: "p1", markdown: "Green only:\n\n- lint\n- test", at: "2026-11-01", wiki: "ci" },
      ],
      nextPolicyId: 2,
    };
    expect(renderBacklog(backlog, new Set(), true)).toBe(
      [
        "# app backlog",
        "",
        "Focus: Ship `v2`",
        "",
        "## Boundary",
        "",
        "- Owned: (none)",
        "- Adjacent: (none)",
        "",
        "## Policies",
        "",
        "- p1 2026-11-01: (wiki: [[ci]])",
        "",
        "  Green only:",
        "",
        "  - lint",
        "  - test",
        "",
        "## Open",
        "",
        "- i1 [waiting-user] pick a store",
        "  - ask: Which `store`?",
        "    - context:",
        "",
        "      Two parts:",
        "",
        "      - speed",
        "      - size",
        "    - json (recommended)",
        "",
        "      Simple.",
        "",
        "      No deps.",
        "",
        "      ```json",
        "      {}",
        "      ```",
        "    - sqlite: one line",
        "  - decided 2026-11-23:",
        "",
        "    ## Plan",
        "",
        "    1. a",
        "    2. b",
        "  - decided 2026-11-23: **short**",
        "",
        "## Findings",
        "",
        "(none)",
        "",
        "## Done",
        "",
        "- i2 [done 2026-11-23] pick a store:",
        "",
        "  Shipped.",
        "",
        "  - tests green",
        "",
      ].join("\n"),
    );
  });
});

describe("coordinate CLI Markdown flags", () => {
  it("writes each -md flag to its sibling and refuses a flag beside its text form", async () => {
    const state = tempDir();
    dirs.push(state);
    const cfg = await Effect.runPromise(
      resolveConfig({ backlog_dir: join(state, "md"), state_dir: state }, "/c"),
    );
    await runWith(
      start(cfg, "app", { HC_TERMINAL_ID: "t9" }),
      fakeProc((argv) => {
        if (argv[1] === "ls") return ok('{"terminals":[]}');
        if (argv[1] === "get")
          return ok(
            JSON.stringify({
              address: "t9",
              state: "live",
              labels: { "fleet.role": "coordinator", "fleet.domain": "app" },
            }),
          );
        if (argv[1] === "run") return ok('{"address":"t-watch","state":"live"}');
        return ok("{}");
      }).layer,
    );
    const path = join(state, "backlogs", "app.json");
    const env = cliEnv(state, { "fleet.role": "coordinator", "fleet.domain": "app" });
    const script = join(import.meta.dir, "..", "coordinate.ts");
    const run = (...args: string[]) => {
      const done = Bun.spawnSync(["bun", script, ...args, "--domain", "app"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      return [done.exitCode, done.stdout.toString() + done.stderr.toString()];
    };
    const read = (): Backlog => JSON.parse(readFileSync(path, "utf8"));

    expect(run("item", "add", "pick a store")).toEqual([0, "added i1: pick a store\n"]);
    expect(
      run(
        "item",
        "update",
        "i1",
        "--status",
        "waiting-user",
        "--ask-md",
        "Which `store`?",
        "--context-md",
        "- fast\n- local",
        "--option-md",
        "json :: - no deps",
        "--option-md",
        "sqlite",
        "--rec",
        "json",
        "--why-md",
        "**simple**",
        "--decided-md",
        "- one\n- two",
      ),
    ).toEqual([0, "updated i1 [waiting-user] pick a store\n"]);
    expect(read().items[0]?.ask).toEqual({
      questionMarkdown: "Which `store`?",
      context: null,
      contextMarkdown: "- fast\n- local",
      options: ["json", "sqlite"],
      optionDetailsMarkdown: ["- no deps", ""],
      rec: "json",
      recReason: null,
      recReasonMarkdown: "**simple**",
      discuss: null,
    });
    expect(read().items[0]?.decided.map(({ markdown }) => markdown)).toEqual(["- one\n- two"]);
    expect(run("item", "answer", "i1", "json", "--md", "x")).toEqual([
      1,
      "refused: pass exactly one of <answer> or --md\n",
    ]);
    expect(run("item", "answer", "i1", "--md", "use `json`", "--note-md", "- safe")).toEqual([
      0,
      "updated i1 [waiting-user] pick a store\n",
    ]);
    const answered = read().items[0]?.answered[0];
    expect([answered?.answerMarkdown, answered?.note, answered?.noteMarkdown]).toEqual([
      "use `json`",
      null,
      "- safe",
    ]);
    expect(run("item", "close", "i1", "--outcome", "a", "--outcome-md", "b")).toEqual([
      1,
      "refused: --outcome and --outcome-md cannot be combined\n",
    ]);
    expect(run("item", "close", "i1", "--outcome-md", "- shipped")).toEqual([
      0,
      "done i1: - shipped\n",
    ]);
    expect([read().items[0]?.outcome, read().items[0]?.outcomeMarkdown]).toEqual([
      null,
      "- shipped",
    ]);
    expect(run("finding", "add", "slow", "--kind", "issue", "--detail-md", "- 9s")).toEqual([
      0,
      "added f2: slow\n",
    ]);
    expect(run("finding", "close", "f2", "--outcome-md", "**fixed**")).toEqual([
      0,
      "acted f2: **fixed**\n",
    ]);
    expect([read().findings[0]?.detailMarkdown, read().findings[0]?.outcomeMarkdown]).toEqual([
      "- 9s",
      "**fixed**",
    ]);
    expect(run("backlog", "policy", "add", "--md", "- green only", "--at", "2026-11-01")).toEqual([
      0,
      "added policy p1: - green only\n",
    ]);
    expect(run("backlog", "policy", "add", "text", "--md", "md")).toEqual([
      1,
      "refused: pass the policy as text or --md, not both\n",
    ]);
    expect(
      run("backlog", "policy", "replace", "p1", "--md", "**all** green", "--at", "2026-11-02"),
    ).toEqual([0, "replaced policy p1: **all** green\n"]);
    expect(read().policies).toEqual([{ id: "p1", markdown: "**all** green", at: "2026-11-02" }]);
    expect(run("backlog", "focus", "--md", "Ship `v2`")).toEqual([0, "focus: Ship `v2`\n"]);
    expect(run("backlog", "focus", "plain", "--md", "md")).toEqual([
      1,
      "refused: pass exactly one of --md, <text> or --clear\n",
    ]);
    expect([read().focus, read().focusMarkdown]).toEqual([null, "Ship `v2`"]);
    expect(run("item", "add", "second")).toEqual([0, "added i3: second\n"]);
    expect(
      run("item", "update", "i3", "--status", "waiting-user", "--ask-md", "Q?", "--option-md", "A"),
    ).toEqual([0, "updated i3 [waiting-user] second\n"]);
    expect(run("item", "update", "i3", "--answer-md", "free `x`", "--note-md", "- n")).toEqual([
      0,
      "updated i3 [waiting-user] second\n",
    ]);
    expect(run("item", "update", "i3", "--status", "done", "--outcome-md", "- ok")).toEqual([
      0,
      "updated i3 [done] second\n",
    ]);
    const second = read().items.find((entry) => entry.id === "i3");
    expect([
      second?.answered[0]?.answerMarkdown,
      second?.answered[0]?.noteMarkdown,
      second?.outcome,
      second?.outcomeMarkdown,
    ]).toEqual(["free `x`", "- n", null, "- ok"]);
  }, 60_000);
});
