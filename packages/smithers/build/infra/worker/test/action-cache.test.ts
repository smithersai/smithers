import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type * as CacheStore from "../../../../flows/step-cache/src/CacheStore.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeActionCache, readTouchDays } from "../D1ActionCache.ts"
import { pruneStaleEntries, retentionDays } from "../RetentionSweep.ts"
import { type ActionCache, type ActionCachePublication, type ContentStore, createHandler } from "../protocol.ts"
import { makeTestDatabase, type TestDatabase } from "./d1.ts"

const publication = (
  overrides: Partial<ActionCachePublication> = {}
): ActionCachePublication => ({
  body: "{\"result\":{\"exitOk\":true}}",
  resultJson: "{\"exitOk\":true}",
  createdAtMs: 0,
  recordedRunId: "run-1",
  recordedEventSeq: 7,
  ...overrides
})

interface StoredRow {
  readonly access_count: number
  readonly last_accessed_at: string
  readonly result_json: string
  readonly entry_json: string
  readonly created_at_ms: number | null
  readonly recorded_run_id: string | null
  readonly recorded_event_seq: number | null
}

interface ParkedQuery {
  readonly query: string
  readonly release: () => void
}

/**
 * Parks the statements a test names so two publications meet at a chosen
 * point. A held statement binds its values, waits, and then reads whatever
 * the database holds when it is released, which is the interleaving the
 * sequential API cannot express.
 */
const makeQueryGate = (): {
  readonly beforeQuery: (query: string) => Promise<void> | void
  readonly hold: (needle: string) => void
  readonly waitFor: (needle: string) => Promise<ParkedQuery>
  readonly ran: ReadonlyArray<string>
} => {
  const held: Array<string> = []
  const parked: Array<ParkedQuery> = []
  const ran: Array<string> = []
  let arrived: (() => void) | undefined
  return {
    ran,
    beforeQuery: (query) => {
      ran.push(query)
      if (!held.some((needle) => query.includes(needle))) return
      return new Promise<void>((resolve) => {
        parked.push({ query, release: resolve })
        arrived?.()
      })
    },
    hold: (needle) => {
      held.push(needle)
    },
    waitFor: async (needle) => {
      // A statement that never arrives is a test that no longer schedules what
      // it claims to, so say so rather than waiting out the suite's timeout.
      let expiry: ReturnType<typeof setTimeout> | undefined
      const abandoned = new Promise<never>((_, reject) => {
        expiry = setTimeout(() => reject(new Error(`no statement holding \`${needle}\` was parked`)), 2_000)
      })
      try {
        for (;;) {
          const index = parked.findIndex((entry) => entry.query.includes(needle))
          if (index >= 0) {
            const heldAt = held.indexOf(needle)
            if (heldAt >= 0) held.splice(heldAt, 1)
            return parked.splice(index, 1)[0]!
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              arrived = resolve
            }),
            abandoned
          ])
        }
      } finally {
        clearTimeout(expiry)
      }
    }
  }
}

const inserts = (gate: { readonly ran: ReadonlyArray<string> }): number =>
  gate.ran.filter((query) => query.includes("INSERT INTO smithers_build_cache_entry")).length

