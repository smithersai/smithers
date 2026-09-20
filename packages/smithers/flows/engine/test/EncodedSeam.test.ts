import { describe, expect, it } from "@effect/vitest"
import type { Flow } from "@smthrs/flow"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import type { FlowEngine } from "../src/index.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

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

  it("forwards a store's node recorder, and leaves the port without one when the store has none", () => {
    // The typed port's `recordNode` is what the interpreter reads to decide
    // whether to build records at all, so a store that keeps no history must
    // leave the property ABSENT rather than present and inert.
    const silent = scriptedEngine({})
    expect("recordNode" in silent).toBe(false)
    const recorded: Array<string> = []
    const recording = scriptedEngine({
      recordNode: (record) => Effect.sync(() => recorded.push(record.sourceId))
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
    expect(recorded).toEqual(["node/read/1"])
  })
})
