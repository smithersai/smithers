import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { type Actor, Sessions } from "../../../worker/Actor.vibe"
import * as ProjectsApi from "../../../worker/projects/Api.vibe"
import { boundFetch } from "../../device/identity.vibe"
import { DEVICE_PERSON_HEADER } from "../auth/contract"
import { PROJECT_PERSON_HEADER, PROJECTS_ROUTE } from "./contract"
import { saveAt } from "./steps.vibe"

test("the step keeps the captured account across an account switch and the real route refuses the write", async () => {
  const origin = "https://projects.test"
  const unopened = Layer.effect(SqlClient.SqlClient, Effect.die("wrong-account request reached the store"))
  const route = HttpEffect.toWebHandler(ProjectsApi.serve(
    unopened, {} as never, { admins: new Set() }, () => Effect.die("write requested plan counts"),
  ).pipe(Effect.provideService(Sessions, {
    resolve: Effect.succeedSome<Actor>({ subject: { kind: "person", id: "second-owner" }, role: "member" }),
  })))
  const received: Array<{ device: string | null; expected: string | null; body: unknown }> = []
  const fetch = boundFetch(async (input, init) => {
    const request = new Request(input, init)
    expect(new URL(request.url).pathname).toBe(PROJECTS_ROUTE)
    expect(request.method).toBe("POST")
    received.push({
      device: request.headers.get(DEVICE_PERSON_HEADER),
      expected: request.headers.get(PROJECT_PERSON_HEADER),
      body: await request.clone().json(),
    })
    return route(request)
  }, { origin, principal: () => "second-owner" })

  const result = await Effect.runPromise(saveAt(origin)({ project: "example/idle-project", personId: "first-owner" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.flip,
  ))
  expect(result).toMatchObject({ _tag: "@smthrs/mvp/projects/AddFailed", code: "sign_in" })
  expect(received).toEqual([{ device: "second-owner", expected: "first-owner", body: { project: "example/idle-project" } }])
})
