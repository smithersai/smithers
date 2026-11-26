import { Effect, Option } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { Sessions, SessionsUnavailable } from "./Actor.vibe"
import { guard, handles } from "./SshKeyAccess.vibe"

test.each([
  ["POST", "/api/user/keys", true],
  ["POST", "/api/user/keys/42", false],
  ["DELETE", "/api/user/keys/42", true],
  ["DELETE", "/api/user/keys/", false],
  ["DELETE", "/api/user/keys/42/extra", false],
  ["GET", "/api/user/keys", false],
])("%s %s has the expected credential-write classification", (method, path, expected) => {
  expect(handles(method, path)).toBe(expected)
})

test("credential writes dispatch only with a confirmed person", async () => {
  let dispatched = 0
  const next = Effect.sync(() => {
    dispatched++
    return HttpServerResponse.empty({ status: 204 })
  })
  const handle = (resolve: typeof Sessions.Service.resolve) =>
    HttpEffect.toWebHandler(guard(next).pipe(Effect.provideService(Sessions, Sessions.of({ resolve }))))
  const write = () => new Request("https://chat.test/api/user/keys?source=settings", { method: "POST" })
  expect((await handle(Effect.succeedNone)(write())).status).toBe(401)
  const unavailable = handle(Effect.fail(new SessionsUnavailable()))
  expect((await unavailable(write())).status).toBe(503)
  expect(dispatched).toBe(0)

  const person = handle(Effect.succeed(Option.some({ subject: { kind: "person", id: "person" }, role: "member" })))
  expect((await person(write())).status).toBe(204)
  expect((await unavailable(new Request("https://chat.test/api/user/keys"))).status).toBe(204)
  expect(dispatched).toBe(2)
})
