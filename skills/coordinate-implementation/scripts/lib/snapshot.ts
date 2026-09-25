import { basename, isAbsolute, join, relative, sep } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { Data, Effect, Result } from "effect";
import {
  isUtcIsoTimestamp,
  type CliIssue,
  type ProjectRemoteWrites,
  type SnapshotInput,
  type WritebackMode,
} from "./contract.ts";
import { appendSectionLine } from "./resume-sections.ts";
import { mutateStateFile, StateMutationError, type StateMutationHooks } from "./state-mutation.ts";
import { validateStateText } from "./state.ts";
import { isRecord, sha256Hex } from "./values.ts";

/**
 * Source metadata carried by every normalized snapshot.
 */
export type SnapshotSource = {
  kind: "local" | "remote";
  tracker: string;
  reference: string;
  tracker_workflow: string | null;
};

/**
 * Deterministic digest and durable source reference for one snapshot input.
 */
export type SnapshotFileRecord = {
  path: string;
  source_reference: string;
  sha256: string;
};

/**
 * One input difference between the accepted and current snapshot revisions.
 */
export type SnapshotChange = {
  path: string;
  change: "added" | "changed" | "removed";
};

/**
 * Public result returned by snapshot integrity operations.
 */
export type SnapshotResult = {
  status: "unaccepted" | "unchanged" | "changed" | "accepted";
  scheduling_allowed: boolean;
  revision: string;
  accepted_revision: string | null;
  changed_inputs: SnapshotChange[];
  source: SnapshotSource;
  writeback: WritebackMode | null;
  inputs: SnapshotFileRecord[];
};

/**
 * Typed snapshot validation, policy, or persistence failure.
 */
export class SnapshotError extends Data.TaggedError("SnapshotError")<{
  issue: CliIssue;
}> {}

type SnapshotTicket = {
  number: string;
  path: string;
  sourceReference: string;
  blockedBy: string[];
};

type SnapshotManifest = {
  source: SnapshotSource;
  specification: {
    path: string;
    sourceReference: string;
  };
  tickets: SnapshotTicket[];
};

type SnapshotCandidate = {
  revision: string;
  source: SnapshotSource;
  inputs: SnapshotFileRecord[];
};

type AcceptedSnapshot = {
  revision: string;
  accepted_at: string;
  source: SnapshotSource;
  writeback: WritebackMode;
  inputs: SnapshotFileRecord[];
};

type StateDocument = {
  markdown: string;
  accepted: AcceptedSnapshot | undefined;
};

const invalidSnapshot = (problems: string[]): SnapshotError =>
  new SnapshotError({
    issue: {
      code: "snapshot.invalid",
      message: problems.join("; "),
      remediation:
        "Repair snapshot.json and its referenced files so the specification and every ticket are complete and consistent.",
    },
  });

const readFailure = (path: string, error: unknown): SnapshotError =>
  new SnapshotError({
    issue: {
      code: "snapshot.read_failed",
      message: `Could not read snapshot input ${path}: ${(error as Error).message}`,
      remediation: "Verify the normalized snapshot exists and every referenced file is readable.",
    },
  });

const stateFailure = (message: string): SnapshotError =>
  new SnapshotError({
    issue: {
      code: "snapshot.state_invalid",
      message,
      remediation: "Repair the Snapshot section in RESUME.md manually, then retry.",
    },
  });

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isWritebackMode = (value: unknown): value is WritebackMode =>
  value === "none" || value === "final" || value === "live";

const isRelativeSnapshotPath = (path: string): boolean =>
  !isAbsolute(path) &&
  path.length > 0 &&
  !path.startsWith("./") &&
  !path.split("/").includes("..") &&
  !path.includes("\\");

const directCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const parseManifest = (value: unknown): Effect.Effect<SnapshotManifest, SnapshotError> =>
  Effect.gen(function* () {
    const problems: string[] = [];
    if (!isRecord(value)) return yield* invalidSnapshot(["snapshot.json must contain an object"]);
    if (value.schema_version !== 1) {
      problems.push("snapshot.json must use schema_version 1");
    }

    const sourceValue = value.source;
    let source: SnapshotSource | undefined;
    if (!isRecord(sourceValue)) {
      problems.push("snapshot.json requires source metadata");
    } else {
      const kind = sourceValue.kind;
      const tracker = sourceValue.tracker;
      const reference = sourceValue.reference;
      const workflow = sourceValue.tracker_workflow;
      if (kind !== "local" && kind !== "remote") {
        problems.push("Snapshot source kind must be `local` or `remote`");
      }
      if (!isNonEmptyString(tracker)) problems.push("Snapshot source tracker is required");
      if (!isNonEmptyString(reference)) problems.push("Snapshot source reference is required");
      if (kind === "local" && workflow !== null) {
        problems.push("Local snapshot sources must set tracker_workflow to null");
      }
      if (kind === "remote" && !isNonEmptyString(workflow)) {
        problems.push("Remote snapshot sources require a configured tracker_workflow");
      }
      if (
        (kind === "local" || kind === "remote") &&
        isNonEmptyString(tracker) &&
        isNonEmptyString(reference) &&
        ((kind === "local" && workflow === null) ||
          (kind === "remote" && isNonEmptyString(workflow)))
      ) {
        source = {
          kind,
          tracker,
          reference,
          tracker_workflow: typeof workflow === "string" ? workflow : null,
        };
      }
    }

    const specificationValue = value.specification;
    let specification: SnapshotManifest["specification"] | undefined;
    if (!isRecord(specificationValue)) {
      problems.push("snapshot.json requires specification metadata");
    } else {
      if (specificationValue.agreed !== true) {
        problems.push("Snapshot specification must be explicitly agreed");
      }
      if (
        !isNonEmptyString(specificationValue.path) ||
        !isRelativeSnapshotPath(specificationValue.path)
      ) {
        problems.push("Snapshot specification path must be a safe relative path");
      }
      if (!isNonEmptyString(specificationValue.source_reference)) {
        problems.push("Snapshot specification requires a stable source_reference");
      }
      if (
        specificationValue.agreed === true &&
        isNonEmptyString(specificationValue.path) &&
        isRelativeSnapshotPath(specificationValue.path) &&
        isNonEmptyString(specificationValue.source_reference)
      ) {
        specification = {
          path: specificationValue.path,
          sourceReference: specificationValue.source_reference,
        };
      }
    }

    const ticketsValue = value.tickets;
    const tickets: SnapshotTicket[] = [];
    if (!Array.isArray(ticketsValue) || ticketsValue.length === 0) {
      problems.push("snapshot.json requires at least one numbered ticket");
    } else {
      for (const [index, ticketValue] of ticketsValue.entries()) {
        if (!isRecord(ticketValue)) {
          problems.push(`Snapshot ticket at index ${index} must be an object`);
          continue;
        }
        const number = ticketValue.number;
        const path = ticketValue.path;
        const sourceReference = ticketValue.source_reference;
        const blockedBy = ticketValue.blocked_by;
        if (!isNonEmptyString(number) || !/^\d{2,}$/u.test(number)) {
          problems.push(`Snapshot ticket at index ${index} requires a zero-padded number`);
        }
        if (!isNonEmptyString(path) || !isRelativeSnapshotPath(path)) {
          problems.push(`Snapshot ticket ${String(number)} requires a safe relative path`);
        }
        if (!isNonEmptyString(sourceReference)) {
          problems.push(`Snapshot ticket ${String(number)} requires a stable source_reference`);
        }
        if (
          !Array.isArray(blockedBy) ||
          blockedBy.some((blocker) => typeof blocker !== "string" || !/^\d{2,}$/u.test(blocker))
        ) {
          problems.push(`Snapshot ticket ${String(number)} requires numbered blocked_by entries`);
        }
        if (
          isNonEmptyString(number) &&
          /^\d{2,}$/u.test(number) &&
          isNonEmptyString(path) &&
          isRelativeSnapshotPath(path) &&
          isNonEmptyString(sourceReference) &&
          Array.isArray(blockedBy) &&
          blockedBy.every(
            (blocker): blocker is string =>
              typeof blocker === "string" && /^\d{2,}$/u.test(blocker),
          )
        ) {
          tickets.push({ number, path, sourceReference, blockedBy });
        }
      }
    }

    const numbers = new Set<string>();
    const paths = new Set<string>();
    for (const ticket of tickets) {
      if (numbers.has(ticket.number))
        problems.push(`Snapshot ticket ${ticket.number} is duplicated`);
      if (paths.has(ticket.path)) problems.push(`Snapshot input ${ticket.path} is duplicated`);
      if (!basename(ticket.path).startsWith(`${ticket.number}-`)) {
        problems.push(`Snapshot ticket ${ticket.number} path must begin with ${ticket.number}-`);
      }
      numbers.add(ticket.number);
      paths.add(ticket.path);
    }
    if (specification?.path === "snapshot.json") {
      problems.push("Snapshot input snapshot.json is duplicated");
    }
    if (specification !== undefined && paths.has(specification.path)) {
      problems.push(`Snapshot input ${specification.path} is duplicated`);
    }
    for (const ticket of tickets) {
      for (const blocker of ticket.blockedBy) {
        if (!numbers.has(blocker)) {
          problems.push(`Snapshot ticket ${ticket.number} references unknown blocker ${blocker}`);
        }
        if (blocker === ticket.number) {
          problems.push(`Snapshot ticket ${ticket.number} cannot block itself`);
        }
      }
    }

    if (problems.length > 0 || source === undefined || specification === undefined) {
      return yield* invalidSnapshot(problems);
    }
    return { source, specification, tickets };
  });

