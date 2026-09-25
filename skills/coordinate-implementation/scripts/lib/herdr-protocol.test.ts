import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { HerdrWaitError, openSubscription, readSnapshot } from "./herdr-protocol.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listening ? server.close(() => resolve()) : resolve(),
          ),
      ),
  );
});

/**
 * Serves one scripted Herdr socket that counts connections and request writes.
 */
const serve = async (onData: (write: (line: string) => void) => void) => {
  const path = join(
    "/tmp",
    `herdr-protocol-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`,
  );
  const observed = { connections: 0, writes: 0, closed: Promise.withResolvers<boolean>() };
  const server = createServer((socket) => {
    observed.connections += 1;
    socket.on("close", () => observed.closed.resolve(true));
    socket.on("data", () => {
      observed.writes += 1;
      onData((line) => socket.write(`${line}\n`));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  const serverClosed = () =>
    Promise.race([observed.closed.promise, Bun.sleep(500).then(() => false)]);
  return { path, observed, serverClosed };
};

/**
 * A clock that reads 0 until its `expiresAt`-th read, then reports the deadline as passed.
 */
const expiringClock = (expiresAt: number) => {
  let reads = 0;
  return (): number => {
    reads += 1;
    return reads >= expiresAt ? 101 : 0;
  };
};

const issueCode = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return error instanceof HerdrWaitError ? error.issue.code : "resolved";
};

describe("Herdr socket protocol", () => {
  it("closes the subscription when acknowledgement JSON is malformed", async () => {
    const herdr = await serve((write) => write("{not-json}"));

    const code = await issueCode(
      openSubscription(herdr.path, ["w1:p1"], Date.now() + 500, Date.now),
    );

    expect(code).toBe("herdr.subscribe_malformed");
    expect(await herdr.serverClosed()).toBe(true);
  });

  it("writes no subscription request when connection completes after the deadline", async () => {
    const herdr = await serve(() => undefined);

    const code = await issueCode(openSubscription(herdr.path, ["w1:p1"], 100, expiringClock(2)));

    expect(code).toBe("herdr.subscribe_timeout");
    expect(herdr.observed.connections).toBe(1);
    expect(herdr.observed.writes).toBe(0);
    expect(await herdr.serverClosed()).toBe(true);
  });

  it("writes no snapshot request when connection completes after the deadline", async () => {
    const herdr = await serve(() => undefined);

    const code = await issueCode(readSnapshot(herdr.path, 100, expiringClock(2)));

    expect(code).toBe("herdr.snapshot_timeout");
    expect(herdr.observed.connections).toBe(1);
    expect(herdr.observed.writes).toBe(0);
    expect(await herdr.serverClosed()).toBe(true);
  });
});
