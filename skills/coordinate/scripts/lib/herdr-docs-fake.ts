import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  DOC_LIMIT_BYTES,
  docNameProblem,
  type DocReply,
  type DocRequest,
  type DocTransport,
} from "./herdr-docs.ts";

/**
 * The documents of every core a fake can reach, and which of those cores are down.
 */
export type FakeDocCores = {
  /**
   * The name of the core the fake answers as (requests without `on`).
   */
  self: string;
  /**
   * Documents per core name, each with its value (null once deleted) and version.
   */
  docs: Record<string, Record<string, { value: unknown; version: number }>>;
  /**
   * Other machines the core knows, each up or down. A name missing here is unknown.
   */
  machines: Record<string, "up" | "down">;
  /**
   * Documents another writer keeps changing: every set on one of these names loses the race (the
   * version moves on and the set conflicts).
   */
  contended: string[];
};

/**
 * Fresh fake cores: this core and the machines it knows, all with no documents.
 * @param self This core's name.
 * @param machines Other machines, up or down.
 * @returns The cores.
 */
export const fakeDocCores = (
  self: string,
  machines: Record<string, "up" | "down"> = {},
): FakeDocCores => ({ self, docs: {}, machines: { ...machines }, contended: [] });

const error = (kind: string, message: string): DocReply => ({ ok: false, kind, message });

/**
 * Answer one request the way herdr-core 0.1.22 does (as probed): a name rule of 1-32 characters,
 * a 1 MiB limit on the serialized value, compare-and-set on the version, null as a tombstone that
 * keeps the name and bumps the version, and unknown or unreachable machines named in `on`.
 * @param cores Fake cores, changed in place by a successful set.
 * @param request The request.
 * @returns The reply.
 */
export const answerDocRequest = (cores: FakeDocCores, request: DocRequest): DocReply => {
  const target = request.params.on ?? cores.self;
  if (target !== cores.self) {
    const state = cores.machines[target];
    if (state === undefined) return error("machine_unknown", `unknown machine "${target}"`);
    if (state === "down")
      return error("unavailable", `${target} is unreachable: cannot reach ${target}`);
  }
  const name = request.params.name;
  if (docNameProblem(name) !== undefined)
    return error(
      "invalid_params",
      `bad name "${name}": use 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like an id (t7)`,
    );
  const docs = (cores.docs[target] ??= {});
  const current = docs[name] ?? { value: null, version: 0 };
  if (request.method === "doc.get") return { ok: true, result: { ...current } };
  if (cores.contended.includes(name)) {
    docs[name] = { value: current.value, version: current.version + 1 };
    return error(
      "conflict",
      `document "${name}" is at version ${current.version + 1}, not ${request.params.version}`,
    );
  }
  if (request.params.version !== current.version)
    return error(
      "conflict",
      `document "${name}" is at version ${current.version}, not ${request.params.version}`,
    );
  if (Buffer.byteLength(JSON.stringify(request.params.value)) > DOC_LIMIT_BYTES)
    return error("invalid_params", "document exceeds 1 MiB of JSON");
  const version = current.version + 1;
  docs[name] = { value: structuredClone(request.params.value), version };
  return { ok: true, result: { version } };
};

/**
 * An in-memory doc transport over fake cores, for tests.
 * @param cores Fake cores it answers from.
 * @returns The transport.
 */
export const memoryDocTransport =
  (cores: FakeDocCores): DocTransport =>
  (requests) =>
    Effect.sync(() => requests.map((request) => answerDocRequest(cores, request)));

const lock = async (path: string): Promise<string> => {
  const dir = `${path}.lock`;
  for (let tries = 0; ; tries += 1) {
    try {
      await mkdir(dir);
      return dir;
    } catch (cause) {
      if (tries > 2000) throw cause;
      await Bun.sleep(5);
    }
  }
};

/**
 * Serve `hc connect` from a JSON file of fake cores: read one JSON-RPC request per stdin line,
 * answer each against the file under a lock, and print one reply line per request. The CLI test
 * fixture's `hc` stub runs this for `hc connect`.
 * @param path The fake cores file (`FakeDocCores` as JSON).
 * @param input The request lines.
 * @returns The reply lines.
 */
export const serveDocFile = async (path: string, input: string): Promise<string> => {
  const held = await lock(path);
  try {
    const cores = JSON.parse(await readFile(path, "utf8")) as FakeDocCores;
    const lines = input
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const request = JSON.parse(line) as {
          id: number;
          method: string;
          params: DocRequest["params"];
        };
        const reply =
          request.method === "doc.get" || request.method === "doc.set"
            ? answerDocRequest(cores, {
                method: request.method,
                params: request.params,
              } as DocRequest)
            : error("unknown_method", `unknown method "${request.method}"`);
        return JSON.stringify(
          reply.ok
            ? { id: request.id, jsonrpc: "2.0", result: reply.result }
            : {
                id: request.id,
                jsonrpc: "2.0",
                error: { code: -32000, data: { kind: reply.kind }, message: reply.message },
              },
        );
      });
    await writeFile(`${path}.tmp`, JSON.stringify(cores));
    await rename(`${path}.tmp`, path);
    return lines.map((line) => `${line}\n`).join("");
  } finally {
    await rmdir(held);
  }
};

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: herdr-docs-fake.ts <cores.json>");
  process.stdout.write(await serveDocFile(path, await Bun.stdin.text()));
}