describe("D1 action cache", () => {
  let d1: TestDatabase
  let cache: ActionCache
  let gate: ReturnType<typeof makeQueryGate>

  beforeEach(async () => {
    gate = makeQueryGate()
    d1 = await makeTestDatabase({ beforeQuery: gate.beforeQuery })
    cache = makeActionCache(d1.database)
  })

  afterEach(() => {
    d1.close()
  })

  const row = (keyDigest: string): StoredRow | undefined =>
    d1.sqlite
      .prepare(
        `SELECT access_count, last_accessed_at, result_json, entry_json, created_at_ms, recorded_run_id,
          recorded_event_seq
        FROM smithers_build_cache_entry WHERE key_digest = ?`
      )
      .all(keyDigest)[0] as unknown as StoredRow | undefined

  it("gives the first writer the row and classifies every later publication", async () => {
    await expect(cache.put("key", publication())).resolves.toBe("inserted")
    await expect(cache.put("key", publication({ body: "{\"reordered\":true}" }))).resolves.toBe("identical")
    await expect(cache.put("key", publication({ resultJson: "{\"exitOk\":false}" }))).resolves.toBe("conflict")

    // The first writer's original text survives every later publication.
    expect(await cache.get("key")).toBe("{\"result\":{\"exitOk\":true}}")
  })

  it("classifies concurrent publications against the writer that wins the row", async () => {
    gate.hold("INSERT INTO smithers_build_cache_entry")
    const winner = cache.put("key", publication({ body: "{\"winner\":true}", createdAtMs: 11 }))
    const identical = cache.put("key", publication({ body: "{\"identical\":true}", recordedRunId: "run-2" }))
    const divergent = cache.put(
      "key",
      publication({ body: "{\"divergent\":true}", resultJson: "{\"exitOk\":false}" })
    )

    // All three inserts are in flight; each is released in turn, so the second
    // and third read a row the first has already committed.
    ;(await gate.waitFor("INSERT INTO smithers_build_cache_entry")).release()
    await expect(winner).resolves.toBe("inserted")
    ;(await gate.waitFor("INSERT INTO smithers_build_cache_entry")).release()
    await expect(identical).resolves.toBe("identical")
    ;(await gate.waitFor("INSERT INTO smithers_build_cache_entry")).release()
    await expect(divergent).resolves.toBe("conflict")

    // The winner's bytes and provenance are what a later reader gets.
    expect(await cache.get("key")).toBe("{\"winner\":true}")
    expect(row("key")?.created_at_ms).toBe(11)
    expect(row("key")?.recorded_run_id).toBe("run-1")
    expect(row("key")?.recorded_event_seq).toBe(7)
  })

  it("republishes when the row it lost to is deleted before the discriminator read", async () => {
    await cache.put("key", publication())
    gate.hold("RETURNING result_json")
    const republished = cache.put(
      "key",
      publication({ body: "{\"republished\":true}", recordedRunId: "run-2", recordedEventSeq: 9 })
    )

    // The losing insert has already conflicted; retention deletes the row
    // underneath the read that would have classified it.
    const classification = await gate.waitFor("RETURNING result_json")
    expect(await cache.delete("key", null)).toBe(true)
    classification.release()

    await expect(republished).resolves.toBe("inserted")
    expect(await cache.get("key")).toBe("{\"republished\":true}")
    expect(row("key")?.recorded_run_id).toBe("run-2")
    // One disappearance costs one extra insert, not the whole retry budget.
    expect(inserts(gate)).toBe(3)
  })

  it("keeps a replacement a delete under the superseded fence arrives to remove", async () => {
    await cache.put("key", publication())
    gate.hold("recorded_run_id = ?")
    const stale = cache.delete("key", { runId: "run-1", eventSeq: 7 })

    // The fenced delete binds the old provenance, then the entry it named is
    // evicted and republished while that statement waits.
    const fenced = await gate.waitFor("recorded_run_id = ?")
    expect(await cache.delete("key", null)).toBe(true)
    await expect(
      cache.put("key", publication({ body: "{\"replacement\":true}", recordedRunId: "run-2", recordedEventSeq: 9 }))
    ).resolves.toBe("inserted")
    fenced.release()

    await expect(stale).resolves.toBe(false)
    expect(await cache.get("key")).toBe("{\"replacement\":true}")
    expect(row("key")?.recorded_run_id).toBe("run-2")
    expect(row("key")?.recorded_event_seq).toBe(9)
  })

  it("stores a publication without provenance", async () => {
    await expect(
      cache.put("unfenced", publication({ createdAtMs: null, recordedRunId: null, recordedEventSeq: null }))
    ).resolves.toBe("inserted")

    expect(await cache.get("unfenced")).toBe("{\"result\":{\"exitOk\":true}}")
  })

  const updates = (): number =>
    gate.ran.filter((query) => query.trimStart().startsWith("UPDATE smithers_build_cache_entry")).length

  const lastAccessed = (keyDigest: string, at: string): void => {
    d1.sqlite
      .prepare("UPDATE smithers_build_cache_entry SET last_accessed_at = ? WHERE key_digest = ?")
      .run(at, keyDigest)
  }

  it("touches access metadata on a losing publication", async () => {
    await cache.put("key", publication())
    const published = row("key")

    await new Promise((resolve) => setTimeout(resolve, 2))
    await cache.put("key", publication())
    const contested = row("key")

    expect(published?.access_count).toBe(0)
    expect(contested?.access_count).toBe(1)
    expect(contested?.last_accessed_at.localeCompare(published?.last_accessed_at ?? "")).toBe(1)
  })

  it("reads an entry touched inside the last day without writing its row", async () => {
    await cache.put("key", publication())
    const published = row("key")

    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(await cache.get("key")).toBe("{\"result\":{\"exitOk\":true}}")
    expect(await cache.get("key")).toBe("{\"result\":{\"exitOk\":true}}")

    // The read credential is public within the organization, so a read that
    // wrote its row would let any reader drive metered D1 writes one request
    // at a time. A hot key costs its readers row reads and one write a day.
    expect(updates()).toBe(0)
    expect(row("key")?.access_count).toBe(0)
    expect(row("key")?.last_accessed_at).toBe(published?.last_accessed_at)
  })

  it("touches an entry once its last access is more than a day old", async () => {
    await cache.put("key", publication())
    const stale = new Date(Date.now() - (readTouchDays * 86_400_000 + 60_000)).toISOString()
    lastAccessed("key", stale)

    expect(await cache.get("key")).toBe("{\"result\":{\"exitOk\":true}}")
    const touched = row("key")
    expect(await cache.get("key")).toBe("{\"result\":{\"exitOk\":true}}")

    expect(updates()).toBe(1)
    expect(touched?.access_count).toBe(1)
    expect(touched?.last_accessed_at.localeCompare(stale)).toBe(1)
    expect(row("key")?.last_accessed_at).toBe(touched?.last_accessed_at)
  })

  it("touches often enough that an entry read daily stays inside retention", () => {
    expect(readTouchDays).toBeGreaterThan(0)
    expect(readTouchDays).toBeLessThan(retentionDays)
  })

  it("reports a missing key rather than inventing one", async () => {
    expect(await cache.get("absent")).toBeNull()
    expect(await cache.delete("absent", null)).toBe(false)
  })

  it("deletes unconditionally, and under a fence only when the fence matches", async () => {
    await cache.put("fenced", publication())

    expect(await cache.delete("fenced", { runId: "run-1", eventSeq: 8 })).toBe(false)
    expect(await cache.delete("fenced", { runId: "run-2", eventSeq: 7 })).toBe(false)
    expect(await cache.delete("fenced", { runId: "run-1", eventSeq: 7 })).toBe(true)
    expect(await cache.get("fenced")).toBeNull()

    await cache.put("unfenced", publication())
    expect(await cache.delete("unfenced", null)).toBe(true)
    expect(await cache.delete("unfenced", null)).toBe(false)
  })

  it("refuses a stored discriminator that is not the canonical text it wrote", async () => {
    await cache.put("poisoned", publication())
    d1.sqlite
      .prepare("UPDATE smithers_build_cache_entry SET result_json = ? WHERE key_digest = ?")
      .run("{ \"exitOk\" : true }", "poisoned")

    // A row rewritten outside the protocol is a tamper signal, not a hit.
    await expect(cache.put("poisoned", publication())).rejects.toThrow(/non-canonical/)
  })

  it("refuses a stored discriminator that is not bounded text", async () => {
    // The schema's `json_valid` check and the migration's size trigger keep
    // these rows out of D1, so the last line of defense is only reachable
    // through a store that answers with something D1 could not have held.
    const answering = (result: unknown): ActionCache =>
      makeActionCache(
        {
          prepare: (query: string) => ({
            bind: () => ({ first: async () => (query.startsWith("INSERT") ? null : { result_json: result }) })
          })
        } as unknown as D1Database
      )

    await expect(answering(42).put("key", publication())).rejects.toThrow(/invalid action-cache discriminator/)
    await expect(answering(`"${"x".repeat(2 * 1024 * 1024)}"`).put("key", publication())).rejects.toThrow(
      /invalid action-cache discriminator/
    )
    await expect(answering("{").put("key", publication())).rejects.toThrow(/invalid action-cache discriminator/)
  })

  it("gives up after three attempts when the row keeps disappearing", async () => {
    // A store that loses the row it just inserted: the conditional insert
    // reports a conflict and the read that should find the winner finds
    // nothing, which is the only way the retry loop can exhaust.
    let inserts = 0
    const disappearing = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => {
            if (query.startsWith("INSERT")) inserts += 1
            return null
          }
        })
      })
    } as unknown as D1Database

    await expect(makeActionCache(disappearing).put("key", publication())).rejects.toThrow(
      "action-cache publication lost its row repeatedly"
    )
    expect(inserts).toBe(3)
  })
})

