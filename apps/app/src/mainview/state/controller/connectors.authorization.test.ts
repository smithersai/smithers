import { expect, test } from "bun:test"
import { createAppStore, verboseTrace } from "../AppStore"
import type { ControllerContext } from "./context"
import { createConnectorController } from "./connectors"

const repository = { authorizationId: "synthetic-capability", root: "/tmp/repo", name: "repo", head: null, branch: "main", remoteUrl: null }
const setup = async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  } })
  return { store, data }
}

test("journal and verbose output strip an accidentally supplied capability", async () => {
  const { store, data } = await setup()
  const transition = { type: "connector.local.connected", actor: "system", access: "read-write", repository } as const
  store.dispatch({ type: "verbose.toggled", actor: "user", on: true })
  await store.dispatch(transition).isPersisted.promise
  expect(verboseTrace(transition)).not.toContain("authorizationId")
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain(repository.authorizationId)
  expect(JSON.stringify([...data.values()])).not.toContain(repository.authorizationId)
})

/*
 * No host opens a repository on this machine any more
 * (docs/LOCAL-BACKEND-RETIREMENT.md): `/api/repos`, `/api/repo/access` and
 * `/api/repo/close` are gone, so narrowing or forgetting a connector is a
 * store act alone and reaches the network for nothing.
 */
for (const action of ["read-only", "disconnect"] as const) {
  test(`${action} is a store act and calls no host route`, async () => {
    const { store } = await setup()
    const { authorizationId: _, ...inspection } = repository
    store.dispatch({ type: "connector.local.connected", actor: "system", access: "read-write", repository: inspection })
    const connector = [...store.collections.connectors.values()][0]!
    const calls: Array<string> = []
    const ctx = { store, baseUrl: "", errorMessageOf: async () => "Host refused",
      boundedFetch: async (url: string) => {
        calls.push(url)
        return Response.json({})
      }
    } as unknown as ControllerContext
    const controller = createConnectorController(ctx)
    controller.askConnectorRemoval(connector.id)
    const result = action === "read-only" ? controller.makeConnectorReadOnly(connector.id) : controller.removeConnector(connector.id)
    expect(result).toBeUndefined()
    expect(calls).toEqual([])
    if (action === "read-only") expect(store.collections.connectors.get(connector.id)?.access).toBe("read")
    else expect(store.collections.connectors.has(connector.id)).toBe(false)
  })
}

test("a connector nobody asked to remove is refused, and an unknown id is named", async () => {
  const { store } = await setup()
  const { authorizationId: _, ...inspection } = repository
  store.dispatch({ type: "connector.local.connected", actor: "system", access: "read-write", repository: inspection })
  const connector = [...store.collections.connectors.values()][0]!
  const controller = createConnectorController({ store } as unknown as ControllerContext)
  expect(controller.removeConnector(connector.id)).toBe("Ask before disconnecting this repository.")
  expect(controller.makeConnectorReadOnly("nope")).toBe("There is no connector with id nope.")
})
