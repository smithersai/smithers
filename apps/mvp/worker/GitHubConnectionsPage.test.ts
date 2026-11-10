import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as Actor from "./Actor.vibe"
import * as Page from "./GitHubConnectionsPage.vibe"
import * as SessionStore from "./SessionStore.ts"

// The Disconnect page against the real `people` table; the person's Durable Object is the injected seam.
const database = TestDatabase.layer("connect_page")
const run = (name: string, body: Effect.Effect<void, unknown, any>) =>
  test(name, () => Effect.runPromise(Effect.scoped(Effect.provide(body, database)) as Effect.Effect<void, unknown, never>))
const origin = "https://smithers.test"
const site = "https://vibelang.smithers.test"
interface Calls { readonly revoked: Array<[number, string]>; readonly fails?: boolean }
const unavailable = { reason: "unavailable" as const }
const objects = (calls: Calls) => ({
  getByName: () => ({
    connections: () => Effect.succeed(calls.fails === true ? unavailable : { ok: [{ origin: site, expires: 9 }] }),
    revoke: (person: number, target: string) => {
      calls.revoked.push([person, target])
      return Effect.succeed(calls.fails === true ? unavailable : { ok: null })
    }
  })
}) as never
const request = (method: string, headers: Record<string, string> = {}, body?: string) =>
  HttpServerRequest.fromWeb(new Request(origin + Page.ROUTE, { method, headers, ...(body === undefined ? {} : { body }) }))
const person = (id: string): Actor.Actor => ({ subject: { kind: "person", id }, role: "member" })

const answer = (calls: Calls, actor: Actor.Actor | undefined, web: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const response = yield* Page.serve(objects(calls)).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, web),
      Effect.provideService(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.succeed(actor === undefined ? Option.none() : Option.some(actor)) }))
    )
    const out = HttpServerResponse.toWeb(response)
    return { status: out.status, location: out.headers.get("location"), csp: out.headers.get("content-security-policy"), text: yield* Effect.promise(() => out.text()) }
  })
const seeded = Effect.gen(function*() {
  const id = crypto.randomUUID()
  yield* SessionStore.upsertPerson({ id, githubId: Math.floor(Math.random() * 1e9) + 1, login: "ada" })
  return { id, github: (yield* SessionStore.githubIdOf(id))! }
})
const form = { origin, "content-type": "application/x-www-form-urlencoded" }

test("escapes the sites it shows and says when there are none", () => {
  expect(Page.pageHtml(["https://a.test"])).toContain("a.test")
  expect(Page.pageHtml(['https://x.test/"><script>'])).not.toContain("<script>")
  expect(Page.pageHtml([])).toContain("No connections.")
})
run("signed out or as an agent, the page answers Sign in and changes nothing", Effect.gen(function*() {
  const calls: Calls = { revoked: [] }
  const signedOut = yield* answer(calls, undefined, request("GET"))
  const agent = yield* answer(calls, { ...person("x"), act: { kind: "agent", id: "a" } as never }, request("POST", form, "origin=x"))
  expect([signedOut.status, agent.status]).toEqual([401, 401])
  expect(calls.revoked).toEqual([])
}))
run("lists the person's sites under the consent page's policy", Effect.gen(function*() {
  const { id } = yield* seeded
  const page = yield* answer({ revoked: [] }, person(id), request("GET"))
  expect(page.status).toBe(200)
  expect(page.text).toContain("vibelang.smithers.test")
  expect(page.csp).toContain("default-src 'none'")
}))
run("Disconnect revokes that site for the signed-in person and returns to the page", Effect.gen(function*() {
  const { id, github } = yield* seeded
  const calls: Calls = { revoked: [] }
  const page = yield* answer(calls, person(id), request("POST", form, `origin=${encodeURIComponent(site)}`))
  expect(page.status).toBe(303)
  expect(page.location).toBe(Page.ROUTE)
  expect(calls.revoked).toEqual([[github, site]])
}))
run("refuses a cross-site POST before any session is read", Effect.gen(function*() {
  const calls: Calls = { revoked: [] }
  const page = yield* answer(calls, person("x"), request("POST", { origin: "https://evil.test" }, "origin=x"))
  const nullCrossSite = yield* answer(calls, person("x"), request("POST", { origin: "null", "sec-fetch-site": "cross-site" }, "origin=x"))
  expect([page.status, nullCrossSite.status]).toEqual([403, 403])
  expect(calls.revoked).toEqual([])
}))
run("accepts its own form, which a no-referrer page posts with Origin null", Effect.gen(function*() {
  const { id, github } = yield* seeded
  const calls: Calls = { revoked: [] }
  const page = yield* answer(calls, person(id), request("POST", { ...form, origin: "null", "sec-fetch-site": "same-origin" }, `origin=${encodeURIComponent(site)}`))
  expect(page.status).toBe(303)
  expect(calls.revoked).toEqual([[github, site]])
}))
run("says Retry when the connection object is unavailable, and refuses other methods", Effect.gen(function*() {
  const { id } = yield* seeded
  const down = yield* answer({ revoked: [], fails: true }, person(id), request("GET"))
  const posted = yield* answer({ revoked: [], fails: true }, person(id), request("POST", form, "origin=x"))
  const put = yield* answer({ revoked: [] }, person(id), request("PUT"))
  expect([down.status, posted.status, put.status]).toEqual([503, 503, 405])
  expect(down.text).toContain("Retry")
}))
