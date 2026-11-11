import { describe, expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import { STACK_COMMAND, TODO_COMMAND, TODO_NEW_COMMAND, todoCard, TodoNewInputSchema } from "../src/TodoCommands.ts"
import { fixtures } from "./fixtures/Todo.ts"

describe("the TODO commands every host binds", () => {
  test("are named, described, ruled and routed once", () => {
    expect(STACK_COMMAND).toEqual({ name: "stack", summary: "Show the stack and background runs", agent: "run" })
    expect(TODO_COMMAND).toEqual({ name: "todo", summary: "Open a TODO", args: "<Tn>", agent: "run" })
    // Committing a TODO is the person's press: the agent only drafts one.
    expect(TODO_NEW_COMMAND).toEqual({
      name: "todo.new",
      summary: "Write and place a TODO",
      args: "[text]",
      agent: "confirm"
    })
  })

  test("todo.new's input takes a Draft's text, title, acceptance and place, or the Draft a Commit files", () => {
    const accepted = [
      {},
      { text: "" },
      { text: "Log retry counts", title: "Retry counts", acceptance: ["Counts log", ""], before: 12 },
      { cardId: "draft:1", idempotencyKey: "k-1" }
    ]
    for (const input of accepted) expect(TodoNewInputSchema.parse(input)).toEqual(input)
    const refused = [
      { title: "" },
      { idempotencyKey: "" },
      { before: 0 },
      { before: -1 },
      { before: 1.5 },
      { before: "12" },
      { acceptance: "Counts log" },
      { acceptance: [1] },
      { text: 1 },
      { cardId: 1 }
    ]
    for (const input of refused) expect(TodoNewInputSchema.safeParse(input).success).toBe(false)
  })

  test("the TODO card carries the model once read, and its number before", () => {
    const model = fixtures.queued.model
    const card = todoCard(12, model, 3, 1_000)
    expect(card).toEqual({
      id: "todo:12",
      kind: "todo",
      title: "Card model contracts",
      status: "active",
      createdAt: 1_000,
      ordinal: 3,
      payload: { n: 12, model, requests: [] }
    })
    expect(CardSchema.parse(card)).toEqual(card)
    const blank = todoCard(7, undefined, 0, 5)
    expect(blank).toEqual({
      id: "todo:7",
      kind: "todo",
      title: "T7",
      status: "active",
      createdAt: 5,
      ordinal: 0,
      payload: { n: 7, requests: [] }
    })
    expect(CardSchema.parse(blank)).toEqual(blank)
  })
})