describe("action-cache retention", () => {
  let d1: TestDatabase

  beforeEach(async () => {
    d1 = await makeTestDatabase()
  })

  afterEach(() => {
    d1.close()
  })

  const seed = (keyDigest: string, lastAccessedAt: string): void => {
    d1.sqlite
      .prepare(
        `INSERT INTO smithers_build_cache_entry (key_digest, entry_json, result_json, last_accessed_at)
        VALUES (?, '{}', '{}', ?)`
      )
      .run(keyDigest, lastAccessedAt)
  }

  const survivors = (): ReadonlyArray<string> =>
    (d1.sqlite.prepare("SELECT key_digest FROM smithers_build_cache_entry ORDER BY key_digest").all() as ReadonlyArray<
      unknown
    > as ReadonlyArray<{ readonly key_digest: string }>).map((entry) => entry.key_digest)

  it("deletes only entries last read before the cutoff", async () => {
    seed("cold", "2026-01-01T00:00:00.000Z")
    seed("warm", "2026-08-30T00:00:00.000Z")

    await expect(pruneStaleEntries(d1.database, "2026-06-01T00:00:00.000Z")).resolves.toBe(1)

    expect(survivors()).toEqual(["warm"])
  })

  it("deletes more rows than one batch holds and reports the total", async () => {
    for (let index = 0; index < 501; index += 1) seed(`cold-${index}`, "2026-01-01T00:00:00.000Z")

    await expect(pruneStaleEntries(d1.database, "2026-06-01T00:00:00.000Z")).resolves.toBe(501)

    expect(survivors()).toEqual([])
  })

  it("stops after twenty batches and resumes on the next invocation", async () => {
    const insert = d1.sqlite.prepare(
      `INSERT INTO smithers_build_cache_entry (key_digest, entry_json, result_json, last_accessed_at)
      VALUES (?, '{}', '{}', ?)`
    )
    d1.sqlite.exec("BEGIN")
    try {
      for (let index = 0; index < 10_001; index += 1) {
        insert.run(`cold-${index}`, "2026-01-01T00:00:00.000Z")
      }
      d1.sqlite.exec("COMMIT")
    } catch (error) {
      d1.sqlite.exec("ROLLBACK")
      throw error
    }

    await expect(pruneStaleEntries(d1.database, "2026-06-01T00:00:00.000Z")).resolves.toBe(10_000)
    expect(survivors()).toHaveLength(1)

    await expect(pruneStaleEntries(d1.database, "2026-06-01T00:00:00.000Z")).resolves.toBe(1)
    expect(survivors()).toEqual([])
  })

  it("removes nothing when every entry is inside the window", async () => {
    seed("warm", "2026-08-30T00:00:00.000Z")

    await expect(pruneStaleEntries(d1.database, "2026-01-01T00:00:00.000Z")).resolves.toBe(0)

    expect(survivors()).toEqual(["warm"])
  })

  it("prunes from the scheduled handler at the documented retention window", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      const worker = (await import("../CacheWorker.ts")).default
      const now = Date.parse("2026-09-01T00:00:00.000Z")
      vi.setSystemTime(now)
      seed("cold", new Date(now - (retentionDays + 1) * 86_400_000).toISOString())
      seed("warm", new Date(now - 1000).toISOString())

      await worker.scheduled({} as ScheduledController, { CACHE_DATABASE: d1.database } as never)

      expect(survivors()).toEqual(["warm"])
      expect(String(logs.mock.calls[0]?.[0])).toContain("pruned 1 action-cache entries")
    } finally {
      vi.useRealTimers()
      logs.mockRestore()
    }
  })

  it("reports a retention failure without repeating its cause", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const worker = (await import("../CacheWorker.ts")).default
      const failing = {
        prepare: () => {
          throw Object.assign(new Error("connection string with a password"), { code: "ECONNRESET" })
        }
      } as unknown as D1Database

      await expect(
        worker.scheduled({} as ScheduledController, { CACHE_DATABASE: failing } as never)
      ).rejects.toThrow("scheduled retention failed")
      expect(String(errors.mock.calls[0]?.[0])).toContain("code=ECONNRESET")
      expect(String(errors.mock.calls[0]?.[0])).not.toContain("password")
    } finally {
      errors.mockRestore()
    }
  })
})

