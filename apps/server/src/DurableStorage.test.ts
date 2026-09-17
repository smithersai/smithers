import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { DurableStorage, memoryStorage, namespaceCall, storageLayer } from "./DurableStorage"
import { StorageFailure } from "./Failures"

describe("DurableStorage over the platform storage", () => {
  test("reads back what it wrote", async () => {
    const storage = memoryStorage()
    const program = Effect.gen(function* () {
      const store = yield* DurableStorage
      yield* store.put("state", { state: "active", at: 1 })
      return yield* store.get<{ state: string; at: number }>("state")
    })
    expect(await Effect.runPromise(program.pipe(Effect.provide(storageLayer(storage))))).toEqual({ state: "active", at: 1 })
    expect(storage.data.get("state")).toEqual({ state: "active", at: 1 })
  })

  test("a throwing platform call is a StorageFailure naming the operation", async () => {
    const broken = {
      get: async () => {
        throw new Error("storage unavailable")
      },
      put: async () => {
        throw new Error("storage unavailable")
      }
    }
    const result = await Effect.runPromise(
      DurableStorage.use((store) => store.put("reports", [])).pipe(Effect.result, Effect.provide(storageLayer(broken)))
    )
    expect(Result.isFailure(result)).toBe(true)
    const failure = Result.isFailure(result) ? result.failure : undefined
    expect(failure).toBeInstanceOf(StorageFailure)
    expect(failure?.operation).toBe("storage.put reports")
  })

  test("batch admission is one platform write and failed serialization commits no keys", async () => {
    const storage = memoryStorage({ retained: 1 }), calls: unknown[] = []
    const layer = storageLayer({ ...storage, put: async (key, value) => { calls.push(key); await storage.put(key, value) } })
    await Effect.runPromise(DurableStorage.use(store => store.putMany({ request: { id: 1 }, pointer: 1, queue: [1] })).pipe(Effect.provide(layer)))
    expect(calls).toEqual([{ request: { id: 1 }, pointer: 1, queue: [1] }])
    const before = [...storage.data]
    const failed = await Effect.runPromise(DurableStorage.use(store => store.putMany({ request: { id: 2 }, pointer: 2, queue: () => {} })).pipe(Effect.result, Effect.provide(layer)))
    expect(Result.isFailure(failed)).toBe(true)
    expect([...storage.data]).toEqual(before)
    const row = await storage.get<{ id: number }>("request"); row!.id = 99
    expect(await storage.get<{ id: number }>("request")).toEqual({ id: 1 })
  })

  test("prefix pagination reads cloned rows and proves the final partial page", async () => {
    const storage = memoryStorage({ "r:b": { value: 2 }, "r:a": { value: 1 }, "other:a": 3 })
    const rows = await Effect.runPromise(DurableStorage.use(store => store.list<{ value: number }>({ prefix: "r:", limit: 1 })).pipe(Effect.provide(storageLayer(storage))))
    expect([...rows.keys()]).toEqual(["r:a"])
    rows.get("r:a")!.value = 9
    const rest = await storage.list!({ prefix: "r:", limit: 50, startAfter: "r:a" })
    expect([...rest]).toEqual([["r:b", { value: 2 }]])
    expect(await storage.get<{ value: number }>("r:a")).toEqual({ value: 1 })
  })

  test("namespaceCall addresses the object by name and returns its answer", async () => {
    const seen: Array<string> = []
    const namespace = {
      idFromName: (name: string) => `id:${name}`,
      get: (id: unknown) => ({
        fetch: async (request: Request) => {
          seen.push(`${String(id)} ${new URL(request.url).pathname}`)
          return Response.json({ ok: true })
        }
      })
    }
    const response = await Effect.runPromise(namespaceCall("turnCancels.state", namespace, "run-1", new Request("https://internal/state")))
    expect(await response.json()).toEqual({ ok: true })
    expect(seen).toEqual(["id:run-1 /state"])
  })
})
