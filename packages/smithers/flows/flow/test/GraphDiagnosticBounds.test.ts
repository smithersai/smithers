import { expect, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"

it("does not traverse object values beyond the placement diagnostic member limit", () => {
  let omittedReads = 0
  const placement: Record<string, unknown> = {}
  for (let index = 0; index < 32; index++) placement[`a${String(index).padStart(2, "0")}`] = 1
  placement["z"] = new Proxy({}, {
    getPrototypeOf() {
      omittedReads++
      throw new Error("a value outside the diagnostic budget was inspected")
    }
  })
  const child = Flow.make("GraphDiagnosticBounds/child", {
    payload: {},
    body: () => Node.succeed(undefined)
  }).annotate(Flow.Placement, placement)
  const parent = Flow.make("GraphDiagnosticBounds/parent", {
    payload: {},
    body: () => child.call({})
  }).annotate(Flow.Placement, "different" as unknown as Flow.PlacementDirective)

  expect(() => Graph.build(parent, {})).toThrowError(expect.objectContaining({
    code: "placement_requires_boundary",
    message: expect.stringContaining("<more>")
  }))
  expect(omittedReads).toBe(0)
})