// Ported from review-evidence/2026-09-05-grid-review/probes/build-infra/api-design-1.ts.
// Keep the probe's identity and changed metadata/time against the real D1 adapter,
// and drive the actual step-cache client to pin the HTTP outcome mapping.
describe("hosted result-only contract (build-infra/api-design/1)", () => {
  const first = {
    keyDigest: "key",
    result: { ok: true },
    meta: { output: "first" },
    createdAtMs: 1,
    recordedRunId: "run-a",
    recordedEventSeq: 7
  }
  const changed = { ...first, meta: { output: "changed" }, createdAtMs: 2 }
  const replacement = { ...first, result: { ok: false }, meta: { output: "replacement" }, recordedRunId: "run-b" }
  const contentStore: ContentStore = {
    get: async () => null,
    has: async () => false,
    put: async () => "inserted",
    presentDigests: async () => new Set()
  }
  let d1: TestDatabase
  let cache: ActionCache
  let handler: ReturnType<typeof createHandler>

  beforeEach(async () => {
    d1 = await makeTestDatabase()
    cache = makeActionCache(d1.database)
    handler = createHandler({
      actionCache: cache,
      contentStore,
      readTokenHash: createHash("sha256").update("probe-reader").digest("hex"),
      writeTokenHash: createHash("sha256").update("probe-writer").digest("hex")
    })
  })

  afterEach(() => d1.close())

  const send = (method: string, body?: unknown, query = "") =>
    handler(new Request(`https://cache.test/ac/key${query}`, {
      method,
      headers: { authorization: "Bearer probe-writer", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }))

  const remote = async () => {
    // Load the Node client at runtime: importing its implementation into the
    // Workers typecheck mixes incompatible TextDecoder ambient declarations.
    // The shared CacheStore service still types every operation below.
    const { make } = await import(new URL("../../../../flows/step-cache/src/RemoteCacheStore.ts", import.meta.url).href) as {
      readonly make: (options: {
        readonly endpoint: string
        readonly headers: Readonly<Record<string, string>>
      }) => Effect.Effect<CacheStore.Service, CacheStore.CacheStoreError, HttpClient.HttpClient>
    }
    const client = HttpClient.make((request, url, signal) =>
      Effect.promise(async () => {
        const response = await handler(new Request(url, {
          method: request.method,
          headers: request.headers,
          signal,
          ...(request.body._tag === "Uint8Array"
            ? { body: new TextDecoder().decode(request.body.body) }
            : {})
        }))
        return HttpClientResponse.fromWeb(request, response)
      })
    )
    return Effect.runPromise(make({
      endpoint: "https://cache.test",
      headers: { authorization: "Bearer probe-writer" }
    }).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  }

  it("advertises its versioned arbitration contract on health, hits, misses and refusals", async () => {
    const responses = [
      await handler(new Request("https://cache.test/healthz")),
      await send("GET"),
      await send("PUT", { keyDigest: "key", result: first.result }),
      await send("GET"),
      await send("PUT", first),
      await handler(new Request("https://cache.test/ac/key"))
    ]
    for (const response of responses) {
      expect(response.headers.get("smithers-cache-contract")).toBe("result-only-v1")
      await response.text()
    }
  })

  it("refuses the probe's first publication, identity retry and replacement without storing them", async () => {
    for (const entry of [first, changed, replacement]) {
      const response = await send("PUT", entry)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_PROVENANCE" })
      expect(await cache.get("key")).toBeNull()
    }
  })

  it("refuses identity retries against a legacy head without changing its bytes", async () => {
    await cache.put("key", publication({
      body: JSON.stringify(first),
      resultJson: JSON.stringify(first.result),
      createdAtMs: first.createdAtMs,
      recordedRunId: first.recordedRunId,
      recordedEventSeq: first.recordedEventSeq
    }))
    expect((await send("PUT", changed)).status).toBe(422)
    expect(await (await send("GET")).json()).toEqual(first)
    expect((await send("DELETE", undefined, "?recordedRunId=run-b&recordedEventSeq=7")).status).toBe(404)
    expect((await send("DELETE", undefined, "?recordedRunId=run-a&recordedEventSeq=7")).status).toBe(200)
    expect((await send("PUT", replacement)).status).toBe(422)
    expect((await send("GET", undefined, "?recordedRunId=run-a&recordedEventSeq=7")).status).toBe(422)
  })

  it("refuses provenance-selected reads before consulting the head", async () => {
    const get = vi.spyOn(cache, "get")
    // Reconstruct the handler so it captures the spied method.
    handler = createHandler({
      actionCache: cache,
      contentStore,
      readTokenHash: createHash("sha256").update("probe-reader").digest("hex"),
      writeTokenHash: createHash("sha256").update("probe-writer").digest("hex")
    })
    for (const query of ["?recordedRunId=run-a&recordedEventSeq=7", "?recordedRunId=", "?recordedEventSeq=7"]) {
      const response = await send("GET", undefined, query)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_PROVENANCE" })
    }
    expect(get).not.toHaveBeenCalled()
  })

  it("preserves result-only head arbitration for publications without journal identity", async () => {
    const head = { keyDigest: "key", result: first.result, meta: first.meta, createdAtMs: 1 }
    expect((await send("PUT", head)).status).toBe(201)
    expect((await send("PUT", { ...head, meta: changed.meta, createdAtMs: 2 })).status).toBe(200)
    expect((await send("PUT", { ...head, result: replacement.result })).status).toBe(409)
    expect(await (await send("GET")).json()).toEqual(head)
    expect((await send("DELETE")).status).toBe(200)
    expect((await send("PUT", { ...head, result: replacement.result })).status).toBe(201)
    expect((await send("GET", undefined, "?recordedRunId=run-a&recordedEventSeq=7")).status).toBe(422)
    expect(await (await send("GET")).json()).toEqual({ ...head, result: replacement.result })
  })

  it("maps provenance publications to RemoteCacheStore refusal, never ExistingSame or Conflict", async () => {
    const store = await remote()
    for (const entry of [first, changed, replacement]) {
      const error = await Effect.runPromise(Effect.flip(store.put(entry)))
      expect(error.code).toBe("persistence_failed")
      expect(error.message).toContain("HTTP 422")
    }
  })

  it("maps provenance lookups to RemoteCacheStore refusal", async () => {
    const store = await remote()
    const error = await Effect.runPromise(Effect.flip(store.get("key", {
      recordedBy: { runId: "run-a", eventSeq: 7 }
    })))
    expect(error.code).toBe("persistence_failed")
    expect(error.message).toContain("HTTP 422")
  })
})
