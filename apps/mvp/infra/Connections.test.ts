import { describe, expect, it } from "vitest"
import {
  ALERT_PERCENT,
  COMPUTE_MAX_CU,
  COMPUTE_MIN_CU,
  CONNECTION_BUDGET,
  ELECTRIC_POOL_SIZE,
  maxConnections,
} from "./Connections.ts"

// On 2026-10-22 a fixed 0.25 CU compute (112 connections) held 91 under load and stopped accepting logins.
describe("the production database's connection budget", () => {
  it("matches Neon's connection limits at the range's ends", () => {
    expect([maxConnections(0.25), maxConnections(1), maxConnections(10)]).toEqual([112, 450, 4000])
    expect(COMPUTE_MIN_CU).toBeLessThan(COMPUTE_MAX_CU)
  })

  it("stays under the alert share of the smallest compute's connections with every client at its cap", () => {
    const sum = Object.values(CONNECTION_BUDGET).reduce((total, share) => total + share, 0)
    expect(sum * 100).toBeLessThanOrEqual(ALERT_PERCENT * maxConnections(COMPUTE_MIN_CU))
  })

  it("gives Electric's query pool its share less the replication connection", () => {
    expect(ELECTRIC_POOL_SIZE).toBe(CONNECTION_BUDGET.electric - 1)
  })
})
