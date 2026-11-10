import { ConfigProvider, Effect, Redacted } from "effect"
import { HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { GitHub } from "@smthrs/integrations"
import * as Connection from "./GitHubConnection.vibe"

// smithers.sh's delegation route: the person's Durable Object namespace is the injected seam, so a test sees every
// object the route addresses. Addressing an object by name is what creates it.
const origin = "https://smithers.test"
const site = "https://vibelang.smithers.test"
const secret = Redacted.make("s".repeat(32))
const setup = { origin, sites: [{ origin: site, secret, grants: [] }], keyring: { active: "k1", keys: { k1: Redacted.make("k") } } }
const key = "f".repeat(64)
const call = { person: 7, delegation: "d", mode: "perform" as const, key, payload: { kind: "issue.close", repository: "o/r", number: 1 } }

const answer = (body: string, options: { readonly person?: string; readonly setup?: Connection.Setup | undefined; readonly fails?: boolean } = {}) =>
  Effect.gen(function*() {
    const addressed: Array<string> = []
    const objects = {
      getByName: (name: string) => {
        addressed.push(name)
        return { fetch: () => options.fails === true ? Effect.die("object down") : Effect.succeed(HttpServerResponse.jsonUnsafe({ reached: name })) }
      }
    } as never
    const url = origin + GitHub.Delegation.ROUTE + "?person=" + (options.person ?? "7")
    const web = yield* HttpClientRequest.toWeb(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(body, "application/json")))
    const response = yield* Connection.route(objects, "setup" in options ? options.setup : setup).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(web))
    ) as Effect.Effect<HttpServerResponse.HttpServerResponse>
    return { status: response.status, text: yield* Effect.promise(() => HttpServerResponse.toWeb(response).text()), addressed }
  })
const run = (name: string, body: Effect.Effect<void, unknown>) => test(name, () => Effect.runPromise(body))
const signer = (options: { readonly origin?: string; readonly secret?: Redacted.Redacted<string> } = {}) =>
  GitHub.Delegation.signer({ origin: options.origin ?? site, brokerOrigin: origin, secret: options.secret ?? secret })

run("a call its site signed for that person reaches that person's object", Effect.gen(function*() {
  const signed = yield* (yield* signer()).envelope(call)
  const reached = yield* answer(JSON.stringify(signed))
  expect(reached).toEqual({ status: 200, text: JSON.stringify({ reached: "person:7" }), addressed: ["person:7"] })
}))
run("an unsigned, wrongly signed or misaddressed call creates no object", Effect.gen(function*() {
  const signed = yield* (yield* signer()).envelope(call)
  const answers = [
    yield* answer(JSON.stringify({ origin: site, person: 7, request: "", payload: "{}" })),
    yield* answer(JSON.stringify(yield* (yield* signer({ secret: Redacted.make("x".repeat(32)) })).envelope(call))),
    yield* answer(JSON.stringify(yield* (yield* signer({ origin: "https://evil.test" })).envelope(call))),
    yield* answer(JSON.stringify(signed), { person: "8" }),
    yield* answer("not json")
  ]
  for (const refused of answers) expect(refused).toEqual({ status: 403, text: JSON.stringify({ reason: "forbidden" }), addressed: [] })
}))
run("with connections unconfigured, or the object down, the call is unavailable", Effect.gen(function*() {
  const signed = JSON.stringify(yield* (yield* signer()).envelope(call))
  const off = yield* answer(signed, { setup: undefined })
  const down = yield* answer(signed, { fails: true })
  expect([off.status, off.addressed]).toEqual([503, []])
  expect([down.status, down.text]).toEqual([503, JSON.stringify({ reason: "unavailable" })])
}))

// The registry loads only when every grant passes `DelegationPolicy.validGrant`: a prefix one keystroke from opening
// every branch, path or label disables connections instead.
const configuredWith = (grants: unknown) =>
  Effect.runPromise(Connection.configured().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
    HOSTED_AUTH_SITES: JSON.stringify([{ origin: site, secret: "s".repeat(32), grants }]),
    AUTH_BROKER_ORIGIN: origin,
    GITHUB_CONNECTION_KEYS: JSON.stringify({ k1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }),
    GITHUB_CONNECTION_KEY_ACTIVE: "k1"
  })))))
const grant = { repository: "smithersai/vibelang", repositoryId: 11, scopes: ["issues"], paths: ["docs/design/vips/"], branchPrefix: "vibelang/", labelPrefix: "vibelang:" }
test("a registry with a valid grant loads; an empty or slash-less prefix disables connections", async () => {
  expect((await configuredWith([grant]))?.sites[0]?.grants).toEqual([grant])
  for (const change of [{ branchPrefix: "" }, { paths: ["docs"] }, { labelPrefix: "" }, { paths: [] }]) {
    expect(await configuredWith([{ ...grant, ...change }]), JSON.stringify(change)).toBeUndefined()
  }
})
