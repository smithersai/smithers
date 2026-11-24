import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type * as JsonSchema from "../src/JsonSchema.ts"
import * as Load from "../src/Load.ts"
import { host, minimal } from "./support/hostFacts.ts"

const variant = (kind: string, field: string): JsonSchema.Resolved => ({
  type: "object",
  properties: { kind: { const: kind }, [field]: { type: "string" } },
  required: ["kind"],
  additionalProperties: false
})

const facts: Load.FlowFacts = {
  capabilities: [],
  minimum: "anyone",
  personOnly: false,
  system: false,
  payload: { oneOf: [variant("a", "left"), variant("b", "right")] }
}

const refusals = async (args: Record<string, unknown>) =>
  (await Effect.runPromise(Load.load(host({ catalog: new Map([["notes/add", facts]]) }), [{
    tier: "built-in",
    manifest: minimal("notes", {
      uses: ["notes/add"],
      contributes: {
        views: [{
          id: "notes/list",
          title: "Notes",
          scope: "app",
          path: "notes",
          sizes: ["full"],
          minimum: "anyone",
          render: { kind: "blocks", blocks: [] },
          events: [{ name: "add", flow: "notes/add", args }]
        }]
      }
    })
  }]))).refused.map((refusal) => [refusal.reason, refusal.path])

describe("event args against a payload discriminated on a property", () => {
  it("loads a literal that any declaring member admits", async () => {
    expect(await refusals({ kind: "a" })).toEqual([])
    expect(await refusals({ kind: "b", right: "x" })).toEqual([])
  })

  it("refuses a literal that no declaring member admits", async () => {
    expect(await refusals({ kind: "c" })).toEqual([["invalid", "contributes.views[0].events[0].args.kind"]])
    expect(await refusals({ kind: "b", right: 1 })).toEqual([["invalid", "contributes.views[0].events[0].args.right"]])
    expect(await refusals({ kind: "b", other: "x" })).toEqual([[
      "invalid",
      "contributes.views[0].events[0].args.other"
    ]])
  })
})
