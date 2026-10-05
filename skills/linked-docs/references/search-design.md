# Search design

## Source and adaptation

The design is based on the Apache-2.0 [jev-doc-search README](https://github.com/VectifyAI/jev-doc-search/blob/7b1008c437c8c9a88da8a427a76052fb0454977a/README.md) and [tree_search.py](https://github.com/VectifyAI/jev-doc-search/blob/7b1008c437c8c9a88da8a427a76052fb0454977a/tree_search.py), consulted locally under `.claude/references/jev-doc-search`. This helper is a new implementation for linked Markdown documentation, not a copy of the PDF uploader.

| Reference technique                  | Linked-docs implementation                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Hierarchical section summaries       | Markdown index headings, link titles, and descriptions                             |
| One small Choice per level           | Bounded heading/page menus, with grouping for wide indexes                         |
| Top-K beam search                    | Up to `--beam` open branches and `--pages` finished page candidates                |
| Geometric mean of step probabilities | Log-space geometric mean, skipping singleton menus                                 |
| Parent opening pages                 | Links owned directly by a heading stay beside its subheadings                      |
| Page windows                         | Exact heading-owned passages, including opening prose and long lines               |
| Independent Noul check               | One question per candidate excerpt, judged from its source text                    |
| Best-two fallback                    | Explicitly unverified excerpts with `insufficient_evidence`, never a forced answer |

The index is a routing tree over a site's link graph. Fetches stay on its origin, redirects are checked before following, and duplicate fragment variants share one page target. It supports Markdown inline and reference links; code fences and images are ignored. It does not execute page JavaScript, scrape HTML, or recursively follow every page link. Supply a published Markdown index, not `llms-full.txt`.

## Ranking and uncertainty

Routing uses only metadata. A Choice distribution compares its options and always assigns a winner; it does not establish that any option answers the question. Keeping multiple branches reduces early-pruning risk, but finite beam width still limits recall.

Path scores are geometric means, avoiding systematic preference for shallow heading trees. They are routing heuristics, not calibrated probabilities of correctness. Selected pages get a balanced, 32-option section-metadata tree. Heading paths and query-focused source hints route down one grouping branch, then retain its two best original passages. Hints are routing metadata, never substitute evidence. Choice scores from unrelated menus are not globally comparable: each page's best candidate gets a verification slot before any page's second candidate. Independent Noul checks supply the final cross-candidate ordering, bounded to 16 checks. Early grouping choices and split facts can still limit recall.

The 0.6 evidence threshold is a conservative starting policy, not an evaluated accuracy guarantee. Validate it against representative questions before treating it as an application gate. No-match candidates remain labeled unverified, even when they are the best available. Check caveats and context before using accepted snippets.

## Budgets and reuse

Defaults retain two open branches, fetch up to three selected pages, and return up to three accepted excerpts (or two unverified fallback excerpts). Section routing sends bounded metadata rather than ranking every full-text window. Evidence is split into exact, at-most-3500-byte slices, never silently truncated. A 301-passage page needs two metadata Choices rather than 75 window Choices.

Application limits deliberately sit below the documented TypeSafe limits:

- Up to 32 menu options, compared with the API's maximum of 255 per Choice.
- Whole serialized request at most 24,000 UTF-8 bytes, a conservative token-budget guard with room below the documented 32k limit for state plus longest question. Metadata escaping can still exceed it; such a request fails explicitly.
- At most 64 logical model evaluations and 13 document fetches per run, including the index. Cached judgments count toward logical work, not fresh API usage.
- At most 16 routing levels, three simultaneous jobs, and three redirects per document.
- At most 2,000,000 downloaded bytes per document and 100,000 per API response.
- A 20-second request/body deadline and 180-second run deadline. A service failure or exhausted model-call budget fails the search rather than manufacturing results.

Public documents are cached by URL for 24 hours; `--refresh` bypasses document reuse. Both normal searches and benchmarks persist validated Jev answers in `<cache>/jev/`. Exact endpoint and serialized input hashes include model, question, state, instructions, criteria, and question IDs, not headers or credentials. Identical inputs reuse answers across processes; changed inputs miss naturally. Invalid answers and HTTP errors are never persisted. Model entries do not expire: use a different cache directory for an explicitly approved fresh-inference run. Cache I/O failures fail closed. Normal-search metrics distinguish fresh calls/input tokens from logical workload and model-cache hits. Cached content is not proof of current documentation when the user's requested version or an observed behavior conflicts with it.

## Diagnosis

Separate four failure classes:

1. **Missing coverage:** the index lacks the page, a link is excluded, a fetch fails, or the beam/shortlist drops it. Inspect headings and counts, then adjust the query or retrieve the prerequisite source explicitly.
2. **Routing error:** the right leaf exists but is ranked poorly. Check its title/description and route trace before widening the beam. A larger beam increases API calls, not guaranteed correctness.
3. **Evidence error:** a topical snippet passes Noul without stating the answer, or a correct answer spans chunks. Read the neighboring source and report the limitation; a model score cannot replace source checking.
4. **Service/budget error:** credentials, rate limits, invalid response schema, HTML, redirects, byte limits, or deadlines. The error identifies the boundary; retries are explicit and bounded.

Current HTTP contract and model limits were checked against the official [API](https://docs.typesafe.ai/api.md), [models](https://docs.typesafe.ai/models.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), and [hierarchical classification cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md). The default model is pinned to `jev-1.13.0`; verify current docs before changing it or the request budgets.

## Verification

The Bun tests use injected document and model services, plus mocked HTTP responses. They exercise retained alternatives, opening evidence, exact excerpts, absent answers, partial fetch failures, malformed probabilities, cache reuse/refresh, redirects, and budget guards without spending API credits.

A live index smoke test establishes that a site's Markdown format parses. It does not measure Jev relevance quality. A live model evaluation needs `TYPESAFE_API_KEY` resolved and injected through the skill's varlock configuration, plus representative answerable, ambiguous, and absent-answer questions with expected source excerpts checked independently.
