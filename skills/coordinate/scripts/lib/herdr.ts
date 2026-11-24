import { Effect, Schema } from "effect";
import { Proc } from "./proc.ts";

/**
 * A herdr-core or herdr-app call failed. `kind` keeps the core's error kind when it gave one.
 */
export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  command: Schema.String,
  kind: Schema.String,
  message: Schema.String,
}) {}

/**
 * Agent states that need the coordinator's attention.
 */
export const SETTLED: ReadonlySet<string> = new Set(["idle", "done", "blocked", "error"]);

/**
 * Terminal names `hc run --name` accepts.
 */
export const TERMINAL_NAME = /^[a-z0-9_-]{1,32}$/;

const Listed = Schema.Struct({
  address: Schema.String,
  agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  turn: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  where: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const ListDocument = Schema.Struct({
  terminals: Schema.Array(Listed),
  machines: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String }))),
  ),
});

const Got = Schema.Struct({
  address: Schema.String,
  pid: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  turn: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  status_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  status: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(Schema.NullOr(Schema.String)),
        state: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  foreground: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        argv: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
        cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
        pid: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});

/**
 * One terminal as `hc ls` lists it (no labels).
 */
export type ListedTerminal = {
  address: string;
  agent: string | undefined;
  cwd: string;
  live: boolean;
  status: string | undefined;
  turn: number;
  name: string | undefined;
  parent: string | undefined;
  where: string;
};

/**
 * One terminal as `hc get` shows it.
 */
export type Terminal = {
  address: string;
  name: string | undefined;
  cwd: string;
  parent: string | undefined;
  live: boolean;
  turn: number;
  statusMs: number | undefined;
  status: string | undefined;
  app: string | undefined;
  labels: Record<string, string>;
  argv: string[];
  /**
   * The terminal's root process.
   */
  pid: number | undefined;
};

const decodeJson = <A>(schema: Schema.Decoder<A>, command: string, text: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(text)),
    catch: (cause) =>
      new HerdrError({ command, kind: "unreadable_output", message: String(cause).slice(0, 300) }),
  });

const coreError = (command: string, text: string, exitCode: number): HerdrError => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = (parsed as { error: { kind?: unknown; message?: unknown } }).error;
      return new HerdrError({
        command,
        kind: typeof error.kind === "string" ? error.kind : "error",
        message: typeof error.message === "string" ? error.message : text.slice(0, 300),
      });
    }
  } catch {
    // Plain-text failure; fall through.
  }
  return new HerdrError({
    command,
    kind: "command_failed",
    message: text.trim().slice(0, 300) || `exit ${exitCode}`,
  });
};

const ENV = (): Record<string, string> => ({ ...process.env }) as Record<string, string>;

/**
 * Run an `hc` or `herdr-app` command and return stdout, mapping failures to `HerdrError`.
 * @param argv Program and arguments.
 * @param timeoutMs Budget.
 * @param stdin Text piped to the command, when it reads one.
 * @returns stdout.
 */
export const herdr = Effect.fn("herdr")(function* (
  argv: readonly string[],
  timeoutMs = 30_000,
  stdin: string | undefined = undefined,
) {
  const proc = yield* Proc;
  const command = argv.slice(0, 3).join(" ");
  const out = yield* proc
    .run(argv, { timeoutMs, env: ENV(), ...(stdin === undefined ? {} : { stdin }) })
    .pipe(
      Effect.mapError(
        (error) => new HerdrError({ command, kind: "spawn", message: error.message }),
      ),
    );
  if (out.exitCode !== 0) return yield* coreError(command, out.stderr || out.stdout, out.exitCode);
  return out.stdout;
});

/**
 * Parse `hc ls --json`.
 * @param text JSON text.
 * @returns Terminals.
 */
export const parseList = (text: string) =>
  Effect.map(parseListing(text), (listing) => listing.terminals);

/**
 * Parse `hc ls --json` with the other machines it lists and their connection state.
 * @param text JSON text.
 * @returns Terminals (this core's, then each connected machine's) and machines.
 */
