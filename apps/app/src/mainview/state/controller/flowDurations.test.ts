/*
 * Reading a flow's measured history: what lands, and what stays silent.
 *
 * Every refusal this projection can answer with is the same refusal to a
 * reader — no rows — because the numbers are an enhancement nobody asked for.
 * A toast about them would be an error message about a prediction.
 */
import { describe, expect, test } from "bun:test"
import type { FlowDurationRow, GatewayResult } from "./gateway"
import { createAppStore, type AppStore } from "../AppStore"
import { flowDurationRowId } from "../AppState"
import { memoryStorage } from "../TestFixtures"
import { createFlowDurationsReader } from "./flowDurations"
import type { ControllerContext } from "./context"

const row = (actionTag: string, p50Ms: number): FlowDurationRow =>
  ({ flowId: "review", actionTag, samples: 4, p50Ms, p90Ms: p50Ms * 2 })

const scope = async (
  answer: (repo: string, flowId: string) => Promise<GatewayResult<ReadonlyArray<FlowDurationRow>>>,
  flowBuilder = true
) => {
  const store: AppStore = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const asked: Array<string> = []
  const read = createFlowDurationsReader({
    store,
    disposed: false,
    services: { features: { flowBuilder } },
    gateway: {
      flowDurations: (repo: string, flowId: string) => {
        asked.push(`${repo} ${flowId}`)
        return answer(repo, flowId)
      }
    }
  } as unknown as ControllerContext)
  return { store, asked, read }
}

const rowsOf = (store: AppStore, flowId: string): ReadonlyArray<string> =>
  [...store.collections.flowDurations.values()].filter((held) => held.flowId === flowId).map((held) => held.actionTag).sort()

describe("reading a flow's measured durations", () => {
  test("the rows the gateway served reach the collection, keyed by tag", async () => {
    const { store, asked, read } = await scope(async () => ({ status: "ok", value: [row("acme/Build", 1_000)] }))
    await read("o/r", "review", { workspaceId: "ws-1" })
    expect(asked).toEqual(["o/r review"])
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build"))?.p50Ms).toBe(1_000)
  })

  test("a box that refuses the selector leaves no rows, and says nothing", async () => {
    const { store, read } = await scope(async () => ({ status: "error", message: "Unknown selector" }))
    await read("o/r", "review")
    expect([...store.collections.flowDurations.values()]).toEqual([])
    expect([...store.collections.toasts.values()]).toEqual([])
  })

  test("an answer overtaken by a later read of the same flow is dropped", async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let first = true
    const { store, read } = await scope(async () => {
      if (!first) return { status: "ok", value: [row("acme/Fresh", 2_000)] }
      first = false
      await held
      return { status: "ok", value: [row("acme/Stale", 1_000)] }
    })
    const slow = read("o/r", "review")
    await read("o/r", "review")
    release!()
    await slow
    expect(rowsOf(store, "review")).toEqual(["acme/Fresh"])
  })

  test("two flows read at once keep their own rows", async () => {
    const { store, read } = await scope(async (_repo, flowId) => ({
      status: "ok",
      value: [{ ...row(`acme/${flowId}`, 1_000), flowId }]
    }))
    await Promise.all([read("o/r", "review"), read("o/r", "ship")])
    expect(rowsOf(store, "review")).toEqual(["acme/review"])
    expect(rowsOf(store, "ship")).toEqual(["acme/ship"])
  })

  test("with the flow builder off the projection is never asked for", async () => {
    const { asked, read, store } = await scope(async () => ({ status: "ok", value: [row("acme/Build", 1_000)] }), false)
    await read("o/r", "review")
    expect(asked).toEqual([])
    expect([...store.collections.flowDurations.values()]).toEqual([])
  })
})
