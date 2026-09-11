/**
 * Cloudflare Worker entry point for the hosted build cache.
 *
 * @since 0.1.0
 */
import { CacheFailure } from "./cache-failure.ts"
import { makeActionCache } from "./D1ActionCache.ts"
import { createHandler, describeFailure } from "./protocol.ts"
import { makeContentStore } from "./R2ContentStore.ts"
import { makeCredentialBudget } from "./RateLimitCredentialBudget.ts"
import { pruneStaleEntries, retentionDays } from "./RetentionSweep.ts"

interface CacheWorkerEnv {
  readonly CACHE_DATABASE: D1Database
  readonly CACHE_BUCKET: R2Bucket
  /** Counts every admitted request per credential digest at this location. */
  readonly CACHE_REQUEST_BUDGET: RateLimit
  /** Counts `findMissing` probes per credential digest at this location. */
  readonly CACHE_FIND_MISSING_BUDGET: RateLimit
  /** SHA-256 of the pull credential every job may hold, trusted or not. */
  readonly CACHE_READ_TOKEN: string
  /** SHA-256 of the publish credential only post-merge jobs may hold. */
  readonly CACHE_WRITE_TOKEN: string
}

interface HealthRow {
  readonly ok: number
}

const healthObjectKey = "__smithers_build_healthcheck__"
const millisecondsPerDay = 24 * 60 * 60 * 1000

const makeHealth = (database: D1Database, bucket: R2Bucket) => async (): Promise<void> => {
  const [row] = await Promise.all([
    database.prepare("SELECT 1 AS ok").first<HealthRow>(),
    bucket.head(healthObjectKey)
  ])
  if (row?.ok !== 1) {
    throw new CacheFailure("D1_READINESS_INVALID", "health", "D1 readiness check did not return its sentinel")
  }
}

type CacheHandler = ReturnType<typeof createHandler>

let isolateHandler: CacheHandler | null = null

const handlerFor = (env: CacheWorkerEnv): CacheHandler => {
  if (isolateHandler !== null) return isolateHandler
  isolateHandler = createHandler({
    actionCache: makeActionCache(env.CACHE_DATABASE),
    contentStore: makeContentStore(env.CACHE_BUCKET),
    readTokenHash: env.CACHE_READ_TOKEN,
    writeTokenHash: env.CACHE_WRITE_TOKEN,
    credentialBudget: makeCredentialBudget(env.CACHE_REQUEST_BUDGET, env.CACHE_FIND_MISSING_BUDGET),
    health: makeHealth(env.CACHE_DATABASE, env.CACHE_BUCKET)
  })
  return isolateHandler
}

/**
 * Cloudflare Worker entry point for the hosted remote cache.
 *
 * @category runtime
 * @since 0.1.0
 */
const worker = {
  async fetch(request: Request, env: CacheWorkerEnv): Promise<Response> {
    try {
      return await handlerFor(env)(request)
    } catch (cause) {
      console.error(describeFailure(cause))
      return new Response(JSON.stringify({ error: "the cache tier failed to initialize" }), {
        status: 503,
        headers: { "content-type": "application/json", "Smithers-Cache-Contract": "result-only-v1" }
      })
    }
  },
  async scheduled(_controller: ScheduledController, env: CacheWorkerEnv): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * millisecondsPerDay).toISOString()
    try {
      const removed = await pruneStaleEntries(env.CACHE_DATABASE, cutoff)
      console.log(`smithers build cache: pruned ${removed} action-cache entries last read before ${cutoff}`)
    } catch (cause) {
      // The allowlisted diagnostic is the record; the rethrown failure is what
      // makes Cloudflare retry the invocation without repeating the cause.
      console.error(
        describeFailure(new CacheFailure("RETENTION_FAILED", "retention", "scheduled retention failed", { cause }))
      )
      throw new Error("scheduled retention failed")
    }
  }
} satisfies ExportedHandler<CacheWorkerEnv>

export default worker
