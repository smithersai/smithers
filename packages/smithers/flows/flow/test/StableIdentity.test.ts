import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const stable = { callbackIdentity: "stable" } as const
const version = { implementationVersion: "stable-tests/v1" }
const callbackDiagnostics = (node: Node.Any | Flow.Any) => Graph.build(node, {}, stable).diagnostics

describe("stable callback admission", () => {
  it("names all unstable callback sites and keeps the graph inspectable but not compilable", () => {
    const flow = Flow.make("stable/refuse", {
      payload: {},
      success: Schema.String,
      body: () =>
        Node.succeed(1).pipe(
          Node.map((value) => value + 1),
          Node.bindPlanned(() =>
            Node.branch(Node.succeed(1), {
              if: (value) => value > 0,
              then: () => Node.succeed("positive"),
              else: () => Node.succeed("negative")
            })
          )
        )
    })
    const graph = Graph.build(flow, {}, stable)
    expect(graph.nodes).toHaveLength(8)
    expect(graph.diagnostics.map(({ code, node, path }) => ({ code, node, path }))).toEqual([
      { code: "unstable_callback", node: "root.flow", path: ["continuation"] },
      { code: "unstable_callback", node: "root.flow.andThen", path: ["mapper"] },
      { code: "unstable_callback", node: "root.flow.then", path: ["predicate"] },
      { code: "unstable_callback", node: "root", path: ["body"] }
    ])
    expect(() => Graph.drafts(graph)).toThrow(/Node.capture with every semantic capture/)
    expect(Graph.build(flow, {}).diagnostics).toEqual([])
    expect(Graph.build(flow, {}, { callbackIdentity: "process-local" }).diagnostics).toEqual([])
  })

  it("checks child and handoff body identities even when their graph is left as a leaf", () => {
    const child = Flow.make("stable/child", { payload: {}, success: Schema.Number, body: () => Node.succeed(1) })
    for (const node of [child.child({}), child.to({})]) {
      expect(callbackDiagnostics(node)).toMatchObject([
        { code: "unstable_callback", node: "root", path: ["body"] }
      ])
    }
    const captured = Flow.make("stable/captured-child", {
      payload: {},
      success: Schema.Number,
      body: Node.capture(version, () => Node.succeed(1))
    })
    expect(callbackDiagnostics(captured.child({}))).toEqual([])
    expect(callbackDiagnostics(captured.to({}))).toEqual([])
    for (const node of [captured.child({}), captured.to({})]) {
      const detached = { ...node, ast: JSON.parse(JSON.stringify(node.ast)) as Node.Ast }
      expect(callbackDiagnostics(detached)).toMatchObject([
        { code: "unstable_callback", path: ["body"], message: expect.stringContaining("unavailable identity") }
      ])
    }
  })

  it("accepts complete captures and function-free sequencing without allocating ephemeral identity", () => {
    const configuration = { increment: 2, implementationVersion: "stable-tests/v1" }
    const flow = Flow.make("stable/accept", {
      payload: { seed: Schema.Number },
      success: Schema.String,
      body: Node.capture(configuration, ({ seed }) =>
        Node.succeed(seed).pipe(
          Node.map(Node.capture(configuration, (value: number) => value + configuration.increment)),
          Node.bindPlanned(Node.capture(version, () =>
            Node.branch(Node.succeed(1), {
              if: Node.capture(version, (value: number) => value > 0),
              then: () => Node.succeed("positive"),
              else: () => Node.succeed("negative")
            }))),
          Node.andThen(Node.succeed("done"))
        ))
    })
    const graph = Graph.build(flow, { seed: 1 }, stable)
    expect(graph.diagnostics).toEqual([])
    expect(Graph.drafts(graph)).toHaveLength(graph.nodes.length)
    expect(Graph.drafts(graph)).toEqual(Graph.drafts(Graph.build(flow, { seed: 1 })))
  })

  it.effect("the canonical interpreter admits a captured poll and runs its first attempt", () =>
    withCrypto(Effect.gen(function*() {
      const attempts: Array<number> = []
      const check = Action.make("stable/poll-check", {
        payload: { attempt: Schema.Number },
        success: Poll.CheckResult(Schema.String)
      })
      const poll = Poll.make("stable/poll", {
        input: {},
        result: Schema.String,
        intervalMs: 10,
        maxAttempts: 3,
        check: Node.capture({ action: check.name, ...version }, ({ attempt }) => check.call({ attempt }))
      })
      const graph = Graph.build(poll, {}, stable)
      expect(graph.diagnostics).toEqual([])
      expect(Graph.drafts(graph)).toHaveLength(graph.nodes.length)
      const implementations = Layer.mergeAll(
        check.toLayer(({ attempt }) =>
          Effect.sync(() => {
            attempts.push(attempt)
            return { satisfied: true, output: "ready" }
          })
        ),
        Poll.layer,
        Sleep.layer
      )
      const result = yield* poll.execute({}).pipe(Effect.provide(
        Interpreter.layerWithImplementations(poll, implementations).pipe(Layer.provideMerge(layerMemory))
      ))
      expect(result).toBe("ready")
      expect(attempts).toEqual([1])
    })))

  it.effect("the canonical interpreter refuses unstable callbacks before the first action", () =>
    withCrypto(Effect.gen(function*() {
      let runs = 0
      const step = Action.make("stable/action", { payload: {}, success: Schema.Number })
      const flow = Flow.make("stable/dispatch", { payload: {}, success: Schema.Number, body: () => step.call({}) })
      const implementations = step.toLayer(() => Effect.sync(() => ++runs))
      const exit = yield* Effect.exit(
        flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(flow, implementations).pipe(Layer.provideMerge(layerMemory))
        ))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "incomplete_graph",
          node: "root",
          message: expect.stringContaining("process-local identity")
        })
      }
      expect(runs).toBe(0)
      expect(
        yield* flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(flow, implementations, { callbackIdentity: "process-local" }).pipe(
            Layer.provideMerge(layerMemory)
          )
        ))
      ).toBe(1)
    })))
})

