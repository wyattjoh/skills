import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callbackAddress, listenCallbacks, notifyCallback } from "./callbacks.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const endpoint = async (drain: () => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "to-code-callback-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const target = "worker";
  cleanups.push(await listenCallbacks(directory, target, drain, false));
  return { directory, target };
};

test("callback drains a newline-framed request without requiring the requester to half-close", async () => {
  let drains = 0;
  const { directory, target } = await endpoint(async () => {
    drains += 1;
  });
  const response = await new Promise<string>((resolve) => {
    const socket = createConnection(callbackAddress(directory, target));
    let received = "";
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.on("error", (error) => {
      socket.destroy();
      resolve(error.message);
    });
    socket.on("connect", () => socket.write("notify\n"));
    socket.on("data", (data: Buffer) => {
      received += data.toString("utf8");
      if (!received.includes("\n")) return;
      socket.destroy();
      resolve(received);
    });
    socket.on("close", () => resolve(received));
  });
  expect(response).toBe("accepted\n");
  expect(drains).toBe(1);
});

test("callback acknowledgment follows the completed durable drain", async () => {
  let drained = false;
  const { directory, target } = await endpoint(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    drained = true;
  });
  expect(await notifyCallback(directory, target)).toBe(true);
  expect(drained).toBe(true);
});
