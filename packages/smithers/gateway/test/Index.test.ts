import { describe, expect, it } from "vitest"
import * as Gateway from "../src/index.ts"

describe("/gateway", () => {
  it("exports its canonical schemas and sync package", () => {
    expect(Gateway.GatewaySchema.ProjectionSnapshot).toBeDefined()
    expect(Gateway.Sync.SyncClient.SyncClient).toBeDefined()
    expect("SuperviseRuntime" in Gateway).toBe(false)
  })
})
