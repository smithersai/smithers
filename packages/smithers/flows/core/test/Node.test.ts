import * as Identity from "@smthrs/crypto/Identity"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const declaration = Effects.make({
  reads: ["src/**"],
  writes: ["dist/**"],
  mode: "hermetic",
  onConflict: "serialize"
})

describe("Node", () => {
  it("constructs succeed, all, and dynamic AST nodes", () => {
    const name = Node.succeed("Ada")
    const age = Node.succeed(37)
    const combined = Node.all({ name, age })
    const dynamic = Node.dynamic({
      model: "test-model",
      flows: ["lookup"],
      output: { Type: "" },
      prompt: "Summarize",
      effects: declaration
    })

    expect(name.ast).toMatchObject({ _tag: "Succeed", value: "Ada" })
    expect(combined.ast).toMatchObject({
      _tag: "All",
      nodes: {
        name: name.ast,
        age: age.ast
      }
    })
    expect(dynamic.ast).toMatchObject({
      _tag: "Dynamic",
      model: "test-model",
      flows: ["lookup"],
      output: { Type: "" },
      prompt: "Summarize",
      effects: declaration
    })
    expect(Node.dynamic({}).ast).toMatchObject({ _tag: "Dynamic", flows: [] })
    expect(Node.isNode(combined)).toBe(true)
    expect(Node.isNode({ ast: combined.ast })).toBe(false)
  })

  it("supports data-first and data-last map", () => {
    const source = Node.succeed(2)
    const increment = (value: number) => value + 1
    const dataFirst = Node.map(source, increment)
    const dataLast = source.pipe(Node.map((value) => value * 3))

    expect(dataFirst.ast._tag).toBe("Map")
    expect(dataLast.ast._tag).toBe("Map")
    if (dataFirst.ast._tag === "Map" && dataLast.ast._tag === "Map") {
      expect(dataFirst.ast.first).toBe(source.ast)
      expect(dataFirst.ast.mapper).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataLast.ast.first).toBe(source.ast)
      expect(dataLast.ast.mapper).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataFirst.ast.mapper).not.toEqual(dataLast.ast.mapper)
      expect(JSON.stringify(dataFirst.ast)).not.toContain("increment")
    }
  })

  it("supports data-first and data-last andThen with deferred continuations", () => {
    const source = Node.succeed(2)
    let continuationCalls = 0
    const stringify = (value: number) => {
      continuationCalls++
      return Node.succeed(String(value))
    }
    const dataFirst = Node.andThen(source, stringify)
    const dataLast = source.pipe(Node.andThen((value) => Node.succeed(value * 3)))
    const next = Node.succeed("done")
    const staticFirst = Node.andThen(source, next)
    const staticLast = source.pipe(Node.andThen(next))

    expect(continuationCalls).toBe(0)
    for (const node of [dataFirst, dataLast, staticFirst, staticLast]) {
      expect(node.ast._tag).toBe("AndThen")
    }
    if (
      dataFirst.ast._tag === "AndThen" &&
      dataLast.ast._tag === "AndThen" &&
      staticFirst.ast._tag === "AndThen" &&
      staticLast.ast._tag === "AndThen"
    ) {
      expect(dataFirst.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataLast.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataFirst.ast.continuation).not.toEqual(dataLast.ast.continuation)
      expect(staticFirst.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "static-node/v1",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
      expect(staticLast.ast.continuation).toEqual(staticFirst.ast.continuation)
      expect(staticFirst.ast.next).toBe(next.ast)
      expect(staticLast.ast.next).toBe(next.ast)
      expect(continuationCalls).toBe(0)
    }
  })

  it("supports data-first and data-last within", () => {
    const source = Node.succeed("value")
    const placement = Placement.sandbox({ image: "flows:test" })
    const dataFirst = Node.within(source, placement)
    const dataLast = source.pipe(Node.within(placement))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Placement))).toBe(
      placement
    )
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Placement))).toBe(
      placement
    )
  })

  it("supports data-first and data-last withEffects", () => {
    const source = Node.succeed("value")
    const dataFirst = Node.withEffects(source, declaration)
    const dataLast = source.pipe(Node.withEffects(declaration))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Effects))).toBe(
      declaration
    )
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Effects))).toBe(
      declaration
    )
  })

  it("does not mutate the original AST or annotations while piping", () => {
    const source = Node.succeed({ value: 1 })
    const originalAst = source.ast
    const placed = source.pipe(Node.within(Placement.local()))
    const mapped = source.pipe(Node.map((value) => value.value))

    expect(source.ast).toBe(originalAst)
    expect(placed).not.toBe(source)
    expect(placed.ast).not.toBe(source.ast)
    expect(mapped).not.toBe(source)
    expect(mapped.ast).not.toBe(source.ast)
    expect(Option.isNone(Annotations.getOption(source.ast.annotations, Annotations.Placement))).toBe(true)
  })

  it("constructs structurally identical ASTs deterministically", () => {
    const build = () =>
      Node.all({
        input: Node.succeed({ id: 42 }),
        model: Node.dynamic({
          model: "test-model",
          flows: ["lookup"],
          prompt: "Inspect"
        })
      })

    expect(build().ast).toEqual(build().ast)
  })

  // Capture admission and the identity digest itself moved to
  // `@smthrs/crypto/Identity` with their suite. What core still owns is the
  // wiring: the names it re-exports are that one implementation, and a mapper
  // it records carries that implementation's digest.
  it("records the one capture and identity implementation", () => {
    expect(Node.functionIdentity).toBe(Identity.functionIdentity)

    const body = function(this: { readonly offset: number }, value: number) {
      return value + this.offset
    }
    const operation = Node.capture({ offset: 1 }, body)
    const ast = Node.map(Node.succeed(1), operation).ast
    if (ast._tag !== "Map") throw new Error("expected Map")
    expect(ast.mapper).toEqual(Identity.functionIdentity(Identity.capture({ offset: 1 }, body)))
    expect(ast.mapper.algorithm).toBe("sha256-source-captures/v4")
  })

  it("rejects non-Node members with NodeBuildError", () => {
    const invalid = { valid: Node.succeed("ok"), invalid: 42 } as unknown as Readonly<Record<string, Node.Any>>

    expect(() => Node.all(invalid)).toThrow(Node.NodeBuildError)
    try {
      Node.all(invalid)
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "flows/core/NodeBuildError",
        code: "invalid_all_member",
        member: "invalid"
      })
    }
  })

  it("retains prototype-like Node.all member names", () => {
    const combined = Node.all({
      ["__proto__"]: Node.succeed("proto"),
      constructor: Node.succeed("constructor"),
      prototype: Node.succeed("prototype")
    })

    if (combined.ast._tag !== "All") throw new Error("expected All")
    expect(Object.getPrototypeOf(combined.ast.nodes)).toBeNull()
    expect(Object.keys(combined.ast.nodes)).toEqual(["__proto__", "constructor", "prototype"])
  })
})