export const parseListing = (text: string) =>
  Effect.map(decodeJson(ListDocument, "hc ls", text), (document) => ({
    machines: (document.machines ?? []).map((machine) => ({ ...machine })),
    terminals: document.terminals.map((terminal): ListedTerminal => ({
      address: terminal.address,
      agent: terminal.agent ?? undefined,
      cwd: terminal.cwd ?? "",
      live: (terminal.state ?? "live") === "live",
      status: terminal.status ?? undefined,
      turn: terminal.turn ?? 0,
      name: terminal.name ?? undefined,
      parent: terminal.parent ?? undefined,
      where: terminal.where ?? "",
    })),
  }));

/**
 * Parse `hc get --json`.
 * @param text JSON text.
 * @returns The terminal.
 */
export const parseGet = (text: string) =>
  Effect.map(decodeJson(Got, "hc get", text), (terminal): Terminal => ({
    address: terminal.address,
    name: terminal.name ?? undefined,
    cwd: terminal.foreground?.cwd ?? terminal.cwd ?? "",
    parent: terminal.parent ?? undefined,
    live: (terminal.state ?? "live") === "live",
    turn: terminal.turn ?? 0,
    statusMs: terminal.status_ms ?? undefined,
    status: terminal.status?.state ?? undefined,
    app: terminal.status?.app ?? undefined,
    labels: { ...terminal.labels },
    argv: [...(terminal.foreground?.argv ?? [])],
    pid: terminal.pid ?? undefined,
  }));

/**
 * Whether a listed terminal runs a coding agent (reports a status, or is a known agent program).
 * @param terminal Listed terminal.
 * @returns True for agents.
 */
export const isAgent = (terminal: ListedTerminal): boolean =>
  terminal.status !== undefined || terminal.agent === "claude-code" || terminal.agent === "pi";

/**
 * List terminals, optionally only those carrying every label.
 * @param labels `key=value` filters.
 * @param all Include finished terminals.
 * @returns Terminals.
 */
export const list = Effect.fn("hc.list")(function* (labels: readonly string[] = [], all = false) {
  return (yield* listing(labels, all)).terminals;
});

/**
 * List terminals like `list`, with the other machines Herdr knows and whether each is connected.
 * A machine that is not connected lists none of its terminals.
 * @param labels `key=value` filters.
 * @param all Include finished terminals.
 * @returns Terminals and machines.
 */
export const listing = Effect.fn("hc.listing")(function* (
  labels: readonly string[] = [],
  all = false,
) {
  const argv = [
    "hc",
    "ls",
    "--json",
    ...(all ? ["--all"] : []),
    ...labels.flatMap((label) => ["--label", label]),
  ];
  return yield* parseListing(yield* herdr(argv));
});

/**
 * One terminal, or undefined when herdr-core has no such terminal.
 * @param target Address or name.
 * @returns The terminal.
 */
export const get = Effect.fn("hc.get")(function* (target: string) {
  const result = yield* herdr(["hc", "get", target, "--json"]).pipe(
    Effect.map((text) => ({ text })),
    Effect.catchTag("HerdrError", (error) =>
      error.kind === "not_found" ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
  if (result === undefined) return undefined;
  return yield* parseGet(result.text);
});

const ServerStatus = Schema.Struct({ core: Schema.Struct({ name: Schema.String }) });

/**
 * This core's Herdr machine name, the name coordinate uses for this machine everywhere.
 * @returns The name from `hc server status --json`.
 */
export const coreName = Effect.fn("hc.coreName")(function* () {
  const status = yield* decodeJson(
    ServerStatus,
    "hc server status",
    yield* herdr(["hc", "server", "status", "--json"], 10_000),
  );
  return status.core.name;
});

const MachineList = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ name: Schema.String })),
});

/**
 * The other Herdr machines this core knows, connected or not.
 * @returns Their Herdr machine names, as `hc machine ls` lists them.
 */
export const machineNames = Effect.fn("hc.machineNames")(function* () {
  const listed = yield* decodeJson(
    MachineList,
    "hc machine ls",
    yield* herdr(["hc", "machine", "ls", "--json"], 10_000),
  );
  return listed.machines.map((machine) => machine.name);
});

