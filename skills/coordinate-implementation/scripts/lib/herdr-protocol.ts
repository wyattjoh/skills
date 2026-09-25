import { Data } from "effect";
import { createConnection, type Socket } from "node:net";
import type { CliIssue } from "./contract.ts";

/**
 * Every recognized live agent status.
 */
export const AGENT_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

/**
 * Typed Herdr socket, protocol, or event failure.
 */
export class HerdrWaitError extends Data.TaggedError("HerdrWaitError")<{
  issue: CliIssue;
}> {}

/**
 * Builds a typed Herdr failure with a stable code and remediation.
 *
 * @param code - Stable issue code.
 * @param message - Human-readable failure.
 * @param remediation - Actionable next step.
 * @returns The typed Herdr error.
 */
export const herdrError = (code: string, message: string, remediation: string): HerdrWaitError =>
  new HerdrWaitError({ issue: { code, message, remediation } });

/**
 * Newline-delimited JSON reader over one Herdr control socket connection.
 */
export class LineReader {
  readonly socket: Socket;
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{
    resolve: (line: string | null) => void;
    reject: (error: HerdrWaitError) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private failure: HerdrWaitError | undefined;
  private intentionalClose = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.push(chunk));
    socket.on("error", (error) =>
      this.fail(
        herdrError(
          "herdr.socket_failed",
          `Herdr socket failed: ${error.message}`,
          "Retry with the same workers and bound runtime configuration.",
        ),
      ),
    );
    socket.on("close", () => {
      if (this.intentionalClose) return;
      this.fail(
        herdrError(
          "herdr.subscription_disconnected",
          "Herdr closed the event subscription before a terminal condition or timeout.",
          "Apply the bounded Herdr infrastructure retry for each affected ticket.",
        ),
      );
    });
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0) continue;
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.lines.push(line);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  private fail(error: HerdrWaitError): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  takeBuffered(): string[] {
    return this.lines.splice(0);
  }

  nextLine(timeoutMs: number): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<string | null>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.intentionalClose = true;
    this.socket.destroy();
  }
}

/**
 * Opens one Herdr control socket connection.
 *
 * @param path - Herdr socket path.
 * @param timeoutMs - Connection timeout.
 * @returns A line reader bound to the connected socket.
 */
export const connect = (path: string, timeoutMs: number): Promise<LineReader> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        herdrError(
          "herdr.connect_timeout",
          "Timed out connecting to the Herdr control socket.",
          "Apply the bounded Herdr infrastructure retry for each affected ticket.",
        ),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(new LineReader(socket));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(
        herdrError(
          "herdr.connect_failed",
          `Could not connect to the Herdr control socket: ${error.message}`,
          "Verify HERDR_SOCKET_PATH and apply the bounded Herdr infrastructure retry.",
        ),
      );
    });
  });

/**
 * Parses one JSON object line or throws a typed Herdr error.
 *
 * @param line - Raw protocol line.
 * @param code - Issue code for malformed input.
 * @param subject - Name of the parsed message for the error text.
 * @returns The parsed object.
 */
export const parseJson = (line: string, code: string, subject: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw herdrError(
      code,
      `Herdr returned malformed ${subject} JSON.`,
      "Treat this as a Herdr infrastructure failure and retry with the same worker bindings.",
    );
  }
};

/**
 * Millisecond time source.
 */
export type Clock = () => number;

/**
 * Milliseconds left before an absolute deadline, never negative.
 *
 * @param deadline - Absolute deadline in milliseconds.
 * @param clock - Time source.
 * @returns Remaining milliseconds.
 */
export const remaining = (deadline: number, clock: Clock): number =>
  Math.max(0, deadline - clock());

/**
 * Opens an acknowledged status and exit subscription for the given panes.
 *
 * @param socketPath - Herdr socket path.
 * @param paneIds - Panes whose agent status changes are subscribed.
 * @param deadline - Absolute deadline in milliseconds.
 * @param clock - Time source.
 * @returns A reader positioned after the subscription acknowledgement.
 */
