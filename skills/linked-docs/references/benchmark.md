# Retrieval eval bench

Optimize request count without losing evidence coverage or accepting unsupported answers. This bench calls the existing production `retrieve` function; it changes only routing policy, not the algorithm, model prompts, or probability validator.

## Cases and scoring

Six human-reviewed cases live in `scripts/evals.ts`:

| Case                 | Expectation                                                | Gold source                                                            |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `lsp-binary`         | Executable path and arguments in one accepted excerpt      | [Configuring Languages](https://zed.dev/docs/configuring-languages.md) |
| `python-indent`      | Python's tab size under language-specific settings         | [Configuring Languages](https://zed.dev/docs/configuring-languages.md) |
| `rust-check-on-save` | `checkOnSave` and `false` together                         | [Rust](https://zed.dev/docs/languages/rust.md)                         |
| `local-mcp`          | Local server command and arguments under `context_servers` | [MCP](https://zed.dev/docs/ai/mcp.md)                                  |
| `lean-missing`       | Abstain on the reviewed indexed corpus                     | Lean extension setup is documented outside this index                  |
| `invented-setting`   | Abstain on a fabricated setting                            | No supported setting                                                   |

Positive cases require an accepted excerpt from the gold URL containing every specified string **in that same excerpt**. Negative cases require `insufficient_evidence` with no accepted excerpts. Fetch warnings and operational errors cannot masquerade as correct abstentions. Case IDs, exact questions, rationales, and gold labels are included in each report.

These are deterministic source/span checks, not a complete semantic judge of generated answers. No extra judge-model requests are spent. Inspect stored excerpts when a score surprises you; a matching example is a proxy for evidence quality, not proof that every caveat is covered. Re-review labels when docs change. In particular, Lean's absence means absent from this indexed corpus, not unsupported by Zed or absent from the web.

## Run

Preview the cases and policies without network access or credentials:

```bash
bun "$SKILL_DIR/scripts/bench.ts"
```

Run a small live comparison through the skill's existing varlock configuration:

```bash
varlock run --path "$SKILL_DIR/" --inject vars -- \
  bun "$SKILL_DIR/scripts/bench.ts" --run --case lsp-binary \
  --max-calls 100 --output .scratch/linked-docs-bench-smoke.json
```

The three profiles use the same 0.6 threshold:

- `baseline`: current defaults, beam 3 and up to 6 pages.
- `balanced`: beam 2 and up to 3 pages.
- `narrow`: beam 1 and up to 1 page.

Use `--case` and `--profiles` to focus experiments. `--repeat 3` rotates profile order and gives more than one sample per case. Each repetition spends fresh model calls, while public document bodies are reused.

```bash
varlock run --path "$SKILL_DIR/" --inject vars -- \
  bun "$SKILL_DIR/scripts/bench.ts" --run --repeat 3 \
  --max-calls 600 --output .scratch/linked-docs-bench.json
```

Read `--help` for all options. The default total request cap is **200**, not a promise that all 18 default case/profile combinations fit. The global cap is enforced before dispatch, including parallel attempts; caps and deadlines produce explicitly incomplete reports. Each attempt retains the production 64-call limit, a configurable deadline up to 180 seconds, and the suite has a ten-minute deadline. There are no automatic retries. Exit 0 means the selected matrix completed and every eval passed; exit 2 means a miss, error, or incomplete matrix; exit 1 means invalid setup or inability to write the report.

## Measurements and reproducibility

Reports are local JSON files under the current repository's `.scratch/`. They contain:

- Actual TypeSafe HTTP attempts, split into requests containing Choice or Noul questions. Blocked over-budget attempts are excluded; attempted requests that fail still count.
- API-reported input/output tokens, number of responses supplying complete usage, serialized request bytes, document HTTP requests, and wall-clock elapsed time.
- Per-case grades, source excerpts and offsets, errors, implementation SHA-256, corpus URL/body hashes, model ID, policies, budgets, and deadlines.
- Positive hit rate counts, correct-abstention counts, accepted-span precision, operational errors, and mean calls/latency per profile. Failed attempts remain in the quality denominators.

Usage totals cover responses that supplied valid usage fields; a missing usage response is not evidence of zero cost. Budget-blocked requests and API errors are not semantic abstentions. Reports never store request headers, credentials, or private configuration.

Bodies are pinned in memory on first access during a run, backed by the existing 24-hour disk cache. The runner does not copy the whole docs site or cache model judgments. Document hashes help spot corpus drift across runs; preserve the public-doc cache if you need to replay its content. Cold document requests may affect latency, and rotating profile order only mitigates that bias. Single-run timings and tiny samples do not establish stable quality or speed improvements.

## Optimization loop

1. Establish a complete baseline on all six cases and review its evidence, including negative controls.
2. Compare paired case/repetition rows for a cheaper profile. Keep quality counts and errors beside calls/tokens; a fast failure is not an optimization.
3. Make one algorithm change, such as batching independent checks, and rerun the same cases/model/corpus. Transport-level counts continue to measure actual requests even if multiple questions share one request.
4. Re-review difficult cases and add a regression case before promoting a new default. Keep this small development set separate from a larger holdout set to avoid tuning only for these six questions.

Unit tests use fake HTTP responses and the real retrieval pipeline to check grading, budget enforcement, partial reports, corpus reuse, operational failures, CLI safety, and request/usage accounting. They spend no TypeSafe credits.
