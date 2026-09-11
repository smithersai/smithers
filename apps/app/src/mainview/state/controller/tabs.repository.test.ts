import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { createTabsController } from "./tabs"

for (const refusal of [undefined, "The repository authorization expired."]) {
  test(`native picking reports connected only after host adoption (${refusal === undefined ? "success" : "failure"})`, async () => {
    const data = new Map<string, string>()
    const store = await createAppStore({ kind: "localStorage", storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key)
    } })
    let finish!: (value: string | undefined) => void
    const opening = new Promise<string | undefined>((resolve) => { finish = resolve })
    let adopting = false
    const ctx = {
      store, services: {}, commandActor: "user",
      repositories: {
        available: true,
        pickLocalRepository: async () => ({ status: "connected", repository: {
          authorizationId: "one-use", root: "/tmp/repository", name: "org/repository",
          head: "head", branch: "main", remoteUrl: "https://github.com/org/repository.git"
        } })
      },
      openRepo: async () => { adopting = true; return opening }
    } as unknown as ControllerContext
    const running = createTabsController(ctx).openLocalRepo()
    await Promise.resolve()
    expect(adopting).toBe(true)
    expect([...store.collections.connectors.values()]).toHaveLength(0)
    finish(refusal)
    expect(await running).toBe(refusal)
    const connected = [...store.collections.connectors.values()]
    if (refusal === undefined) expect(connected[0]).toMatchObject({ status: "connected", root: "/tmp/repository" })
    else {
      expect(connected).toHaveLength(0)
      expect(store.collections.connectorOperations.get("connector-operation")).toMatchObject({ error: refusal })
    }
  })
}