export const openSubscription = async (
  socketPath: string,
  paneIds: string[],
  deadline: number,
  clock: Clock,
): Promise<LineReader> => {
  const connectTimeout = remaining(deadline, clock);
  if (connectTimeout === 0) {
    throw herdrError(
      "herdr.subscribe_timeout",
      "Timed out before opening the Herdr event subscription.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  const subscriptions: Array<Record<string, unknown>> = paneIds.map((paneId) => ({
    type: "pane.agent_status_changed",
    pane_id: paneId,
    agent_status: null,
  }));
  subscriptions.push({ type: "pane.exited" }, { type: "pane.closed" });
  const request = `${JSON.stringify({
    id: "subscribe",
    method: "events.subscribe",
    params: { subscriptions },
  })}\n`;
  const reader = await connect(socketPath, connectTimeout);
  if (remaining(deadline, clock) === 0) {
    reader.close();
    throw herdrError(
      "herdr.subscribe_timeout",
      "Timed out before writing the Herdr event subscription request.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  reader.socket.write(request);
  const acknowledgementTimeout = remaining(deadline, clock);
  const line = acknowledgementTimeout === 0 ? null : await reader.nextLine(acknowledgementTimeout);
  if (line === null) {
    reader.close();
    throw herdrError(
      "herdr.subscribe_timeout",
      "Timed out waiting for the Herdr subscription acknowledgement.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  try {
    const response = parseJson(line, "herdr.subscribe_malformed", "subscription acknowledgement");
    const result = response.result as Record<string, unknown> | undefined;
    if (response.id !== "subscribe" || result?.type !== "subscription_started") {
      throw herdrError(
        "herdr.subscribe_failed",
        "Herdr did not acknowledge the worker event subscription.",
        "Verify the installed Herdr protocol and retry without polling.",
      );
    }
    return reader;
  } catch (error) {
    reader.close();
    throw error;
  }
};

/**
 * Agent status reported for a live pane.
 */
export type LiveAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * One agent entry from a Herdr session snapshot.
 */
export type RawAgent = {
  name: string | null;
  displayAgent: string | null;
  title: string | null;
  paneId: string;
  status: LiveAgentStatus;
  contextUsed: number | undefined;
  contextLimit: number | undefined;
};

/**
 * One pane entry from a Herdr session snapshot.
 */
export type RawPane = {
  paneId: string;
  status: LiveAgentStatus;
};

/**
 * Parsed Herdr session snapshot.
 */
export type RawSnapshot = {
  agents: RawAgent[];
  panes: RawPane[];
};

/**
 * Parses a recognized live agent status.
 *
 * @param value - Raw status value.
 * @returns The status, or undefined when unrecognized.
 */
export const parseStatus = (value: unknown): LiveAgentStatus | undefined =>
  typeof value === "string" && AGENT_STATUSES.has(value) ? (value as LiveAgentStatus) : undefined;

/**
 * Parses one `session.snapshot` response line.
 *
 * @param line - Raw response line.
 * @returns The parsed snapshot.
 */
export const parseSnapshotResponse = (line: string): RawSnapshot => {
  const response = parseJson(line, "herdr.snapshot_malformed", "snapshot response");
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw herdrError(
      "herdr.snapshot_malformed",
      "Herdr snapshot response has no result object.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  const snapshot = (result as Record<string, unknown>).snapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw herdrError(
      "herdr.snapshot_malformed",
      "Herdr snapshot response has no session snapshot.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.agents) || !Array.isArray(record.panes)) {
    throw herdrError(
      "herdr.snapshot_malformed",
      "Herdr session snapshot is missing agents or panes.",
      "Verify the installed Herdr socket schema before retrying.",
    );
  }
  const agents: RawAgent[] = [];
  for (const candidate of record.agents) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const agent = candidate as Record<string, unknown>;
    const status = parseStatus(agent.agent_status);
    if (typeof agent.pane_id !== "string" || status === undefined) continue;
    agents.push({
      name: typeof agent.name === "string" ? agent.name : null,
      displayAgent: typeof agent.display_agent === "string" ? agent.display_agent : null,
      title: typeof agent.title === "string" ? agent.title : null,
      paneId: agent.pane_id,
      status,
      contextUsed:
        typeof agent.context_used === "number" && Number.isSafeInteger(agent.context_used)
          ? agent.context_used
          : undefined,
      contextLimit:
        typeof agent.context_limit === "number" && Number.isSafeInteger(agent.context_limit)
          ? agent.context_limit
          : undefined,
    });
  }
  const panes: RawPane[] = [];
  for (const candidate of record.panes) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const pane = candidate as Record<string, unknown>;
    const status = parseStatus(pane.agent_status);
    if (typeof pane.pane_id !== "string" || status === undefined) continue;
    panes.push({ paneId: pane.pane_id, status });
  }
  return { agents, panes };
};

/**
 * Reads one complete Herdr session snapshot on a fresh connection.
 *
 * @param socketPath - Herdr socket path.
 * @param deadline - Absolute deadline in milliseconds.
 * @param clock - Time source.
 * @returns The parsed snapshot.
 */
export const readSnapshot = async (
  socketPath: string,
  deadline: number,
  clock: Clock,
): Promise<RawSnapshot> => {
  const connectTimeout = remaining(deadline, clock);
  if (connectTimeout === 0) {
    throw herdrError(
      "herdr.snapshot_timeout",
      "Timed out before opening a Herdr session snapshot connection.",
      "Apply the bounded Herdr infrastructure retry for each affected ticket.",
    );
  }
  const request = `${JSON.stringify({ id: "snapshot", method: "session.snapshot", params: {} })}\n`;
  const reader = await connect(socketPath, connectTimeout);
  try {
    if (remaining(deadline, clock) === 0) {
      throw herdrError(
        "herdr.snapshot_timeout",
        "Timed out before writing the Herdr session snapshot request.",
        "Apply the bounded Herdr infrastructure retry for each affected ticket.",
      );
    }
    reader.socket.write(request);
    const responseTimeout = remaining(deadline, clock);
    const line = responseTimeout === 0 ? null : await reader.nextLine(responseTimeout);
    if (line === null) {
      throw herdrError(
        "herdr.snapshot_timeout",
        "Timed out waiting for a complete Herdr session snapshot.",
        "Apply the bounded Herdr infrastructure retry for each affected ticket.",
      );
    }
    return parseSnapshotResponse(line);
  } finally {
    reader.close();
  }
};

/**
 * Finds the agents Herdr reports under one session name. Herdr exposes the
 * name through `name`, `displayAgent`, or `title` depending on the harness.
 *
 * @param snapshot - Current Herdr snapshot.
 * @param session - Durable session name.
 * @returns Every agent carrying that session name.
 */
export const agentsNamed = (snapshot: RawSnapshot, session: string): RawAgent[] =>
  snapshot.agents.filter(
    (agent) => agent.name === session || agent.displayAgent === session || agent.title === session,
  );
