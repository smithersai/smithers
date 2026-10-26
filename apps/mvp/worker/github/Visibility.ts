import { GitHub } from "@smthrs/integrations"
import { Effect, Metric, Option, Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import { isRateLimited } from "./Calls.ts"
import type { Repository } from "./Config.ts"
import * as Metrics from "./Metrics.ts"
import type { ReadToken } from "./ReadToken.ts"

/** Only bounded diagnostics leave the metadata transport; no headers or provider text are logged. */
export const remainingBucket = (raw: string | undefined): string => {
  if (raw === undefined || !/^\d+$/.test(raw)) return "unknown"
  const remaining = Number(raw)
  return remaining === 0 ? "0" : remaining < 10 ? "1-9" : remaining < 100 ? "10-99" : "100+"
}

/** Each invocation owns its client and I/O, including the response diagnostics. */
export const read = (target: Repository, apiBaseUrl: string, readToken: ReadToken, http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    let statusClass = "none"
    let remaining = "unknown"
    let headerLimited = false
    const observed = HttpClient.make((request) => http.execute(request).pipe(Effect.tap((response) => Effect.sync(() => {
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
    const status = failed ? result.failure.details?.["status"] : 200
    const visible = failed ? status === 404 || status === 410 ? Option.some(false) : Option.none<boolean>()
      : Option.some(!result.success.private)
    const outcome = Option.isNone(visible) ? "unavailable" : visible.value ? "public" : "private"
    const attributes = { outcome, statusClass, rateLimited: String(headerLimited || (failed && isRateLimited(result.failure))),
      remaining, errorCode: failed ? result.failure.reason : "none" }
    yield* Metric.update(Metric.withAttributes(Metrics.visibilityReads, attributes), 1)
    yield* Effect.logInfo("github.visibility").pipe(Effect.annotateLogs({ repoId: target.id, ...attributes }))
    return visible
  }).pipe(Effect.withSpan("github.visibility"))
