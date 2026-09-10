/*
 * Test fixture: the Worker's two Durable Object bindings driven through the
 * REAL classes over fresh in-memory storage, so tests exercise the deployed
 * code path — registry state, serialization, per-name isolation, in-progress
 * join — instead of a test-only twin. Nothing in the Worker imports this.
 */
import { GatewaySessionRegistry } from "./gateway"
import type { GatewayRecord, GatewayRegistryEnv, GatewaySessionNamespace } from "./gateway"
import { TurnCancelRegistry } from "./index"
import type { TurnCancelNamespace } from "./index"

/**
 * One binding pair per call: per-name storage is retained for the life of the
 * fixture (recreating the Worker keeps the records, like a DO keeps its
 * SQLite), and `reset` wipes both namespaces between tests. `seedGatewayRecord`
 * writes an aged record through the registry's own PUT route — the state a
 * real deployment is in most of the time, which tests cannot wait out.
 */
export const memoryDurableObjects = (env: GatewayRegistryEnv = {}) => {
  const gatewayData = new Map<string, Map<string, unknown>>()
  const gatewayRegistries = new Map<string, GatewaySessionRegistry>()
  const cancelData = new Map<string, Map<string, unknown>>()
  const cancelRegistries = new Map<string, TurnCancelRegistry>()
  const retained = (maps: Map<string, Map<string, unknown>>, name: string): Map<string, unknown> => {
    let data = maps.get(name)
    if (data === undefined) {
      data = new Map()
      maps.set(name, data)
    }
    return data
  }
  const GATEWAY_SESSIONS: GatewaySessionNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = gatewayRegistries.get(name)
      if (registry === undefined) {
        const data = retained(gatewayData, name)
        registry = new GatewaySessionRegistry({
          storage: {
            get: async <T>(key: string) => data.get(key) as T | undefined,
            put: async (key, value) => void data.set(key, value)
          }
        }, env)
        gatewayRegistries.set(name, registry)
      }
      return registry
    }
  }
  const TURN_CANCELS: TurnCancelNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let registry = cancelRegistries.get(name)
      if (registry === undefined) {
        const data = retained(cancelData, name)
        registry = new TurnCancelRegistry({
          storage: {
            get: async <T>(key: string) => data.get(key) as T | undefined,
            put: async (key, value) => void data.set(key, value)
          }
        })
        cancelRegistries.set(name, registry)
      }
      return registry
    }
  }
  return {
    GATEWAY_SESSIONS,
    TURN_CANCELS,
    seedGatewayRecord: async (login: string, repo: string, record: GatewayRecord): Promise<void> => {
      const stub = GATEWAY_SESSIONS.get(GATEWAY_SESSIONS.idFromName(login))
      const response = await stub.fetch(
        new Request("https://gateway-sessions.internal/record", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, workspaceId: record.workspaceId, record })
        })
      )
      if (!response.ok) throw new Error(`Seeding a gateway record failed: HTTP ${response.status}`)
    },
    reset: (): void => {
      gatewayData.clear()
      gatewayRegistries.clear()
      cancelData.clear()
      cancelRegistries.clear()
    }
  }
}
