// Local test-only extensions for host services and retained input state.
import { mock } from "bun:test";
import { byId, nodeOf, texts, walk } from "@wyattjoh/herdr-dev/test/renderer";
import type { Node as SharedNode } from "@wyattjoh/herdr-dev/test/renderer";
import { div } from "gpui-kit";

/**
 * One rendered element: its id, children, the style calls made on it and its callbacks.
 */
export type Node = {
  kind: string;
  elementId: string | undefined;
  nodes: (Node | string)[];
  styles: Record<string, unknown>;
  click: ((event: unknown, cx: unknown) => void) | undefined;
};

const adapt = (node: SharedNode): Node => ({
  ...node,
  elementId: node.styles.id as string | undefined,
  nodes: node.children as (Node | string)[],
});

/**
 * The first element with this id, depth first.
 * @param root The rendered tree.
 * @param id The element id.
 * @returns The element, or undefined.
 */
export const find = (root: Node | string, id: string): Node | undefined => {
  if (typeof root === "string") return undefined;
  const found = byId(root, id);
  return found ? adapt(found) : undefined;
};

/**
 * Like find, but fails the test when the element is missing.
 * @param root The rendered tree.
 * @param id The element id.
 * @returns The element.
 */
export const get = (root: Node | string, id: string): Node => {
  const found = find(root, id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found;
};

/**
 * Every id in the tree that starts with a prefix, in render order.
 * @param root The rendered tree.
 * @param prefix The id prefix.
 * @returns The matching ids.
 */
export const ids = (root: Node | string, prefix: string): string[] =>
  typeof root === "string"
    ? []
    : walk(root)
        .map((node) => node.styles.id)
        .filter((id): id is string => typeof id === "string" && id.startsWith(prefix));

/**
 * The element's text, its string descendants joined by single spaces.
 * @param root The element.
 * @returns The text.
 */
export const text = (root: Node | string): string =>
  typeof root === "string" ? root : texts(root).join(" ");

/**
 * A retained text field's state, as InputState.new makes it: its value and its event handlers.
 */
export type FakeInput = {
  placeholder: string | undefined;
  current: string;
  handlers: Map<string, (event: unknown, cx: unknown) => void>;
  value: () => string;
  set_value: (next: string) => void;
  on: (event: string, handler: (event: unknown, cx: unknown) => void) => boolean;
};

const fakeInput = (options: { placeholder?: string; value?: string } = {}): FakeInput => {
  const input: FakeInput = {
    placeholder: options.placeholder,
    current: options.value ?? "",
    handlers: new Map(),
    value: () => input.current,
    set_value: (next) => {
      input.current = next;
    },
    on: (event, handler) => {
      input.handlers.set(event, handler);
      return true;
    },
  };
  host.inputs.push(input);
  return input;
};

/**
 * Type into a field as a person does: the value changes, then its change handler runs.
 * @param input The field's state.
 * @param value The whole new value.
 * @param cx The context the handler gets.
 */
export const typeInto = (input: FakeInput, value: string, cx: unknown) => {
  input.current = value;
  input.handlers.get("change")?.({}, cx);
};

// Bun cannot extend a registered mock's named exports. Keep only these base-element adapters,
// and build every one with the shared renderer's GPUI element factory.
const baseElement = (kind: string) => {
  const value = div();
  nodeOf(value).kind = kind;
  return value;
};

const baseFactory = (kind: string) => ({
  new: (id?: unknown, extra?: unknown) => {
    const value = baseElement(kind);
    if (id !== undefined) nodeOf(value).styles.ctor = extra === undefined ? id : [id, extra];
    return value;
  },
});

mock.module("gpui-base", () => ({
  h_flex: () => baseElement("h_flex"),
  v_flex: () => baseElement("v_flex"),
  InputState: { new: fakeInput },
  Input: {
    new: (state: FakeInput) => {
      const value = baseElement("Input");
      nodeOf(value).styles.state = state;
      return value;
    },
  },
  Popover: baseFactory("Popover"),
  Scrollbar: { vertical: baseFactory("Scrollbar").new },
  TextView: { markdown: baseFactory("TextView").new, new: baseFactory("TextView").new },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * One pending watchFolder call, settled by the test.
 */
export type Watch = {
  path: string;
  cancelled: boolean;
  fire: (paths: string[]) => void;
  fail: (error: unknown) => void;
};

/**
 * The fake host: files on disk, terminals, focus and the watches a mod is holding.
 */
export const host = {
  files: new Map<string, string>(),
  terminals: [] as Record<string, unknown>[],
  focused: null as {
    space: string;
    tab: string;
    pane: string | null;
    terminal: string | null;
  } | null,
  watches: [] as Watch[],
  reads: [] as string[],
  // Paths whose read rejects, as an unreadable file does.
  unreadable: new Set<string>(),
  // Every exec call, and how the next ones end: a rejection, or a non-zero exit.
  execs: [] as { command: string; args: string[] }[],
  execRejects: undefined as unknown,
  execExit: undefined as { code: number; stderr: string } | undefined,
  checking: false,
  // The shown layout tree, shared values, commands the mod ran, and pending nextCommand calls.
  layout: null as unknown,
  shared: new Map<string, unknown>(),
  runs: [] as { command: string; args: Record<string, unknown> | undefined }[],
  commandReaders: [] as ((command: string) => void)[],
  // Every text field state a mod made.
  inputs: [] as FakeInput[],
};

/**
 * Deliver a key command to the mod's pending nextCommand(), as keys.json's "<mod>.<command>" does.
 * @param command The command after the mod name.
 */
export const sendCommand = (command: string) => {
  const reader = host.commandReaders.shift();
  if (!reader) throw new Error("no nextCommand is waiting");
  reader(command);
};

// The panel's listing protocol (sh -c LIST_SCRIPT name folder): each *.json basename in the
// folder without its extension, NUL-terminated; nothing at all when the folder is missing.
const listFolder = (folder: string): string =>
  [...host.files.keys()]
    .filter((path) => path.startsWith(`${folder}/`) && path.endsWith(".json"))
    .map((path) => path.slice(folder.length + 1, -".json".length))
    .filter((name) => !name.includes("/"))
    .map((name) => `${name}\0`)
    .join("");

// The shared renderer provides an empty herdr mock; these host services extend it for these tests.
mock.module("herdr", () => ({
  checking: () => host.checking,
  home: () => "/Users/test",
  theme: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => (typeof key === "string" ? key : undefined),
      },
    ),
  terminals: () => host.terminals,
  focused: () => host.focused,
  layout: () => host.layout,
  shared: (key: string) => host.shared.get(key),
  setShared: (key: string, value: unknown) => {
    host.shared.set(key, value);
    return null;
  },
  run: (command: string, args?: Record<string, unknown>) => {
    host.runs.push({ command, args });
    return null;
  },
  nextCommand: () => new Promise<string>((resolve) => host.commandReaders.push(resolve)),
  readTextFile: async (path: string) => {
    host.reads.push(path);
    if (host.unreadable.has(path)) throw new Error(`permission denied: ${path}`);
    return host.files.get(path) ?? null;
  },
  exec: async (command: string, args: string[] = []) => {
    host.execs.push({ command, args });
    if (host.execRejects !== undefined) throw host.execRejects;
    if (host.execExit !== undefined) return { stdout: "", ...host.execExit };
    return { code: 0, stdout: listFolder(args.at(-1) ?? ""), stderr: "" };
  },
  watchFolder: (path: string) => {
    const pending = deferred<string[]>();
    const watch: Watch = {
      path,
      cancelled: false,
      fire: pending.resolve,
      fail: pending.reject,
    };
    host.watches.push(watch);
    return Object.assign(pending.promise, {
      cancel: () => {
        watch.cancelled = true;
        pending.resolve([]);
      },
    });
  },
}));

/**
 * A repeating timer the mod registered.
 */
export type Timer = { ms: number; handler: (cx: unknown) => void; cancelled: boolean };

/**
 * A fake context: spawned bodies run at once, timers wait for the test to fire them.
 * @returns The context and its timers.
 */
export const context = () => {
  const timers: Timer[] = [];
  let notified = 0;
  const cx = {
    notify: () => {
      notified += 1;
    },
    stop_propagation: () => {},
    spawn: (body: (cx: unknown) => unknown) => {
      void Promise.resolve(body(cx));
      return { cancel: () => {} };
    },
    timer: {
      every: (ms: number, handler: (cx: unknown) => void) => {
        const timer: Timer = { ms, handler, cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
  };
  return {
    cx,
    timers,
    get notified() {
      return notified;
    },
    /**
     * Fire every live timer registered with this period.
     * @param ms The period.
     */
    tick: (ms: number) => {
      for (const timer of timers) if (timer.ms === ms && !timer.cancelled) timer.handler(cx);
    },
  };
};

/**
 * Let pending host reads and spawned bodies run to their next await.
 */
export const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Put the fake host back to empty between tests.
 */
export const resetHost = () => {
  host.files = new Map();
  host.terminals = [];
  host.focused = null;
  host.watches = [];
  host.reads = [];
  host.unreadable = new Set();
  host.execs = [];
  host.execRejects = undefined;
  host.execExit = undefined;
  host.checking = false;
  host.layout = null;
  host.shared = new Map();
  host.runs = [];
  host.commandReaders = [];
  host.inputs = [];
};
