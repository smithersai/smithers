import { describe, expect, it } from "bun:test"

import { CodexAgent } from "@/agents/CodexAgent"

class TestCodexAgent extends CodexAgent {
  getInterpreter() {
    return this.createOutputInterpreter()
  }
}

function collectEvents(lines: string[]) {
  const agent = new TestCodexAgent({})
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

describe("CodexAgent output interpreter", () => {
  it("maps codex JSONL to started/action/completed events", () => {
    const events = collectEvents([
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_cmd",
          type: "command_execution",
          command: "bun test",
          status: "in_progress",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_cmd",
          type: "command_execution",
          command: "bun test",
          status: "completed",
          exit_code: 0,
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_msg", type: "agent_message", text: "Done from codex" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    ])

    expect(events[0]).toMatchObject({
      type: "started",
      engine: "codex",
      resume: "thread_1",
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          engine: "codex",
          phase: "started",
          action: expect.objectContaining({
            kind: "command",
            title: "bun test",
          }),
        }),
      ])
    )

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      engine: "codex",
      ok: true,
      answer: "Done from codex",
      resume: "thread_1",
      usage: { input_tokens: 10, output_tokens: 4 },
    })
  })

  it("treats reconnect top-level errors as non-fatal warnings", () => {
    const events = collectEvents([
      JSON.stringify({ type: "thread.started", thread_id: "thread_2" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
      JSON.stringify({ type: "turn.failed", error: { message: "failed" } }),
    ])

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          phase: "updated",
          level: "warning",
          message: "Reconnecting... 1/5",
        }),
      ])
    )

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      ok: false,
      error: "failed",
    })
  })

  it("filters unparsed runtime metadata blobs and keeps actionable unparsed errors", () => {
    const metadataNoise =
      "\"mcp_servers\":[{\"name\":\"context7\"}],\"slash_commands\":[\"plan\"],\"permissionMode\":\"bypassPermissions\",\"claude_code_version\":\"2.1.71\",\"plugins\":[{\"name\":\"ast-grep\"}],\"skills\":[\"smithers\"]"

    const noisyEvents = collectEvents([
      JSON.stringify({ type: "thread.started", thread_id: "thread_3" }),
      metadataNoise,
      JSON.stringify({ type: "turn.failed", error: { message: "failed" } }),
    ])

    expect(noisyEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          action: expect.objectContaining({ title: "stdout" }),
        }),
      ])
    )

    const errorEvents = collectEvents([
      JSON.stringify({ type: "thread.started", thread_id: "thread_4" }),
      "timeout while reconnecting to upstream stream",
      JSON.stringify({ type: "turn.failed", error: { message: "failed" } }),
    ])

    expect(errorEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          action: expect.objectContaining({ title: "stdout" }),
          level: "warning",
        }),
      ])
    )
  })
})
