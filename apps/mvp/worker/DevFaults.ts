// Only DevChatApi imports these faulty services. Headers select faults for one browser context, including old builds.
import { ShapeProxy } from "@smthrs/effect-electric"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpServerRequest } from "effect/http"
import { Sessions } from "./Actor.ts"
import { parseStackPath } from "./stack/Api.ts"

/** Explicit dev-host switches; production never installs these services. */
export const SHAPES_HEADER = "x-smithers-test-shapes"
export const STACK_HEADER = "x-smithers-test-stack"

/** Sign-in's real service, refusing a stack write as a Guest while its switch is set. The real route answers 403. */
export const sessions = Layer.effect(Sessions, Effect.map(Sessions, (real) => ({
  ...real,
  resolve: Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const actor = yield* real.resolve
    return request.method === "POST" && parseStackPath(request.url.split("?")[0]!) !== undefined &&
        request.headers[STACK_HEADER] === "refuse"
      ? Option.map(actor, (who) => ({ ...who, role: "guest" as const }))
      : actor
  }),
})))

/** Electric's real HTTP client, held after shape authorization and before its network call until the request ends. */
export const electric = Layer.effect(ShapeProxy.Upstream, Effect.gen(function* () {
  const real = yield* HttpClient.HttpClient
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "http://dev.test")
  const held = request.headers[SHAPES_HEADER]
  const hold = held === "issues"
    ? ["/api/shapes/items", "/api/shapes/item-summaries"].includes(url.pathname)
    : url.pathname === "/api/shapes/todos" &&
      (held === "todos" || (held === "todos-live" && url.searchParams.get("live") === "true"))
  return real.pipe(HttpClient.transform((answer) => hold
    ? Effect.logDebug("test.shape.held").pipe(
      Effect.annotateLogs({ shape: url.pathname, live: url.searchParams.get("live") === "true" }),
      // A bare unresolved promise is rejected as hung by workerd. Keep a cancellable clock event pending.
      Effect.andThen(Effect.forever(Effect.sleep("1 hour"))),
    )
    : answer))
})).pipe(Layer.provide(FetchHttpClient.layer))
