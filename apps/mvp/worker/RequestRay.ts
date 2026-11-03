import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { RAY_HEADER, rayOf } from "../src/requestRay.ts"

/** Available to role reads in an HTTP request, absent in a flow or local development. */
export const requestRay = Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
  Option.isSome(request) ? rayOf(request.value.headers["cf-ray"]) : undefined)

/** Correlate existing route logs and error responses without touching successful representations. */
export const withRequestRay = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const ray = yield* requestRay
    const response = yield* effect.pipe(Effect.annotateLogs({ ray: ray ?? "none" }))
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const api = Option.isSome(request) && new URL(request.value.url, "http://request.invalid").pathname.startsWith("/api/")
    return api && response.status >= 400 && ray !== undefined
      ? HttpServerResponse.setHeader(response, RAY_HEADER, ray)
      : response
  })
