/*
 * The measured-durations collection: one row per action tag the gateway
 * measured, keyed by repository, workspace, flow and tag, and never persisted.
 *
 * A prediction is only as honest as the read behind it, so a re-read of one
 * flow replaces that flow's rows and leaves every other flow's alone.
 */
import { describe, expect, test } from "bun:test"
import { flowDurationRowId } from "./AppState"
import { createAppStore, type AppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

const boot = (): Promise<AppStore> => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const row = (actionTag: string, p50Ms: number, samples = 4) => ({ actionTag, samples, p50Ms, p90Ms: p50Ms * 2 })

const loaded = async (store: AppStore, repo: string, flowId: string, rows: ReadonlyArray<ReturnType<typeof row>>): Promise<void> => {
  await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo, flowId, rows }).isPersisted.promise
}

describe("flow durations", () => {
  test("one row per tag, keyed by repository, flow and tag", async () => {
    const store = await boot()
    await loaded(store, "o/r", "review", [row("acme/Build", 1_000), row("acme/Test", 2_000)])
    expect([...store.collections.flowDurations.keys()].sort()).toEqual([
      flowDurationRowId("o/r", "review", "acme/Build"),
      flowDurationRowId("o/r", "review", "acme/Test")
    ])
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build"))?.p50Ms).toBe(1_000)
  })

  test("a re-read moves the tags it still measures and drops the ones it does not", async () => {
    const store = await boot()
    await loaded(store, "o/r", "review", [row("acme/Build", 1_000), row("acme/Retired", 500)])
    await loaded(store, "o/r", "review", [row("acme/Build", 1_400, 9)])
    const build = store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build"))
    expect(build?.p50Ms).toBe(1_400)
    expect(build?.samples).toBe(9)
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Retired"))).toBeUndefined()
  })

  test("reading one flow leaves another flow's history alone", async () => {
    const store = await boot()
    await loaded(store, "o/r", "review", [row("acme/Build", 1_000)])
    await loaded(store, "o/r", "ship", [row("acme/Deploy", 8_000)])
    await loaded(store, "o/r", "review", [])
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build"))).toBeUndefined()
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "ship", "acme/Deploy"))?.p50Ms).toBe(8_000)
  })

  test("the same flow on two repositories keeps two histories", async () => {
    const store = await boot()
    await loaded(store, "o/r", "review", [row("acme/Build", 1_000)])
    await loaded(store, "o/other", "review", [row("acme/Build", 5_000)])
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build"))?.p50Ms).toBe(1_000)
    expect(store.collections.flowDurations.get(flowDurationRowId("o/other", "review", "acme/Build"))?.p50Ms).toBe(5_000)
  })
})

test("refreshing one workspace retains another workspace and the default gateway", async () => {
  const store = await boot()
  for (const [workspaceId, p50Ms] of [[undefined, 1000], ["ws-1", 2000], ["ws-2", 3000]] as const) {
    await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo: "o/r", flowId: "review", workspaceId,
      rows: [row("acme/Build", p50Ms), row("acme/Retired", p50Ms)] }).isPersisted.promise
  }
  await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo: "o/r", flowId: "review", workspaceId: "ws-1", rows: [row("acme/Build", 4000)] }).isPersisted.promise
  expect([...store.collections.flowDurations.values()]).toHaveLength(5)
  for (const [workspaceId, expected] of [[undefined, 1000], ["ws-1", 4000], ["ws-2", 3000]] as const) {
    expect(store.collections.flowDurations.get(flowDurationRowId("o/r", "review", "acme/Build", workspaceId))?.p50Ms).toBe(expected)
  }
  await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo: "o/r", flowId: "review", workspaceId: "ws-2", rows: [] }).isPersisted.promise
  expect([...store.collections.flowDurations.values()]).toHaveLength(3)
})

test("workspace measurements remain session-only after reload", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo: "o/r", flowId: "review", workspaceId: "ws-1", rows: [row("acme/Build", 4000)] }).isPersisted.promise
  await store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect([...reloaded.collections.flowDurations.values()]).toHaveLength(0)
  await reloaded.dispose?.()
})
