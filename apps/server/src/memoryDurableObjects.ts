import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { runDurable } from "./Boundary"
import { configLayer } from "./Config"
import type { ServerConfig, ServerEnvVars } from "./Config"
import { storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { GatewaySessionRegistry, gatewayResolutionsLayer, gatewaySessionRequest, makeGatewayResolutions } from "./gateway"
import type { GatewayRecord } from "./gateway"
import { TransportLive } from "./Http"
import type { Transport } from "./Http"
import { TurnCancelRegistry } from "./turns"
import { setupStorageMutexLayer } from "./repositorySetupStore"

/*
 * Test fixture: the Worker's two required Durable Object bindings driven
 * through the REAL request Effects over fresh in-memory storage, so tests
 * exercise the deployed code path — registry state, serialization, per-name
 * isolation, the in-progress join — instead of a test-only twin. Nothing in
 * the Worker imports this.
 *
 * The registry resolves (token door + provision) inside the object, so the
 * fixture takes the services it runs under: the deployment's config and
 * transport, either as an env bag (`TransportLive` + `configLayer`) or as an
 * injected Layer for a test that never patches the global fetch.
 */

export interface MemoryDurableObjectsOptions {
  /** The vars the registry resolves with; ignored when `services` is given. */
  readonly env?: ServerEnvVars
  /** The transport and config the registry runs under, for injected-layer tests. */
  readonly services?: Layer.Layer<Transport | ServerConfig>
  readonly nativeAlarms?: boolean
}

/** Every stub's `fetch` is the native Durable Object boundary: `runDurable` over the object's Effect. */
export const memoryDurableObjects = (options: MemoryDurableObjectsOptions = {}) => {
  const services = options.services ?? Layer.mergeAll(TransportLive, configLayer(options.env ?? {}))
  const gatewayData = new Map<string, Map<string, unknown>>()
  const gatewayObjects = new Map<string, Layer.Layer<any>>()
  const nativeGatewayObjects = new Map<string, GatewaySessionRegistry>()
  const gatewayAlarms = new Map<string, number>()
  const cancelData = new Map<string, Map<string, unknown>>()
  const cancelObjects = new Map<string, TurnCancelRegistry>()
  const retained = (maps: Map<string, Map<string, unknown>>, name: string): Map<string, unknown> => {
    let data = maps.get(name)
    if (data === undefined) {
      data = new Map()
      maps.set(name, data)
    }
    return data
  }
  // The fixture's map IS the object's storage: recreating the object (a
  // Worker restart) keeps the rows, like a Durable Object keeps its SQLite.
  const nativeStorageOver = (data: Map<string, unknown>): NativeStorage => ({
      get: <T>(key: string) => Promise.resolve(structuredClone(data.get(key)) as T | undefined),
      put: (key: string, value: unknown) => {
        data.set(key, structuredClone(value))
        return Promise.resolve()
      },
      delete: (key: string) => {
        data.delete(key)
        return Promise.resolve()
      }
    })
  const storageOver = (data: Map<string, unknown>) => storageLayer(nativeStorageOver(data))
  const GATEWAY_SESSIONS: NativeNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      if (options.nativeAlarms) {
        let object = nativeGatewayObjects.get(name)
        if (!object) {
          object = new GatewaySessionRegistry({ storage: { ...nativeStorageOver(retained(gatewayData, name)),
            setAlarm: time => { gatewayAlarms.set(name, time); return Promise.resolve() } } }, options.env)
          nativeGatewayObjects.set(name, object)
        }
        return object
      }
      let object = gatewayObjects.get(name)
      if (object === undefined) {
        // The join map is made once per object, exactly as the native class does.
        object = Layer.mergeAll(storageOver(retained(gatewayData, name)), services, gatewayResolutionsLayer(makeGatewayResolutions()), setupStorageMutexLayer())
        gatewayObjects.set(name, object)
      }
      const layers = object
      return { fetch: (request) => runDurable(gatewaySessionRequest(request).pipe(Effect.provide(layers))) }
    }
  }
  const TURN_CANCELS: NativeNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = String(id)
      let object = cancelObjects.get(name)
      if (object === undefined) {
        object = new TurnCancelRegistry({ storage: nativeStorageOver(retained(cancelData, name)) })
        cancelObjects.set(name, object)
      }
      const registry = object
      return { fetch: (request) => registry.fetch(request) }
    }
  }
  return {
    GATEWAY_SESSIONS,
    TURN_CANCELS,
    /** Deliver one platform alarm per pending object, without a browser request. */
    runGatewayAlarms: (): Promise<void> => runDurable(Effect.forEach([...gatewayAlarms.keys()], login => Effect.gen(function* () {
        gatewayAlarms.delete(login)
        yield* Effect.promise(() => (GATEWAY_SESSIONS.get(login) as GatewaySessionRegistry).alarm())
    }), { discard: true })),
    pendingGatewayAlarms: () => [...gatewayAlarms.keys()],
    /** The rows one login's registry holds, by storage key, for a test to inspect. */
    gatewayRows: (login: string): Map<string, unknown> => retained(gatewayData, login),
    /**
     * Writes an aged record through the registry's own PUT route — the state a
     * real deployment is in most of the time, which tests cannot wait out.
     */
    seedGatewayRecord: (login: string, repo: string, record: GatewayRecord): Promise<void> =>
      runDurable(
        Effect.gen(function* () {
          const stub = GATEWAY_SESSIONS.get(GATEWAY_SESSIONS.idFromName(login))
          const response = yield* Effect.promise(() =>
            stub.fetch(
              new Request("https://gateway-sessions.internal/record", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ repo, workspaceId: record.workspaceId, record })
              })
            )
          )
          if (!response.ok) return yield* Effect.die(new Error(`Seeding a gateway record failed: HTTP ${response.status}`))
        })
      ),
    /** Forgets every object AND its rows: the next test starts cold. */
    reset: (): void => {
      gatewayData.clear()
      gatewayObjects.clear()
      nativeGatewayObjects.clear()
      gatewayAlarms.clear()
      cancelData.clear()
      cancelObjects.clear()
    },
    /** Forgets the objects but keeps their rows: a Worker restart. */
    restart: (): void => {
      gatewayObjects.clear()
      nativeGatewayObjects.clear()
      cancelObjects.clear()
    }
  }
}

export type MemoryDurableObjects = ReturnType<typeof memoryDurableObjects>
