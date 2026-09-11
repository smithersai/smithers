import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestDatabase, type TestDatabase } from "./d1.ts"

const readTokenHash = createHash("sha256").update("entry-point-read-token", "utf8").digest("hex")
const writeTokenHash = createHash("sha256").update("entry-point-write-token", "utf8").digest("hex")

const bucket = (): R2Bucket =>
  ({
    head: async () => null,
    get: async () => null,
    put: async () => null
  }) as unknown as R2Bucket

/** A Rate Limiting binding that records the keys it was asked to count. */
const budget = (success = true) => {
  const keys: Array<string> = []
  const binding = {
    limit: async ({ key }: { readonly key: string }) => {
      keys.push(key)
      return { success }
    }
  } as unknown as RateLimit
  return { binding, keys }
}

describe("worker entry point", () => {
  let d1: TestDatabase
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    d1 = await makeTestDatabase()
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.resetModules()
  })

  afterEach(() => {
    d1.close()
    errors.mockRestore()
  })

  const env = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      CACHE_DATABASE: d1.database,
      CACHE_BUCKET: bucket(),
      CACHE_READ_TOKEN: readTokenHash,
      CACHE_WRITE_TOKEN: writeTokenHash,
      CACHE_REQUEST_BUDGET: budget().binding,
      CACHE_FIND_MISSING_BUDGET: budget().binding,
      ...overrides
    }) as never

  const load = async () => (await import("../CacheWorker.ts")).default

  it("answers 503 rather than starting on an environment it cannot verify", async () => {
    const worker = await load()

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_READ_TOKEN: "not-a-digest" })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("smithers-cache-contract")).toBe("result-only-v1")
    await expect(response.json()).resolves.toEqual({ error: "the cache tier failed to initialize" })
    expect(String(errors.mock.calls[0]?.[0])).toContain("name=TypeError")
  })

  it("probes D1 and R2 on a readiness check", async () => {
    const worker = await load()
    let heads = 0
    const probe = { ...bucket(), head: async () => (heads += 1, null) } as unknown as R2Bucket

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_BUCKET: probe })
    )

    expect(response.status).toBe(200)
    expect(heads).toBe(1)
  })

  it("refuses readiness when D1 does not return its sentinel", async () => {
    const worker = await load()
    const wrongSentinel = {
      prepare: () => ({ bind: () => ({ first: async () => null }), first: async () => ({ ok: 0 }) })
    } as unknown as D1Database

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_DATABASE: wrongSentinel })
    )

    expect(response.status).toBe(503)
    expect(String(errors.mock.calls[0]?.[0])).toContain("cause1.code=D1_READINESS_INVALID")
    expect(String(errors.mock.calls[0]?.[0])).toContain("operation=health")
  })

  it("identifies corrupt D1 discriminators in request logs", async () => {
    const worker = await load()
    const corrupt = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () => sql.startsWith("INSERT") ? null : { result_json: '{ "ok": true }' } })
      })
    } as unknown as D1Database
    const response = await worker.fetch(new Request("https://cache.test/ac/key", {
      method: "PUT",
      headers: { authorization: "Bearer entry-point-write-token", "content-type": "application/json" },
      body: '{"ok":true}'
    }), env({ CACHE_DATABASE: corrupt }))
    expect(response.status).toBe(503)
    expect(String(errors.mock.calls[0]?.[0])).toContain("cause1.code=D1_RESULT_NON_CANONICAL")
    expect(String(errors.mock.calls[0]?.[0])).toContain("operation=actionCache.put")
  })

  it("identifies repeated R2 publication loss in request logs", async () => {
    const worker = await load()
    const digest = createHash("sha256").update("artifact").digest("hex")
    const response = await worker.fetch(new Request(`https://cache.test/cas/${digest}`, {
      method: "PUT",
      headers: { authorization: "Bearer entry-point-write-token", "content-type": "application/octet-stream" },
      body: "artifact"
    }), env())
    expect(response.status).toBe(503)
    expect(String(errors.mock.calls[0]?.[0])).toContain("cause1.code=R2_PUBLICATION_LOST")
    expect(String(errors.mock.calls[0]?.[0])).toContain("operation=contentStore.put")
  })

  it("counts every request under the presented credential's digest and refuses a spent budget", async () => {
    const worker = await load()
    const requests = budget()
    const probes = budget(false)
    const authorized = (path: string, init: RequestInit = {}) =>
      new Request(`https://cache.test${path}`, {
        ...init,
        headers: { authorization: "Bearer entry-point-read-token", ...(init.headers as Record<string, string>) }
      })
    const environment = env({ CACHE_REQUEST_BUDGET: requests.binding, CACHE_FIND_MISSING_BUDGET: probes.binding })

    const read = await worker.fetch(authorized(`/ac/${"a".repeat(64)}`), environment)
    const probe = await worker.fetch(
      authorized("/cas/findMissing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digests: ["b".repeat(64)] })
      }),
      environment
    )

    expect(read.status).toBe(404)
    expect(probe.status).toBe(429)
    // The key is the digest the Worker already computes to classify the
    // credential, never the bearer value itself.
    expect(requests.keys).toEqual([readTokenHash, readTokenHash])
    expect(probes.keys).toEqual([readTokenHash])
  })

  it("keeps one handler per isolate so admission counters and the health cache mean something", async () => {
    const worker = await load()
    let firstHeads = 0
    let secondHeads = 0
    const first = { ...bucket(), head: async () => (firstHeads += 1, null) } as unknown as R2Bucket
    const second = { ...bucket(), head: async () => (secondHeads += 1, null) } as unknown as R2Bucket

    await worker.fetch(new Request("https://cache.test/healthz"), env({ CACHE_BUCKET: first }))
    // A second environment must not build a second handler: the readiness
    // cache and every admission counter live on the first one.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await worker.fetch(new Request("https://cache.test/healthz"), env({ CACHE_BUCKET: second }))

    expect(firstHeads).toBe(2)
    expect(secondHeads).toBe(0)
  })
})