const readSnapshotText = (path: string): Effect.Effect<string, SnapshotError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) => readFailure(path, error),
  });

const resolveRealPath = (path: string): Effect.Effect<string, SnapshotError> =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: (error) => readFailure(path, error),
  });

const resolvesWithin = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
};

const resolveSnapshotInput = (
  runRoot: string,
  inputPath: string,
): Effect.Effect<string, SnapshotError> =>
  resolveRealPath(join(runRoot, inputPath)).pipe(
    Effect.flatMap((resolvedPath) =>
      resolvesWithin(runRoot, resolvedPath)
        ? Effect.succeed(resolvedPath)
        : Effect.fail(
            invalidSnapshot([`Snapshot input ${inputPath} resolves outside the run folder`]),
          ),
    ),
  );

const parseBlockedBy = (markdown: string): string[] | undefined => {
  const line = markdown
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("**Blocked by:**"));
  if (line === undefined) return undefined;
  const value = line.slice("**Blocked by:**".length).trim();
  if (/^(?:none|-)[.]?$/iu.test(value)) return [];
  return [...value.matchAll(/\b(\d{2,})\s*:/gu)].map((match) => match[1]!);
};

const digest = (content: string | Uint8Array): string => sha256Hex(content);

const loadCandidate = (runPath: string): Effect.Effect<SnapshotCandidate, SnapshotError> =>
  Effect.gen(function* () {
    const runRoot = yield* resolveRealPath(runPath);
    const manifestPath = yield* resolveSnapshotInput(runRoot, "snapshot.json");
    const manifestText = yield* readSnapshotText(manifestPath);
    const manifestValue = yield* Effect.try({
      try: () => JSON.parse(manifestText) as unknown,
      catch: () => invalidSnapshot(["snapshot.json is not valid JSON"]),
    });
    const manifest = yield* parseManifest(manifestValue);
    const problems: string[] = [];

    const specificationPath = yield* resolveSnapshotInput(runRoot, manifest.specification.path);
    const specificationText = yield* readSnapshotText(specificationPath);
    if (specificationText.trim().length === 0) {
      problems.push("Snapshot specification is empty");
    }

    const ticketTexts = yield* Effect.all(
      manifest.tickets.map((ticket) =>
        resolveSnapshotInput(runRoot, ticket.path).pipe(
          Effect.flatMap(readSnapshotText),
          Effect.map((markdown) => ({ ticket, markdown })),
        ),
      ),
      { concurrency: "unbounded" },
    );
    for (const { ticket, markdown } of ticketTexts) {
      const blockedBy = parseBlockedBy(markdown);
      if (blockedBy === undefined) {
        problems.push(`Snapshot ticket ${ticket.number} is missing a Blocked by field`);
      } else if (JSON.stringify(blockedBy) !== JSON.stringify(ticket.blockedBy)) {
        problems.push(
          `Snapshot ticket ${ticket.number} blocking edges disagree with snapshot.json`,
        );
      }
      if (!/^\*\*Status:\*\*\s+\S+/mu.test(markdown)) {
        problems.push(`Snapshot ticket ${ticket.number} is missing a Status field`);
      }
      if (!/^- \[[ xX]\]\s+\S+/mu.test(markdown)) {
        problems.push(`Snapshot ticket ${ticket.number} has no acceptance criteria`);
      }
    }
    if (problems.length > 0) return yield* invalidSnapshot(problems);

    const inputs: SnapshotFileRecord[] = [
      {
        path: "snapshot.json",
        source_reference: manifest.source.reference,
        sha256: digest(manifestText),
      },
      {
        path: manifest.specification.path,
        source_reference: manifest.specification.sourceReference,
        sha256: digest(specificationText),
      },
      ...ticketTexts.map(({ ticket, markdown }) => ({
        path: ticket.path,
        source_reference: ticket.sourceReference,
        sha256: digest(markdown),
      })),
    ].toSorted((left, right) => directCompare(left.path, right.path));
    return {
      revision: revisionForInputs(inputs),
      source: manifest.source,
      inputs,
    };
  });

