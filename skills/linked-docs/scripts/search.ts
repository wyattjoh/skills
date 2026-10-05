#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { docUrl, parseIndex } from "./documents.ts";
import { createServices, DEFAULT_POLICY, RetrievalError, retrieve } from "./retrieve.ts";

const HELP = `Usage: bun scripts/search.ts <https://site/docs/llms.txt> "question" [options]
       bun scripts/search.ts <https://site/docs/llms.txt> --inspect-index

Jev search requires TYPESAFE_API_KEY. Only selected public pages are fetched.
--cache <dir>       Public-doc cache (default: .scratch/linked-docs-cache)
--refresh           Bypass the 24-hour document cache
--model <id>        TypeSafe model (default: jev-1.13.0)
--beam <1-8>        Open routing branches (default: 3)
--pages <1-12>      Maximum selected pages (default: 6)
--threshold <0-1>   Independent evidence threshold (default: 0.6)
--inspect-index     Parse live index and print counts without model calls
--help              Show this help

JSON output contains exact excerpts, URLs, offsets, routing trace, and usage.
Exit codes: 0 evidence (or inspection), 1 failure, 2 insufficient evidence.
Limits: 64 model calls, 20s/request, 180s/run, 2MB/document, 16 checks.
`;

const main = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () =>
      parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
          help: { type: "boolean" },
          "inspect-index": { type: "boolean" },
          cache: { type: "string" },
          refresh: { type: "boolean" },
          model: { type: "string" },
          beam: { type: "string" },
          pages: { type: "string" },
          threshold: { type: "string" },
        },
      }),
    catch: () => new RetrievalError({ message: `Invalid arguments.\n${HELP}` }),
  });
  if (args.values.help) {
    yield* Console.log(HELP);
    return;
  }
  const [indexUrl, question] = args.positionals;
  const inspect = args.values["inspect-index"] ?? false;
  if (!indexUrl || !docUrl(indexUrl, indexUrl) || args.positionals.length !== (inspect ? 1 : 2)) {
    return yield* Effect.fail(new RetrievalError({ message: HELP }));
  }
  if (!inspect && !process.env.TYPESAFE_API_KEY) {
    return yield* Effect.fail(
      new RetrievalError({
        message:
          "Set TYPESAFE_API_KEY in the environment, never in arguments. Use --inspect-index to test parsing without a key.",
      }),
    );
  }
  const { services, metrics } = createServices({
    indexUrl,
    cache: resolve(args.values.cache ?? ".scratch/linked-docs-cache"),
    refresh: args.values.refresh ?? false,
    apiKey: process.env.TYPESAFE_API_KEY,
    model: args.values.model ?? "jev-1.13.0",
    maxCalls: 64,
  });
  if (inspect) {
    const document = yield* services.document(indexUrl);
    const parsed = parseIndex(document.text, document.url);
    if (!parsed.pages)
      return yield* Effect.fail(
        new RetrievalError({ message: "Index has no same-origin Markdown links" }),
      );
    yield* Console.log(
      JSON.stringify(
        {
          index: document.url,
          pages: parsed.pages,
          excluded: parsed.excluded,
          rootHeadings: parsed.root.children.map((node) => node.title).slice(0, 20),
          metrics,
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = yield* retrieve(indexUrl, question, services, {
    beam: Number(args.values.beam ?? DEFAULT_POLICY.beam),
    pages: Number(args.values.pages ?? DEFAULT_POLICY.pages),
    threshold: Number(args.values.threshold ?? DEFAULT_POLICY.threshold),
  });
  yield* Console.log(JSON.stringify({ ...result, metrics }, null, 2));
  if (result.status === "insufficient_evidence") process.exitCode = 2;
});

if (import.meta.main) {
  await Effect.runPromise(
    main.pipe(
      Effect.timeoutFail({
        duration: "180 seconds",
        onTimeout: () =>
          new RetrievalError({
            message: "Search exceeded 180-second deadline; narrow the question or reduce --pages",
          }),
      }),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Console.error(error.message);
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
