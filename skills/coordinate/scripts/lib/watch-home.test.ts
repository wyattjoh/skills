import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { createDocument, itemAdd, itemUpdate } from "./backlog-doc.ts";
import type { ItemUpdate } from "./backlog-store/ops.ts";
import { type Config, resolveConfig } from "./config.ts";
import { runWith, tempDir } from "./fixture.ts";
import type { DocSubscriber } from "./herdr-docs.ts";
import {
  fakeDocCores,
  memoryDocSubscriber,
  memoryDocTransport,
  type FakeDocCores,
} from "./herdr-docs-fake.ts";
import { fakeProc, ok, type RunOutput } from "./proc.ts";
import { registerStateStore } from "./state.ts";
import { herdrStore } from "./state-herdr.ts";
import { watch } from "./watch.ts";

const made: string[] = [];
const unregister: Array<() => void> = [];
afterAll(() => {
  for (const undo of unregister) undo();
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const NOW = "2026-11-10T09:00:00.000Z";
const noRemote = () => Effect.die(new Error("this test touches no remote archive"));
const eventText = (line: string): string => line.replace(/ id="e[0-9a-z]+"/u, "");
const ownerGone = "owner gone: t1 no longer runs; nothing will read these events";
const answeredB =
  '<event kind="answered" item="i1"><title>Fix login</title><answer>Re "Which login provider?": B</answer></event>';

const update = (id: string, change: Partial<ItemUpdate>): ItemUpdate & { json: boolean } => ({
  id,
  status: undefined,
  outcome: undefined,
  decided: [],
  touch: [],
  untouch: [],
  due: undefined,
  ask: undefined,
  context: undefined,
  options: [],
  rec: undefined,
  why: undefined,
  answer: undefined,
  now: NOW,
  json: false,
  ...change,
});

/**
 * A machine on the herdr-doc backend: its own state dir, registered with a store over the shared
 * fake cores that answers as `self`.
 */
const machine = async (self: string, cores: FakeDocCores, subscribe?: DocSubscriber) => {
  const state = tempDir(`coordinate-watch-${self}-`);
  made.push(state);
  const config: Config = await Effect.runPromise(
    resolveConfig({ state_dir: state, backlog_dir: join(state, "md") }, "/c"),
  );
  // Each machine's core answers as itself over the same documents.
  const view: FakeDocCores = {
    self,
    docs: cores.docs,
    machines: Object.fromEntries(
      [cores.self, ...Object.keys(cores.machines)]
        .filter((name) => name !== self)
        .map((name) => [name, "up" as const]),
    ),
    contended: cores.contended,
  };
  const store = herdrStore({
    home: "homebase",
    prefix: "ct.",
    appendRemote: noRemote,
    readRemote: noRemote,
    transport: memoryDocTransport(view),
    self: Effect.succeed(self),
    stateDir: state,
    subscribe: subscribe ?? memoryDocSubscriber(view),
  });
  unregister.push(registerStateStore(state, store));
  return { config, view };
};

/**
 * Two machines sharing the home homebase's documents: the watcher on `watcherOn`, and strix or
 * homebase writing out of band. The domain has one item waiting on an answer.
 */
const twoMachines = async (watcherOn: "homebase" | "strix", subscribe?: DocSubscriber) => {
  const cores = fakeDocCores("homebase", { strix: "up" });
  const writerOn = watcherOn === "homebase" ? "strix" : "homebase";
  const watcher = await machine(watcherOn, cores, subscribe);
  const writer = await machine(writerOn, cores);
  await runWith(createDocument(writer.config, "app"));
  await runWith(itemAdd(writer.config, "app", { title: "Fix login", json: false, now: NOW }));
  await runWith(
    itemUpdate(
      writer.config,
      "app",
      update("i1", { ask: "Which login provider?", options: ["A", "B"] }),
    ),
  );
  return { cores, watcher, writer };
};

/**
 * `hc` for a watcher with owner t1: no delegates, and the owner live for `liveTicks` ticks.
 */
const ownerFor = (liveTicks: number) => {
  let asked = 0;
  return fakeProc((argv): RunOutput => {
    if (argv[0] === "hc" && argv[1] === "ls") return ok('{"terminals":[]}');
    if (argv[0] === "hc" && argv[1] === "get" && argv[2] === "t1") {
      asked += 1;
      return asked <= liveTicks
        ? ok(JSON.stringify({ address: "t1", state: "live" }))
        : { exitCode: 1, stdout: "", stderr: '{"error":{"kind":"not_found","message":"gone"}}' };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
};

const follow = (
  config: Config,
  sleep: (ms: number) => Effect.Effect<void>,
  liveTicks: number,
  owner: string | undefined,
) => {
  const emitted: string[] = [];
  const run = runWith(
    watch(config, {
      domain: "app",
      intervalMs: 600_000,
      forgeIntervalMs: 600_000,
      maxMs: 3_600_000,
      owner,
      replace: false,
      deliver: false,
      today: () => "2026-11-10",
      now: () => 1_000_000,
      sleep,
      follow: true,
      emit: (line) => {
        emitted.push(line);
      },
    }),
    ownerFor(liveTicks).layer,
  );
  return run.then((returned) => ({ returned, emitted: emitted.map(eventText) }));
};

describe("watch on the herdr-doc backend", () => {
  it("polls the home on another machine: an answer written there fires the usual event", async () => {
    const { watcher, writer } = await twoMachines("strix");
    const slept: number[] = [];
    // Between the first and second tick, the home's machine records the answer.
    const sleep = (ms: number) =>
      Effect.promise(async () => {
        slept.push(ms);
        if (slept.length === 1)
          await runWith(itemUpdate(writer.config, "app", update("i1", { answer: "B" })));
      });
    expect(await follow(watcher.config, sleep, 1, "t1")).toEqual({
      returned: [],
      emitted: [answeredB, ownerGone],
    });
    expect(slept).toEqual([600_000]);
  });

  it("reports blind after three ticks with the home unreachable, and emits nothing else", async () => {
    const { watcher } = await twoMachines("strix");
    watcher.view.machines.homebase = "down";
    expect(await follow(watcher.config, () => Effect.void, 0, undefined)).toEqual({
      returned: [],
      emitted: [
        "blind: state home homebase unreachable 3 times: the state home homebase is unreachable (homebase is unreachable: cannot reach homebase); shared state was not read or written; re-arm the watcher",
      ],
    });
  });

  it("counts only consecutive unreachable ticks toward blind", async () => {
    const { watcher, writer } = await twoMachines("strix");
    // Ticks 1 and 2 down, 3 up, 4 and 5 down, then up with the answer and the owner gone.
    const down = [true, true, false, true, true, false];
    let tick = 0;
    watcher.view.machines.homebase = "down";
    const sleep = () =>
      Effect.promise(async () => {
        tick += 1;
        watcher.view.machines.homebase = down[tick] === true ? "down" : "up";
        if (tick === 5)
          await runWith(itemUpdate(writer.config, "app", update("i1", { answer: "B" })));
      });
    expect(await follow(watcher.config, sleep, 5, "t1")).toEqual({
      returned: [],
      emitted: [answeredB, ownerGone],
    });
  });

  it("on the home, a subscribed change wakes the watcher without waiting for the interval", async () => {
    const { watcher, writer } = await twoMachines("homebase");
    let slept = 0;
    // The first wait never ends on its own: only the document event can end it.
    const sleep = () =>
      slept++ === 0
        ? Effect.promise(() =>
            runWith(itemUpdate(writer.config, "app", update("i1", { answer: "B" }))),
          ).pipe(Effect.andThen(Effect.never))
        : Effect.void;
    expect(await follow(watcher.config, sleep, 1, "t1")).toEqual({
      returned: [],
      emitted: [answeredB, ownerGone],
    });
  });

  it("on the home with subscriptions unavailable, polling alone fires the event", async () => {
    const unavailable: DocSubscriber = () => ({ ready: Promise.resolve(false), close: () => {} });
    const { watcher, writer } = await twoMachines("homebase", unavailable);
    const slept: number[] = [];
    const sleep = (ms: number) =>
      Effect.promise(async () => {
        slept.push(ms);
        if (slept.length === 1)
          await runWith(itemUpdate(writer.config, "app", update("i1", { answer: "B" })));
      });
    expect(await follow(watcher.config, sleep, 1, "t1")).toEqual({
      returned: [],
      emitted: [answeredB, ownerGone],
    });
    expect(slept).toEqual([600_000]);
  });

  it("off the home, never subscribes: Herdr subscriptions reach only this core", async () => {
    const patterns: string[][] = [];
    const spy: DocSubscriber = (subscribed) => {
      patterns.push([...subscribed]);
      return { ready: Promise.resolve(true), close: () => {} };
    };
    const off = await twoMachines("strix", spy);
    expect(await follow(off.watcher.config, () => Effect.void, 0, "t1")).toEqual({
      returned: [],
      emitted: [ownerGone],
    });
    const on = await twoMachines("homebase", spy);
    expect(await follow(on.watcher.config, () => Effect.void, 0, "t1")).toEqual({
      returned: [],
      emitted: [ownerGone],
    });
    expect(patterns).toEqual([["ct.*"]]);
  });
});
