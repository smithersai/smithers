import { describe, expect, it } from "vitest"
import type { Config } from "../src/index.ts"
import { estimate, eta, remaining, samples, schedule } from "../src/index.ts"

const config: Config = { required: [1, 2, 3], maxAttempts: 1, maxBatch: 1, maxRuns: 1, window: 5, defaultDuration: 60 }

const history = [
  { check: 1, duration: 30 },
  { check: 2, duration: 200 },
  { check: 1, duration: 10 },
  { check: 2, duration: 100 },
  { check: 1, duration: 20 }
]

describe("estimate", () => {
  it("is the median of a check's samples", () => {
    expect(samples(history, 1)).toEqual([30, 10, 20])
    expect(estimate(config, history, 1)).toBe(20)
  })

  it("takes the upper of two middle samples", () => {
    expect(estimate(config, history, 2)).toBe(200)
  })

  it("is the configured default for a check never seen", () => {
    expect(estimate(config, history, 3)).toBe(60)
  })
})

describe("schedule", () => {
  it("orders the required checks slowest first and drops none", () => {
    expect(schedule(config, history)).toEqual([2, 3, 1])
  })

  it("keeps the configured order among equal estimates", () => {
    expect(schedule(config, [])).toEqual([1, 2, 3])
  })
})

describe("remaining and eta", () => {
  it("lists the checks without a result, in schedule order", () => {
    expect(remaining(config, history, [{ check: 2, verdict: "pass" }])).toEqual([3, 1])
  })

  it("predicts the slowest remaining check, and 0 for a complete run", () => {
    expect(eta(config, history, [])).toBe(200)
    expect(eta(config, history, [{ check: 2, verdict: "pass" }])).toBe(60)
    expect(eta(config, history, [1, 2, 3].map((check) => ({ check, verdict: "pass" as const })))).toBe(0)
  })
})
