/**
 * The `jsx-single.migrated` fixture is the definition of a clean migration, so
 * what it holds is asserted against the packages themselves, not only read by
 * the deterministic checks.
 *
 * The module carries ONE declaration: the default export is the
 * `@smthrs/flow` flow, tag and `body` included. Discovery reads it without
 * evaluating the module and `Executable` hands that same value to the engine,
 * so the contract the control plane admits is the one that runs. Both halves
 * are pinned here against the real packages: the flow's own graph, and the
 * load through the registry with nothing registered to delegate to.
 *
 * @since 0.1.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import ts from "@typescript/typescript6"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Mapping from "../src/Mapping.ts"
import * as Transform from "../src/flow/Transform.ts"
import { fixture } from "./fixtures/helpers.ts"

const module = await import("./fixtures/jsx-single.migrated/flows/simple-workflow/flow.ts")

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/** The descriptor the registry derives from the fixture's `flows/` directory. */
const descriptor = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scan = yield* Discovery.make(fs, path).scan({
    source: "project",
    root: join(fixture("jsx-single.migrated"), "flows"),
    naming: "path"
  })
  expect(scan.warnings).toEqual([])
  const found = scan.entries.find((entry) => entry.name === "simple-workflow")
  expect(found).toBeDefined()
  return found!
})

describe("the migrated fixture's flow module", () => {
  it("default-exports the flow the registry reads", () => {
    expect(module.default._tag).toBe("simple-workflow")
    expect(module.default.description).toBe("Researches a topic and writes a short article about it.")
    expect(Object.keys(module.default.payloadSchema.fields)).toEqual(["topic"])
    expect(Object.keys(module.default.successSchema.fields)).toEqual(["article", "wordCount"])
  })

  it("runs the two agent steps in order, with the second waiting on the first", () => {
    const graph = Graph.build(module.default, { topic: "effect" })
    const nodes = Graph.nodes(graph)

    expect(Graph.diagnostics(graph)).toEqual([])
    // Two agent calls, the second waiting on the first, under one flow call.
    expect(nodes.map((node) => `${node.id}:${node.kind}`)).toEqual([
      "root.flow.andThen:ActionCall",
      "root.flow.then:ActionCall",
      "root.flow:AndThen",
      "root:FlowCall"
    ])
    expect(nodes[1]?.dependencies).toEqual(["root.flow.andThen"])
    expect(Graph.edges(graph).length).toBeGreaterThan(0)
  })

  it.effect("loads and plans through the registry with no delegate registered", () =>
    Effect.gen(function*() {
      // What a host does with a discovered flow. The module IS the flow, so
      // there is no delegate to name and no registration to miss, and the plan
      // a host reads is the body's own steps rather than one delegating node.
      const executable = yield* Executable.fromDescriptor(yield* descriptor, { delegates: [] })

      expect(executable.delegate).toBeUndefined()
      expect(executable.flow._tag).toBe("simple-workflow")

      const graph = Graph.build(executable.flow, { input: { topic: "effect" } })
      expect(Graph.diagnostics(graph)).toEqual([])
      expect(Graph.nodes(graph).map((node) => node.kind)).toContain("ActionCall")
      expect(Graph.drafts(graph).map((draft) => JSON.stringify(draft.material)).join("\n"))
        .toContain("simple-workflow/Research")
    }).pipe(Effect.provide(platform)))
})

/**
 * The golden is written by hand, because `jsx-single`'s `<Workflow>` declares
 * no payload schema: `Mapping.classify` calls it `guided` and
 * `Mapping.snippet` gives it no rewrite. A hand-written file can drift from
 * the emitter with nothing to catch it, so the SHAPE of its declaration is
 * asserted against what `Mapping.snippet` really emits for a `<Workflow>` the
 * emitter does accept.
 */
const goldenSource = readFileSync(
  join(fixture("jsx-single.migrated"), "flows", "simple-workflow", "flow.ts"),
  "utf8"
)

/** A `<Workflow>` the emitter accepts: a payload schema, two agent children. */
const emittedSource = Mapping.snippet({
  file: "flow.tsx",
  line: 1,
  column: 1,
  construct: "Workflow",
  props: ["name"],
  detail: {
    name: "simple-workflow",
    description: "Researches a topic and writes a short article about it.",
    payloadChain: "z.object({ topic: z.string() })",
    childConstructs: "Task:research,Task:write",
    childPayloads: "{\"research\":{\"topic\":\"ctx.input.topic\"},\"write\":{\"summary\":\"deps.research.summary\"}}",
    childOutputs:
      "{\"research\":\"z.object({ summary: z.string() })\",\"write\":\"z.object({ article: z.string() })\"}",
    childAgents: "research,write"
  }
})

interface DeclarationShape {
  /** The callee text, for example `Flow.make`. */
  readonly callee: string
  /** The syntax of the first argument, which must be the tag literal. */
  readonly tag: string
  /** The option keys, in source order. */
  readonly optionKeys: ReadonlyArray<string>
}

/** The shape of the one `export default <callee>(<tag>, { ... })` in a module. */
const defaultExportedDeclaration = (source: string): DeclarationShape => {
  const file = ts.createSourceFile("flow.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Array<DeclarationShape> = []
  const visit = (node: ts.Node): void => {
    if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isCallExpression(node.expression)) {
      const call = node.expression
      const tag = call.arguments[0]
      const options = call.arguments[1]
      found.push({
        callee: call.expression.getText(file),
        tag: tag === undefined ? "<absent>" : ts.SyntaxKind[tag.kind],
        optionKeys: options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.flatMap((property) =>
            property.name !== undefined && ts.isIdentifier(property.name) ? [property.name.text] : []
          )
          : []
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(found.length).toBe(1)
  return found[0]!
}

/** Every module specifier a module imports from. */
const importedModules = (source: string): ReadonlyArray<string> => {
  const file = ts.createSourceFile("flow.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return file.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : []
  )
}

describe("the golden's declaration has the shape the emitter emits", () => {
  it("emits a workflow declaration for a `<Workflow>` that declares a payload", () => {
    expect(emittedSource).toBeDefined()
    expect(emittedSource!).toContain("export default Flow.make(\"simple-workflow\", {")
  })

  it("declares the same call, the same tag form, and the same option keys as the emitter", () => {
    const emitted = defaultExportedDeclaration(emittedSource!)
    const golden = defaultExportedDeclaration(goldenSource)

    expect(golden.callee).toBe(emitted.callee)
    expect(golden.callee).toBe("Flow.make")
    expect(golden.tag).toBe(emitted.tag)
    expect(golden.tag).toBe(ts.SyntaxKind[ts.SyntaxKind.StringLiteral])
    expect(golden.optionKeys).toEqual(emitted.optionKeys)
    expect(golden.optionKeys).toEqual([
      "description",
      "capabilities",
      "effects",
      "payload",
      "success",
      "error",
      "body"
    ])
  })

  it("imports only packages the mapping table names as a target", () => {
    const smthrsImports = importedModules(goldenSource).filter((specifier) => specifier.startsWith("@smthrs/"))

    expect(smthrsImports).toEqual(["@smthrs/agent/AgentAction", "@smthrs/flow", "@smthrs/plan"])
    for (const specifier of smthrsImports) {
      const owner = specifier.split("/").slice(0, 2).join("/")
      expect(Transform.approvedPackages, specifier).toContain(owner)
    }
  })
})
