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
  --max-calls 900 --max-calls-per-profile 300 \
  --output .scratch/linked-docs-bench-smoke.json
```

The three profiles use the same 0.6 threshold:

- `baseline`: fixed original policy, beam 3 and up to 6 pages, independent of later default changes.
- `balanced`: selected default, beam 2 and up to 3 pages.
- `narrow`: beam 1 and up to 1 page.

Use `--case` and `--profiles` to focus experiments. `--repeat 2` rotates profile order and replays the same cached judgments, useful for verifying cache reuse and measuring replay latency. These are deterministic replays, not independent model-quality samples.

```bash
varlock run --path "$SKILL_DIR/" --inject vars -- \
  bun "$SKILL_DIR/scripts/bench.ts" --run --repeat 2 \
  --max-calls 900 --max-calls-per-profile 300 \
  --output .scratch/linked-docs-bench.json
```

Read `--help` for all options. The default total fresh-request cap is **200**, not a promise that all 18 default case/profile combinations fit. `--max-calls-per-profile` defaults to 64 and caps fresh HTTP attempts across **all cases and repetitions** of each profile. It also bounds logical evaluations within each individual attempt, including cached work; raise it explicitly when testing large pages. The example permits at most 300 fresh requests per profile and 900 overall.

Both spend guards run before HTTP dispatch, including parallel attempts. Cache hits consume neither spend budget and remain available after the budget is exhausted. Uncached work blocked by a spend guard is recorded as an error row; later cached cases may still complete. A configurable per-attempt deadline up to 180 seconds and a ten-minute suite deadline bound runtime. A suite deadline may leave rows unattempted. `complete` means all planned rows were attempted, not that they passed. There are no automatic retries. Exit 0 means the selected matrix completed and every eval passed; exit 2 means a miss, error, or incomplete matrix; exit 1 means invalid setup or inability to write the report.

## Measurements and reproducibility

Reports are local JSON files under the current repository's `.scratch/`. They contain:

- Actual fresh TypeSafe HTTP attempts, split into requests containing Choice or Noul questions, and spend by profile. Blocked attempts are excluded; dispatched requests that fail still count.
- Logical model evaluations, split into Choice/Noul, and model-cache/in-flight reuse counts. Logical counts expose policy cost without mistaking a warm-cache profile for a cheaper algorithm.
- API-reported fresh input/output tokens, number of responses supplying complete usage, serialized fresh request bytes, document HTTP requests, and wall-clock elapsed time. Logical token totals add the original usage of reused responses; they are nominal workload estimates, not new charges.
- Per-case grades, source excerpts and offsets, errors, implementation SHA-256, corpus URL/body hashes, model ID, policies, budgets, and deadlines.
- Positive hit rate counts, correct-abstention counts, accepted-span precision, operational errors, and mean calls/latency per profile. Failed attempts remain in the quality denominators.

Usage totals cover responses that supplied valid usage fields; a missing usage response is not evidence of zero cost. Budget-blocked requests and API errors are not semantic abstentions. Reports never store request headers, credentials, or private configuration.

Bodies are pinned in memory on first access during a run, backed by the existing 24-hour disk cache. Document hashes help spot corpus drift across runs; preserve the public-doc cache if you need to replay its content. The runner does not copy the whole docs site.

Both normal searches and the benchmark persist validated Jev Choice and Noul answers under `<cache>/jev/`, with atomic writes and in-flight deduplication. SHA-256 keys cover the endpoint and exact serialized request, including model, state, instructions, criteria, and question IDs. Identical inputs reuse the same judgment across profiles, repetitions, and later processes. Changed inputs miss naturally. Model entries do not expire; use a different `--cache` directory for an explicitly approved fresh-inference experiment. The pinned model is important for reproducibility.

Only validated answers and usage are stored, not credentials, request headers, or plaintext inputs. Corrupt entries are misses; invalid model responses and HTTP errors are not persisted. Unreadable caches or failed writes stop the affected attempt rather than silently spending without caching. Normal `search.ts` uses the same cached service boundary and reports fresh versus logical calls/input tokens and model-cache hits.

Cold document fetches, live inference, and warm model-cache reads have different latency profiles. Compare logical workload and quality to select a policy; fresh-call counts instead measure actual incremental spend. Single-run timings and tiny samples do not establish stable quality or speed improvements.

## Evaluated default

On the six-case Zed development suite, with `jev-1.13.0` and the section-routing/page-diverse retriever:

| Profile        | Positive hits | Correct abstentions | Errors | Logical calls | Nominal input tokens |
| -------------- | ------------- | ------------------- | ------ | ------------- | -------------------- |
| baseline (3/6) | 4/4           | 2/2                 | 0      | 153           | 157,710              |
| balanced (2/3) | 4/4           | 2/2                 | 0      | 88            | 97,520               |
| narrow (1/1)   | 2/4           | 2/2                 | 0      | 35            | 39,829               |

Balanced is the default: it retained all four gold spans and both abstentions with 42% fewer logical calls and 38% fewer nominal input tokens than the original-width baseline. Narrow missed executable overrides and Python indentation, so its lower cost did not justify promotion. Accepted excerpts were reviewed, including useful alternative configuration paths that do not count as exact gold-source matches. The original binary-query baseline needed 126 logical calls and missed the guide; section routing and page diversity now find it in 27.

The final variant's full matrix used 35 fresh requests and 241 reuses, with no operational errors. Optimization runs spent 173 fresh requests in total; subsequent full-matrix and production-CLI replays used none. Fresh counts reflect balanced-first cache sharing, not intrinsic policy cost. Timing is not a cold-speed ranking. This small development suite supports the default tradeoff, not a general accuracy guarantee or independently sampled repetitions.

## Optimization loop

1. Establish a complete baseline on all six cases and review its evidence, including negative controls.
2. Compare paired case/repetition rows for a cheaper profile. Keep quality counts and errors beside calls/tokens; a fast failure is not an optimization.
3. Make one algorithm change, such as batching independent checks, and rerun the same cases/model/corpus. Transport-level counts continue to measure actual requests even if multiple questions share one request.
4. Re-review difficult cases and add a regression case before promoting a new default. Keep this small development set separate from a larger holdout set to avoid tuning only for these six questions.

Unit tests use fake HTTP responses and the real retrieval pipeline to check grading, global/profile quotas, deadline reports, corpus reuse, persistent and concurrent model-cache reuse, invalid responses, operational failures, CLI safety, and fresh/logical accounting. They spend no TypeSafe credits.
