import { GitHub } from "@smthrs/integrations"
import { Clock, Effect, Metric, Option, Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import { classify, isRateLimited, statusOf } from "#vibelang/emitted/worker/github/Calls"
import type { Repository } from "#vibelang/source/worker/github/Config"
import * as Metrics from "#vibelang/emitted/worker/github/Metrics"
import type { ReadToken } from "./ReadToken.ts"

/** Only bounded diagnostics leave the metadata transport; no headers or provider text are logged. */
export const remainingBucket = (raw: string | undefined): string => {
  if (raw === undefined || !/^\d+$/.test(raw)) return "unknown"
  const remaining = Number(raw)
  return remaining === 0 ? "0" : remaining < 10 ? "1-9" : remaining < 100 ? "10-99" : "100+"
}

/** Each invocation owns its client and I/O, including the response diagnostics. */
export const readDetailed = (target: Repository, apiBaseUrl: string, readToken: ReadToken, http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    let statusClass = "none"
    let remaining = "unknown"
    let headerLimited = false
    let headerRetrySeconds: number | undefined
    const clock = yield* Clock.Clock
    const observed = HttpClient.make((request) => http.execute(request).pipe(Effect.tap((response) => Effect.sync(() => {
      const rawRetry = response.headers["retry-after"]
      const relative = rawRetry === undefined ? NaN : Number(rawRetry)
      const serverNow = Date.parse(response.headers["date"] ?? "")
      const retry = Number.isFinite(relative) ? relative :
        (Date.parse(rawRetry ?? "") - (Number.isFinite(serverNow) ? serverNow : clock.currentTimeMillisUnsafe())) / 1000
      if (Number.isFinite(retry) && retry > 0) headerRetrySeconds = Math.ceil(retry)
      statusClass = `${Math.floor(response.status / 100)}xx`
      remaining = remainingBucket(response.headers["x-ratelimit-remaining"])
      headerLimited = (response.status === 403 || response.status === 429) &&
        (remaining === "0" || response.headers["retry-after"] !== undefined)
    }))))
    const token = yield* readToken
    const client = yield* GitHub.GitHubClient.make({ apiBaseUrl,
      token: Option.isSome(token) ? Redacted.value(token.value) : undefined,
    }, {}).pipe(Effect.provideService(HttpClient.HttpClient, observed), Effect.orDie)
    const result = yield* client.request("GET", `/repos/${GitHub.Repository.repositoryPath(target.owner, target.name)}`,
      undefined, { schema: Schema.Struct({ private: Schema.Boolean }) }).pipe(Effect.result)
    const failed = result._tag === "Failure"
    const rateLimited = headerLimited || (failed && isRateLimited(result.failure))
    const failure = failed ? classify(result.failure) : undefined
    // A 404 proves only that this read cannot see a public repository. Cache the denial equally for absent and
    // inaccessible repositories; never infer which. Other failed reads cannot establish visibility.
    const notFound = !rateLimited && failure?.kind === "refused" && failure.status === 404
    const visible = failed ? notFound ? Option.some(false) : Option.none<boolean>()
      : Option.some(!result.success.private)
    const outcome = notFound ? "not_found" : Option.isNone(visible) ? "unavailable" : visible.value ? "public" : "private"
    const attributes = { outcome, statusClass, rateLimited: String(rateLimited),
      remaining, errorCode: failed ? result.failure.reason : "none" }
    yield* Metric.update(Metric.withAttributes(Metrics.visibilityReads, attributes), 1)
    yield* Effect.logInfo("github.visibility").pipe(Effect.annotateLogs({
      repoId: target.id, stage: "metadata", upstreamStatus: failed ? statusOf(result.failure) ?? null : 200, ...attributes,
    }))
    const retryAfterSeconds = headerRetrySeconds ?? (failure?.kind === "retry" && failure.retryAfterMillis !== undefined
      ? Math.max(1, Math.ceil(failure.retryAfterMillis / 1000)) : undefined)
    return { visible, rateLimited, retryAfterSeconds, upstreamStatus: failed ? statusOf(result.failure) : undefined }
  }).pipe(Effect.withSpan("github.visibility"))

/** Metadata visibility for readers that need no refusal details. */
export const read = (target: Repository, apiBaseUrl: string, readToken: ReadToken, http: HttpClient.HttpClient) =>
  Effect.map(readDetailed(target, apiBaseUrl, readToken, http), (answer) => answer.visible)

/** A current metadata answer is less than 60 seconds old. Only completed values cross requests. */
export const TTL_MS = 60_000

/** Construct once per isolate's routes. Concurrent misses each own a GitHub request. */
export const make = (apiBaseUrl: string, readToken: ReadToken, http: HttpClient.HttpClient) => {
  const held = new Map<string, { readonly public: boolean; readonly at: number }>()
  return (target: Repository) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const cached = held.get(target.id)
    if (cached !== undefined && now - cached.at < TTL_MS) return Option.some(cached.public)
    const answer = yield* read(target, apiBaseUrl, readToken, http)
    if (Option.isSome(answer)) held.set(target.id, { public: answer.value, at: now })
    return answer
  })
}
