import * as Effects from "@smthrs/plan/Effects"
import { describe, expect, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Diagnostic from "../src/internal/diagnostic.ts"
import * as Reflection from "../src/internal/reflection.ts"
import * as Node from "../src/Node.ts"

describe("Graph module boundary", () => {
  it("delegates the diagnostic and every limit it no longer declares itself", () => {
    expect(Graph.GraphBuildError).toBe(Diagnostic.GraphBuildError)
    expect(Graph.GraphBuildErrorCode).toBe(Diagnostic.GraphBuildErrorCode)
    expect(Graph.isFatalDiagnostic).toBe(Diagnostic.isFatalDiagnostic)
    expect(Graph.maximumPayloadDepth).toBe(Reflection.maximumDepth)
    expect(Graph.maximumPayloadMembers).toBe(Reflection.maximumMembers)
    expect(Graph.maximumEffectPathLength).toBe(Effects.maximumPathLength)
    expect(Graph.maximumEffectGlobs).toBe(Effects.maximumGlobs)
  })

  it("refuses an over-deep plan value through the extracted reflection", () => {
    let deep: unknown = "leaf"
    for (let level = 0; level <= Graph.maximumPayloadDepth; level++) deep = { deep }

    expect(() => Graph.build(Flow.make({ body: () => Node.succeed(deep) })))
      .toThrow(expect.objectContaining({ _tag: "flows/core/GraphBuildError", code: "payload_too_deep" }))
  })
})
