/**
 * Exploit regressions for issue #4655: a `model:call` grant for one model must
 * not authorize another model, another endpoint, or another store.
 *
 * Every test runs the real guarded layer over a real `GrantStore` holding the
 * rules it names; the host client below the guard only records what reached it.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { type PermissionErrorPayload, Rule } from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Option, Redacted, type Scope, Stream } from "effect"
import * as HttpBody from "effect/http/HttpBody"
import * as EffectHttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as GrantStore from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Workspace from "../src/Workspace.ts"

const haiku = "claude-haiku-4-5"
const opus = "claude-opus-4-5"
const messages = "https://api.anthropic.com/v1/messages"

const allow = (action: Capability.Capability["action"], resource: string): Rule =>
  new Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action, resource }) })

/** An unattended store, so a request outside the rules fails instead of waiting for an answer. */
const storeWith = (...rules: ReadonlyArray<Rule>) =>
  GrantStore.make({ attended: false, rules }).pipe(Effect.provide(Workspace.layer("/workspace")))

const haikuOnly = storeWith(allow("model:call", `api.anthropic.com/${haiku}`))

const json = (value: unknown): HttpBody.HttpBody => HttpBody.text(JSON.stringify(value), "application/json")

const text = (value: string): HttpBody.HttpBody => HttpBody.text(value, "application/json")

const post = (url: string, body?: HttpBody.HttpBody): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(url, body === undefined ? {} : { body })

interface Sent {
  readonly method: string
  readonly url: string
}

const recording = (sent: Array<Sent>): EffectHttpClient.HttpClient =>
  EffectHttpClient.make((request) =>
    Effect.sync(() => {
      sent.push({ method: request.method, url: request.url })
      return { status: 200, headers: {}, request } as HttpClientResponse.HttpClientResponse
    })
  )

const guarded = (
  store: GrantStore.Service,
  sent: Array<Sent>,
  layer: typeof HttpClient.layer = HttpClient.layer
): Layer.Layer<EffectHttpClient.HttpClient> =>
  layer.pipe(
    Layer.provide(Layer.succeed(EffectHttpClient.HttpClient)(recording(sent))),
    Layer.provide(Layer.succeed(GrantStore.GrantStore)(store))
  )

/** Sends `request` through the guard and answers the capability it was refused for, if it was refused. */
const refusal = (
  request: HttpClientRequest.HttpClientRequest,
  mark: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  layer: Layer.Layer<EffectHttpClient.HttpClient>
): Effect.Effect<Option.Option<PermissionErrorPayload>> =>
  Effect.gen(function*() {
    const client = yield* EffectHttpClient.HttpClient
    return yield* client.execute(request).pipe(
      mark,
      Effect.match({
        onFailure: (error) => HttpClient.fromHttpClientError(error),
        onSuccess: () => Option.none()
      })
    )
  }).pipe(Effect.provide(layer))

const refused = (action: string, resource: string) =>
  Option.some(expect.objectContaining({ capability: expect.objectContaining({ action, resource }) }))

const scenario = <E>(name: string, body: Effect.Effect<void, E, Scope.Scope>) =>
  it.effect(name, () => Effect.scoped(body))

