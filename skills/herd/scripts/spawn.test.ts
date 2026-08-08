import { describe, expect, it } from "bun:test";
import {
  type AgentKind,
  agentArgs,
  AgentStartFailed,
  isPaneNotReady,
  isPromptStalled,
  kindForModel,
  normalizePiModel,
  parseTabCreate,
  PromptFailed,
  reasoningFlag,
  type SpawnRequest,
  statusForPeer,
} from "./spawn.ts";

const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  workspaceId: "wJE",
  label: "01-fix",
  cwd: "/repo/.pando/01-fix",
  peerName: "herd-defects-01-fix",
  kind: "claude",
  brief: "do the thing",
  startTimeoutMs: 60000,
  promptTimeoutMs: 120000,
  ...overrides,
});

describe("kindForModel", () => {
  it("routes gpt- models to pi", () => {
    expect(kindForModel("gpt-5.6-luna")).toBe("pi");
    expect(kindForModel("gpt-5.6-sol")).toBe("pi");
    expect(kindForModel("gpt-5.6-terra")).toBe("pi");
  });

  it("routes the bare terra, luna and sol aliases to pi", () => {
    expect(kindForModel("terra")).toBe("pi");
    expect(kindForModel("luna")).toBe("pi");
    expect(kindForModel("sol")).toBe("pi");
  });

  it("routes an already-qualified openai-codex model to pi", () => {
    expect(kindForModel("openai-codex/gpt-5.6-terra")).toBe("pi");
  });

  it("routes Claude models to claude", () => {
    expect(kindForModel("opus")).toBe("claude");
    expect(kindForModel("claude-opus-5")).toBe("claude");
  });

  it("defaults to claude when no model is given", () => {
    expect(kindForModel(undefined)).toBe("claude");
  });
});