/**
 * Read the online processor count from another Herdr machine.
 * @param machine Herdr machine name.
 * @returns The positive core count, or undefined when the output is invalid.
 */
export const coresOn = Effect.fn("hc.coresOn")(function* (machine: string) {
  const output = yield* herdr(
    ["hc", "exec", "--on", machine, "--timeout", "5", "getconf", "_NPROCESSORS_ONLN"],
    7_000,
  );
  const cores = Number(output.trim());
  return Number.isSafeInteger(cores) && cores > 0 ? cores : undefined;
});

/**
 * Run a POSIX shell script on another Herdr machine through `hc exec`, in a login shell so the
 * harness, git and the base tools are on its PATH. A non-zero exit is a `HerdrError`, so
 * scripts that report a finding print it and exit 0.
 * @param machine Herdr machine name.
 * @param script Shell script.
 * @param timeoutS Remote timeout in seconds (at most 600).
 * @returns stdout.
 */
export const execOn = Effect.fn("hc.execOn")(function* (
  machine: string,
  script: string,
  timeoutS = 60,
) {
  return yield* herdr(
    ["hc", "exec", "--on", machine, "--timeout", String(timeoutS), "--", "sh", "-lc", script],
    (timeoutS + 10) * 1000,
  );
});

/**
 * Write a text file on another Herdr machine (atomic, missing folders made).
 * @param machine Herdr machine name.
 * @param path Absolute path there.
 * @param content File text.
 */
export const writeFileOn = Effect.fn("hc.writeFileOn")(function* (
  machine: string,
  path: string,
  content: string,
) {
  yield* herdr(["hc", "file", "write", "--on", machine, path, "--json"], 30_000, content);
});

const FileRead = Schema.Struct({ text: Schema.String, last: Schema.Number, lines: Schema.Number });

/**
 * Read a whole text file on another Herdr machine, in pages when it is over Herdr's 8 MB cap.
 * @param machine Herdr machine name.
 * @param path Absolute path there.
 * @returns The file's text, or undefined when there is no such file.
 */
