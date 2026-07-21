# Worked example: manual execution trace

A complete workflow script followed by the exact sequence of manual steps an
agent without the Workflow tool performs to execute it.

## The script

```js
export const meta = {
  name: "audit-docs",
  description: "Audit doc files for stale claims, verify each finding, fix confirmed ones",
  phases: [
    { title: "Audit", detail: "one auditor per doc file" },
    { title: "Verify", detail: "adversarial check per finding" },
    { title: "Fix", detail: "apply confirmed fixes" },
    { title: "Sweep", detail: "optional budget-gated deep sweep" },
  ],
};

const DOCS = ["README.md", "CONTRIBUTING.md", "docs/setup.md"];

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "claim", "why"],
        properties: {
          file: { type: "string" },
          claim: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["stale"],
  properties: { stale: { type: "boolean" }, reason: { type: "string" } },
};

phase("Audit");
const verified = await pipeline(
  DOCS,
  (doc) =>
    agent(
      "Read " +
        doc +
        " and check every shell command and file path it mentions against the actual repo. Return findings for claims that appear wrong or outdated.",
      { label: "audit:" + doc, phase: "Audit", schema: FINDINGS_SCHEMA },
    ),
  (audit, doc, i) =>
    parallel(
      audit.findings.map(
        (f) => () =>
          agent(
            "Adversarially verify this claim from " +
              doc +
              ': "' +
              f.claim +
              '" (' +
              f.why +
              "). Try to prove the doc is actually correct. Default stale=false when uncertain.",
            { label: "verify:" + i, phase: "Verify", schema: VERDICT_SCHEMA },
          ).then((v) => ({ ...f, stale: v.stale, reason: v.reason })),
      ),
    ),
);

const confirmed = verified
  .filter(Boolean)
  .flat()
  .filter(Boolean)
  .filter((f) => f.stale);
log(confirmed.length + " confirmed stale claims");
if (confirmed.length === 0) return { clean: true, docsAudited: DOCS.length };

phase("Fix");
const fixes = await parallel(
  confirmed.map(
    (f) => () =>
      agent(
        "Fix this stale claim in " +
          f.file +
          ': "' +
          f.claim +
          '". Reason it is stale: ' +
          f.reason +
          ". Edit the file in place and return a one-line summary of the edit.",
        { label: "fix:" + f.file, phase: "Fix" },
      ),
  ),
);

phase("Sweep");
let sweeps = 0;
while (budget.total && budget.remaining() > 50000 && sweeps < 2) {
  await agent(
    "Deep-sweep pass " +
      (sweeps + 1) +
      ": re-read all docs and hunt for anything the first audit missed.",
    { label: "sweep:" + sweeps, phase: "Sweep" },
  );
  sweeps++;
}

return { confirmed: confirmed.length, fixed: fixes.filter(Boolean).length, sweeps };
```

## The manual trace

Setup: announce the run ("audit-docs: Audit doc files for stale claims...",
phases Audit, Verify, Fix, Sweep) and create
`<tmp>/workflow-runs/audit-docs/journal.md`. No `args` are referenced. The
user gave no token target, so `budget.total` is `null`.

The `pipeline` has 3 items and 2 stages. Execute depth-first: both stages for
`README.md`, then both for `CONTRIBUTING.md`, then both for `docs/setup.md`.

**Item 1: README.md**

1. `audit:README.md` (Audit). Materialized prompt: `Read README.md and check
every shell command and file path it mentions against the actual repo.
Return findings for claims that appear wrong or outdated.` Perform it; the
   result must validate against `FINDINGS_SCHEMA`. Suppose it returns
   `{ findings: [F1, F2] }`, each with `file`, `claim`, `why`. Journal it.
2. Stage 2 receives `(audit, 'README.md', 0)`: the stage callback always gets
   `(prevResult, originalItem, index)`. It maps the 2 findings to 2 verify
   thunks and runs them via `parallel`, so sequentially:
   - `verify:0` for F1: materialize the prompt by substituting `f.claim` and
     `f.why`; result must validate against `VERDICT_SCHEMA`, for example
     `{ stale: false, reason: '...' }`. The `.then` merges it:
     `{ ...F1, stale: false, reason: '...' }`.
   - `verify:0` for F2: same, suppose `{ stale: true, reason: '...' }` giving
     `{ ...F2, stale: true, reason: '...' }`.
     Item 1's pipeline value is the array of those 2 merged objects.

**Item 2: CONTRIBUTING.md**

3. `audit:CONTRIBUTING.md` returns `{ findings: [] }`. Stage 2 maps an empty
   array, so `parallel([])` runs zero subtasks and the item's value is `[]`.
   No verify work happens for this doc. That is correct, not a gap.

**Item 3: docs/setup.md**

4. `audit:docs/setup.md` returns `{ findings: [F3] }`; one verify subtask,
   suppose `{ ...F3, stale: false, reason: '...' }`.

**Glue code** (evaluate with the real values):

```
verified = [ [F1', F2'], [], [F3'] ]      // F2'.stale === true
confirmed = verified.filter(Boolean).flat().filter(Boolean).filter(f => f.stale)
          = [ F2' ]
```

Report the log line: `1 confirmed stale claims`. The early return is skipped
because `confirmed.length` is 1.

**Fix phase**

5. `fix:README.md`: materialize the prompt from `F2'`, edit the file in place,
   and the call's value is the one-line summary. `fixes` is a 1-element array.

Had this subtask failed after a retry, its slot would be `null` and
`fixes.filter(Boolean).length` would be 0; the run continues either way.

**Sweep phase**

6. `budget.total` is `null`, so `while (budget.total && ...)` never enters the
   loop. Zero sweep subtasks run. Do not "helpfully" run them anyway; the
   script gates them on a token target the user did not set.

**Return**

```json
{ "confirmed": 1, "fixed": 1, "sweeps": 0 }
```

Journal the result and present it to the user: 7 subtasks executed (3 audits,
3 verifies via the findings counts 2 + 0 + 1, 1 fix), 1 stale claim confirmed
and fixed, sweep skipped because no token budget was set.
