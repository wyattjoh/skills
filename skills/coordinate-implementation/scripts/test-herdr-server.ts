import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

/**
 * Agent row served in fake `session.snapshot` responses.
 */
export type FakeAgent = {
  session: string;
  pane: string;
  status: string;
};

/**
 * Scriptable in-memory Herdr control socket for engine tests.
 */
export type FakeHerdrServer = {
  path: string;
  agents: FakeAgent[];
  subscriptions: number;
  snapshots: number;
  setStatus: (session: string, status: string, emit: boolean) => void;
  exitPane: (pane: string) => void;
  dropSubscribers: () => void;
  close: () => Promise<void>;
};

const writeLine = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`);
};

const snapshotResult = (agents: FakeAgent[]): Record<string, unknown> => ({
  type: "session_snapshot",
  snapshot: {
    version: "0.9.1",
    protocol: 1,
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    workspaces: [],
    tabs: [],
    panes: agents.map((agent) => ({
      pane_id: agent.pane,
      workspace_id: "w1",
      tab_id: "w1:t1",
      agent_status: agent.status,
    })),
    layouts: [],
    agents: agents.map((agent) => ({
      display_agent: agent.session,
      title: agent.session,
      pane_id: agent.pane,
      workspace_id: "w1",
      tab_id: "w1:t1",
      agent_status: agent.status,
    })),
  },
});

/**
 * Starts a fake Herdr control socket that answers subscribe and snapshot requests.
 *
 * @param agents - Initial agents; mutate through the returned controls.
 * @returns Controls for scripting status changes and tearing the server down.
 */
export const startFakeHerdr = async (agents: FakeAgent[]): Promise<FakeHerdrServer> => {
  const path = join(
    "/tmp",
    `coordinate-hub-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`,
  );
  const subscribers = new Set<Socket>();
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => {
      subscribers.delete(socket);
      connections.delete(socket);
    });
    socket.on("error", () => undefined);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const request = JSON.parse(line) as { id: string; method: string };
        if (request.method === "events.subscribe") {
          fake.subscriptions += 1;
          subscribers.add(socket);
          writeLine(socket, { id: request.id, result: { type: "subscription_started" } });
        }
        if (request.method === "session.snapshot") {
          fake.snapshots += 1;
          writeLine(socket, { id: request.id, result: snapshotResult(fake.agents) });
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  const emit = (event: string, data: Record<string, unknown>) => {
    for (const socket of subscribers) writeLine(socket, { event, data });
  };
  const fake: FakeHerdrServer = {
    path,
    agents: agents.map((agent) => ({ ...agent })),
    subscriptions: 0,
    snapshots: 0,
    setStatus: (session, status, shouldEmit) => {
      const agent = fake.agents.find((candidate) => candidate.session === session)!;
      agent.status = status;
      if (shouldEmit) {
        emit("pane.agent_status_changed", {
          type: "pane_agent_status_changed",
          pane_id: agent.pane,
          workspace_id: "w1",
          agent_status: status,
        });
      }
    },
    exitPane: (pane) => {
      fake.agents = fake.agents.filter((agent) => agent.pane !== pane);
      emit("pane.exited", { type: "pane_exited", pane_id: pane });
    },
    dropSubscribers: () => {
      for (const socket of subscribers) socket.destroy();
      subscribers.clear();
    },
    close: async () => {
      for (const socket of connections) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
};
