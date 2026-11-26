import { Effect, Option, Result } from "effect"
import { HttpServerRequest } from "effect/http"
import { expect, test } from "vitest"
import { type Actor, Sessions, SessionsUnavailable } from "./Actor.ts"
import * as ShapeAccess from "./ShapeAccess.vibe"

const request = HttpServerRequest.fromWeb(new Request("https://app.example/api/shapes/admin"))
const admin: Actor = { subject: { kind: "person", id: "admin-1" }, role: "admin" }

const read = <A, E>(
  program: Effect.Effect<A, E, Sessions | HttpServerRequest.HttpServerRequest>,
  resolve: Effect.Effect<Option.Option<Actor>, SessionsUnavailable, HttpServerRequest.HttpServerRequest>,
) => Effect.runSync(Effect.result(program.pipe(
  Effect.provideService(Sessions, { resolve }),
  Effect.provideService(HttpServerRequest.HttpServerRequest, request),
)))

test("shape access preserves the resolved actor and distinguishes a signed-out request", () => {
  expect(read(ShapeAccess.actor, Effect.succeedSome(admin))).toEqual(Result.succeed(Option.some(admin)))
  expect(read(ShapeAccess.actor, Effect.succeedNone)).toEqual(Result.succeed(Option.none()))
})

test("an unreadable session refuses both shape checks with the retryable 503", () => {
  const unreadable = Effect.fail(new SessionsUnavailable({ errorCode: "offline" }))
  for (const program of [ShapeAccess.actor, ShapeAccess.admin] as const) {
    const result = read(Effect.asVoid(program), unreadable)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBe(ShapeAccess.unavailable)
      expect(result.failure).toMatchObject({ status: 503, upstream: "database", retryAfter: 5 })
    }
  }
})

test("an administrator's own session can read admin shapes", () => {
  expect(read(ShapeAccess.admin, Effect.succeedSome(admin))).toEqual(Result.succeed(undefined))
})

test.each([
  ["a signed-out reader", Option.none<Actor>()],
  ["a member", Option.some<Actor>({ ...admin, role: "member" })],
  ["a delegated administrator", Option.some<Actor>({ ...admin, act: { kind: "flow", id: "run-1" } })],
])("admin shapes refuse %s with 403", (_, actor) => {
  expect(read(ShapeAccess.admin, Effect.succeed(actor))).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
})