describe("normalizePiModel", () => {
  it("expands the bare aliases to qualified gpt-5.6 models", () => {
    expect(normalizePiModel("terra")).toBe("openai-codex/gpt-5.6-terra");
    expect(normalizePiModel("luna")).toBe("openai-codex/gpt-5.6-luna");
    expect(normalizePiModel("sol")).toBe("openai-codex/gpt-5.6-sol");
  });

  it("qualifies a bare gpt- model with the openai-codex provider", () => {
    expect(normalizePiModel("gpt-5.6-terra")).toBe("openai-codex/gpt-5.6-terra");
    expect(normalizePiModel("gpt-5.4")).toBe("openai-codex/gpt-5.4");
  });

  it("leaves an already-qualified model untouched", () => {
    expect(normalizePiModel("openai-codex/gpt-5.6-sol")).toBe("openai-codex/gpt-5.6-sol");
  });

  it("leaves a model from another provider untouched", () => {
    expect(normalizePiModel("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });
});

describe("reasoningFlag", () => {
  it("uses --effort for claude", () => {
    expect(reasoningFlag("claude", "high")).toEqual(["--effort", "high"]);
  });

  it("uses --thinking for pi", () => {
    expect(reasoningFlag("pi", "high")).toEqual(["--thinking", "high"]);
  });

  it("accepts pi-only levels for pi", () => {
    expect(reasoningFlag("pi", "minimal")).toEqual(["--thinking", "minimal"]);
  });

  it("rejects pi-only levels for claude", () => {
    expect(() => reasoningFlag("claude", "minimal")).toThrow(
      "claude --effort accepts low, medium, high, xhigh, max; received 'minimal'",
    );
  });

  it("rejects an unknown level for either kind", () => {
    const kinds: AgentKind[] = ["claude", "pi"];
    for (const kind of kinds) {
      expect(() => reasoningFlag(kind, "extreme")).toThrow("received 'extreme'");
    }
  });
});

describe("agentArgs", () => {
  it("names the claude session and defaults the permission mode to auto", () => {
    expect(agentArgs(request())).toEqual([
      "-n",
      "herd-defects-01-fix",
      "--permission-mode",
      "auto",
    ]);
  });

  it("passes the agent, model and effort for claude", () => {
    const args = agentArgs(request({ agent: "code-reviewer", model: "opus", effort: "high" }));
    expect(args).toEqual([
      "-n",
      "herd-defects-01-fix",
      "--permission-mode",
      "auto",
      "--agent",
      "code-reviewer",
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });

  it("honours an explicit permission mode", () => {
    const args = agentArgs(request({ permissionMode: "acceptEdits" }));
    expect(args).toEqual(["-n", "herd-defects-01-fix", "--permission-mode", "acceptEdits"]);
  });

  it("registers a pi session as a peer and qualifies its model", () => {
    const args = agentArgs(request({ kind: "pi", model: "gpt-5.6-sol", effort: "medium" }));
    expect(args).toEqual([
      "--claude-peer",
      "--cc-name",
      "herd-defects-01-fix",
      "--model",
      "openai-codex/gpt-5.6-sol",
      "--thinking",
      "medium",
    ]);
  });

  it("expands a bare alias into a qualified pi model", () => {
    const args = agentArgs(request({ kind: "pi", model: "terra" }));
    expect(args).toEqual([
      "--claude-peer",
      "--cc-name",
      "herd-defects-01-fix",
      "--model",
      "openai-codex/gpt-5.6-terra",
    ]);
  });

  it("omits the permission mode for pi, which has no such flag", () => {
    expect(agentArgs(request({ kind: "pi" }))).toEqual([
      "--claude-peer",
      "--cc-name",
      "herd-defects-01-fix",
    ]);
  });
});

describe("isPaneNotReady", () => {
  // Verbatim from a real herdr instance: starting an agent immediately after
  // `tab create` fails with this while the pane's shell is still coming up.
  it("recognises the agent_pane_busy response herdr returns for a new tab", () => {
    const error = new AgentStartFailed({
      peerName: "herd-smoke-probe",
      detail:
        '{"error":{"code":"agent_pane_busy","message":"agent target pane wJE:p5 is not an available shell"},"id":"cli:agent:start"}',
    });
    expect(isPaneNotReady(error)).toBe(true);
  });

  it("treats a genuine start failure as terminal", () => {
    const error = new AgentStartFailed({
      peerName: "herd-x",
      detail: '{"error":{"code":"unknown_agent_kind","message":"unsupported kind"}}',
    });
    expect(isPaneNotReady(error)).toBe(false);
  });
});

describe("isPromptStalled", () => {
  // Verbatim from a real herdr instance: submitting a brief immediately after
  // `agent start` returns stalls, because the TUI is not yet taking input.
  it("recognises the agent_prompt_stalled response", () => {
    const error = new PromptFailed({
      peerName: "herd-smoke-probe",
      detail:
        '{"error":{"code":"agent_prompt_stalled","message":"agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 2789"}}',
    });
    expect(isPromptStalled(error)).toBe(true);
  });

  it("treats an unrelated prompt failure as terminal", () => {
    const error = new PromptFailed({
      peerName: "herd-x",
      detail: '{"error":{"code":"agent_not_found","message":"no such agent"}}',
    });
    expect(isPromptStalled(error)).toBe(false);
  });
});

describe("statusForPeer", () => {
  const listing = JSON.stringify({
    result: {
      agents: [
        { name: "herd-a-01", agent_status: "working", pane_id: "wJE:p8" },
        { name: "herd-a-02", agent_status: "idle", pane_id: "wJE:p9" },
        { agent_status: "done", pane_id: "wJE:p2" },
      ],
    },
  });

  it("finds an agent's status by peer name", () => {
    expect(statusForPeer(listing, "herd-a-01")).toBe("working");
    expect(statusForPeer(listing, "herd-a-02")).toBe("idle");
  });

  it("returns null for a peer that is not listed", () => {
    expect(statusForPeer(listing, "herd-a-99")).toBe(null);
  });

  it("ignores unnamed agent panes rather than matching them", () => {
    expect(statusForPeer(listing, "")).toBe(null);
  });

  it("returns null when the listing carries no agents", () => {
    expect(statusForPeer(JSON.stringify({ result: {} }), "herd-a-01")).toBe(null);
  });
});

describe("parseTabCreate", () => {
  it("extracts the tab and root pane ids", () => {
    const stdout = JSON.stringify({
      id: "cli:tab:create",
      result: { tab: { tab_id: "wJE:t4" }, root_pane: { pane_id: "wJE:p9" } },
    });
    expect(parseTabCreate(stdout)).toEqual({ tabId: "wJE:t4", paneId: "wJE:p9" });
  });

  it("throws when the root pane is missing", () => {
    const stdout = JSON.stringify({ result: { tab: { tab_id: "wJE:t4" } } });
    expect(() => parseTabCreate(stdout)).toThrow(
      "tab create response is missing tab_id or root_pane.pane_id",
    );
  });

  it("throws when the response carries no result", () => {
    expect(() => parseTabCreate(JSON.stringify({ id: "cli:tab:create" }))).toThrow(
      "tab create response has no 'result'",
    );
  });
});
