import { describe, expect, test } from "vitest"
import { FLOW_AUTHORING_ENTRY, FLOW_AUTHORING_PACK, FLOW_AUTHORING_STAGES } from "../src/FlowAuthoring.ts"

describe("flow authoring pack (unit)", () => {
  test("names the public entry and keeps the six stages in pipeline order", () => {
    expect(FLOW_AUTHORING_ENTRY).toBe("create-flow")
    expect(FLOW_AUTHORING_STAGES).toEqual([
      "create-flow/clarify",
      "create-flow/provision",
      "create-flow/design",
      "create-flow/scaffold",
      "create-flow/fix",
      "create-flow/document"
    ])
    expect(FLOW_AUTHORING_PACK).toEqual([
      "create-flow",
      "create-flow/clarify",
      "create-flow/provision",
      "create-flow/design",
      "create-flow/scaffold",
      "create-flow/fix",
      "create-flow/document"
    ])
  })
})