describe("HttpClient model-call admission (#4655)", () => {
  scenario(
    "admits the granted model when the request body asks for that model",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const layer = guarded(yield* haikuOnly, sent)

      expect(yield* refusal(post(messages, json({ model: haiku })), HttpClient.withModelCall(haiku), layer))
        .toEqual(Option.none())
      expect(sent).toEqual([{ method: "POST", url: messages }])
    })
  )

  scenario(
    "does not let a Haiku grant send a body that asks for Opus",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const layer = guarded(yield* haikuOnly, sent)

      // The exploit from the issue: claim the granted model, send another one.
      expect(yield* refusal(post(messages, json({ model: opus })), HttpClient.withModelCall(haiku), layer))
        .toEqual(refused("net:post", "api.anthropic.com"))
      // Claiming the model the body names asks for the grant that model needs.
      expect(yield* refusal(post(messages, json({ model: opus })), HttpClient.withModelCall(opus), layer))
        .toEqual(refused("model:call", `api.anthropic.com/${opus}`))
      expect(sent).toEqual([])
    })
  )

  scenario(
    "does not let a Haiku grant reach an endpoint whose request names no model",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const layer = guarded(yield* haikuOnly, sent)
      const claim = HttpClient.withModelCall(haiku)
      const host = "https://api.anthropic.com"

      const attempts: ReadonlyArray<readonly [HttpClientRequest.HttpClientRequest, string]> = [
        [HttpClientRequest.get(`${host}/v1/organizations/api_keys`), "net:get"],
        [HttpClientRequest.make("DELETE")(`${host}/v1/files/file_1`), "net:post"],
        [post(`${host}/v1/organizations/invites`), "net:post"],
        [post(`${host}/v1/organizations/invites`, json({ email: "a@b.test", role: "admin" })), "net:post"],
        [HttpClientRequest.put(`${host}/v1/messages`, { body: json({ model: haiku }) }), "net:post"],
        // A batch names its models below the top level, where the claim cannot vouch for them.
        [post(`${host}/v1/messages/batches`, json({ requests: [{ params: { model: opus } }] })), "net:post"],
        [post(messages, json([{ model: haiku }])), "net:post"],
        [post(messages, json(haiku)), "net:post"],
        [post(messages, json({ model: 7 })), "net:post"],
        [post(messages, text(`{"model":"${haiku}"`)), "net:post"],
        [post(messages, HttpBody.uint8Array(new Uint8Array([0xff, 0xfe]), "application/json")), "net:post"],
        [post(messages, HttpBody.stream(Stream.empty, "application/json")), "net:post"]
      ]
      for (const [request, action] of attempts) {
        expect(yield* refusal(request, claim, layer)).toEqual(refused(action, "api.anthropic.com"))
      }
      expect(sent).toEqual([])
    })
  )

  scenario(
    "refuses a body that spells the model twice, whichever spelling a parser would keep",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const layer = guarded(yield* haikuOnly, sent)
      const claim = HttpClient.withModelCall(haiku)

      const smuggled = [
        `{"model":"${opus}","model":"${haiku}"}`,
        `{"model":"${haiku}","model":"${opus}"}`,
        `{"\\u006dodel":"${opus}", "model" : "${haiku}"}`
      ]
      for (const body of smuggled) {
        expect(yield* refusal(post(messages, text(body)), claim, layer))
          .toEqual(refused("net:post", "api.anthropic.com"))
      }
      // The same word below the top level, or as a value, is not a second spelling.
      const honest = `{"metadata":{"model":"${opus}"},"tags":["model",{"model":1}],"note":"model","model":"${haiku}"}`
      expect(yield* refusal(post(messages, text(honest)), claim, layer)).toEqual(Option.none())
      expect(sent).toEqual([{ method: "POST", url: messages }])
    })
  )

  scenario(
    "lets a transport read the caller's model id from the ModelCall reference",
    Effect.gen(function*() {
      expect(yield* HttpClient.ModelCall).toBeUndefined()
      const read = Effect.gen(function*() {
        return yield* HttpClient.ModelCall
      })
      expect(yield* read.pipe(HttpClient.withModelCall(haiku))).toBe(haiku)
    })
  )

  scenario(
    "checks a forged ModelCall reference as plain network access",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const layer = guarded(yield* haikuOnly, sent)
      const request = post(messages, json({ model: haiku }))

      // The public reference, set by hand instead of through `withModelCall`.
      const bare = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, HttpClient.ModelCall, haiku)
      expect(yield* refusal(request, bare, layer)).toEqual(refused("net:post", "api.anthropic.com"))

      // A second reference with the private claim's key, carrying a look-alike claim.
      const Forged = Context.Reference<{ readonly modelId: string } | undefined>(
        "@smthrs/kernel/HttpClient/ModelClaim",
        { defaultValue: () => undefined }
      )
      const forged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Forged, Object.freeze({ modelId: haiku }))
      expect(yield* refusal(request, forged, layer)).toEqual(refused("net:post", "api.anthropic.com"))
      expect(sent).toEqual([])
    })
  )

  scenario(
    "checks a model call as net:post when the caller holds only that grant",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const layer = guarded(yield* storeWith(allow("net:post", "api.anthropic.com")), sent)
      const identity = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect

      expect(yield* refusal(post(messages, json({ model: opus })), identity, layer)).toEqual(Option.none())
      expect(yield* refusal(post(messages, json({ model: opus })), HttpClient.withModelCall(opus), layer))
        .toEqual(refused("model:call", `api.anthropic.com/${opus}`))
      expect(sent).toEqual([{ method: "POST", url: messages }])
    })
  )

  scenario(
    "does not replay a claim on another store",
    Effect.gen(function*() {
      const sentGranted: Array<Sent> = []
      const sentOther: Array<Sent> = []
      const granted = guarded(yield* haikuOnly, sentGranted)
      const other = guarded(yield* storeWith(), sentOther)
      const claim = HttpClient.withModelCall(haiku)
      const request = post(messages, json({ model: haiku }))

      // One claim wraps a call on each store. The first store's grant does not follow it.
      const both = Effect.all([
        refusal(request, (effect) => effect, granted),
        refusal(request, (effect) => effect, other)
      ])
      expect(yield* claim(both)).toEqual([Option.none(), refused("model:call", `api.anthropic.com/${haiku}`)])
      expect(sentGranted).toEqual([{ method: "POST", url: messages }])
      expect(sentOther).toEqual([])
    })
  )

  scenario(
    "does not replay a preflight admission on a model call, another store, or a forged reference",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const store = yield* storeWith(allow("net:get", "api.anthropic.com"), allow("model:call", `evil.test/${haiku}`))
      const layer = guarded(store, sent)
      const admitted = HttpClientRequest.get("https://api.anthropic.com/v1/models")

      // Preflight authorizes net:* only: a model claim around it earns no model:call admission.
      const viaPreflight = HttpClient.authorizePreflight(
        admitted,
        refusal(post(messages, json({ model: haiku })), HttpClient.withModelCall(haiku), layer)
      ).pipe(Effect.provideService(GrantStore.GrantStore, store))
      expect(yield* viaPreflight).toEqual(refused("model:call", `api.anthropic.com/${haiku}`))

      // A hand-made admission under the private key names the right store and capability, and is ignored.
      const Forged = Context.Reference<unknown>("@smthrs/kernel/HttpClient/Admission", {
        defaultValue: () => undefined
      })
      const capability = Capability.make("net:post", "api.anthropic.com")
      const forged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Forged, { store, capability, consumed: false })
      expect(yield* refusal(post(messages), forged, layer)).toEqual(refused("net:post", "api.anthropic.com"))
      expect(sent).toEqual([])
    })
  )

  scenario(
    "pins model calls to the exact endpoints a host lists",
    Effect.gen(function*() {
      const sent: Array<Sent> = []
      const gateway = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
      const store = yield* storeWith(
        allow("model:call", `api.anthropic.com/${haiku}`),
        allow("model:call", `ai-gateway.vercel.sh/${haiku}`)
      )
      const layer = guarded(
        store,
        sent,
        HttpClient.layerWith({
          modelIdentity: HttpClient.modelEndpoints([
            { url: messages },
            { url: gateway, identity: HttpClient.headerModel("AI-Model-Id") }
          ])
        })
      )
      const claim = HttpClient.withModelCall(haiku)
      const lenient = json({ model: haiku, requests: [{ params: { model: opus } }] })

      // The listed endpoints, each read its own way.
      expect(yield* refusal(post(messages, json({ model: haiku })), claim, layer)).toEqual(Option.none())
      const judged = post(gateway, json({ state: {} })).pipe(HttpClientRequest.setHeader("ai-model-id", haiku))
      expect(yield* refusal(judged, claim, layer)).toEqual(Option.none())

      // Another endpoint that tolerates a top-level `model` is not a model endpoint.
      expect(yield* refusal(post("https://api.anthropic.com/v1/messages/batches", lenient), claim, layer))
        .toEqual(refused("net:post", "api.anthropic.com"))
      // Neither is the listed path with a query, a plain or redacted parameter, or an unparsable URL.
      const withQuery = [
        post(`${messages}?beta=true`, json({ model: haiku })),
        post(messages, json({ model: haiku })).pipe(HttpClientRequest.setUrlParam("beta", "true")),
        post(messages, json({ model: haiku })).pipe(
          HttpClientRequest.setUrlParams([["key", Redacted.make("secret")]] as never)
        )
      ]
      for (const request of withQuery) {
        expect(yield* refusal(request, claim, layer)).toEqual(refused("net:post", "api.anthropic.com"))
      }
      expect(yield* refusal(post("not a url", json({ model: haiku })), claim, layer))
        .toEqual(refused("net:post", "not a url"))
      // The header protocol is read only at its own endpoint, and only on POST.
      const headerOnMessages = post(messages, json({ model: opus })).pipe(
        HttpClientRequest.setHeader("ai-model-id", haiku)
      )
      expect(yield* refusal(headerOnMessages, claim, layer)).toEqual(refused("net:post", "api.anthropic.com"))
      const wrongHeader = post(gateway, json({ model: haiku })).pipe(HttpClientRequest.setHeader("ai-model-id", opus))
      expect(yield* refusal(wrongHeader, claim, layer)).toEqual(refused("net:post", "ai-gateway.vercel.sh"))
      expect(
        HttpClient.headerModel("ai-model-id")(HttpClientRequest.get(gateway, { headers: { "ai-model-id": haiku } }))
      )
        .toBeUndefined()

      expect(sent).toEqual([{ method: "POST", url: messages }, { method: "POST", url: gateway }])
      expect(() => HttpClient.modelEndpoints([{ url: "/v1/messages" }])).toThrow(
        "a model endpoint needs an absolute, parseable URL"
      )
    })
  )
})
