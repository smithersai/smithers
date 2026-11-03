import { describe, expect, it } from "@effect/vitest"
import { GraphBuildError } from "../src/GraphBuildError.vibe"
import * as Node from "../src/Node.ts"
import * as Planned from "../src/Planned.vibe"

interface Result {
  readonly files: ReadonlyArray<string>
  readonly count: number
}

const guidance = "Use Node.map to compute, Node.branch to decide, or pass the value into a payload."

const refused = (operation: () => unknown): unknown => {
  try {
    operation()
    return undefined
  } catch (error) {
    return error
  }
}

describe("Planned", () => {
  it("records a reference for the result itself and for every field read", () => {
    const value = Planned.make<Result>("read-pr")
    expect(Planned.reference(value)).toEqual({ node: "read-pr", path: [] })
    expect(Planned.reference(value.files)).toEqual({ node: "read-pr", path: ["files"] })
    expect(Planned.reference(value.files[0])).toEqual({ node: "read-pr", path: ["files", "0"] })
  })

  it("records a symbol key by its description", () => {
    const value = Planned.make<Record<PropertyKey, unknown>>("read-pr")
    const marker = Symbol("marker")
    expect(Planned.reference(value[marker])).toEqual({ node: "read-pr", path: ["Symbol(marker)"] })
  })

  it("is not a thenable", () => {
    const value = Planned.make<Result>("read-pr")
    expect((value as { readonly then?: unknown }).then).toBeUndefined()
  })

  it("recognises a planned value and nothing else", () => {
    expect(Planned.isPlanned(Planned.make<number>("read-pr"))).toBe(true)
    expect(Planned.isPlanned({ files: [] })).toBe(false)
    expect(Planned.isPlanned(null)).toBe(false)
    expect(Planned.isPlanned(1)).toBe(false)
    expect(Planned.isPlanned(() => 1)).toBe(false)
    expect(Planned.reference(undefined)).toBeUndefined()
  })

  it("rejects forged carriers whose references do not have the complete shape", () => {
    const typeId = Symbol.for("@smthrs/plan/Planned")
    const forged = [
      { [typeId]: { node: "n", path: "abc" } },
      { [typeId]: { node: 123 } },
      { [typeId]: { node: "n", path: ["valid", 1] } },
      { [typeId]: { node: "n", path: Array(1) } }
    ]
    for (const value of forged) {
      expect(Planned.reference(value)).toBeUndefined()
      expect(Planned.isPlanned(value)).toBe(false)
    }

    const real = Planned.make<{ readonly field: string }>("n")
    expect(Planned.reference(real)).toEqual({ node: "n", path: [] })
    expect(Planned.reference(real.field)).toEqual({ node: "n", path: ["field"] })
    expect(Node.succeed(forged[0]).ast).toEqual({ _tag: "Succeed", value: {} })
  })

  it("refuses primitive coercion, naming the node and the fix", () => {
    const refusal = refused(() => String(Planned.make<number>("read-pr")))
    expect(refusal).toBeInstanceOf(GraphBuildError)
    expect(refusal).toMatchObject({
      code: "planned_value_computed",
      node: "read-pr",
      path: [],
      message: `Planned value read-pr was computed at plan time by Symbol.toPrimitive. ${guidance}`
    })
  })

  it("refuses valueOf, toString, and toJSON on a field, naming the path", () => {
    const value = Planned.make<Result>("read-pr")
    for (const operation of ["valueOf", "toString", "toJSON"]) {
      expect(refused(() => (value.count as unknown as Record<string, unknown>)[operation])).toMatchObject({
        code: "planned_value_computed",
        node: "read-pr",
        path: ["count"],
        message: `Planned value read-pr.count was computed at plan time by ${operation}. ${guidance}`
      })
    }
  })

  it("refuses JSON serialization of a plan-time placeholder", () => {
    const value = Planned.make<Result>("read-pr")
    expect(() => JSON.stringify({ payload: value })).toThrow(GraphBuildError)
  })

  it("refuses function application", () => {
    const value = Planned.make<() => number>("read-pr")
    expect(refused(() => (value as unknown as () => number)())).toMatchObject({
      code: "planned_value_computed",
      node: "read-pr",
      path: [],
      message: `Planned value read-pr was computed at plan time by function application. ${guidance}`
    })
  })

  it("refuses property existence and enumeration", () => {
    const value = Planned.make<Result>("read-pr")
    expect(refused(() => "files" in value)).toMatchObject({
      code: "planned_value_computed",
      message: `Planned value read-pr was computed at plan time by property existence (\`in\`). ${guidance}`
    })
    expect(refused(() => Object.keys(value))).toMatchObject({
      code: "planned_value_computed",
      message: `Planned value read-pr was computed at plan time by property enumeration. ${guidance}`
    })
  })
})
