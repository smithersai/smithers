import { describe, expect, it } from "vitest"
import config from "../vitest.config.ts"

describe("build coverage gate", () => {
  it("requires every coverage metric to be complete on every test run", () => {
    expect(config.test?.coverage).toMatchObject({
      enabled: true,
      include: ["src/**"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    })
  })
})
