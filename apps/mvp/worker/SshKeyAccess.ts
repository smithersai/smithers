import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { refusesPersonOnly, Sessions } from "./Actor.ts"

export const handles = (method: string, path: string): boolean =>
  (method === "POST" && path === "/api/user/keys") ||
  (method === "DELETE" && /^\/api\/user\/keys\/[^/]+$/.test(path))

/** Guard the account credential write paths before dispatching to product handlers. */
export const guard = <E, R>(next: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "https://smithers.invalid").pathname
    if (handles(request.method, path)) {
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 })
      if (yield* refusesPersonOnly(actor.value, "ssh-key")) {
        return HttpServerResponse.jsonUnsafe({ error: "person_only" }, { status: 403 })
      }
    }
    return yield* next
  }).pipe(Effect.catchTag("@smthrs/mvp/auth/SessionsUnavailable", () =>
    Effect.succeed(HttpServerResponse.empty({ status: 503 }))))
