import { Result, Schema } from "effect"
import { createHash } from "node:crypto"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const serialized = Effects.make({
  reads: ["src/**"],
  writes: ["out/a"],
  mode: "hermetic",
  onConflict: "serialize"
})
const laned = Effects.make({ reads: [], writes: ["out/a"], mode: "hermetic", onConflict: "lane" })

// One value per branch of the reflection walk that key material depends on, so
// a byte the extraction moved between modules shows up as a changed digest.
const payload = {
  text: "one",
  count: 2,
  big: 10n,
  when: new Date(1_700_000_000_000),
  pattern: /ab+c/gi,
  set: new Set([1, 2]),
  map: new Map([["k", "v"]]),
  bytes: new Uint8Array([1, 2, 3]),
  url: new URL("https://smithers.sh/docs"),
  error: new Error("boom"),
  nested: { list: [1, undefined, 3] }
}

const schemaFlow = Flow.make({
  input: Schema.Struct({ prompt: Schema.String }),
  output: Schema.Struct({ answer: Schema.String }),
  effects: serialized,
  body: (input) =>
    Node.andThen(
      Node.withEffects(Node.dynamic({ prompt: input.prompt }), serialized),
      Node.capture({ tag: "payload" }, () => Node.succeed(payload as never))
    )
})

const laneFlow = Flow.make({
  effects: laned,
  body: () =>
    Node.all({
      left: Node.withEffects(Node.dynamic({ prompt: "left" }), laned),
      right: Node.withEffects(Node.dynamic({ prompt: "right" }), laned)
    })
})

const plainFlow = Flow.within(Flow.make({ body: () => Node.succeed(payload) }), Placement.local())

const material = (flow: Flow.Any, input?: unknown): unknown => {
  const entries = Graph.keyMaterial(Graph.build(flow, input))
  return Result.isSuccess(entries) ? entries.success : { failure: entries.failure.code }
}
import { describe, expect, it } from "vitest"

describe("Graph key material", () => {
  it("derives key material byte-identical to the pre-extraction module", () => {
    const projection = JSON.stringify(
      {
        schemaFlow: material(schemaFlow, { prompt: "hello" }),
        laneFlow: material(laneFlow),
        plainFlow: material(plainFlow)
      },
      (_key, value) => (typeof value === "bigint" ? `${value}n` : value)
    )

    // Recorded from origin/main before Graph.ts was split; regenerate only
    // when a change is meant to move key material.
    expect(createHash("sha256").update(projection).digest("hex"))
      .toBe("cc97468186e50f2e3dfe80e19fdefd6d5dc7ca1149f942417785bc5ad0b2a634")
  })
})