export const readFileOn = Effect.fn("hc.readFileOn")(function* (machine: string, path: string) {
  const parts: string[] = [];
  // hc has no line limit by default, but stops at 8 MB on a whole line and says where (`last` of
  // `lines`): read on from the next line until the last one is in.
  for (let offset = 1; ;) {
    const page = ["hc", "file", "read", "--on", machine, path, "--json"];
    if (offset > 1) page.push("--offset", String(offset));
    const result = yield* herdr(page, 30_000).pipe(
      Effect.map((text) => ({ text })),
      Effect.catchTag("HerdrError", (error) =>
        error.kind === "not_found" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (result === undefined) return offset === 1 ? undefined : parts.join("");
    const read = yield* decodeJson(FileRead, "hc file read", result.text);
    parts.push(read.text);
    if (read.last >= read.lines || read.last < offset) return parts.join("");
    offset = read.last + 1;
  }
});

/**
 * Set labels; an empty value removes one.
 * @param target Address or name.
 * @param labels Labels to set.
 */
export const label = Effect.fn("hc.label")(function* (
  target: string,
  labels: Record<string, string>,
) {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  if (pairs.length === 0) return;
  yield* herdr(["hc", "label", target, ...pairs, "--json"]);
});

/**
 * Paste text and press enter. hc waits for an unfinished draft and refuses a blocked terminal.
 * @param target Address or name.
 * @param text Message.
 */
export const send = Effect.fn("hc.send")(function* (target: string, text: string) {
  yield* herdr(["hc", "send", target, text, "--json"], 120_000);
});

/**
 * Screen and history as text.
 * @param target Address or name.
 * @param lines History limit.
 * @returns Text.
 */
export const read = Effect.fn("hc.read")(function* (target: string, lines = 80) {
  return yield* herdr(["hc", "read", target, "--lines", String(lines)]);
});

/**
 * End a terminal's program (if running) and remove its record.
 * @param target Address.
 */
export const end = Effect.fn("hc.end")(function* (target: string) {
  yield* herdr(["hc", "kill", target]).pipe(Effect.catch(() => Effect.void));
  yield* herdr(["hc", "rm", target]).pipe(
    Effect.catchTag("HerdrError", (error) =>
      error.kind === "not_found" ? Effect.void : Effect.fail(error),
    ),
  );
});

/**
 * What a launch needs.
 */
export type RunSpec = {
  name: string;
  cwd: string;
  labels: Record<string, string>;
  /**
   * Parent terminal on this core. With `machine`, only the terminal running this process
   * (`HC_TERMINAL_ID`) can be the parent; any other gets none.
   */
  parent: string | undefined;
  outliveParent: boolean;
  notifyParent: boolean;
  argv: readonly string[];
  /**
   * Another Herdr machine to run it on; undefined runs it on this core.
   */
  machine: string | undefined;
};

/**
 * Start a program in a new background terminal.
 * @param spec Name, folder, labels, parent and argv.
 * @returns The new terminal's address.
 */
export const run = Effect.fn("hc.run")(function* (spec: RunSpec) {
  const flags = [
    ...(spec.outliveParent ? ["--outlive-parent"] : []),
    ...(spec.notifyParent ? [] : ["--no-notify"]),
  ];
  // With --on, another machine's core resolves --parent and knows none of ours, but a terminal
  // run from one of ours takes the calling terminal as its parent across machines.
  const lineage =
    spec.parent === undefined
      ? ["--no-parent"]
      : spec.machine === undefined
        ? ["--parent", spec.parent, ...flags]
        : spec.parent === process.env.HC_TERMINAL_ID
          ? flags
          : ["--no-parent"];
  const argv = [
    "hc",
    "run",
    "--bg",
    "--json",
    "--name",
    spec.name,
    "--cwd",
    spec.cwd,
    ...(spec.machine === undefined ? [] : ["--on", spec.machine]),
    ...lineage,
    ...Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--",
    ...spec.argv,
  ];
  const started = yield* decodeJson(
    Schema.Struct({ address: Schema.String }),
    "hc run",
    yield* herdr(argv),
  );
  return started.address;
});

const AppSpace = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  folder: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tabs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      terminals: Schema.Array(
        Schema.Struct({
          terminal: Schema.String,
          pane: Schema.String,
          status: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
});

/**
 * A space in the open Herdr window.
 */
export type AppSpace = typeof AppSpace.Type;

/**
 * Spaces in the open window.
 * @returns Spaces with their tabs and terminals.
 */
export const appSpaces = Effect.fn("app.spaces")(function* () {
  const document = yield* decodeJson(
    Schema.Struct({ spaces: Schema.Array(AppSpace) }),
    "herdr-app ls",
    yield* herdr(["herdr-app", "ls"]),
  );
  return document.spaces;
});

/**
 * Run one herdr-app command with a JSON argument object.
 * @param command Command name.
 * @param args Arguments.
 * @returns stdout.
 */
export const appDo = Effect.fn("app.do")(function* (
  command: string,
  args: Record<string, unknown>,
) {
  return yield* herdr(["herdr-app", "do", command, JSON.stringify(args)]);
});

/**
 * Make a space in the background holding one placeholder shell.
 * @param name Space name.
 * @param folder Folder its terminals start in.
 * @param machine Another Herdr machine for the space to live on; undefined keeps it on this core.
 *   Its ids then come back qualified as `machine/id`.
 * @returns Space, tab and placeholder terminal ids.
 */
export const newSpace = Effect.fn("app.newSpace")(function* (
  name: string,
  folder: string,
  machine: string | undefined = undefined,
) {
  return yield* decodeJson(
    Schema.Struct({ space: Schema.String, tab: Schema.String, terminal: Schema.String }),
    "herdr-app space.new",
    yield* appDo("space.new", {
      name,
      folder,
      focus: false,
      ...(machine === undefined ? {} : { machine }),
    }),
  );
});

/**
 * Close a space and end its terminals, without the confirmation dialog.
 * @param id Space id.
 */
export const closeSpace = Effect.fn("app.closeSpace")(function* (id: string) {
  yield* appDo("space.close", { id, confirmed: true });
});
