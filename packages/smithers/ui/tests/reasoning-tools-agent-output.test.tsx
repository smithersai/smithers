/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOutput, parseAgentOutput } from "../src/index";

describe("reasoning summary safety boundary", () => {
  test("reads reasoningSummary and reasoning_summary", () => {
    const model = parseAgentOutput({ reasoningSummary: "Provider disclosed summary" });
    expect(model?.reasoningSummary).toBe("Provider disclosed summary");
    expect(parseAgentOutput({ reasoning_summary: "Snake summary" })?.reasoningSummary).toBe("Snake summary");
  });

  test("raw reasoning/thinking/thought transcripts are never surfaced as summaries", () => {
    // These fields may contain raw private chain-of-thought; the parser must
    // not assume they are provider-safe summaries.
    const model = parseAgentOutput({
      response: "done",
      reasoning: "raw reasoning transcript",
      thinking: "raw thinking transcript",
      thought: "raw thought transcript",
      reasoningText: "raw reasoningText transcript",
      thinkingText: "raw thinkingText transcript",
    });
    expect(model?.reasoningSummary).toBeUndefined();

    const partsModel = parseAgentOutput({
      response: "done",
      reasoning: [
        { type: "reasoning", text: "raw reasoning part" },
        { type: "thinking", text: "raw thinking part" },
        { type: "thought", text: "raw thought part" },
      ],
    });
    expect(partsModel?.reasoningSummary).toBeUndefined();
  });

  test("summary-typed parts and nested summary arrays are extracted", () => {
    expect(
      parseAgentOutput({
        reasoning: [
          { type: "summary_text", text: "First summary" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "Second summary" }] },
          { type: "reasoning", summary: "Third summary" },
        ],
      })?.reasoningSummary,
    ).toBe("First summary\n\nSecond summary\n\nThird summary");
  });

  test("a summary field on unrelated part kinds is never reasoning text", () => {
    const model = parseAgentOutput({
      response: "done",
      content: [
        { type: "text", text: "answer", summary: "a tl;dr of the answer" },
        { type: "tool-call", name: "search", summary: "what the tool did" },
        { type: "image", summary: "alt-text-ish summary" },
      ],
      reasoning: [
        { type: "tool_result", summary: "tool metadata, not reasoning" },
        { type: "reasoning", summary: "Real reasoning summary" },
      ],
    });
    expect(model?.reasoningSummary).toBe("Real reasoning summary");
  });

  test("a summary field on an untyped generic content part is never reasoning text", () => {
    const model = parseAgentOutput({
      response: "done",
      content: [
        { summary: "untyped content-part metadata" },
        { text: "untyped text part", summary: "still not reasoning" },
      ],
      reasoning: [
        { summary: "untyped reasoning-array entry" },
        { summary: [{ text: "untyped nested summary part" }] },
        { type: "reasoning", summary: "Real reasoning summary" },
      ],
    });
    expect(model?.reasoningSummary).toBe("Real reasoning summary");
  });

  test("drops redacted_thinking parts and signature/redactedData fields", () => {
    const model = parseAgentOutput({
      reasoning: [
        { type: "summary_text", text: "Visible summary" },
        { type: "redacted_thinking", text: "must never render" },
        { type: "summary_text", text: "signed blob", signature: "abc123" },
        { type: "summary_text", text: "redacted blob", redactedData: "xyz" },
        { type: "reasoning", summary: "signed summary", signature: "abc123" },
      ],
    });
    expect(model?.reasoningSummary).toBe("Visible summary");
  });

  test("renderer displays the reasoning summary", () => {
    const html = renderToStaticMarkup(
      <AgentOutput
        model={{
          reasoningSummary: "Safe summary",
          toolCalls: [],
          streaming: false,
        }}
      />,
    );
    expect(html).toContain('data-slot="reasoning-summary"');
    expect(html).toContain("Safe summary");
  });

  test("parses tool durationMs through to the render model", () => {
    const model = parseAgentOutput({
      toolCalls: [{ toolName: "search", input: { q: "x" }, state: "completed", durationMs: 1200 }],
    });
    expect(model?.toolCalls[0]).toMatchObject({ name: "search", durationMs: 1200 });
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain("1.2s");
  });

  test("AgentOutput renders the summary through ReasoningSummary anatomy when open", () => {
    const model = parseAgentOutput({ reasoningSummary: "Consider the evidence" });
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain('data-slot="reasoning"');
    expect(html).toContain('data-slot="reasoning-summary"');
    expect(html).toContain("Consider the evidence");
    expect(html).toContain("Thinking");
  });
});
