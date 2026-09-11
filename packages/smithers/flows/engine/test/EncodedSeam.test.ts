import { describe, expect, it } from "@effect/vitest"
import type { Flow } from "@smthrs/flow"
import { readFileSync } from "node:fs"
import type { FlowEngine } from "../src/index.ts"

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
})