const revisionForInputs = (inputs: SnapshotFileRecord[]): string => {
  const revisionMaterial = inputs.map((input) => `${input.path}\0${input.sha256}\n`).join("");
  return `sha256:${digest(revisionMaterial)}`;
};

const isSnapshotSource = (value: unknown): value is SnapshotSource => {
  if (
    !isRecord(value) ||
    (value.kind !== "local" && value.kind !== "remote") ||
    !isNonEmptyString(value.tracker) ||
    !isNonEmptyString(value.reference)
  ) {
    return false;
  }
  if (value.kind === "local") return value.tracker_workflow === null;
  return isNonEmptyString(value.tracker_workflow);
};

const isSnapshotFileRecord = (value: unknown): value is SnapshotFileRecord =>
  isRecord(value) &&
  isNonEmptyString(value.path) &&
  isRelativeSnapshotPath(value.path) &&
  isNonEmptyString(value.source_reference) &&
  typeof value.sha256 === "string" &&
  /^[a-f0-9]{64}$/u.test(value.sha256);

const parseAcceptedSnapshot = (value: unknown): AcceptedSnapshot | undefined => {
  if (
    !isRecord(value) ||
    typeof value.revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.revision) ||
    !isUtcIsoTimestamp(value.accepted_at) ||
    !isSnapshotSource(value.source) ||
    !isWritebackMode(value.writeback) ||
    !Array.isArray(value.inputs) ||
    value.inputs.length === 0 ||
    !value.inputs.every(isSnapshotFileRecord)
  ) {
    return undefined;
  }
  if (value.source.kind === "local" && value.writeback !== "none") return undefined;
  const inputs = value.inputs;
  const paths = inputs.map((input) => input.path);
  if (new Set(paths).size !== paths.length) return undefined;
  const sortedPaths = paths.toSorted(directCompare);
  if (paths.some((path, index) => path !== sortedPaths[index])) return undefined;
  if (revisionForInputs(inputs) !== value.revision) return undefined;
  return {
    revision: value.revision,
    accepted_at: value.accepted_at,
    source: value.source,
    writeback: value.writeback,
    inputs,
  };
};

const snapshotSectionPattern = /^## Snapshot\n\n```json\n([\s\S]*?)\n```(?:\n|$)/mu;

const parseStateDocument = (
  path: string,
  markdown: string,
): Effect.Effect<StateDocument, SnapshotError> =>
  Effect.gen(function* () {
    const validation = yield* Effect.result(validateStateText(path, markdown));
    if (Result.isFailure(validation)) {
      return yield* new SnapshotError({ issue: validation.failure.issue });
    }
    const snapshotHeadings = [...markdown.matchAll(/^## Snapshot$/gmu)];
    if (snapshotHeadings.length > 1) {
      return yield* stateFailure("RESUME.md contains more than one Snapshot section.");
    }
    const match = snapshotSectionPattern.exec(markdown);
    if (snapshotHeadings.length === 0) return { markdown, accepted: undefined };
    if (match === null) {
      return yield* stateFailure("RESUME.md has a malformed Snapshot section.");
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(match[1]!) as unknown,
      catch: () => stateFailure("RESUME.md has malformed JSON in its Snapshot section."),
    });
    const accepted = parseAcceptedSnapshot(parsed);
    if (accepted === undefined) {
      return yield* stateFailure("RESUME.md has an invalid accepted Snapshot record.");
    }
    return { markdown, accepted };
  });

const readStateDocument = (path: string): Effect.Effect<StateDocument, SnapshotError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) =>
      stateFailure(`Could not read run state at ${path}: ${(error as Error).message}`),
  }).pipe(Effect.flatMap((markdown) => parseStateDocument(path, markdown)));

