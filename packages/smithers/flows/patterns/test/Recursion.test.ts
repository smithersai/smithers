import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Recursion from "../src/Recursion.ts"
import { callsTo } from "./Graphs.ts"

const child = Flow.make("child", {
  payload: { input: Schema.Unknown, envelope: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ input }) => Node.succeed(input)
})

// The tree is the pattern's input, and `@smthrs/flow` requires a struct
// payload, so a tree is handed over as the one `input` field.
const tree = (value: unknown): { readonly input: unknown } => ({ input: value })

describe("Recursion", () => {
  it("declares a child under an attenuated envelope", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 2 })

    expect(Flow.isFlow(recursive)).toBe(true)
    expect(recursive.body(tree("root")).ast._tag).toBe("FlowCall")
    const graph = Graph.build(
      recursive,
      tree({
        input: "root",
        children: [
          { input: "left", children: [{ input: "leaf" }] },
          { input: "right" }
        ]
      })
    )
    expect(callsTo(graph, "child")).toHaveLength(4)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const recursive = Recursion.recurse({
      child,
      fuel: 4,
      depth: 3,
      fanout: 2,
      name: "expand-tree",
      description: "Expand every branch under the envelope."
    })

    expect(recursive._tag).toBe("expand-tree")
    expect(recursive.description).toBe("Expand every branch under the envelope.")
    expect(Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 2 }).description).toBeUndefined()
  })

  it("rejects exhausted and widened bounds", () => {
    expect(() => Recursion.recurse({ child, fuel: 0, depth: 1, fanout: 1 })).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursion bounds must be positive safe integers"
      })
    )
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 3,
        depth: 2,
        fanout: 2,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Nested recursion may attenuate but cannot widen its parent envelope"
      })
    )
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 2,
        depth: 3,
        fanout: 2,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Nested recursion may attenuate but cannot widen its parent envelope"
      })
    )
    expect(() =>
      Recursion.recurse({
        child,
        fuel: 2,
        depth: 2,
        fanout: 3,
        parent: { fuel: 2, depth: 2, fanout: 2 }
      })
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Nested recursion may attenuate but cannot widen its parent envelope"
      })
    )
    expect(() =>
      Graph.build(
        Recursion.recurse({ child, fuel: 3, depth: 3, fanout: 1 }),
        tree({ input: "root", children: [{ input: "a" }, { input: "b" }] })
      )
    ).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursive child fan-out exceeds the envelope"
      })
    )
    expect(() =>
      Graph.build(
        Recursion.recurse({ child, fuel: 2, depth: 3, fanout: 2 }),
        tree({
          input: "root",
          children: [{ input: "a", children: [{ input: "b" }] }]
        })
      )
    ).toThrow(
      expect.objectContaining({ code: "recursion_bound", message: "Recursion fuel is exhausted" })
    )
  })

  it("admits an equal or attenuated parent envelope", () => {
    expect(Flow.isFlow(Recursion.recurse({
      child,
      fuel: 2,
      depth: 1,
      fanout: 1,
      parent: { fuel: 2, depth: 2, fanout: 2 }
    }))).toBe(true)
  })

  it("refuses invalid parent envelope fields before attenuation", () => {
    const invalidParents = [
      ["fuel", Number.NaN],
      ["depth", Number.POSITIVE_INFINITY],
      ["fanout", 1.5]
    ] as const

    for (const [field, value] of invalidParents) {
      const parent = { fuel: 2, depth: 2, fanout: 2, [field]: value }
      expect(() => Recursion.recurse({ child, fuel: 1, depth: 1, fanout: 1, parent })).toThrow(
        expect.objectContaining({
          code: "recursion_bound",
          message: `Recursion parent ${field} must be a positive safe integer, received ${value}`
        })
      )
    }
  })

  it("refuses non-array branch children with a typed bound error", () => {
    const recursive = Recursion.recurse({ child, fuel: 3, depth: 3, fanout: 2 })
    const invalidChildren = [
      ["x", "string"],
      [{ input: "nested" }, "object"]
    ] as const

    for (const [children, received] of invalidChildren) {
      expect(() => Graph.build(recursive, tree({ input: "root", children }))).toThrow(
        expect.objectContaining({
          code: "recursion_bound",
          message: `Recursive branch children must be an array when present, received ${received}`
        })
      )
    }
  })

  it("treats a value without an own input property as an opaque leaf", () => {
    const recursive = Recursion.recurse({ child, fuel: 3, depth: 3, fanout: 2 })
    // Only an OWN `input` makes a value a branch, so a value carrying only
    // `children` is a leaf and those children are never expanded.
    const leaf = { children: [{ input: "nested" }] }

    expect(recursive.body(tree(leaf)).ast._tag).toBe("FlowCall")
    expect(callsTo(Graph.build(recursive, tree(leaf)), "child")).toHaveLength(1)
    // A value whose `input` and `children` are INHERITED gets a stricter answer
    // than core's "read own properties only": `@smthrs/plan`'s payload mirror
    // refuses a foreign prototype outright, so the forged branch cannot even
    // reach a call payload.
    expect(() => recursive.body(tree(Object.create({ input: "forged", children: [{ input: "nested" }] }))))
      .toThrow(expect.objectContaining({ code: "invalid_payload" }))
  })

  it("admits the declared depth and refuses one level past it", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 1 })
    const atBound = {
      input: "root",
      children: [{ input: "middle", children: [{ input: "leaf" }] }]
    }
    const pastBound = {
      input: "root",
      children: [{ input: "middle", children: [{ input: "leaf", children: [{ input: "past" }] }] }]
    }

    expect(callsTo(Graph.build(recursive, tree(atBound)), "child")).toHaveLength(3)
    expect(() => Graph.build(recursive, tree(pastBound))).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursive child depth exceeds the envelope"
      })
    )
  })

  it("refuses a symbolic tree instead of silently planning one leaf", () => {
    const recursive = Recursion.recurse({ child, fuel: 4, depth: 3, fanout: 2 })
    const composed = Flow.make("recursion/host", {
      payload: { input: Schema.Unknown },
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: ({ input }) => Node.bindPlanned(Node.succeed(input), (value) => recursive.call({ input: value }))
    })

    expect(() => Graph.build(composed, { input: "root" })).toThrow(
      expect.objectContaining({
        code: "recursion_bound",
        message: "Recursion input must be a literal tree available while planning"
      })
    )
  })
})
