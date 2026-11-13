/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOutput, parseAgentOutput } from "../src/index";

afterEach(() => document.documentElement.removeAttribute("data-theme"));

describe("parseAgentOutput", () => {
  test("recognizes markdown strings while leaving arbitrary rows unclaimed", () => {
    expect(parseAgentOutput("**done**")).toEqual({
      response: "**done**",
      toolCalls: [],
      streaming: false,
    });
    expect(parseAgentOutput({ count: 2, ok: true })).toBeNull();
  });

  test("normalizes reasoning summaries and AI SDK tool calls/results into the render model", () => {
    const model = parseAgentOutput({
      text: "Found **two** matches.",
      reasoningSummary: "I should search first.",
      toolCalls: [{ toolCallId: "call-1", toolName: "search", input: { query: "smithers" } }],
      toolResults: [{ toolCallId: "call-1", output: { hits: 2 }, status: "completed" }],
    });

    expect(model).toEqual({
      response: "Found **two** matches.",
      reasoningSummary: "I should search first.",
      streaming: false,
      toolCalls: [
        {
          id: "call-1",
          name: "search",
          state: "output-available",
          args: { query: "smithers" },
          result: { hits: 2 },
        },
      ],
    });
  });

  test("treats a null tool error as absent and renders the successful output", () => {
    const model = parseAgentOutput({
      toolCalls: [
        { toolCallId: "call-null", toolName: "read", output: { content: "actual output" }, error: null },
      ],
    });

    expect(model?.toolCalls[0]).toEqual({
      id: "call-null",
      name: "read",
      state: "output-available",
      result: { content: "actual output" },
    });
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain("Done");
    expect(html).not.toContain(">null<");
  });

  test("maps interrupted terminal tool states to denied even when partial output exists", () => {
    for (const status of ["cancelled", "canceled", "aborted", "interrupted", "timeout", "timed-out"]) {
      const model = parseAgentOutput({
        toolCalls: [{ toolCallId: status, toolName: "shell", status, output: "partial output" }],
      });
      expect(model?.toolCalls[0]?.state).toBe("output-denied");
    }
  });

  test("accepts snake-case and JSON-encoded calls while dropping raw thinking fields", () => {
    const model = parseAgentOutput({
      output: "Working",
      thinking: "Check the files",
      is_streaming: true,
      tool_calls: JSON.stringify([{ tool_name: "read", arguments: '{"path":"README.md"}', status: "running" }]),
    });

    expect(model?.streaming).toBe(true);
    // Raw `thinking` fields may be private transcripts; they are never surfaced.
    expect(model?.reasoningSummary).toBeUndefined();
    expect(model?.reasoningSummary).toBeUndefined();
    expect(model?.toolCalls[0]).toMatchObject({
      name: "read",
      state: "running",
      argsText: '{"path":"README.md"}',
    });

    // Summary-typed parts are provider-disclosed summaries and ARE surfaced.
    expect(
      parseAgentOutput({
        reasoning_summary: "Inspect the result",
      })?.reasoningSummary,
    ).toBe("Inspect the result");
  });

  test("unwraps nested agent results and reads message content parts", () => {
    expect(
      parseAgentOutput({
        status: "running",
        output: {
          message: {
            content: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Inspect the nested result" }],
              },
              {
                type: "tool-call",
                toolCallId: "call-nested",
                toolName: "read_file",
                input: { path: "README.md" },
              },
              { type: "text", text: "Found **the answer**." },
            ],
          },
        },
      }),
    ).toEqual({
      response: "Found **the answer**.",
      reasoningSummary: "Inspect the nested result",
      streaming: true,
      toolCalls: [
        {
          id: "call-nested",
          name: "read_file",
          state: "running",
          args: { path: "README.md" },
        },
      ],
    });

    expect(
      parseAgentOutput({
        reasoningSummary: "Outer reasoning",
        output: { text: "Nested response" },
      }),
    ).toMatchObject({
      response: "Nested response",
      reasoningSummary: "Outer reasoning",
    });
  });
});

describe("AgentOutput", () => {
  test("composes Response, Reasoning, and ToolCall anatomy", () => {
    const model = parseAgentOutput({
      text: "Final **answer**",
      reasoning: [{ type: "reasoning", summary: "Consider the evidence" }],
      toolCalls: [{ toolName: "inspect", input: { path: "a.ts" }, result: "ok" }],
    });
    expect(model).not.toBeNull();
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain('data-slot="agent-output"');
    expect(html).toContain('data-slot="reasoning"');
    expect(html).toContain('data-slot="tool-call"');
    expect(html).toContain('data-slot="message-response"');
    expect(html).toContain("<strong>answer</strong>");
  });

});
