// The gpui-kit, gpui-base and herdr doubles every suite in this project renders through.
// Elements keep their children, styles and callbacks so tests can assert ids, text and tones.
import { mock } from "bun:test";

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

const attached = new WeakSet<object>();

const element = (kind: string, asset: string | undefined = undefined): Node => {
  const node: Node = { kind, elementId: undefined, nodes: [], styles: {}, click: undefined };
  if (asset !== undefined) node.styles.asset = asset;
  const attach = (child: Node | string) => {
    if (typeof child !== "string") {
      if (attached.has(child)) throw new Error("an element was added to two parents");
      attached.add(child);
    }
    node.nodes.push(child);
  };
  const builder: Node = new Proxy(node, {
    get(target, key) {
      if (key === "then") return undefined;
      if (typeof key === "symbol" || key in target) return Reflect.get(target, key);
      if (key === "id")
        return (id: string) => {
          target.elementId = id;
          return builder;
        };
      if (key === "child")
        return (child: Node | string) => {
          attach(child);
          return builder;
        };
      if (key === "children")
        return (children: (Node | string)[]) => {
          children.forEach(attach);
          return builder;
        };
      if (key === "when")
        return (condition: unknown, branch: (el: Node) => Node) =>
          condition ? branch(builder) : builder;
      if (key === "on_click")
        return (handler: Node["click"]) => {
          target.click = handler;
          return builder;
        };
      if (key === "hover")
        return (declare: (el: Node) => unknown) => {
          const hovered = element("hover");
          declare(hovered);
          target.styles.hover = hovered.styles;
          return builder;
        };
      return (...args: unknown[]) => {
        target.styles[key] = args.length === 0 ? true : args.length === 1 ? args[0] : args;
        return builder;
      };
    },
  });
  return builder;
};

/**
 * The first element with this id, depth first.
 * @param root The rendered tree.
 * @param id The element id.
 * @returns The element, or undefined.
 */
export const find = (root: Node | string, id: string): Node | undefined => {
  if (typeof root === "string") return undefined;
  if (root.elementId === id) return root;
  for (const child of root.nodes) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
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
    : [
        ...(root.elementId?.startsWith(prefix) ? [root.elementId] : []),
        ...root.nodes.flatMap((child) => ids(child, prefix)),
      ];

/**
 * The element's text, its string descendants joined by single spaces.
 * @param root The element.
 * @returns The text.
 */
export const text = (root: Node | string): string =>
  typeof root === "string"
    ? root
    : root.nodes
        .map(text)
        .filter((part) => part !== "")
        .join(" ");

// oxlint-disable-next-line typescript/no-extraneous-class -- the empty base every mod View extends
class View {}

mock.module("gpui-kit", () => ({
  View,
  div: () => element("div"),
  svg: (path: string) => element("svg", path),
}));

mock.module("gpui-base", () => ({
  h_flex: () => element("h_flex"),
  v_flex: () => element("v_flex"),
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
};
