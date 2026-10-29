import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Placement from "@smthrs/plan/Placement"
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { type FlowEngine, Hosts } from "../src/index.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const Noop = Action.make("seam/noop", { payload: {}, success: Schema.Void })
const Local = Flow.make("seam/local", { payload: {}, body: () => Noop.call({}) })
const Remote = Flow.make("seam/remote", { payload: {}, body: () => Noop.call({}) }).annotate(
  Flow.Placement,
  Placement.remote({ target: "elsewhere" })
)

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const source = read("../src/FlowEngine/Encoded.ts")
const reference = read("../docs/reference/engine.md")

const interfaceStart = source.indexOf("export interface Encoded {")
const interfaceBody = source.slice(interfaceStart, source.indexOf("\n}\n", interfaceStart))
const members = new Map(
  [...interfaceBody.matchAll(/^ {2}readonly (\w+)(\??):/gm)].map(([, name, optional]) => [name!, optional === "?"])
)

const sectionStart = reference.indexOf("### `FlowEngine.Encoded`")
const section = reference.slice(sectionStart, reference.indexOf("\n### ", sectionStart + 1))
const rows = [...section.matchAll(/^\| `(\w+)` +\| (yes|no) +\| (.+?) +\|$/gm)].map(([, name, optional, value]) => ({
  name: name!,
  optional: optional === "yes",
  value: value!
}))

describe("FlowEngine.Encoded seam", () => {
  it("requires the trampoline round on every execute call", () => {
    // `makeUnsafe` always supplies one, and implementations index their
    // lineage bookkeeping by it. Never invoked.
    const missingRound = (encoded: FlowEngine.Encoded, flow: Flow.Any) =>
      // @ts-expect-error every execute call names its trampoline round
      encoded.execute(flow, { executionId: "run-1", payload: {}, discard: false })
    expect(missingRound).toBeTypeOf("function")
  })

  it("classifies every member, optional ones included, in the reference table", () => {
    expect(members.size).toBeGreaterThan(10)
    expect(new Map(rows.map((row) => [row.name, row.optional]))).toEqual(members)
  })

  it("names exactly the payload-carrying members in the module header", () => {
    // The header states the rule for the rest instead of listing them, so an
    // optional member added without a payload cannot leave it incomplete.
    const header = source.slice(0, source.indexOf("*/"))
    const named = [...members.keys()].filter((name) => header.includes(`\`${name}\``))
    const carrying = rows.filter((row) => row.value !== "None.").map((row) => row.name)
    expect(named.sort()).toEqual(carrying.sort())
  })

  it("forwards the journal byte measurement without inventing one for a silent store", () => {
    expect("nodeRecordBytes" in scriptedEngine({})).toBe(false)
    const measured = scriptedEngine({ nodeRecordBytes: () => Effect.succeed(4096) })
    expect(measured.nodeRecordBytes).toBeTypeOf("function")
    expect(Effect.runSync(measured.nodeRecordBytes!({
      _tag: "PlanRecorded",
      sourceId: "plan/0/0",
      flow: "test",
      generation: 0,
      page: 0,
      pages: 1,
      nodeCount: 0,
      nodes: [],
      edges: []
    }) as Effect.Effect<number>)).toBe(4096)
  })

  it.effect("forwards a store's retryFrom for a flow placed here, and leaves the port without one otherwise", () =>
    Effect.gen(function*() {
      // A store that keeps no history has nothing to replay: the port's
      // `retryFrom` is absent, and `Flow.retryFrom` refuses `unsupported`.
      expect("retryFrom" in scriptedEngine({})).toBe(false)
      const asked: Array<unknown> = []
      const engine = scriptedEngine({ retryFrom: (_flow, options) => Effect.sync(() => void asked.push(options)) })
      yield* engine.retryFrom!(Local, { source: "run-1", step: "root.flow", executionId: "retry-1" })
      expect(asked).toEqual([{ source: "run-1", step: "root.flow", executionId: "retry-1" }])
      // A flow bound to another engine is refused: no remote operation
      // carries a retry, and this store does not hold that run's history.
      const refused = yield* Effect.flip(
        engine.retryFrom!(Remote, { source: "run-1", step: "root.flow", executionId: "retry-2" }).pipe(
          Effect.provide(Hosts.layer({ elsewhere: { _tag: "Proxy", connect: () => Effect.die("unused") } }))
        )
      )
      expect(refused).toEqual(
        new FlowRuntime.RetryFromRefused({ code: "unsupported", executionId: "run-1", step: "root.flow" })
      )
      expect(asked).toHaveLength(1)
    }))

  it("forwards a store's node recorder, and leaves the port without one when the store has none", () => {
    // The typed port's `recordNode` is what the interpreter reads to decide
    // whether to build records at all, so a store that keeps no history must
    // leave the property ABSENT rather than present and inert.
    const silent = scriptedEngine({})
    expect("recordNode" in silent).toBe(false)
    const recorded: Array<{ readonly sourceId: string; readonly flush: boolean | undefined }> = []
    const recording = scriptedEngine({
      recordNode: (record, options) =>
        Effect.sync(() => recorded.push({ sourceId: record.sourceId, flush: options?.flush }))
    })
    Effect.runSync(
      recording.recordNode!({
        _tag: "NodeScheduled",
        sourceId: "node/read/1",
        nodeId: "read",
        kind: "ActionCall",
        attempt: 1
      }) as Effect.Effect<void>
    )
    Effect.runSync(
      recording.recordNode!({
        _tag: "NodeScheduled",
        sourceId: "node/progress/1",
        nodeId: "progress",
        kind: "ActionCall",
        attempt: 1
      }, { flush: true }) as Effect.Effect<void>
    )
    expect(recorded).toEqual([
      { sourceId: "node/read/1", flush: undefined },
      { sourceId: "node/progress/1", flush: true }
    ])
  })
})