describe("independent process identity", () => {
  it("rebuilds equal plans across fresh processes and re-keys each semantic change", () => {
    const fixture = fileURLToPath(new URL("./fixtures/stableIdentity.ts", import.meta.url))
    const base = { offset: 2, implementationVersion: "counter/v1", changedSource: false, unrelated: 0, stable: true }
    const compile = (changes: Partial<typeof base> = {}) =>
      JSON.parse(execFileSync(process.execPath, [
        fixture,
        JSON.stringify({ ...base, ...changes })
      ], { encoding: "utf8", timeout: 30_000 })) as { digest: string; keys: Array<[string, string]> }
    const first = compile()
    expect(compile()).toEqual(first)
    expect(compile({ unrelated: 19 })).toEqual(first)
    for (const changes of [{ offset: 3 }, { implementationVersion: "counter/v2" }, { changedSource: true }]) {
      const changed = compile(changes)
      expect(changed.digest).not.toBe(first.digest)
      expect(changed.keys[0]).toEqual(first.keys[0])
      expect(changed.keys.slice(1)).not.toEqual(first.keys.slice(1))
    }
    expect(compile({ stable: false }).digest).not.toBe(compile({ stable: false }).digest)
  }, 120_000)
})

// Compile the declarations readers copy, so their cross-process key claim is
// checked against the actual examples rather than a second handwritten flow.
describe("tutorial callback identity", () => {
  for (
    const [page, flow, payload] of [
      ["quickstart.md", "Greeting", { name: "Ada" }],
      ["README.md", "Digest", { url: "https://example.com/post" }]
    ] as const
  ) {
    it(`${page} admits its example under stable policy and reproduces its plan`, () => {
      const markdown = readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8")
      const example = markdown.match(/```ts\n([\s\S]*?)\n```/)![1]!
        .split("/** The code arrives separately")[0]!
        .replace(/^import .*$/gm, "")
      const script = `
        import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
        import { Action, Flow, Graph } from "@smthrs/flow"
        import { Node, Plan } from "@smthrs/plan"
        import { Effect, Schema } from "effect"
        ${example}
        const graph = Graph.build(${flow}, ${JSON.stringify(payload)}, { callbackIdentity: "stable" })
        const plan = await Effect.runPromise(Plan.compile({
          planId: "tutorial", flow: ${flow}._tag, nodes: Graph.drafts(graph)
        }).pipe(Effect.provide(NodeCrypto.layer)))
        console.log(JSON.stringify({ digest: plan.digest, keys: plan.nodes.map(node => node.key) }))
      `
      const compile = () =>
        execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          encoding: "utf8",
          timeout: 30_000
        })
      expect(compile()).toBe(compile())
      expect(markdown).toContain("Interpreter.layerWithImplementations(")
      expect(markdown).toContain("process-local")
    }, 120_000)
  }
})
