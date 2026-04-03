import { describe, expect, it } from "bun:test"

import { ClaudeCodeAgent } from "@/agents/ClaudeCodeAgent"

class TestClaudeCodeAgent extends ClaudeCodeAgent {
  getInterpreter() {
    return this.createOutputInterpreter()
  }
}

function collectEvents(lines: string[]) {
  const agent = new TestClaudeCodeAgent({})
  const interpreter = agent.getInterpreter()
  if (!interpreter) {
    throw new Error("Interpreter should be defined")
  }

  const toArray = <T,>(value: T | T[] | null | undefined): T[] => {
    if (!value) {
      return []
    }

    return Array.isArray(value) ? value : [value]
  }

  const events = lines.flatMap((line) => toArray(interpreter.onStdoutLine?.(line)))
  events.push(...toArray(interpreter.onExit?.({ stdout: "", stderr: "", exitCode: 0 })))
  return events
}

describe("ClaudeCodeAgent output interpreter", () => {
  it("maps claude stream-json to started/action/completed events", () => {
    const events = collectEvents([
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_1" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Working..." }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session_1",
        is_error: false,
        result: "Done from claude",
      }),
    ])

    expect(events[0]).toMatchObject({
      type: "started",
      engine: "claude-code",
      resume: "session_1",
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          phase: "started",
          action: expect.objectContaining({
            id: "toolu_1",
            title: "Bash",
          }),
        }),
        expect.objectContaining({
          type: "action",
          phase: "completed",
          action: expect.objectContaining({
            id: "toolu_1",
          }),
        }),
      ])
    )

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      engine: "claude-code",
      ok: true,
      answer: "Done from claude",
      resume: "session_1",
    })
  })

  it("emits failed completed event for result errors", () => {
    const events = collectEvents([
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_2" }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        session_id: "session_2",
        is_error: true,
        error: "Permission denied",
      }),
    ])

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      ok: false,
      error: "Permission denied",
      resume: "session_2",
    })
  })

  it("summarizes noisy runtime metadata from tool output", () => {
    const events = collectEvents([
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_3" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "env" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content:
                "\"mcp_servers\":[{\"name\":\"context7\"}],\"slash_commands\":[\"plan\"],\"permissionMode\":\"bypassPermissions\",\"claude_code_version\":\"2.1.71\",\"plugins\":[{\"name\":\"ast-grep\"}],\"skills\":[\"smithers\"]",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session_3",
        is_error: false,
        result: "done",
      }),
    ])

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          phase: "completed",
          action: expect.objectContaining({
            id: "toolu_2",
          }),
          message: "Tool output omitted (runtime metadata).",
        }),
      ])
    )
  })
})
