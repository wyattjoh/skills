import { createHash } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

/**
 * Socket paths are short even when the run lives in a deeply nested worktree.
 * Socket messages only announce durable work; payloads are read from validated storage.
 */
export const callbackAddress = (directory: string, target: string): string => {
  const token = createHash("sha256").update(`${directory}\0${target}`).digest("hex").slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-fleet-${token}`
    : join(`/tmp/pi-fleet-${process.getuid?.() ?? "local"}`, `${token}.sock`);
};

const prepare = async (address: string): Promise<void> => {
  if (process.platform === "win32") return;
  const directory = `/tmp/pi-fleet-${process.getuid?.() ?? "local"}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Unsafe callback socket directory");
  try {
    const socket = await lstat(address);
    if (!socket.isSocket()) throw new Error("Callback address is occupied by a non-socket file");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  // Never remove an existing address here. The owner lease must be checked by resume first.
};

/**
 * Notify a live recipient once, with a fixed deadline. Offline recipients keep their outbox.
 */
export const notifyCallback = (
  directory: string,
  target: string,
  timeoutMs = 2_000,
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(callbackAddress(directory, target));
    let settled = false;
    let response = "";
    const done = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(delivered);
    };
    const deadline = setTimeout(() => done(false), timeoutMs);
    socket.on("error", () => done(false));
    // Keep the response channel open until the durable drain acknowledges the frame.
    socket.on("connect", () => socket.write("notify\n"));
    socket.on("data", (data: Buffer) => {
      response += data.toString("utf8");
      if (response.length > 64) return done(false);
      if (response.includes("\n")) done(response === "accepted\n");
    });
    socket.on("close", () => done(false));
  });

/**
 * Open a session-owned callback endpoint. No daemon, timer, or completion poll is created.
 */
export const listenCallbacks = async (
  directory: string,
  target: string,
  drain: () => Promise<void>,
  recoverDeadOwner: boolean,
  onError: ((error: Error) => void) | undefined = undefined,
): Promise<() => Promise<void>> => {
  const address = callbackAddress(directory, target);
  await prepare(address);
  if (recoverDeadOwner && process.platform !== "win32") {
    try {
      await unlink(address);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let request = "";
    let notified = false;
    // Frame the request explicitly: Bun 1.3 can close a half-ended Unix socket before
    // an asynchronous drain responds. The outbox still owns delivery identities.
    socket.on("data", (data: Buffer) => {
      if (notified) return;
      request += data.toString("utf8");
      if (request.length > 64) return socket.destroy();
      if (!request.includes("\n")) return;
      notified = true;
      if (request !== "notify\n") return socket.end("retry\n");
      void drain().then(
        () => socket.end("accepted\n"),
        () => socket.end("retry\n"),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", (error) => {
    onError?.(error);
  });
  server.unref();
  return async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined || ("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
          ? resolve()
          : reject(error),
      ),
    );
  };
};
