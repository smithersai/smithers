import { ImmutableCache } from "@smthrs/artifacts"
import { WebPage } from "@smthrs/views"
import { Cause, Clock, Config, Duration, Effect, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { MAX_PREVIEW_BODY_BYTES, MAX_URL_LENGTH, WEB_MODES } from "../src/features/web/contract.ts"
import { checkUrl, LOCAL_HOSTS } from "../src/features/web/url.ts"
import { Sessions } from "./Actor.ts"
import { readBounded } from "./Body.ts"
import { codeOf } from "./ErrorCode.ts"
import { localHttpConfig, policyFor } from "./Views.ts"

// Checking a page before the conversation shows it (docs/features/web-pages.md#before-a-page-is-framed):
// `POST /api/web/preview { url, mode }`, which `app/web/preview` calls. A browser can't read why a frame of another site
// stays blank, so ChatApi asks the page, as a frame would, with `@smthrs/views`' `WebPage.check`, and answers whether a
// frame shows it and the title, description and icon a card shows instead. The flow embeds only a page a frame shows.
//
// The URL is someone else's, so it is the policy's first (src/features/web/url.ts, against the host the request came to),
// then `WebPage.check`'s guard on every hop: named hosts only, never an IP literal, `localhost` or a local name, at most
// five redirects, an 8 s deadline and 256 KiB of the head. `WEB_PAGES_LOCAL_HTTP` (development: `alchemy dev`) also lets
// it read this machine's pages. A name that resolves to a private address is Cloudflare's to refuse: a Worker's fetch
// reaches public addresses only. Anyone signed in asks a page; only a person who may ask in a conversation adds it there
// as a view (worker/Views.ts, ruling AUTH-8).
//
// The answer is kept for `WEB_PAGE_CHECK_KEPT` (5 minutes) in the edge cache, by the page's URL and the app's origin,
// in windows of that length: a page asked again within one is answered without a request. The cache sees only a hash
// of the URL. No record carries the URL, its host or its path.

/** `POST /api/web/preview` requests, by `status` and, once checked, `framing`. */
export const previews = Metric.counter("smithers_web_previews", {
  description: "POST /api/web/preview requests, by status and framing",
  incremental: true,
})

/** How long a page's answer is kept, unless `WEB_PAGE_CHECK_KEPT` says otherwise. */
export const KEPT = Duration.minutes(5)

const Ask = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(MAX_URL_LENGTH)),
  mode: Schema.Literals(WEB_MODES),
})
const decodeAsk = Schema.decodeUnknownEffect(Schema.fromJsonString(Ask))
const decodeChecked = Schema.decodeUnknownEffect(Schema.fromJsonString(WebPage.Checked))
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number | boolean>

/** A refusal: its status and code, logged and answered as `{ code }`. */
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })

/**
 * Reads `WEB_PAGES_LOCAL_HTTP` (`localHttp` unless set, `false` unless given) and `WEB_PAGE_CHECK_KEPT`, and returns
 * `POST /api/web/preview`. Each request is a log line `chat.web.preview`, a span `chat.web.preview` around
 * `WebPage.check`'s and a count; none carries the page. It needs the host's `HttpClient`, which requests the page, and
 * an `ImmutableCache`, which keeps the answer.
 */
export const make = (options: { readonly localHttp?: boolean } = {}) =>
  Effect.gen(function* () {
    const localHttp = yield* localHttpConfig(options.localHttp ?? false)
    const kept = Duration.toMillis(yield* Config.Duration("WEB_PAGE_CHECK_KEPT").pipe(Config.withDefault(KEPT)))
    const privateHosts = localHttp ? [...LOCAL_HOSTS] : []

    const preview = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Fields = {}
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        const actor = yield* (yield* Sessions).resolve
        // Anyone signed in: a preview adds nothing to a conversation, which the views route checks by its repository
        // (ruling AUTH-8), and it is one bounded page read, kept for everyone who asks for the same page.
        if (Option.isNone(actor)) return refusal(401, "authentication")
        const body = yield* readBounded(request, MAX_PREVIEW_BODY_BYTES).pipe(Effect.result)
        if (body._tag === "Failure") {
          return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
        }
        const ask = yield* decodeAsk(body.success).pipe(Effect.option)
        if (Option.isNone(ask)) return refusal(400, "invalid")
        fields.mode = ask.value.mode
        const policy = policyFor(request, localHttp)
        const page = checkUrl(ask.value.url, ask.value.mode, policy)
        if (!page.ok) {
          fields.reason = page.reason
          return refusal(400, "refused")
        }
        const appOrigin = new URL(policy.appOrigin).origin
        let asked = false
        const load = Effect.gen(function* () {
          asked = true
          const checked = yield* WebPage.check(page.page.href, { ancestors: [appOrigin], privateHosts })
          return { bytes: encoder.encode(JSON.stringify(checked)), metadata: {} }
        })
        // Zero disables caching: dividing by zero otherwise gives every request the same Infinity bucket.
        const entry = yield* kept > 0
          ? ImmutableCache.readThrough(
            ImmutableCache.key("web.preview", page.page.href, appOrigin, String(Math.floor(startedAt / kept))),
            load,
          )
          : load
        const checked = yield* decodeChecked(decoder.decode(entry.bytes))
        fields.cached = !asked
        fields.framing = checked.framing
        if (checked.reason !== undefined) fields.framingReason = checked.reason
        return HttpServerResponse.jsonUnsafe(checked, { status: 200, headers: noStore })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refusal(503, "unavailable")
          })
        ),
      )
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      yield* Metric.update(
        Metric.withAttributes(previews, {
          status: String(response.status),
          ...(typeof fields.framing === "string" ? { framing: fields.framing } : {}),
        }),
        1,
      )
      yield* Effect.annotateCurrentSpan({
        "http.response.status_code": response.status,
        ...(typeof fields.framing === "string" ? { "smithers.web.framing": fields.framing } : {}),
      })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "chat.web.preview",
      ).pipe(Effect.annotateLogs(fields))
      return response
    }).pipe(Effect.withSpan("chat.web.preview", { kind: "server" }))

    return { preview }
  })
