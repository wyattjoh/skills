import { expect, test } from "bun:test";

import { waitForRegistration } from "./registration.ts";

const controlled = () => {
  let listener: (() => void) | undefined;
  let closed = 0;
  return {
    subscribe: (changed: () => void) => {
      listener = changed;
      return {
        close: () => {
          closed++;
        },
      };
    },
    emit: () => listener?.(),
    closed: () => closed,
  };
};

test("startup registration reads an already-ready durable worker and releases its watcher", async () => {
  const watcher = controlled();
  await waitForRegistration(async () => true, watcher.subscribe, undefined, 100);
  expect(watcher.closed()).toBe(1);
});

test("startup uses durable readiness events, without waiting for worker completion", async () => {
  const watcher = controlled();
  let ready = false;
  const pending = waitForRegistration(async () => ready, watcher.subscribe, undefined, 100);
  ready = true;
  watcher.emit();
  await pending;
  expect(watcher.closed()).toBe(1);
});

test("startup has a hard deadline even if a durable read hangs", async () => {
  const watcher = controlled();
  await expect(
    waitForRegistration(() => new Promise(() => {}), watcher.subscribe, undefined, 10),
  ).rejects.toThrow("timed out; inspect before retrying");
  expect(watcher.closed()).toBe(1);
});

test("cancelled startup releases its watcher and preserves uncertainty", async () => {
  const watcher = controlled();
  const abort = new AbortController();
  const pending = waitForRegistration(async () => false, watcher.subscribe, abort.signal, 100);
  abort.abort();
  await expect(pending).rejects.toThrow("aborted; inspect before retrying");
  expect(watcher.closed()).toBe(1);
});
