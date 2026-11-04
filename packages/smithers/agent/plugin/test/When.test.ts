import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as When from "../src/When.vibe"

const parse = (text: string) => Result.getOrThrow(When.parse(text))

describe("When.parse", () => {
  it("parses a conjunction of view, item and focus clauses, negated or not", () => {
    expect(parse("view == queue/queue && item.question && !focus.input")).toEqual({
      clauses: [
        { negated: false, term: { kind: "view", view: "queue/queue" } },
        { negated: false, term: { kind: "item", field: "question" } },
        { negated: true, term: { kind: "focus" } }
      ]
    })
    expect(parse("! item.x")).toEqual({ clauses: [{ negated: true, term: { kind: "item", field: "x" } }] })
  })

  it("parses an empty condition as always", () => {
    expect(parse("")).toBe(When.always)
    expect(parse("   ")).toBe(When.always)
  })

  it("refuses anything outside the grammar, naming the clause", () => {
    for (const text of ["item.a || item.b", "(item.a)", "item.", "item.a b", "view == Queue", "view = q/q", "focus"]) {
      expect(Result.isFailure(When.parse(text)), text).toBe(true)
    }
    expect(When.parse("focus.input && item.")).toEqual(Result.fail("clause 2 is outside the when grammar"))
  })
})

describe("When.evaluate", () => {
  const when = parse("view == queue/queue && item.question && !focus.input")

  it("holds only when every clause does", () => {
    expect(When.evaluate(when, { view: "queue/queue", item: { question: 1 }, focusInput: false })).toBe(true)
    expect(When.evaluate(when, { view: "other/view", item: { question: true }, focusInput: false })).toBe(false)
    expect(When.evaluate(when, { view: "queue/queue", item: { question: 0 }, focusInput: false })).toBe(false)
    expect(When.evaluate(when, { view: "queue/queue", item: {}, focusInput: false })).toBe(false)
    expect(When.evaluate(when, { view: "queue/queue", focusInput: false })).toBe(false)
    expect(When.evaluate(when, { view: "queue/queue", item: { question: true }, focusInput: true })).toBe(false)
    expect(When.evaluate(When.always, { focusInput: true })).toBe(true)
  })

  it("never reads an inherited field", () => {
    expect(When.evaluate(parse("item.constructor"), { item: {}, focusInput: false })).toBe(false)
  })
})

describe("When.view", () => {
  it("is the first un-negated view clause", () => {
    expect(When.view(parse("!view == a-b/c && item.x && view == q-q/v"))).toBe("q-q/v")
    expect(When.view(parse("item.x"))).toBeUndefined()
  })
})
