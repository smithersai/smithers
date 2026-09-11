import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createHistorySeam } from "./HistorySeam"
import type { SeamContext } from "./SeamContext"

test("bootstrap delegates directly to the durable host, without pretending a history read generated it", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  const ctx: SeamContext = { store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1,
    baseUrl: "", http: async () => { throw new Error("Bootstrap must not read history to claim generation") } }
  const calls: string[] = []
  const seam = createHistorySeam(ctx, async repo => { calls.push(repo) })
  expect(await seam.retellHistory("bootstrap", "will/demo")).toBeUndefined()
  expect(calls).toEqual(["will/demo"])
  expect(await createHistorySeam(ctx).retellHistory("bootstrap", "will/demo")).toBe("Create Mythical history is unavailable on this host.")
})