const changedInputs = (
  accepted: AcceptedSnapshot | undefined,
  candidate: SnapshotCandidate,
): SnapshotChange[] => {
  if (accepted === undefined) return [];
  const previous = new Map(accepted.inputs.map((input) => [input.path, input]));
  const current = new Map(candidate.inputs.map((input) => [input.path, input]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].toSorted(directCompare);
  const changes: SnapshotChange[] = [];
  for (const path of paths) {
    const before = previous.get(path);
    const after = current.get(path);
    if (before === undefined) {
      changes.push({ path, change: "added" });
    } else if (after === undefined) {
      changes.push({ path, change: "removed" });
    } else if (
      before.sha256 !== after.sha256 ||
      before.source_reference !== after.source_reference
    ) {
      changes.push({ path, change: "changed" });
    }
  }
  return changes;
};

const writebackPolicyError = (
  source: SnapshotSource,
  mode: WritebackMode | undefined,
  authority: ProjectRemoteWrites,
): SnapshotError | undefined => {
  if (source.kind === "remote" && mode === undefined) {
    return new SnapshotError({
      issue: {
        code: "snapshot.writeback_required",
        message:
          "Non-local snapshot sources require a `none`, `final`, or `live` writeback decision.",
        remediation: "Choose a writeback mode explicitly, then retry snapshot acceptance.",
      },
    });
  }
  if (source.kind === "local" && mode !== undefined && mode !== "none") {
    return new SnapshotError({
      issue: {
        code: "snapshot.writeback_not_applicable",
        message: `Local snapshot sources cannot use remote writeback mode \`${mode}\`.`,
        remediation: "Use writeback mode `none` for a local-file snapshot.",
      },
    });
  }
  if (authority === "forbidden" && mode !== undefined && mode !== "none") {
    return new SnapshotError({
      issue: {
        code: "snapshot.writeback_forbidden",
        message: `Project authority forbids remote writes, so writeback mode \`${mode}\` cannot be used.`,
        remediation: "Use writeback mode `none` or change the authoritative project policy.",
      },
    });
  }
  return undefined;
};

const resultFor = (
  status: SnapshotResult["status"],
  candidate: SnapshotCandidate,
  acceptedRevision: string | null,
  changes: SnapshotChange[],
  writeback: WritebackMode | null,
): SnapshotResult => ({
  status,
  scheduling_allowed: status === "unchanged" || status === "accepted",
  revision: candidate.revision,
  accepted_revision: acceptedRevision,
  changed_inputs: changes,
  source: candidate.source,
  writeback,
  inputs: candidate.inputs,
});

const replaceSnapshotSection = (markdown: string, accepted: AcceptedSnapshot): string => {
  const section = `## Snapshot\n\n\`\`\`json\n${JSON.stringify(accepted, null, 2)}\n\`\`\``;
  if (snapshotSectionPattern.test(markdown)) {
    return markdown.replace(snapshotSectionPattern, `${section}\n`);
  }
  const decisionsIndex = markdown.search(/^## Decisions$/mu);
  if (decisionsIndex >= 0) {
    const before = markdown.slice(0, decisionsIndex).trimEnd();
    const after = markdown.slice(decisionsIndex);
    return `${before}\n\n${section}\n\n${after}`;
  }
  return `${markdown.trimEnd()}\n\n${section}\n`;
};

const appendDecision = (markdown: string, decision: string): string =>
  appendSectionLine(markdown, "Decisions", decision, { spacing: "blank" });

const acceptanceDecision = (
  acceptedAt: string,
  prior: AcceptedSnapshot | undefined,
  candidate: SnapshotCandidate,
  changes: SnapshotChange[],
  writeback: WritebackMode,
): string => {
  const date = acceptedAt.slice(0, 10);
  if (prior === undefined) {
    return `- ${date} snapshot revision ${candidate.revision} accepted (initial; writeback: ${writeback})`;
  }
  if (prior.revision !== candidate.revision) {
    const changed = changes.map((change) => change.path).join(", ");
    return `- ${date} snapshot revision ${prior.revision} -> ${candidate.revision} accepted (changed: ${changed}; writeback: ${writeback})`;
  }
  return `- ${date} snapshot writeback ${prior.writeback} -> ${writeback} accepted for revision ${candidate.revision}`;
};

/**
 * Validates the current normalized snapshot against the accepted run-state revision.
 *
 * @param input - Snapshot paths and current project remote-write authority.
 * @returns An Effect containing integrity status and all changed input paths.
 */
export const checkSnapshot = (input: SnapshotInput): Effect.Effect<SnapshotResult, SnapshotError> =>
  Effect.gen(function* () {
    const candidate = yield* loadCandidate(input.runPath);
    const state = yield* readStateDocument(input.statePath);
    if (state.accepted === undefined) {
      const initialWriteback = candidate.source.kind === "local" ? "none" : null;
      return resultFor("unaccepted", candidate, null, [], initialWriteback);
    }
    const writeback = state.accepted.writeback;
    const policyError = writebackPolicyError(
      candidate.source,
      writeback,
      input.projectRemoteWrites,
    );
    if (policyError !== undefined) return yield* policyError;
    const changes = changedInputs(state.accepted, candidate);
    const unchanged = state.accepted.revision === candidate.revision && changes.length === 0;
    return resultFor(
      unchanged ? "unchanged" : "changed",
      candidate,
      state.accepted.revision,
      changes,
      state.accepted.writeback,
    );
  });

/**
 * Explicitly accepts the current normalized snapshot and records it in run state.
 *
 * @param input - Snapshot paths, acceptance time, writeback choice, and project authority.
 * @param hooks - Optional deterministic state-mutation hooks for tests.
 * @returns An Effect containing the newly accepted revision after state persistence.
 */
export const acceptSnapshot = (
  input: SnapshotInput,
  hooks: StateMutationHooks | undefined = undefined,
): Effect.Effect<SnapshotResult, SnapshotError> =>
  Effect.gen(function* () {
    const candidate = yield* loadCandidate(input.runPath);
    return yield* mutateStateFile(
      input.statePath,
      (markdown) =>
        Effect.gen(function* () {
          const state = yield* parseStateDocument(input.statePath, markdown);
          const priorRemoteWriteback =
            state.accepted?.source.kind === "remote" ? state.accepted.writeback : undefined;
          const writeback =
            candidate.source.kind === "local"
              ? (input.writeback ?? "none")
              : (input.writeback ?? priorRemoteWriteback);
          const policyError = writebackPolicyError(
            candidate.source,
            writeback,
            input.projectRemoteWrites,
          );
          if (policyError !== undefined) return yield* policyError;
          if (writeback === undefined || input.acceptedAt === undefined) {
            return yield* stateFailure(
              "Snapshot acceptance is missing its accepted_at or writeback value.",
            );
          }

          const changes = changedInputs(state.accepted, candidate);
          const sameAcceptance =
            state.accepted?.revision === candidate.revision &&
            state.accepted.writeback === writeback;
          const result = resultFor("accepted", candidate, candidate.revision, changes, writeback);
          if (sameAcceptance) return { markdown: undefined, result };

          const record: AcceptedSnapshot = {
            revision: candidate.revision,
            accepted_at: input.acceptedAt,
            source: candidate.source,
            writeback,
            inputs: candidate.inputs,
          };
          const decision = acceptanceDecision(
            input.acceptedAt,
            state.accepted,
            candidate,
            changes,
            writeback,
          );
          return {
            markdown: appendDecision(replaceSnapshotSection(state.markdown, record), decision),
            result,
          };
        }),
      hooks,
    ).pipe(
      Effect.mapError((error) =>
        error instanceof SnapshotError
          ? error
          : stateFailure(
              `Could not record accepted snapshot in ${input.statePath}: ${
                error instanceof StateMutationError ? error.message : (error as Error).message
              }`,
            ),
      ),
    );
  });
