import { describe, expect, test } from "bun:test"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

const idleAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

describe("the wire tap", () => {
  test("records method, path, status, and duration for every controller fetch", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, idleAgent, {
      fetchImpl: async () => new Response("{}", { status: 500 })
    })
    await controller.refreshBalance()
    const entries = JSON.parse(controller.debugNet().value) as ReadonlyArray<{
      readonly method: string
      readonly url: string
      readonly status: number | "error"
      readonly ms: number
    }>
    expect(entries.length).toBeGreaterThan(0)
    const balance = entries.find((entry) => entry.url.includes("/api/billing/balance"))
    expect(balance?.method).toBe("GET")
    expect(balance?.status).toBe(500)
    expect(typeof balance?.ms).toBe("number")
  })

  test("records a thrown fetch as an error entry and rethrows to the caller's handling", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, idleAgent, {
      fetchImpl: async () => {
        throw new Error("network down")
      }
    })
    await controller.refreshBalance()
    const entries = JSON.parse(controller.debugNet().value) as ReadonlyArray<{
      readonly status: number | "error"
    }>
    expect(entries.some((entry) => entry.status === "error")).toBe(true)
  })
})
