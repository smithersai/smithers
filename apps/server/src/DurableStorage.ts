import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { StorageFailure } from "./Failures"
import type { BodyNotJson, BodyUnreadable } from "./Failures"
import { readJson, readRefusalDetail } from "./Http"

/*
 * Durable Object state as this Worker's Effects see it.
 *
 * Inside a Durable Object the class body is an Effect over `DurableStorage`;
 * the native class (`fetch(request)`) provides it from the platform's
 * `ctx.storage`. From the Worker side, a
 * Durable Object is reached through its namespace binding, one internal
 * `fetch` per call; `namespaceCall` is that one boundary. The keys written
 * through here ("state", "reports", "recommendations", "gateway:*", the
 * per-bucket counters) are persisted identities and never change.
 */

export interface DurableStorageShape {
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageFailure>
  readonly put: (key: string, value: unknown) => Effect.Effect<void, StorageFailure>
  /** One native transaction, including all keys or none. */
  readonly putMany: (entries: Record<string, unknown>) => Effect.Effect<void, StorageFailure>
  readonly list: <T>(options: StorageListOptions) => Effect.Effect<Map<string, T>, StorageFailure>
  /** Optional host capability; callers requiring erasure fail closed when absent. */
  readonly delete?: (key: string) => Effect.Effect<void, StorageFailure>
  readonly setAlarm?: (time: number) => Effect.Effect<void, StorageFailure>
}

export class DurableStorage extends Context.Service<DurableStorage, DurableStorageShape>()("smithers-server/DurableStorage") {}

/** The platform storage surface the classes need (a subset of `DurableObjectStorage`). */
export interface NativeStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string | Record<string, unknown>, value?: unknown) => Promise<void>
  readonly list?: <T>(options: StorageListOptions) => Promise<Map<string, T>>
  readonly delete?: (key: string) => Promise<boolean | void>
  readonly setAlarm?: (time: number) => Promise<void>
}

export interface StorageListOptions { readonly prefix: string; readonly limit: number; readonly startAfter?: string }

export const storageFrom = (storage: NativeStorage): DurableStorageShape => ({
  get: <T>(key: string) =>
    Effect.tryPromise({ try: () => storage.get<T>(key), catch: (cause) => new StorageFailure({ operation: `storage.get ${key}`, cause }) }),
  put: (key, value) =>
    Effect.tryPromise({ try: () => storage.put(key, value), catch: (cause) => new StorageFailure({ operation: `storage.put ${key}`, cause }) }),
  putMany: entries => Effect.tryPromise({ try: () => storage.put(entries), catch: cause => new StorageFailure({ operation: "storage.put entries", cause }) }),
  list: <T>(options: StorageListOptions) => Effect.tryPromise({
    try: () => storage.list ? storage.list<T>(options) : Promise.reject(new Error("Storage listing is unavailable")),
    catch: cause => new StorageFailure({ operation: "storage.list", cause })
  }),
  ...(storage.setAlarm === undefined ? {} : { setAlarm: (time: number) => Effect.tryPromise({
    try: () => storage.setAlarm!(time), catch: (cause) => new StorageFailure({ operation: "storage.setAlarm", cause })
  }) }),
  ...(storage.delete === undefined ? {} : { delete: (key: string) => Effect.tryPromise({
    try: async () => { await storage.delete!(key) },
    catch: (cause) => new StorageFailure({ operation: `storage.delete ${key}`, cause })
  }) })
})

export const storageLayer = (storage: NativeStorage): Layer.Layer<DurableStorage> => Layer.succeed(DurableStorage, storageFrom(storage))

/** An in-memory storage for tests. */
export const memoryStorage = (initial?: Record<string, unknown>, retained?: Map<string, unknown>): NativeStorage & { readonly data: Map<string, unknown> } => {
  const data = retained ?? new Map<string, unknown>(Object.entries(structuredClone(initial ?? {})))
  return {
    data,
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => {
      const entries = structuredClone(typeof key === "string" ? [[key, value]] : Object.entries(key)) as Array<[string, unknown]>
      for (const [name, item] of entries) data.set(name, item)
    },
    list: async <T>({ prefix, limit, startAfter }: StorageListOptions) => new Map([...data.entries()]
      .filter(([name]) => name.startsWith(prefix) && (startAfter === undefined || name > startAfter))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([name, item]) => [name, structuredClone(item) as T])),
    delete: async (key: string) => { data.delete(key) }
  }
}

/** The namespace surface the Worker needs (a subset of `DurableObjectNamespace`). */
export interface NativeNamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => { readonly fetch: (request: Request) => Promise<Response> }
}

/**
 * A Durable Object's JSON answer, or the failure it stated. An object answers
 * its own storage failures as a 500 with the cause in the body; parsing that
 * as JSON would report a SyntaxError and hide the cause, so a non-2xx answer
 * is a `StorageFailure` naming the status and the body, and only a 2xx is
 * read as JSON.
 */
export const answeredJson = (operation: string, seam: string, response: Response): Effect.Effect<unknown, StorageFailure | BodyUnreadable | BodyNotJson> =>
  response.ok
    ? readJson(response)
    : Effect.flatMap(readRefusalDetail(response), (body) =>
      Effect.fail(new StorageFailure({
        operation,
        cause: new Error(`${seam} answered HTTP ${response.status}${body === "" ? "." : `: ${body}`}`)
      })))

/** One internal request to the named object: the Worker → Durable Object boundary. */
export const namespaceCall = (
  operation: string,
  namespace: NativeNamespace,
  name: string,
  request: Request
): Effect.Effect<Response, StorageFailure> =>
  Effect.tryPromise({
    try: () => namespace.get(namespace.idFromName(name)).fetch(request),
    catch: (cause) => new StorageFailure({ operation, cause })
  })
