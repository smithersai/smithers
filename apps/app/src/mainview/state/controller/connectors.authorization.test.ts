import { expect, test } from "bun:test"
import { createAppStore, verboseTrace } from "../AppStore"
import type { ControllerContext } from "./context"
import { createConnectorController } from "./connectors"

const repository = { authorizationId: "synthetic-capability", root: "/tmp/repo", name: "repo", head: null, branch: "main", remoteUrl: null }
const repo = { id: "host-repo", path: repository.root, name: "repo", git: { branch: "main", remote: null }, warnings: [], smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "none", workspaces: [] } }
const setup = async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  } })
  return { store, data }
}

test("connector picker consumes the capability before publishing inspection metadata", async () => {
  const { store, data } = await setup()
  let finish!: (value: string | undefined) => void
  const opening = new Promise<string | undefined>((resolve) => { finish = resolve })
  const adopted: unknown[] = []
  const ctx = { store, repositories: { pickLocalRepository: async () => ({ status: "connected", repository }) },
    openRepo: async (request: unknown) => { adopted.push(request); return opening }
  } as unknown as ControllerContext
  const running = createConnectorController(ctx).connectLocalRepository("read-write")
  await Promise.resolve()
  expect(adopted).toEqual([{ authorizationId: repository.authorizationId, displayName: "repo" }])
  expect(store.collections.connectors.size).toBe(0)
  finish(undefined)
  await running
  expect(store.collections.connectors.size).toBe(1)
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain(repository.authorizationId)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(JSON.stringify([...data.values()])).not.toContain(repository.authorizationId)
})

test("journal and verbose output strip an accidentally supplied capability", async () => {
  const { store, data } = await setup()
  const transition = { type: "connector.local.connected", actor: "system", access: "read-write", repository } as const
  store.dispatch({ type: "verbose.toggled", actor: "user", on: true })
  await store.dispatch(transition).isPersisted.promise
  expect(verboseTrace(transition)).not.toContain("authorizationId")
  expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain(repository.authorizationId)
  expect(JSON.stringify([...data.values()])).not.toContain(repository.authorizationId)
})

for (const action of ["read-only", "disconnect"] as const) {
  for (const ok of [true, false]) {
    test(`${action} waits for host revocation and retains the connector on failure (${ok})`, async () => {
      const { store } = await setup()
      const { authorizationId: _, ...inspection } = repository
      store.dispatch({ type: "connector.local.connected", actor: "system", access: "read-write", repository: inspection })
      const connector = [...store.collections.connectors.values()][0]!
      let finish!: (response: Response) => void
      const revoking = new Promise<Response>((resolve) => { finish = resolve })
      const calls: Array<{ url: string; body?: unknown }> = []
      let closed = false
      const ctx = { store, baseUrl: "", errorMessageOf: async () => "Host refused",
        boundedFetch: async (url: string, init?: RequestInit) => {
          calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
          if (url === "/api/repos") return Response.json({ repos: closed ? [] : [repo] })
          const response = await revoking
          closed = ok && action === "disconnect"
          return response
        }
      } as unknown as ControllerContext
      const controller = createConnectorController(ctx)
      controller.askConnectorRemoval(connector.id)
      const running = action === "read-only" ? controller.makeConnectorReadOnly(connector.id) : controller.removeConnector(connector.id)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(calls).toContainEqual({ url: action === "read-only" ? "/api/repo/access" : "/api/repo/close",
        body: action === "read-only" ? { repoId: repo.id, access: "read" } : { repoId: repo.id } })
      expect(store.collections.connectors.get(connector.id)?.access).toBe("read-write")
      finish(Response.json(ok ? { ok: true } : {}, { status: ok ? 200 : 500 }))
      const result = await running
      if (!ok) {
        expect(result).toBe("Host refused")
        expect(store.collections.connectors.get(connector.id)?.access).toBe("read-write")
      } else if (action === "read-only") expect(store.collections.connectors.get(connector.id)?.access).toBe("read")
      else {
        expect(store.collections.connectors.has(connector.id)).toBe(false)
        expect(store.collections.repos.size).toBe(0)
      }
    })
  }
}
