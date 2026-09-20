import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Digest from "../src/Digest.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

describe("Flow", () => {
  it("makes callable flow values whose calls build FlowCall nodes without running the body", () => {
    let bodyCalls = 0
    const flow = Flow.make({
      input: Schema.String,
      output: Schema.Number,
      body: () => {
        bodyCalls += 1
        return Node.succeed(1)
      }
    })

    const node = flow("input")

    expect(Flow.isFlow(flow)).toBe(true)
    expect(Node.isNode(node)).toBe(true)
    expect(node.ast).toMatchObject({
      _tag: "FlowCall",
      target: { _tag: "FlowReference" },
      input: "input"
    })
    expect(JSON.stringify(node.ast)).not.toContain("function")
    expect(bodyCalls).toBe(0)
  })

  it("installs a dynamic default body when model or flows are supplied", () => {
    const defaulted = Flow.make({ model: "smart" })
    const callable = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: Node.succeed
    })
    const withModel = Flow.make({
      output: Schema.String,
      model: "smart",
      prompt: "Answer exactly."
    })
    const withFlows = Flow.make({
      output: Schema.String,
      flows: [callable]
    })

    expect(withModel.body).toBeTypeOf("function")
    expect(withFlows.body).toBeTypeOf("function")
    expect(defaulted.input).toBe(Schema.Void)
    expect(defaulted.output).toBe(Schema.Unknown)
    expect(withModel.body?.(undefined).ast).toMatchObject({
      _tag: "Dynamic",
      model: "smart",
      output: Schema.String,
      prompt: "Answer exactly."
    })
    expect(withFlows.body?.(undefined).ast).toMatchObject({
      _tag: "Dynamic",
      flows: [callable],
      output: Schema.String
    })
    expect(withModel.model).toBe("smart")
    expect(withModel.flows).toBeUndefined()
    expect(withModel.prompt).toBe("Answer exactly.")
    expect(withFlows.flows).toEqual([callable])
  })

  it("records advisory model, collaborator, and prompt metadata on a body flow", () => {
    const collaborators: Array<Flow.Reference> = ["helper"]
    const body = (value: string) => Node.succeed(value)
    const flow = Flow.make({
      input: Schema.String,
      output: Schema.String,
      model: "fast",
      flows: collaborators,
      prompt: "P",
      body
    })

    collaborators.push("mutated-later")

    expect(flow.model).toBe("fast")
    expect(flow.flows).toEqual(["helper"])
    expect(flow.prompt).toBe("P")
    expect(flow.body).toBe(body)
    expect(flow.implementation?._tag).toBe("Body")
  })

  it("forwards agent construction to make", () => {
    const config = {
      input: Schema.String,
      output: Schema.String,
      model: "smart",
      prompt: "Review."
    } as const
    const made = Flow.make(config)
    const agent = Flow.agent(config)

    expect(agent.input).toBe(made.input)
    expect(agent.output).toBe(made.output)
    expect(agent.capabilities).toEqual(made.capabilities)
    expect(agent.effects).toBe(made.effects)
    expect(agent.body?.("input").ast).toEqual(made.body?.("input").ast)
  })

  it("accepts unresolved markdown flow names through the same constructor", () => {
    const flow = Flow.make({
      output: Schema.String,
      model: "smart",
      flows: ["search"]
    })

    expect(flow.body?.(undefined).ast).toMatchObject({
      _tag: "Dynamic",
      flows: ["search"]
    })
  })

  it("returns fresh values from immutable combinators", () => {
    const declaration = Effects.make({
      reads: ["src"],
      writes: ["dist"],
      mode: "expected",
      onConflict: "serialize"
    })
    const replacement = Effects.make({
      reads: ["src"],
      writes: ["dist"],
      mode: "hermetic",
      onConflict: "fail"
    })
    const placement = Placement.sandbox({ profile: "test" })
    const original = Flow.make({
      capabilities: ["net"],
      effects: declaration,
      model: "smart"
    })

    const capable = Flow.withCapabilities(original, ["shell"])
    const placed = original.pipe(Flow.within(placement))
    const effected = Flow.withEffects(original, replacement)
    const sealedDirect = Flow.sealed(original)
    const sealedPiped = original.pipe(Flow.sealed())

    expect(capable).not.toBe(original)
    expect(placed).not.toBe(original)
    expect(effected).not.toBe(original)
    expect(sealedDirect).not.toBe(original)
    expect(sealedPiped).not.toBe(original)
    expect(original.capabilities).toEqual(["net"])
    expect(original.effects).toBe(declaration)
    expect(Option.isNone(Annotations.getOption(original.annotations, Annotations.Placement))).toBe(true)
    expect(capable.capabilities).toEqual(["net", "shell"])
    expect(Option.getOrUndefined(Annotations.getOption(placed.annotations, Annotations.Placement))).toEqual(placement)
    expect(effected.effects).toBe(replacement)
    expect(sealedDirect.effects).toEqual(Effects.sealed(declaration))
    expect(sealedPiped.effects).toEqual(Effects.sealed(declaration))
  })

  it("attaches a typed annotation without touching the original or the graph it plans", () => {
    const Bank = Context.Service<{ readonly bank: string }>("test/Flow/Bank")
    const original = Flow.make({
      name: "annotated",
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })

    const direct = Flow.annotate(original, Bank, { bank: "one" })
    const piped = original.pipe(Flow.annotate(Bank, { bank: "two" }))

    expect(direct).not.toBe(original)
    expect(Option.isNone(Annotations.getOption(original.annotations, Bank))).toBe(true)
    expect(Option.getOrUndefined(Annotations.getOption(direct.annotations, Bank))).toEqual({ bank: "one" })
    expect(Option.getOrUndefined(Annotations.getOption(piped.annotations, Bank))).toEqual({ bank: "two" })
    // A custom annotation is advisory, so it takes no part in identity or planning.
    expect(direct.implementation).toEqual(original.implementation)
    expect(Graph.nodes(Graph.build(direct, "x")).map((node) => node.id)).toEqual(
      Graph.nodes(Graph.build(original, "x")).map((node) => node.id)
    )
    expect(Graph.nodes(Graph.build(direct, "x"))[0]?.keyMaterial).toEqual(
      Graph.nodes(Graph.build(original, "x"))[0]?.keyMaterial
    )
  })

  it("keeps the implementation digest but changes key material when a built-in annotation is attached", () => {
    const original = Flow.make({
      name: "annotated-builtin",
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const declaration = Effects.make({
      reads: ["src"],
      writes: ["dist"],
      mode: "expected",
      onConflict: "serialize"
    })

    const placed = Flow.annotate(original, Annotations.Placement, Placement.remote())
    const effected = Flow.annotate(original, Annotations.Effects, declaration)

    const material = (flow: typeof original) => Graph.nodes(Graph.build(flow, "x"))[0]?.keyMaterial

    // Placement and Effects are read by Graph.build, so they are key material,
    // not advisory metadata. The implementation digest still comes across.
    expect(placed.implementation).toEqual(original.implementation)
    expect(effected.implementation).toEqual(original.implementation)
    expect(material(original)?.placement).toBeUndefined()
    expect(material(placed)?.placement).toEqual(Placement.remote())
    expect(material(placed)).not.toEqual(material(original))
    expect(material(effected)?.effects).toEqual(declaration)
    expect(material(effected)).not.toEqual(material(original))
  })

  it("merges annotation bags with supplied values winning without changing identity", () => {
    const Metadata = Context.Service<string>("test/Flow/MergedMetadata")
    const original = Flow.make({
      name: "merged",
      input: Schema.String,
      output: Schema.String,
      body: Node.succeed
    }).pipe(
      Flow.within(Placement.local()),
      Flow.annotate(Metadata, "original")
    )
    const bag = Context.make(Metadata, "supplied").pipe(Context.add(Annotations.Priority, 2))
    const direct = Flow.annotateMerge(original, bag)
    const piped = original.pipe(Flow.annotateMerge(bag))

    for (const merged of [direct, piped]) {
      expect(merged).not.toBe(original)
      expect(Option.getOrUndefined(Context.getOption(merged.annotations, Metadata))).toBe("supplied")
      expect(Option.getOrUndefined(Context.getOption(merged.annotations, Annotations.Priority))).toBe(2)
      expect(Option.getOrUndefined(Context.getOption(merged.annotations, Annotations.Placement))).toEqual(
        Placement.local()
      )
      expect(merged.body).toBe(original.body)
      expect(merged.implementation).toBe(original.implementation)
      expect(Graph.nodes(Graph.build(merged, "x")).map((node) => node.id)).toEqual(
        Graph.nodes(Graph.build(original, "x")).map((node) => node.id)
      )
    }
    expect(Option.getOrUndefined(Context.getOption(original.annotations, Metadata))).toBe("original")
    expect(Option.isNone(Context.getOption(original.annotations, Annotations.Priority))).toBe(true)
    expect(Flow.annotateMerge(original, Context.empty()).annotations).toEqual(original.annotations)
  })

  it("replaces a dynamic flow's collaborators and keeps everything else it carries", () => {
    const first = Flow.make({ name: "first", input: Schema.String, output: Schema.String, model: "smart" })
    const second = Flow.make({
      name: "second",
      input: Schema.String,
      output: Schema.String,
      capabilities: ["shell"],
      model: "smart"
    })
    const placement = Placement.local()
    const original = Flow.make({
      name: "parent",
      description: "declares collaborators",
      input: Schema.String,
      output: Schema.String,
      capabilities: ["net"],
      model: "smart",
      prompt: "delegate",
      flows: [first, "by-name"]
    }).pipe(
      Flow.within(placement),
      Flow.annotate(Annotations.Priority, 3)
    )

    const rebound = Flow.withFlows(original, [second, "by-name"])

    expect(rebound).not.toBe(original)
    expect(rebound.body).not.toBe(original.body)
    expect(rebound.model).toBe("smart")
    expect(rebound.flows).toEqual([second, "by-name"])
    expect(rebound.prompt).toBe("delegate")
    expect(rebound.implementation).toEqual({
      _tag: "Dynamic",
      model: "smart",
      flows: [second, "by-name"],
      prompt: "delegate"
    })
    // The original keeps the collaborators it declared.
    expect(original.implementation).toEqual({
      _tag: "Dynamic",
      model: "smart",
      flows: [first, "by-name"],
      prompt: "delegate"
    })
    // Every other field the flow carries survives the rebuild.
    expect(rebound.name).toBe("parent")
    expect(rebound.description).toBe("declares collaborators")
    expect(rebound.capabilities).toEqual(["net"])
    expect(Option.getOrUndefined(Annotations.getOption(rebound.annotations, Annotations.Placement))).toEqual(placement)
    expect(Option.getOrUndefined(Annotations.getOption(rebound.annotations, Annotations.Priority))).toBe(3)
    // The body the rebuild produces declares the new collaborators, not the old ones.
    const dynamicNode = Graph.nodes(Graph.build(rebound, "x")).find((node) => node.kind === "Dynamic")
    expect(JSON.stringify(dynamicNode?.keyMaterial)).toContain("shell")
  })

  it("keeps a body flow's digest while rebinding the collaborators it keys on", () => {
    const body = (input: string) => Node.succeed(input)
    const original = Flow.make({
      input: Schema.String,
      output: Schema.String,
      flows: ["first"],
      body
    })
    const originalDigest = original.implementation?._tag === "Body"
      ? original.implementation.digest
      : undefined

    const rebound = Flow.withFlows(original, ["second"])

    expect(rebound).not.toBe(original)
    expect(original.flows).toEqual(["first"])
    expect(rebound.flows).toEqual(["second"])
    expect(rebound.body).toBe(body)
    // The body still identifies the code that runs, so the digest is unchanged.
    expect(rebound.implementation?._tag === "Body" && rebound.implementation.digest).toBe(originalDigest)
    // The declaration is what changed, and it is part of the implementation, so
    // a reader of key material can see the rebind.
    expect(original.implementation).toEqual({
      _tag: "Body",
      algorithm: "sha256-source-ephemeral/v4",
      digest: originalDigest,
      declaration: { flows: ["first"] }
    })
    expect(rebound.implementation).toEqual({
      _tag: "Body",
      algorithm: "sha256-source-ephemeral/v4",
      digest: originalDigest,
      declaration: { flows: ["second"] }
    })
  })

  it("snapshots a body flow's replacement collaborator array", () => {
    const base = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: Node.succeed
    })
    const replacements: Array<Flow.Reference> = ["helper"]
    const rebound = Flow.withFlows(base, replacements)
    const before = Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(rebound("input")))))

    replacements.push("late")

    expect(rebound.flows).toEqual(["helper"])
    expect(rebound.implementation).toMatchObject({
      _tag: "Body",
      declaration: { flows: ["helper"] }
    })
    expect(Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(rebound("input")))))).toBe(before)
  })

  it("snapshots a dynamic flow's replacement collaborator array", () => {
    const base = Flow.make({
      input: Schema.String,
      output: Schema.String,
      model: "smart"
    })
    const replacements: Array<Flow.Reference> = ["helper"]
    const rebound = Flow.withFlows(base, replacements)
    const before = Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(rebound("input")))))

    replacements.push("late")

    expect(rebound.flows).toEqual(["helper"])
    expect(rebound.implementation).toEqual({
      _tag: "Dynamic",
      model: "smart",
      flows: ["helper"],
      prompt: undefined
    })
    expect(rebound.body?.("input").ast).toMatchObject({ _tag: "Dynamic", flows: ["helper"] })
    expect(Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(rebound("input")))))).toBe(before)
  })

  it("records collaborators on a declaration-only flow without inventing an implementation", () => {
    const declarationOnly = Flow.make({ name: "unimplemented", input: Schema.String })
    expect(declarationOnly.implementation).toBeUndefined()

    const rebound = Flow.withFlows(declarationOnly, ["helper"])

    expect(rebound.flows).toEqual(["helper"])
    expect(rebound.implementation).toBeUndefined()
    expect(() => rebound("x")).toThrow(Flow.FlowError)
  })

  it("records a body flow's declaration in key material and omits it when undeclared", () => {
    const body = (input: string) => Node.succeed(input)
    const declared = Flow.make({ input: Schema.String, model: "fast", prompt: "P", body })
    const plain = Flow.make({ input: Schema.String, body })

    expect(declared.implementation).toEqual({
      _tag: "Body",
      algorithm: "sha256-source-ephemeral/v4",
      digest: expect.any(String),
      declaration: { model: "fast", prompt: "P" }
    })
    expect(plain.implementation).toEqual({
      _tag: "Body",
      algorithm: "sha256-source-ephemeral/v4",
      digest: expect.any(String)
    })
    expect(plain.implementation).not.toHaveProperty("declaration")

    const material = (flow: Flow.Flow<typeof Schema.String, typeof Schema.Unknown, never>): unknown =>
      Graph.nodes(Graph.build(flow("x")))[0]?.keyMaterial.body

    expect(material(declared)).not.toEqual(material(plain))
    expect(JSON.stringify(material(declared))).toContain("\"model\":\"fast\"")
  })

  it("preserves declared model, collaborators, prompt, and name through every combinator", () => {
    const Metadata = Context.Service<{ readonly value: string }>("test/Flow/Metadata")
    const effects = Effects.make({
      reads: ["src/**"],
      writes: ["out/**"],
      mode: "expected",
      onConflict: "serialize"
    })
    const replacementEffects = Effects.make({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "fail"
    })
    const original = Flow.make({
      name: "metadata",
      input: Schema.String,
      output: Schema.String,
      model: "fast",
      flows: ["helper"],
      prompt: "P",
      effects,
      body: Node.succeed
    })
    const variants = [
      Flow.withCapabilities(original, ["read"]),
      Flow.within(original, Placement.remote()),
      Flow.annotate(original, Metadata, { value: "kept" }),
      Flow.withEffects(original, replacementEffects),
      Flow.sealed(original)
    ]

    for (const variant of variants) {
      expect(variant.name).toBe("metadata")
      expect(variant.model).toBe("fast")
      expect(variant.flows).toEqual(["helper"])
      expect(variant.prompt).toBe("P")
    }

    const rebound = Flow.withFlows(original, ["replacement"])
    expect(rebound.name).toBe("metadata")
    expect(rebound.model).toBe("fast")
    expect(rebound.flows).toEqual(["replacement"])
    expect(rebound.prompt).toBe("P")
  })

  it("seals an empty effect envelope when no declaration exists", () => {
    const sealed = Flow.make({ model: "smart" }).pipe(Flow.sealed())

    expect(sealed.effects).toEqual(Effects.make({
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    }))
  })

  it("throws a typed missing_body error when a declaration-only flow is called", () => {
    const flow = Flow.make({ name: "declared" })

    expect(flow.body).toBeUndefined()
    expect(() => flow(undefined)).toThrow(Flow.FlowError)
    try {
      flow(undefined)
    } catch (error) {
      expect(error).toBeInstanceOf(Flow.FlowError)
      expect((error as Flow.FlowError).code).toBe("missing_body")
    }
  })

  it("accretes, deduplicates, and sorts capabilities", () => {
    const original = Flow.make({
      capabilities: ["write", "read", "write"],
      model: "smart"
    })
    const updated = original.pipe(Flow.withCapabilities(["admin", "read"]))

    expect(original.capabilities).toEqual(["read", "write"])
    expect(updated.capabilities).toEqual(["admin", "read", "write"])
  })

  it("keeps function name semantics without leaking an enumerable name", () => {
    const unnamed = Flow.make({ output: Schema.String, body: () => Node.succeed("ok") })
    const named = Flow.make({ name: "named", output: Schema.String, body: () => Node.succeed("ok") })

    expect(unnamed.name).toBe("")
    expect(Object.keys({ ...unnamed })).not.toContain("name")
    expect(named.name).toBe("named")
    expect(Object.keys({ ...named })).not.toContain("name")
    expect(named.pipe(Flow.withCapabilities(["read"]), Flow.sealed()).name).toBe("named")
  })
})
