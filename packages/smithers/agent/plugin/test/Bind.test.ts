import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Bind from "../src/Bind.vibe"

const references = (args: Record<string, any>, at?: string) => Result.getOrThrow(Bind.references(args, at))
const refused = (args: Record<string, any>, at?: string) =>
  Result.getOrThrowWith(Result.flip(Bind.references(args, at)), () => new Error("referenced"))

describe("Bind.references", () => {
  it("lists every reference, nested ones included, with where it was written", async () => {
    expect(
      await references({
        runId: "$item.runId",
        value: { approved: true, note: "$event.note", list: ["literal", "$item.options[$event.index]", "$item[0].a"] },
        index: "$key.index",
        plain: "text",
        none: null
      })
    ).toEqual([
      { root: "item", path: ["runId"], at: "runId" },
      { root: "event", path: ["note"], at: "value.note" },
      { root: "item", path: ["options", { event: "index" }], at: "value.list[1]" },
      { root: "item", path: [0, "a"], at: "value.list[2]" },
      { root: "key", path: ["index"], at: "index" }
    ])
    expect(await references({ whole: "$event" })).toEqual([{ root: "event", path: [], at: "whole" }])
  })

  it("refuses a $ string outside the grammar, at the arg it was written", async () => {
    for (const text of ["$items", "$item.", "$item.a.b.c.d.e", "$item[x]", "$item[$item.a]", "$other", "$"]) {
      expect(await refused({ v: text }, "args"), text).toMatchObject({ reason: "invalid", path: "args.v" })
    }
    expect(await refused({ v: ["$bad", "$worse"] })).toMatchObject({ path: "v[0]" })
  })
})

describe("Bind.bind", () => {
  const item = { runId: "r", options: ["a", "b"], nested: { deep: [{ x: 1 }] }, nothing: undefined }

  it("fills references and keeps literals", () => {
    expect(
      Bind.bind(
        { runId: "$item.runId", value: "$item.options[$event.index]", fixed: { on: true, list: [1, "$key.index"] } },
        { item, event: { index: 1 }, key: { index: 4 } }
      )
    ).toEqual(Result.succeed({ runId: "r", value: "b", fixed: { on: true, list: [1, 4] } }))
    expect(Bind.bind({ x: "$item.nested.deep[0].x" }, { item, event: {} })).toEqual(Result.succeed({ x: 1 }))
    expect(Bind.bind({ note: "$event.note", kind: "reply" }, { item, event: { note: "Thanks" } })).toEqual(
      Result.succeed({ note: "Thanks", kind: "reply" })
    )
  })

  it("fails naming the reference that reaches nothing", () => {
    const scope = { item, event: { index: 5, negative: -1, text: "1" } }
    expect(Bind.bind({ v: "$item.options[$event.index]" }, scope)).toEqual(
      Result.fail("$item.options[$event.index] is missing")
    )
    expect(Bind.bind({ v: "$item.options[$event.negative]" }, scope)).toEqual(
      Result.fail("$item.options[$event.negative] is missing")
    )
    expect(Bind.bind({ v: "$item.options[$event.text]" }, scope)).toEqual(
      Result.fail("$item.options[$event.text] is missing")
    )
    expect(Bind.bind({ v: "$item.options[$event.absent]" }, scope)).toEqual(
      Result.fail("$item.options[$event.absent] is missing")
    )
    expect(Bind.bind({ v: ["$item.gone"] }, scope)).toEqual(Result.fail("$item.gone is missing"))
    expect(Bind.bind({ v: { w: "$item.runId.length" } }, scope)).toEqual(Result.fail("$item.runId.length is missing"))
    expect(Bind.bind({ v: "$item.options.length" }, scope)).toEqual(Result.fail("$item.options.length is missing"))
    expect(Bind.bind({ v: "$item.runId[0]" }, scope)).toEqual(Result.fail("$item.runId[0] is missing"))
    expect(Bind.bind({ v: "$item.nothing" }, scope)).toEqual(Result.fail("$item.nothing is missing"))
    expect(Bind.bind({ v: "$item.constructor" }, scope)).toEqual(Result.fail("$item.constructor is missing"))
    expect(Bind.bind({ v: "$key.index" }, scope)).toEqual(Result.fail("$key.index is missing"))
    expect(Bind.bind({ v: "$nope" }, scope)).toEqual(Result.fail("$nope is outside the binding grammar"))
  })
})
