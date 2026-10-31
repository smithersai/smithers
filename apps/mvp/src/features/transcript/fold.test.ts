import { describe, expect, test } from "vitest"
import { EMPTY, fold, foldAll } from "./fold"
import type { Row } from "./schema"

let n = 0
const row = (kind: string, update: Record<string, unknown>, generation = 1): Row => ({
  n: ++n,
  generation,
  seq: n,
  at: 1_000 + n,
  kind,
  update: { sessionUpdate: kind, ...update },
})
const text = (value: string) => ({ type: "text", text: value })

describe("the transcript fold", () => {
  test("joins a message's chunks by its id, around tool calls, and keeps each message where it began", () => {
    const rows = [
      row("user_message_chunk", { content: text("Add alpha"), messageId: "u1" }),
      row("agent_message_chunk", { content: text("Working "), messageId: "m1" }),
      row("tool_call", { toolCallId: "t1", title: "Edit a file", kind: "edit", status: "in_progress" }),
      row("agent_message_chunk", { content: text("on it."), messageId: "m1" }),
      row("tool_call_update", { toolCallId: "t1", status: "completed" }),
      row("session_info_update", { title: "Alpha" }),
    ]
    const { state } = foldAll(EMPTY, rows)
    const items = [...state.items.values()].sort((a, b) => a.order - b.order)
    expect(items.map((item) => [item.kind, item.text, item.status])).toEqual([
      ["prompt", "Add alpha", null],
      ["message", "Working on it.", null],
      ["tool", "Edit a file", "completed"],
    ])
  })

  test("joins chunks without an id while they follow each other; a tool call starts the next message", () => {
    const rows = [
      row("agent_message_chunk", { content: text("one ") }),
      row("session_info_update", {}),
      row("agent_message_chunk", { content: text("two") }),
      row("tool_call_update", { toolCallId: "late", title: "Run tests", status: "failed" }),
      row("agent_message_chunk", { content: text("three") }),
      row("agent_thought_chunk", { content: { type: "image" } }),
    ]
    const items = [...foldAll(EMPTY, rows).state.items.values()].sort((a, b) => a.order - b.order)
    expect(items.map((item) => [item.kind, item.text, item.status])).toEqual([
      ["message", "one two", null],
      ["tool", "Run tests", "failed"],
      ["message", "three", null],
      ["thought", "[image]", null],
    ])
  })

  test("a plan is the newest checklist; usage the newest figures; the runner's turns, steers, stops and end read plainly", () => {
    const rows = [
      row("plan", { entries: [{ content: "Read", status: "completed" }, { content: "Write", status: "pending" }] }),
      row("usage_update", { used: 1234, size: 200000, cost: { amount: 0.5, currency: "USD" } }),
      row("plan", { entries: [{ content: "Write", status: "in_progress" }, {}] }),
      row("usage_update", { used: 2000 }),
      row("_smithers/turn", { stopReason: "end_turn" }),
      row("_smithers/steer", { id: "s1", mode: "cancel_prompt" }),
      row("_smithers/cancel", {}),
      row("_smithers/truncated", {}),
      row("_smithers/end", { outcome: "done" }),
    ]
    const { state, changed } = foldAll(EMPTY, rows)
    const items = [...state.items.values()].sort((a, b) => a.order - b.order)
    expect(items.map((item) => [item.kind, item.text])).toEqual([
      ["plan", ""],
      ["usage", "2,000 tokens"],
      ["turn", "end_turn"],
      ["steer", ""],
      ["stop", ""],
      ["other", "truncated"],
      ["end", "done"],
    ])
    expect(items[0]!.entries).toEqual([{ content: "Write", status: "in_progress" }, { content: "", status: "pending" }])
    expect(changed).toHaveLength(7)
    expect(fold(EMPTY, row("usage_update", { used: 5, size: 10, cost: { amount: 1, currency: "EUR" } })).changed[0]!.text)
      .toBe("5 of 10 tokens · EUR 1.00")
  })

  test("reads what an update leaves out as nothing, and never guesses", () => {
    const rows = [
      row("agent_message_chunk", {}),
      row("agent_message_chunk", { content: "not a block" }),
      row("plan", { entries: "not a list" }),
      row("usage_update", { cost: { amount: 0.25 } }),
      row("_smithers/turn", {}),
      row("_smithers/end", {}),
      row("plan", { entries: [["not", "an", "entry"]] }),
    ]
    const items = [...foldAll(EMPTY, rows).state.items.values()].sort((a, b) => a.order - b.order)
    expect(items.map((item) => [item.kind, item.text, item.entries])).toEqual([
      ["message", "", []],
      ["plan", "", [{ content: "", status: "pending" }]],
      ["usage", "$0.25", []],
      ["turn", "", []],
      ["end", "", []],
    ])
  })

  test("a message without an id in a new generation starts its own", () => {
    const rows = [
      row("agent_message_chunk", { content: text("first") }, 1),
      row("agent_message_chunk", { content: text("second") }, 2),
    ]
    expect([...foldAll(EMPTY, rows).state.items.values()].map((item) => [item.generation, item.text])).toEqual([
      [1, "first"],
      [2, "second"],
    ])
  })

  test("each generation's messages and tools are its own", () => {
    const rows = [
      row("agent_message_chunk", { content: text("first"), messageId: "m" }, 1),
      row("agent_message_chunk", { content: text("second"), messageId: "m" }, 2),
      row("tool_call", { title: "x" }, 2),
    ]
    const items = [...foldAll(EMPTY, rows).state.items.values()]
    expect(items.map((item) => [item.generation, item.text])).toEqual([[1, "first"], [2, "second"], [2, "x"]])
  })
})
