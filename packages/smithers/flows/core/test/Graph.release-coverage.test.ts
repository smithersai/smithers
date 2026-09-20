import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as internal from "../src/internal/node.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const effect = (options: Partial<Effects.MakeOptions> = {}): Effects.Declaration =>
  Effects.make({
    reads: options.reads ?? [],
    writes: options.writes ?? [],
    mode: options.mode ?? "expected",
    onConflict: options.onConflict ?? "serialize",
    ...(options.tier === undefined ? {} : { tier: options.tier })
  })

const reflected = (value: unknown): unknown => {
  const body = Graph.nodes(Graph.build(Node.succeed(value)))[0]?.keyMaterial.body as {
    readonly _tag: "Succeed"
    readonly value: unknown
  }
  return body.value
}

describe("Graph release coverage", () => {
  it("reflects bigint, description-less symbols, cycles, and array descriptors", () => {
    expect(reflected(42n)).toEqual({ _tag: "BigInt", value: "42" })
    expect(reflected(Symbol())).toEqual({
      _tag: "Symbol",
      key: null,
      description: null,
      scope: "process-local",
      id: expect.any(String)
    })

    const cycle: Record<string, unknown> = { label: "cycle" }
    cycle.self = cycle
    expect(reflected(cycle)).toEqual({ label: "cycle", self: { _tag: "Circular" } })

    let accessorCalls = 0
    const array: Array<unknown> = []
    array.length = 4
    array[0] = "visible"
    Object.defineProperty(array, "1", { enumerable: false, value: "hidden" })
    Object.defineProperty(array, "2", {
      enumerable: true,
      get: () => {
        accessorCalls++
        return "executed"
      }
    })
    const result = reflected(array) as Array<unknown>

    expect(result[0]).toBe("visible")
    expect(result[1]).toBe("hidden")
    expect(result[2]).toEqual({
      _tag: "Accessor",
      get: {
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4",
        digest: expect.any(String)
      },
      set: null
    })
    expect(result[3]).toEqual({ _tag: "Hole" })
    expect(accessorCalls).toBe(0)
  })

  it("marks a self-referential callable flow without recursing forever", () => {
    const flow = Flow.make({ body: () => Node.succeed("done") })
    ;(flow as unknown as { implementation: unknown }).implementation = { self: flow }

    expect(reflected(flow)).toMatchObject({
      _tag: "Flow",
      implementation: { self: { _tag: "CircularFlow" } }
    })
  })

  it("falls back independently for cyclic schema annotations and JSON Schema failures", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const cyclicAnnotations = Schema.String.annotate({ documentation: cycle as unknown as string })
    const cyclicBody = Graph.nodes(Graph.build(Node.dynamic({ output: cyclicAnnotations })))[0]?.keyMaterial.body

    expect(cyclicBody).toMatchObject({
      output: {
        _tag: "Schema",
        document: { schema: { type: "string" } },
        ast: { tag: "String", annotations: { _tag: "CyclicAnnotations" } }
      }
    })

    let astReads = 0
    const throwingSchema = new Proxy(Schema.String, {
      get: (target, key, receiver) => {
        if (key === "ast" && ++astReads >= 2) throw new Error("JSON Schema unavailable")
        return Reflect.get(target, key, receiver)
      }
    }) as Schema.Top
    const throwingBody = Graph.nodes(Graph.build(Node.dynamic({ output: throwingSchema })))[0]?.keyMaterial.body

    // One read projects the AST; the next belongs to JSON Schema generation, so
    // failing there leaves the AST projection intact and drops only `document`.
    expect(astReads).toBe(2)
    expect(throwingBody).toMatchObject({
      output: { _tag: "Schema", ast: { tag: "String", annotations: null } }
    })
    expect((throwingBody as { readonly output: object }).output).not.toHaveProperty("document")

    const recursiveFlow = Flow.make({ body: () => Node.succeed("done") })
    ;(recursiveFlow as unknown as { implementation: unknown }).implementation = { self: recursiveFlow }
    const recursiveFlowSchema = Schema.String.annotate({ documentation: recursiveFlow as unknown as string })
    const recursiveFlowBody = Graph.nodes(
      Graph.build(Node.dynamic({ output: recursiveFlowSchema }))
    )[0]?.keyMaterial.body
    expect(recursiveFlowBody).toMatchObject({
      output: { ast: { annotations: { _tag: "CyclicAnnotations" } } }
    })
  })

  it("sorts reflection values with undefined and equal JSON projections", () => {
    expect(reflected(new Set([undefined, 1]))).toEqual({
      _tag: "Set",
      values: [1, { _tag: "Undefined" }]
    })
    expect(reflected(new Set([1, undefined]))).toEqual({
      _tag: "Set",
      values: [1, { _tag: "Undefined" }]
    })
    expect(reflected(new Set([{ id: 1 }, { id: 1 }]))).toEqual({
      _tag: "Set",
      values: [{ id: 1 }, { id: 1 }]
    })
  })

  it("uses safe fallbacks for reflective built-in metadata", () => {
    const namelessPrototype = Object.create(Object.prototype)
    const nameless = Object.create(namelessPrototype) as object
    expect(() => reflected(nameless)).toThrowError(
      "Graph.build cannot derive identity for a \"Unknown\" instance at $; plan values must be plain data"
    )

    const emptyName = function NamedConstructor() {}
    Object.defineProperty(emptyName, "name", { configurable: true, value: "" })
    const emptyNamePrototype = Object.create(Object.prototype, {
      constructor: { configurable: true, value: emptyName }
    })
    expect(() => reflected(Object.create(emptyNamePrototype))).toThrowError(
      "Graph.build cannot derive identity for a \"Unknown\" instance at $; plan values must be plain data"
    )

    let prototypeReads = 0
    const alternating = new Proxy({}, {
      getPrototypeOf: () => ++prototypeReads <= 8 ? namelessPrototype : null
    })
    expect(() => reflected(alternating)).toThrowError(
      "Graph.build cannot derive identity for a \"Unknown\" instance at $; plan values must be plain data"
    )
    // The refusal is reached only after the proxy starts reporting a null
    // prototype, which is the branch this hostile value exists to cover.
    expect(prototypeReads).toBeGreaterThan(8)

    const sourceDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!
    Reflect.deleteProperty(RegExp.prototype, "source")
    try {
      expect(reflected(/fallback/g)).toEqual({ _tag: "RegExp", source: "", flags: "g" })
    } finally {
      Object.defineProperty(RegExp.prototype, "source", sourceDescriptor)
    }

    const nameDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, "name")!
    Reflect.deleteProperty(Error.prototype, "name")
    try {
      expect(reflected(new Error())).toEqual({ _tag: "Error", name: "Error", message: "", fields: {} })
    } finally {
      Object.defineProperty(Error.prototype, "name", nameDescriptor)
    }

    const accessorError = new Error("ignored")
    const name = () => 1
    const message = () => 2
    Object.defineProperties(accessorError, {
      name: { get: name },
      message: { get: message }
    })
    expect(reflected(accessorError)).toEqual({
      _tag: "Error",
      name: "Error",
      message: "",
      fields: {
        name: { _tag: "Accessor", get: internal.functionIdentity(name), set: null },
        message: { _tag: "Accessor", get: internal.functionIdentity(message), set: null }
      }
    })

    const bytes = new ArrayBuffer(3)
    new Uint8Array(bytes).set([1, 2, 3])
    expect(reflected(bytes)).toEqual({ _tag: "Bytes", kind: "ArrayBuffer", bytes: [1, 2, 3] })
  })

  it("walks data properties without invoking accessors while discovering planned references", () => {
    const accept = Flow.make({
      input: Schema.Unknown,
      output: Schema.String,
      body: () => Node.succeed("accepted")
    })
    let accessorCalls = 0
    const array: Array<unknown> = []
    array.length = 4
    array[0] = "visible"
    Object.defineProperty(array, "1", { enumerable: false, value: "hidden" })
    Object.defineProperty(array, "2", {
      enumerable: true,
      get: () => {
        accessorCalls++
        return "executed"
      }
    })
    const object = Object.defineProperties({}, {
      hidden: { enumerable: false, value: "hidden" },
      computed: { enumerable: true, get: () => "executed" }
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    expect(() => Graph.build(accept(array))).not.toThrow()
    expect(() => Graph.build(accept(object))).not.toThrow()
    expect(() => Graph.build(accept(cycle))).not.toThrow()
    expect(accessorCalls).toBe(0)
  })

  it("enforces the planned-reference depth limit even for callable inputs", () => {
    const accept = Flow.make({ input: Schema.Unknown, body: () => Node.succeed("accepted") })
    const callable = (() => undefined) as (() => undefined) & { payload?: unknown }
    let payload: unknown = "leaf"
    for (let index = 0; index <= Graph.maximumPayloadDepth; index++) payload = { payload }
    callable.payload = payload

    try {
      Graph.build(accept(callable))
      throw new Error("expected the planned input to exceed its depth limit")
    } catch (error) {
      expect(error).toBeInstanceOf(Graph.GraphBuildError)
      expect(error).toMatchObject({ code: "payload_too_deep", path: [], node: "root.flow" })
    }
  })

  it("deduplicates repeated planned references and supports apply and then probes", () => {
    const accept = Flow.make({ input: Schema.Unknown, body: () => Node.succeed("accepted") })
    const deduplicated = Graph.build(
      Node.andThen(
        Node.succeed({ value: "ready" }),
        (value: { readonly value: string }) => accept({ first: value.value, second: value.value })
      )
    )
    const inputs = Graph.nodes(deduplicated).find((node) => node.id === "root.then")?.keyMaterial.inputs ?? []

    expect(inputs.filter((input) => input._tag === "Ref" && input.from === "root.andThen")).toEqual([{
      _tag: "Ref",
      from: "root.andThen",
      path: ["value"]
    }])

    const applied = Graph.build(
      Node.andThen(Node.succeed(() => "ignored"), (value) => Node.succeed(value()))
    )
    expect(Graph.nodes(applied).find((node) => node.id === "root.then")?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: { _tag: "PlannedInput", path: [] }
    })

    const probed = Graph.build(
      Node.andThen(Node.succeed({ then: "ignored" }), (value) => Node.succeed(value.then))
    )
    expect(Graph.nodes(probed).find((node) => node.id === "root.then")?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: undefined
    })
  })

  it("projects a detached FlowCall without pretending a declaration was resolved", () => {
    const ast = internal.flowCall(undefined, { _tag: "FlowReference", name: "missing" }, "input", Annotations.empty)
    const detached = Node.within(internal.makeNode(ast), Placement.local())
    const graph = Graph.build(detached)

    expect(Graph.nodes(graph)).toHaveLength(1)
    expect(Graph.nodes(graph)[0]?.keyMaterial.body).toEqual({
      _tag: "FlowCall",
      input: undefined,
      output: undefined,
      capabilities: undefined,
      effects: undefined,
      implementation: undefined
    })
  })

  it("rejects unsupported ASTs and preserves descriptor failures as causes", () => {
    const unsupported = internal.makeNode({
      _tag: "Unsupported",
      annotations: Annotations.empty
    } as unknown as internal.NodeAst)
    try {
      Graph.build(unsupported)
      throw new Error("expected an unsupported AST to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Graph.GraphBuildError)
      expect(error).toMatchObject({
        code: "invalid_node",
        path: [],
        node: "root",
        message: "Graph.build expected a supported Node AST at \"root\""
      })
    }

    const cause = new Error("descriptor failure")
    const hostileAst = new Proxy({} as internal.NodeAst, {
      ownKeys: () => {
        throw cause
      }
    })
    try {
      Graph.build(internal.makeNode(hostileAst))
      throw new Error("expected descriptor reflection to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Graph.GraphBuildError)
      expect((error as Error & { readonly cause?: unknown }).cause).toBe(cause)
      expect(error).toMatchObject({ code: "invalid_node", node: "root" })
    }
  })

  it("validates required tag-specific AST fields at the root", () => {
    let accessorCalls = 0
    const succeed = {
      _tag: "Succeed",
      annotations: Annotations.empty
    }
    Object.defineProperty(succeed, "value", {
      get: () => {
        accessorCalls++
        return "forged"
      }
    })
    const first = Node.succeed("valid").ast
    const forged = [
      succeed,
      { _tag: "Fail", annotations: Annotations.empty },
      { _tag: "All", nodes: null, annotations: Annotations.empty },
      { _tag: "Dynamic", flows: null, annotations: Annotations.empty },
      { _tag: "AndThen", first: null, annotations: Annotations.empty },
      { _tag: "Map", first: null, annotations: Annotations.empty },
      { _tag: "Catch", first: null, error: undefined, annotations: Annotations.empty },
      { _tag: "Catch", first, error: 42, annotations: Annotations.empty },
      { _tag: "FlowCall", annotations: Annotations.empty }
    ]

    for (const ast of forged) {
      const node = internal.makeNode(ast as unknown as internal.NodeAst)
      expect(() => Graph.build(node)).toThrow(Graph.GraphBuildError)
      try {
        Graph.build(node)
        throw new Error("expected the forged AST to be rejected")
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_node", node: "root" })
      }
    }
    expect(accessorCalls).toBe(0)
  })

  it("reports exact continuation errors for missing and invalid builders", () => {
    const sequence = Node.andThen(Node.succeed(1), () => Node.succeed(2))
    if (sequence.ast._tag !== "AndThen") throw new Error("expected AndThen")
    const detached = Node.within(internal.makeNode({ ...sequence.ast }), Placement.local())

    for (
      const [node, message] of [
        [detached, "Node.andThen at \"root\" has no continuation builder"],
        [
          Node.andThen(Node.succeed(1), (() => 2) as unknown as () => Node.Node<number>),
          "Node.andThen at \"root\" must return a Node"
        ]
      ] as const
    ) {
      try {
        Graph.build(node)
        throw new Error("expected the continuation to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(Node.NodeBuildError)
        expect(error).toMatchObject({ code: "invalid_continuation", member: "root", message })
      }
    }

    const recovery = Node.catch(Node.fail("failure"), { onFailure: () => Node.succeed("recovered") })
    if (recovery.ast._tag !== "Catch") throw new Error("expected Catch")
    const detachedRecovery = internal.makeNode({ ...recovery.ast })
    try {
      Graph.build(detachedRecovery)
      throw new Error("expected the recovery builder to be missing")
    } catch (error) {
      expect(error).toBeInstanceOf(Node.NodeBuildError)
      expect(error).toMatchObject({
        code: "invalid_continuation",
        member: "root",
        message: "Node.catch at \"root\" has no recovery builder"
      })
    }
  })

  it("preserves every deferred association while annotating nodes", () => {
    const sequence = Node.within(
      Node.andThen(Node.succeed(1), (value) => Node.succeed(value)),
      Placement.local()
    )
    expect(Graph.nodes(Graph.build(sequence)).map((node) => node.id)).toContain("root.then")

    const mapped = Node.within(Node.map(Node.succeed(1), (value) => value + 1), Placement.client())
    if (mapped.ast._tag !== "Map") throw new Error("expected Map")
    expect(internal.operation(mapped.ast)?.(1)).toBe(2)

    const recovered = Node.within(
      Node.catch(Node.fail("failure"), { onFailure: () => Node.succeed("recovered") }),
      Placement.remote()
    )
    expect(Graph.nodes(Graph.build(recovered)).map((node) => node.id)).toContain("root.recover")

    const flow = Flow.make({ input: Schema.String, body: (value) => Node.succeed(value) })
    const call = Node.within(flow("value"), Placement.local())
    expect(Graph.nodes(Graph.build(call)).map((node) => node.id)).toEqual(["root", "root.flow"])
  })

  it("records fail conflicts exactly and refuses their key material", () => {
    const writes = effect({ writes: ["out/result"], onConflict: "fail" })
    const graph = Graph.build(Node.all({
      first: Node.withEffects(Node.dynamic({}), writes),
      second: Node.withEffects(Node.dynamic({}), writes)
    }))

    expect(Graph.conflicts(graph)).toEqual([{
      nodes: ["root.all.first", "root.all.second"],
      paths: ["out/result"],
      strategy: "fail"
    }])
    // The diagnostic names the first writer; `Graph.conflicts` above carries
    // the pair, and the message names both.
    expect(Graph.diagnostics(graph)).toMatchObject([{
      code: "write_conflict",
      node: "root.all.first",
      path: ["out/result"],
      message: expect.stringContaining("root.all.second")
    }])
    expect(Graph.keyMaterial(graph)).toMatchObject({
      _tag: "Failure",
      failure: { code: "write_conflict" }
    })
  })

  it("drops a lane-merge placement when conflicting writers disagree", () => {
    const writes = effect({ writes: ["out/result"], onConflict: "lane" })
    const graph = Graph.build(Node.all({
      local: Node.within(Node.withEffects(Node.dynamic({}), writes), Placement.local()),
      remote: Node.within(Node.withEffects(Node.dynamic({}), writes), Placement.remote())
    }))
    const merge = Graph.nodes(graph).find((node) => node.kind === "LaneMerge")

    expect(merge).toMatchObject({ id: "lane.merge.0", placement: undefined })
    expect(Graph.placements(graph)).toEqual([
      { nodeId: "root.all.local", placement: Placement.local() },
      { nodeId: "root.all.remote", placement: Placement.remote() }
    ])
  })

  it("deduplicates a conflict dependency after duplicate structural ids converge", () => {
    const writes = effect({ writes: ["out/result"] })
    const graph = Graph.build(Node.all({
      group: Node.all({ writer: Node.withEffects(Node.dynamic({}), writes) }),
      "group.all.writer": Node.withEffects(Node.dynamic({}), writes),
      other: Node.withEffects(Node.dynamic({}), writes)
    }))
    const conflictEdges = Graph.edges(graph).filter((edge) => edge.reason === "conflict")

    expect(Graph.diagnostics(graph).some((diagnostic) => diagnostic.code === "duplicate_node")).toBe(true)
    expect(conflictEdges.filter((edge) => edge.to === "root.all.other")).toEqual([{
      from: "root.all.group.all.writer",
      to: "root.all.other",
      reason: "conflict"
    }])
  })

  it("returns no placements for an unplaced graph", () => {
    expect(Graph.placements(Graph.build(Node.succeed("plain")))).toEqual([])
  })

  it("propagates nested key-material failure and skips absent dependency records", () => {
    const built = Graph.build(Node.all({ child: Node.succeed("value") }))
    const [root, child] = Graph.nodes(built)
    if (root === undefined || child === undefined) throw new Error("expected root and child")

    const nestedFailure = {
      ...built,
      nodes: [root, { ...child, keyMaterial: undefined }]
    } as unknown as Graph.Graph
    expect(Graph.keyMaterial(nestedFailure)).toMatchObject({
      _tag: "Failure",
      failure: { code: "missing_key_material", node: child.id }
    })

    const missingDependency = {
      ...built,
      nodes: [{ ...root, dependencies: ["absent"] }, child]
    } as unknown as Graph.Graph
    expect(Result.getOrThrow(Graph.keyMaterial(missingDependency)).map((entry) => entry.nodeId)).toEqual([
      root.id,
      child.id
    ])
  })
})
