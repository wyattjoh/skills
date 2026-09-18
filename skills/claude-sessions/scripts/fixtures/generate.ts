#!/usr/bin/env bun

/**
 * Sample rare record shapes from the real corpus, anonymize their text, and
 * write small anonymized JSONL fixtures plus a manifest into
 * scripts/testdata/corpus/. Run once; the output is checked in and used by
 * lib and sync tests instead of the real corpus.
 *
 * Usage:
 *   bun $SKILL_DIR/scripts/fixtures/generate.ts [--root=PATH] [--out=PATH]
 */

import { parseArgs } from "node:util";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { discoverCorpus, defaultCorpusRoot } from "../lib/corpus.ts";
import { readJsonl } from "../lib/jsonl.ts";
import { extractBlocks, hasInjectedTag, hasInterruptMarker, parseRecord } from "../lib/records.ts";

const PROJECT_DIR = "-Users-testuser-Code-sample-project";
const SESSION_STRING_CONTENT = "session-string-content";
const SESSION_BLOCK_CONTENT = "session-block-content";
const SESSION_TOOL_ERROR = "session-tool-error";
const SESSION_QUEUE_OPERATION = "session-queue-operation";
const SESSION_SUMMARY = "session-summary";
const SESSION_AI_TITLE = "session-ai-title";
const SESSION_ATTACHMENT = "session-attachment";
const SESSION_MALFORMED = "session-malformed";
const SESSION_INJECTED = "session-injected";
const SESSION_INTERRUPT = "session-interrupt";
const PARENT_SESSION_ID = "sample-parent-session";
const SUBAGENT_ID = "sample0agent00id01";

// =============================================================================
// Anonymization: replace free text with a fixed lorem-style lexicon keyed by
// a hash of the original word, and rewrite identifiers to synthetic values.
// This is deliberately non-invertible: unlike a substitution cipher (e.g.
// rot13), recovering the source word from its lexicon replacement requires
// brute-forcing the hash against every word in the language, not just
// knowing the scheme. Structural/enum-shaped fields (type, role, ...) are
// low-risk and kept verbatim so the fixtures still exercise real shapes.
// =============================================================================

/** Fields that hold small, non-identifying, structural values: kept as-is. */
const KEEP_VERBATIM_KEYS = new Set([
  "type",
  "timestamp",
  "version",
  "model",
  "role",
  "stop_reason",
  "stop_sequence",
  "service_tier",
  "operation",
  "isError",
  "is_error",
  "isSidechain",
  "isMeta",
  "userType",
  "entrypoint",
  "slug",
  "agentType",
  "level",
  "subtype",
]);

/**
 * Fields that hold identifiers. Rewritten to synthetic `<category>-NNNN`
 * values instead of preserved verbatim: the id itself is never needed by a
 * test (ingest keys every row by the file path/name, not by these fields),
 * only that occurrences of the same real value inside one file keep mapping
 * to the same synthetic value (e.g. a tool_use.id and the tool_result that
 * answers it).
 */
const ID_KEY_CATEGORY: Record<string, string> = {
  uuid: "uuid",
  parentUuid: "uuid",
  leafUuid: "uuid",
  messageId: "uuid",
  interruptedMessageId: "uuid",
  sessionId: "session",
  session_id: "session",
  id: "tool",
  tool_use_id: "tool",
  toolUseId: "tool",
  requestId: "request",
  promptId: "request",
  agentId: "agent",
  signature: "signature",
};

/** Synthetic replacement for any `cwd` field: never the real home directory. */
const SYNTHETIC_CWD = ".";
/** Synthetic replacement for any `gitBranch` field. */
const SYNTHETIC_GIT_BRANCH = "main";

/**
 * Markers the detection logic in lib/records.ts matches literally. They must
 * survive anonymization intact, or the fixtures built to exercise them stop
 * testing anything.
 */
const PROTECTED_MARKERS = [
  "<local-command-caveat>",
  "</local-command-caveat>",
  "<command-message>",
  "</command-message>",
  "<command-name>",
  "</command-name>",
  "<system-reminder>",
  "</system-reminder>",
  "[Request interrupted by user",
  "The user doesn't want to proceed",
];

