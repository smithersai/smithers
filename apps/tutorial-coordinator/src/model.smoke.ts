import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Stream } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { modelSeats, modelSettings } from "./model"
import { prepareSubscription } from "./subscription"

const directory = await mkdtemp(join(tmpdir(), "tutorial-subscription-"))
const authFile = join(directory, "auth.json")
const jwt = (exp: number) => `test.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
const fresh = jwt(Math.floor(Date.now() / 1000) + 3600)
let refreshes = 0, generations = 0
const executor = RequestExecutor.RequestExecutor.of({ execute: (request) => {
  if (request.url === "https://auth.openai.com/oauth/token") {
    refreshes++
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ access_token: fresh, refresh_token: "rotated-refresh", expires_in: 3600 })))
  }
  generations++
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses")
  assert.equal(request.headers.authorization, `Bearer ${fresh}`)
  assert.equal(request.headers["chatgpt-account-id"], "test-account")
  assert.equal(request.body._tag, "Uint8Array")
  if (request.body._tag !== "Uint8Array") throw Error("Expected JSON body")
  const body = JSON.parse(new TextDecoder().decode(request.body.body))
  assert.equal(body.model, "gpt-5.6-luna")
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.max_output_tokens, undefined)
  assert(!JSON.stringify(body).includes("ignored-api-key"))
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('data: {"type":"response.completed","response":{"id":"test","status":"completed","output":[]}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })))
} })
try {
  await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(1), refresh_token: "initial-refresh", account_id: "test-account" } }), { mode: 0o600 })
  const settings = modelSettings({ TUTORIAL_CHATGPT_AUTH_FILE: authFile, OPENAI_API_KEY: "ignored-api-key" })
  assert.deepEqual(settings, { provider: "chatgpt", modelId: "gpt-5.6-luna", authFile })
  assert.throws(() => modelSettings({ OPENAI_API_KEY: "ignored-api-key" }), /TUTORIAL_CHATGPT_AUTH_FILE/)
  const request = ModelRequest.ModelRequest.make({ modelId: settings.modelId, system: [], messages: [], tools: [], params: ModelRequest.GenerationParams.make() })
  const execute = () => Effect.runPromise(Effect.gen(function*() {
    const resolver = yield* modelSeats(settings)
    const seat = yield* resolver.resolve("tutorial/model")
    const prepared = yield* seat.route!.prepare(request)
    assert(!JSON.stringify(prepared).includes("test-account"))
    assert(!JSON.stringify(prepared).includes(fresh))
    yield* seat.model.stream(request).pipe(Stream.runDrain)
  }).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor)))
  await Promise.all([execute(), execute()])
  assert.equal(refreshes, 1, "concurrent runs must share one refresh")
  assert.equal(generations, 2)
  assert.equal(JSON.parse(await readFile(authFile, "utf8")).tokens.refresh_token, "rotated-refresh")
  const bootstrapFile = join(directory, "bootstrap.json")
  await writeFile(bootstrapFile, JSON.stringify({ tokens: { access_token: "older-access", refresh_token: "older-refresh" } }))
  await prepareSubscription(authFile, bootstrapFile)
  assert.equal(JSON.parse(await readFile(authFile, "utf8")).tokens.refresh_token, "rotated-refresh", "redeploy must not restore a stale bootstrap token")
  const seeded = join(directory, "seeded", "auth.json")
  await prepareSubscription(seeded, bootstrapFile)
  assert.equal(JSON.parse(await readFile(seeded, "utf8")).tokens.refresh_token, "older-refresh")
  await assert.rejects(prepareSubscription(join(directory, "missing.json")), /bootstrap login/)
  await execute()
  assert.equal(refreshes, 1, "subsequent runs must retain rotated credentials")
  console.log("Subscription route passed: Luna, no API-key fallback, one concurrent refresh, durable rotation, credential-free sealed request")
} finally { await rm(directory, { recursive: true, force: true }) }
