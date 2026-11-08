import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { afterAll, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bundle, Compile, compileSource, main, releaseRunId } from "../../examples/20-child-flows.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("scopes tool executions to the call identity and target and reuses them on replay", () => {
  const executions: Array<{ target: string; executionId: string }> = []
  const layer = Layer.mergeAll(
    Bundle.toLayer(({ target }) =>
      Effect.gen(function*() {
        const { executionId } = yield* FlowRuntime.FlowInstance
        executions.push({ target, executionId })
        return `dist/${target}.js`
      })
    ),
    Interpreter.layer(Compile)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

  return Effect.gen(function*() {
    const services = yield* Effect.context<Layer.Success<typeof layer>>()
    const [binding] = yield* compileSource(services).bindings()
    const call = (target: string, identity: Partial<Cell.CallIdentity> = {}) =>
      new Cell.Call({
        flowName: "compile",
        input: { target },
        capabilities: [],
        effects: binding!.descriptor.effects,
        placement: Option.none(),
        identity: new Cell.CallIdentity({
          session: "build-1",
          frame: 0,
          cell: "cell-digest",
          ordinal: 0,
          declaration: Cell.declarationDigest(binding!.descriptor),
          layers: [],
          ...identity
        })
      })

    const calls = [
      call("server"),
      call("web"),
      call("server", { session: "build-2" }),
      call("server", { frame: 1 }),
      call("server", { cell: "other-cell" }),
      call("server", { ordinal: 1 }),
      call("server", { declaration: "other-declaration" }),
      call("server", { layers: ["other-layer"] })
    ]
    for (const request of calls) {
      expect(yield* binding!.run(request)).toEqual({
        outcome: "success",
        value: { bundle: `dist/${(request.input as { target: string }).target}.js` }
      })
    }
    expect(executions).toHaveLength(calls.length)
    expect(new Set(executions.map(({ executionId }) => executionId)).size).toBe(calls.length)

    const recorded = [...executions]
    for (const request of calls) {
      // Reconstruct the call as a replay would, without relying on object identity.
      const replay = new Cell.Call({ ...request, identity: new Cell.CallIdentity({ ...request.identity }) })
      expect(yield* binding!.run(replay)).toEqual({
        outcome: "success",
        value: { bundle: `dist/${(request.input as { target: string }).target}.js` }
      })
    }
    expect(executions).toEqual(recorded)
  }).pipe(Effect.provide(layer))
})

it.live("joins two child runs and replays them on a re-driven parent", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "release.sqlite"))

    expect(summary.report).toBe("dist/server.js + server.sig")
    expect(summary.replayed).toBe(summary.report)

    // Each child is a run of its own, linked to the parent in durable state.
    expect(summary.children).toHaveLength(2)
    for (const child of summary.children) {
      expect(child.parentId).toBe(releaseRunId)
      expect(child.parentExecutionId).toBe(releaseRunId)
      expect(child.status).toBe("completed")
      expect(child.runId).not.toBe(releaseRunId)
    }
    // Two children means two distinct execution ids, not one shared id.
    expect(new Set(summary.children.map((child) => child.runId)).size).toBe(2)

    // The second execution re-read every recorded result, so nothing ran twice.
    // The tool call below compiles a second time, under its own run.
    expect(summary.dispatches).toEqual({ bundle: 2, sign: 1, report: 1 })

    // A model reached the same flow as a tool and got the flow's real answer.
    expect(summary.built).toBe("dist/server.js")

    // The tool call opened a durable run of its own, which completed.
    expect(summary.toolRunStatus).toBe("completed")
    expect(summary.toolRunId).toMatch(/^compile-by-tool\/[a-f0-9]{64}$/)
    expect(summary.children.map((child) => child.runId)).not.toContain(summary.toolRunId)

    // And it is a real child of the run the step was executing in: the engine
    // takes the edge from the execution the handler ran inside, so a flow
    // reached as a tool is linked without the handler saying so.
    expect(summary.toolRunParents).toEqual([summary.builderRunId])
  }), { timeout: 60_000 })