const PROTECTED_MARKERS_RE = new RegExp(
  `(${PROTECTED_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
);

/** A fixed, neutral word list. Real prose is replaced word-for-word from here. */
const LEXICON = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
  "amber",
  "birch",
  "cedar",
  "denim",
  "ember",
  "frost",
  "glade",
  "haven",
  "ivory",
  "jasper",
  "kelp",
  "lumen",
  "maple",
  "nectar",
  "onyx",
  "pebble",
  "quartz",
  "raven",
  "slate",
  "thistle",
  "umbra",
  "velvet",
  "willow",
  "xenon",
  "yarrow",
  "zephyr",
  "acorn",
  "basalt",
  "coral",
  "dune",
  "ferry",
  "grove",
  "harbor",
  "inlet",
];

/** Deterministic, non-cryptographic string hash (FNV-1a). */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Replace one alphabetic word with a lexicon word chosen by hashing it, preserving case shape. */
function scrambleWord(word: string): string {
  const replacement = LEXICON[hashString(word.toLowerCase()) % LEXICON.length]!;
  const firstChar = word[0] ?? "";
  if (firstChar === firstChar.toUpperCase() && /[A-Za-z]/.test(firstChar)) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Scramble every alphabetic word in `text`, leaving the protected markers intact. */
function anonymizeText(text: string): string {
  return text
    .split(PROTECTED_MARKERS_RE)
    .map((part) =>
      PROTECTED_MARKERS.includes(part) ? part : part.replace(/[A-Za-z]+/g, scrambleWord),
    )
    .join("");
}

/** Per-file state so repeated occurrences of one real id map to one synthetic id. */
interface AnonState {
  counters: Map<string, number>;
  cache: Map<string, string>;
}

function createAnonState(): AnonState {
  return { counters: new Map(), cache: new Map() };
}

function syntheticId(state: AnonState, category: string, original: string): string {
  const cacheKey = `${category}:${original}`;
  const cached = state.cache.get(cacheKey);
  if (cached) return cached;
  const next = (state.counters.get(category) ?? 0) + 1;
  state.counters.set(category, next);
  const value = `${category}-${String(next).padStart(4, "0")}`;
  state.cache.set(cacheKey, value);
  return value;
}

function anonymizeValue(state: AnonState, value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "cwd") return SYNTHETIC_CWD;
    if (key === "gitBranch") return SYNTHETIC_GIT_BRANCH;
    if (key && ID_KEY_CATEGORY[key]) return syntheticId(state, ID_KEY_CATEGORY[key]!, value);
    if (key && KEEP_VERBATIM_KEYS.has(key)) return value;
    return anonymizeText(value);
  }
  if (Array.isArray(value)) return value.map((v) => anonymizeValue(state, v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = anonymizeValue(state, v, k);
    }
    return out;
  }
  return value;
}

/** Anonymize one record with its own fresh id-mapping state. */
function anonymizeRecord(record: unknown): unknown {
  return anonymizeValue(createAnonState(), record);
}

/**
 * Anonymize a group of records that must keep cross-references consistent
 * (e.g. a tool_use paired with its tool_result) under one shared id-mapping
 * state.
 */
function anonymizeRecords(records: unknown[]): unknown[] {
  const state = createAnonState();
  return records.map((r) => anonymizeValue(state, r));
}

// =============================================================================
// Category matchers: find one real, un-anonymized line per rare shape.
// =============================================================================

interface FoundLine {
  category: string;
  value: unknown;
  /** Extra companion lines to keep alongside it (e.g. the tool_use paired with a tool_result). */
  companions?: unknown[];
}

type Matcher = (value: unknown, context: { priorAssistant: unknown | null }) => FoundLine | null;

const matchers: Record<string, Matcher> = {
  stringContent: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "user") return null;
    const content = (record as { message?: { content?: unknown } }).message?.content;
    if (typeof content !== "string" || content.length === 0) return null;
    return { category: "stringContent", value };
  },
  blockContent: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "assistant") return null;
    const content = (record as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content) || content.length < 2) return null;
    const kinds = new Set(content.map((b: { type?: string }) => b?.type));
    if (!kinds.has("text")) return null;
    return { category: "blockContent", value };
  },
  toolError: (value, ctx) => {
    const record = parseRecord(value);
    if (record?.type !== "user") return null;
    const content = (record as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return null;
    const errorBlock = content.find(
      (b: { type?: string; is_error?: boolean }) =>
        b?.type === "tool_result" && b?.is_error === true,
    );
    if (!errorBlock || !ctx.priorAssistant) return null;
    return { category: "toolError", value, companions: [ctx.priorAssistant] };
  },
  queueOperation: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "queue-operation") return null;
    return { category: "queueOperation", value };
  },
  summary: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "summary") return null;
    if (!(record as { summary?: string }).summary) return null;
    return { category: "summary", value };
  },
  aiTitle: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "ai-title") return null;
    if (!(record as { aiTitle?: string }).aiTitle) return null;
    return { category: "aiTitle", value };
  },
  attachment: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "attachment") return null;
    if (!Array.isArray((record as { rendered?: unknown[] }).rendered)) return null;
    return { category: "attachment", value };
  },
  injected: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "user") return null;
    const content = (record as { message?: { content?: unknown } }).message?.content;
    const blocks = extractBlocks(content as never);
    const text = blocks.map((b) => b.text).join("\n");
    if (!hasInjectedTag(text)) return null;
    return { category: "injected", value };
  },
  interrupt: (value) => {
    const record = parseRecord(value);
    if (record?.type !== "user") return null;
    const content = (record as { message?: { content?: unknown } }).message?.content;
    const blocks = extractBlocks(content as never);
    const text = blocks.map((b) => b.text).join("\n");
    if (!hasInterruptMarker(text)) return null;
    return { category: "interrupt", value };
  },
};

async function findSamples(
  root: string,
  maxFiles: number,
): Promise<{
  found: Record<string, FoundLine>;
  subagent: { lines: unknown[]; meta: unknown } | null;
}> {
  const found: Record<string, FoundLine> = {};
  let subagent: { lines: unknown[]; meta: unknown } | null = null;

  const files = await discoverCorpus(root);
  let scanned = 0;

  for (const file of files) {
    if (
      scanned >= maxFiles &&
      Object.keys(found).length === Object.keys(matchers).length &&
      subagent
    )
      break;
    scanned += 1;

    if (!subagent && file.kind === "subagent") {
      const { lines } = await readJsonl(file.path);
      if (lines.length >= 2) {
        let meta: unknown = { agentType: "general-purpose" };
        if (file.metaPath) {
          try {
            meta = await Bun.file(file.metaPath).json();
          } catch {
            // keep default
          }
        }
        subagent = { lines: lines.slice(0, 3).map((l) => l.value), meta };
      }
      continue;
    }

    if (file.kind !== "session") continue;

    const { lines, malformedCount: _ignored } = await readJsonl(file.path);
    let priorAssistant: unknown | null = null;

    for (const line of lines) {
      const record = parseRecord(line.value);
      if (record?.type === "assistant") priorAssistant = line.value;

      for (const [key, matcher] of Object.entries(matchers)) {
        if (found[key]) continue;
        const result = matcher(line.value, { priorAssistant });
        if (result) found[key] = result;
      }
    }
  }

  return { found, subagent };
}

// =============================================================================
// Fixture assembly
// =============================================================================

async function writeJsonlFile(path: string, records: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body =
    anonymizeRecords(records)
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  await writeFile(path, body);
}

function truncateToMalformed(record: unknown): string {
  const anonymized = JSON.stringify(anonymizeRecord(record));
  // Cut well before the end so the line is syntactically invalid JSON,
  // simulating a process killed mid-write.
  return anonymized.slice(0, Math.max(20, Math.floor(anonymized.length * 0.6)));
}

// =============================================================================
// Leak check: defense in depth against anonymization gaps.
// =============================================================================

interface ForbiddenPattern {
  name: string;
  re: RegExp;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { name: "a real /Users home directory path", re: /\/Users\/(?!testuser\b)[A-Za-z0-9_.-]+/ },
  { name: "an Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "a generic sk- secret key", re: /\bsk-[A-Za-z0-9_-]{10,}/ },
  { name: "a GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "an AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "a Stripe key", re: /sk_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: "a bearer token", re: /Bearer [A-Za-z0-9._-]{10,}/ },
];

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Defense in depth: after writing, scan every generated fixture for a real
 * home directory path or a recognizable secret pattern. These files are
 * permanent, checked-in artifacts in a public repo; fail loudly rather than
 * ship something the anonymization pass missed.
 */
async function assertNoLeakedSecrets(outRoot: string): Promise<void> {
  const files = await listFilesRecursive(outRoot);
  for (const file of files) {
    const text = await Bun.file(file).text();
    for (const pattern of FORBIDDEN_PATTERNS) {
      const match = text.match(pattern.re);
      if (match) {
        throw new Error(
          `Fixture ${file} still contains ${pattern.name} (${JSON.stringify(match[0])}). Anonymization is incomplete.`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: "string" },
      out: { type: "string" },
    },
  });

  const root = values.root ?? defaultCorpusRoot();
  const outRoot =
    values.out ?? join(dirname(new URL(import.meta.url).pathname), "..", "testdata", "corpus");

  const { found, subagent } = await findSamples(root, 400);

  const missing = Object.keys(matchers).filter((k) => !found[k]);
  if (missing.length > 0) {
    console.error(`Warning: no sample found for: ${missing.join(", ")}`);
  }
  if (!subagent) {
    console.error("Warning: no subagent transcript found");
  }

  await rm(outRoot, { recursive: true, force: true });
  const projectPath = join(outRoot, PROJECT_DIR);

  const manifest: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    projectDir: PROJECT_DIR,
    fixtures: {} as Record<string, string>,
  };
  const fixtures = manifest.fixtures as Record<string, string>;

  if (found.stringContent) {
    await writeJsonlFile(join(projectPath, `${SESSION_STRING_CONTENT}.jsonl`), [
      found.stringContent.value,
    ]);
    fixtures.stringContent = `${SESSION_STRING_CONTENT}.jsonl: a user record whose message.content is a plain string rather than a block array.`;
  }
  if (found.blockContent) {
    await writeJsonlFile(join(projectPath, `${SESSION_BLOCK_CONTENT}.jsonl`), [
      found.blockContent.value,
    ]);
    fixtures.blockContent = `${SESSION_BLOCK_CONTENT}.jsonl: an assistant record with a block-array content mixing text with other block kinds.`;
  }
  if (found.toolError) {
    const records = [...(found.toolError.companions ?? []), found.toolError.value];
    await writeJsonlFile(join(projectPath, `${SESSION_TOOL_ERROR}.jsonl`), records);
    fixtures.toolError = `${SESSION_TOOL_ERROR}.jsonl: a tool_use paired with a tool_result whose is_error is true.`;
  }
  if (found.queueOperation) {
    await writeJsonlFile(join(projectPath, `${SESSION_QUEUE_OPERATION}.jsonl`), [
      found.queueOperation.value,
    ]);
    fixtures.queueOperation = `${SESSION_QUEUE_OPERATION}.jsonl: a queue-operation record.`;
  }
  if (found.summary) {
    await writeJsonlFile(join(projectPath, `${SESSION_SUMMARY}.jsonl`), [found.summary.value]);
    fixtures.summary = `${SESSION_SUMMARY}.jsonl: a summary record.`;
  }
  if (found.aiTitle) {
    await writeJsonlFile(join(projectPath, `${SESSION_AI_TITLE}.jsonl`), [found.aiTitle.value]);
    fixtures.aiTitle = `${SESSION_AI_TITLE}.jsonl: an ai-title record.`;
  }
  if (found.attachment) {
    await writeJsonlFile(join(projectPath, `${SESSION_ATTACHMENT}.jsonl`), [
      found.attachment.value,
    ]);
    fixtures.attachment = `${SESSION_ATTACHMENT}.jsonl: an attachment record with rendered system-reminder content.`;
  }
  if (found.injected) {
    await writeJsonlFile(join(projectPath, `${SESSION_INJECTED}.jsonl`), [found.injected.value]);
    fixtures.injected = `${SESSION_INJECTED}.jsonl: a record carrying an injected tag (<system-reminder>, <command-name>, ...).`;
  }
  if (found.interrupt) {
    await writeJsonlFile(join(projectPath, `${SESSION_INTERRUPT}.jsonl`), [found.interrupt.value]);
    fixtures.interrupt = `${SESSION_INTERRUPT}.jsonl: a record carrying an interrupt or rejected-tool marker.`;
  }
  if (found.stringContent) {
    const malformedLine = truncateToMalformed(found.stringContent.value);
    const path = join(projectPath, `${SESSION_MALFORMED}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    const goodLine = JSON.stringify(anonymizeRecord(found.stringContent.value));
    await writeFile(path, `${goodLine}\n${malformedLine}\n${goodLine}\n`);
    fixtures.malformed = `${SESSION_MALFORMED}.jsonl: a well-formed line, a line truncated mid-record to simulate a crash, and a well-formed line.`;
  }

  if (subagent) {
    const parentPath = join(projectPath, `${PARENT_SESSION_ID}.jsonl`);
    await writeJsonlFile(
      parentPath,
      subagent.lines.map((l, i) => ({
        ...(l as Record<string, unknown>),
        sessionId: PARENT_SESSION_ID,
        uuid: `parent-line-${i}`,
      })),
    );

    const subagentDir = join(projectPath, PARENT_SESSION_ID, "subagents");
    const subagentLines = subagent.lines.map((l, i) => ({
      ...(l as Record<string, unknown>),
      sessionId: PARENT_SESSION_ID,
      agentId: SUBAGENT_ID,
      uuid: `sub-line-${i}`,
    }));
    await writeJsonlFile(join(subagentDir, `agent-${SUBAGENT_ID}.jsonl`), subagentLines);
    await mkdir(subagentDir, { recursive: true });
    await writeFile(
      join(subagentDir, `agent-${SUBAGENT_ID}.meta.json`),
      JSON.stringify(anonymizeRecord(subagent.meta)),
    );
    fixtures.subagent = `${PARENT_SESSION_ID}.jsonl plus ${PARENT_SESSION_ID}/subagents/agent-${SUBAGENT_ID}.jsonl: a parent session with a nested subagent transcript.`;
  }

  await mkdir(outRoot, { recursive: true });
  await writeFile(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  await assertNoLeakedSecrets(outRoot);

  console.log(`Wrote fixtures for: ${Object.keys(fixtures).join(", ")}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
