import { describe, expect, it } from "bun:test";
import {
  extractBlocks,
  extractRecordText,
  hasInjectedTag,
  hasInterruptMarker,
  isSkillToolResult,
  joinBlockText,
  parseRecord,
  type AnyRecord,
} from "./records.ts";

describe("parseRecord", () => {
  it("discriminates a known type", () => {
    const record = parseRecord({ type: "user", message: { role: "user", content: "hi" } });
    expect(record?.type).toBe("user");
  });

  it("parses an unrecognized type as a generic record", () => {
    const record = parseRecord({ type: "cost-state", totalCostUSD: 0 });
    expect(record?.type).toBe("cost-state");
  });

  it("returns null for a value with no type field", () => {
    const record = parseRecord({ foo: "bar" });
    expect(record).toBeNull();
  });

  it("returns null for a non-object value", () => {
    expect(parseRecord("not an object")).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord(42)).toBeNull();
  });
});

describe("extractBlocks", () => {
  it("wraps a plain string content as a single text block", () => {
    const blocks = extractBlocks("Review this change for security vulnerabilities.");
    expect(blocks).toEqual([
      { kind: "text", text: "Review this change for security vulnerabilities." },
    ]);
  });

  it("returns no blocks for empty string content", () => {
    expect(extractBlocks("")).toEqual([]);
  });

  it("returns no blocks for undefined content", () => {
    expect(extractBlocks(undefined)).toEqual([]);
  });

  it("extracts a text block from an array", () => {
    const blocks = extractBlocks([{ type: "text", text: "hello" }]);
    expect(blocks).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("extracts a thinking block", () => {
    const blocks = extractBlocks([{ type: "thinking", thinking: "let me think" }]);
    expect(blocks).toEqual([{ kind: "thinking", text: "let me think" }]);
  });

  it("extracts a tool_use block with its id, name, and input", () => {
    const blocks = extractBlocks([
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/a.ts" } },
    ]);
    expect(blocks).toEqual([
      {
        kind: "tool_use",
        text: '{"file_path":"/tmp/a.ts"}',
        toolUseId: "toolu_1",
        toolName: "Read",
        input: { file_path: "/tmp/a.ts" },
      },
    ]);
  });

  it("extracts a tool_result block with string content", () => {
    const blocks = extractBlocks([
      { type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" },
    ]);
    expect(blocks).toEqual([
      { kind: "tool_result", text: "file contents here", toolUseId: "toolu_1", isError: false },
    ]);
  });

  it("extracts a tool_result block with array content and is_error", () => {
    const blocks = extractBlocks([
      {
        type: "tool_result",
        tool_use_id: "toolu_2",
        content: [{ type: "text", text: "boom" }],
        is_error: true,
      },
    ]);
    expect(blocks).toEqual([
      { kind: "tool_result", text: "boom", toolUseId: "toolu_2", isError: true },
    ]);
  });

  it("extracts multiple blocks in order", () => {
    const blocks = extractBlocks([
      { type: "thinking", thinking: "planning" },
      { type: "text", text: "here is the plan" },
      { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls" } },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool_use"]);
  });
});

describe("joinBlockText", () => {
  it("joins non-empty block text with blank lines", () => {
    const text = joinBlockText([
      { kind: "text", text: "first" },
      { kind: "other", text: "" },
      { kind: "text", text: "second" },
    ]);
    expect(text).toBe("first\n\nsecond");
  });

  it("returns an empty string when no block carries text", () => {
    expect(joinBlockText([{ kind: "other", text: "" }])).toBe("");
  });
});

describe("extractRecordText", () => {
  it("extracts text from a user record with string content", () => {
    const record = parseRecord({
      type: "user",
      message: { role: "user", content: "plain string prompt" },
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("plain string prompt");
  });

  it("extracts text from a user record with block array content", () => {
    const record = parseRecord({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "block prompt" }] },
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("block prompt");
  });

  it("extracts text from an assistant record with mixed blocks", () => {
    const record = parseRecord({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("reasoning\n\nanswer");
  });

  it("extracts text from a system record", () => {
    const record = parseRecord({
      type: "system",
      content: "<local-command-stdout></local-command-stdout>",
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("<local-command-stdout></local-command-stdout>");
  });

  it("extracts text from a summary record", () => {
    const record = parseRecord({ type: "summary", summary: "Context usage overview" }) as AnyRecord;
    expect(extractRecordText(record)).toBe("Context usage overview");
  });

  it("extracts text from a queue-operation record", () => {
    const record = parseRecord({
      type: "queue-operation",
      operation: "enqueue",
      content: "queued prompt",
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("queued prompt");
  });

  it("extracts text from an attachment record's rendered content", () => {
    const record = parseRecord({
      type: "attachment",
      rendered: [{ content: "<system-reminder># Environment</system-reminder>" }],
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("<system-reminder># Environment</system-reminder>");
  });

  it("extracts text from a last-prompt record", () => {
    const record = parseRecord({ type: "last-prompt", lastPrompt: "do the thing" }) as AnyRecord;
    expect(extractRecordText(record)).toBe("do the thing");
  });

  it("extracts text from an ai-title record", () => {
    const record = parseRecord({
      type: "ai-title",
      aiTitle: "workspace.yaml security review",
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("workspace.yaml security review");
  });

  it("extracts text from an atis-latch record", () => {
    const record = parseRecord({ type: "atis-latch", atis: "" }) as AnyRecord;
    expect(extractRecordText(record)).toBe("");
  });

  it("extracts tracked file paths from a file-history-snapshot record", () => {
    const record = parseRecord({
      type: "file-history-snapshot",
      messageId: "m1",
      snapshot: { trackedFileBackups: { "src/a.ts": {}, "src/b.ts": {} } },
    }) as AnyRecord;
    expect(extractRecordText(record)).toBe("src/a.ts\nsrc/b.ts");
  });

  it("returns an empty string for an unknown record type", () => {
    const record = parseRecord({ type: "cost-state", totalCostUSD: 0 }) as AnyRecord;
    expect(extractRecordText(record)).toBe("");
  });
});

describe("hasInjectedTag", () => {
  it("flags local-command-caveat text", () => {
    expect(
      hasInjectedTag(
        "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
      ),
    ).toBe(true);
  });

  it("flags command-message and command-name text", () => {
    expect(
      hasInjectedTag(
        "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
      ),
    ).toBe(true);
  });

  it("flags system-reminder text", () => {
    expect(hasInjectedTag("<system-reminder># Environment</system-reminder>")).toBe(true);
  });

  it("flags a complete injected skill wrapper", () => {
    expect(hasInjectedTag('  <skill name="grilling">\nInjected instructions\n</skill>  ')).toBe(
      true,
    );
  });

  it("does not flag a skill wrapper embedded in human-authored text", () => {
    expect(hasInjectedTag('Please inspect <skill name="grilling">this example</skill> now.')).toBe(
      false,
    );
  });

  it("does not flag ordinary prompt text", () => {
    expect(hasInjectedTag("Review this change for security vulnerabilities.")).toBe(false);
  });
});

describe("isSkillToolResult", () => {
  it("flags a tool_result answering a Skill tool_use", () => {
    const toolNameById = new Map([["toolu_skill", "Skill"]]);
    const block = {
      kind: "tool_result" as const,
      text: "skill body",
      toolUseId: "toolu_skill",
      isError: false,
    };
    expect(isSkillToolResult(block, toolNameById)).toBe(true);
  });

  it("does not flag a tool_result answering a non-Skill tool_use", () => {
    const toolNameById = new Map([["toolu_read", "Read"]]);
    const block = {
      kind: "tool_result" as const,
      text: "file contents",
      toolUseId: "toolu_read",
      isError: false,
    };
    expect(isSkillToolResult(block, toolNameById)).toBe(false);
  });

  it("does not flag a text block", () => {
    const toolNameById = new Map([["toolu_skill", "Skill"]]);
    const block = { kind: "text" as const, text: "hello" };
    expect(isSkillToolResult(block, toolNameById)).toBe(false);
  });
});

describe("hasInterruptMarker", () => {
  it("flags a request-interrupted marker", () => {
    expect(hasInterruptMarker("[Request interrupted by user for tool use]")).toBe(true);
  });

  it("flags a rejected-tool marker", () => {
    expect(
      hasInterruptMarker(
        "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      ),
    ).toBe(true);
  });

  it("does not flag ordinary text", () => {
    expect(hasInterruptMarker("Everything worked as expected.")).toBe(false);
  });
});
