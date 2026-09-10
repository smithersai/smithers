import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { Effect, Exit, ManagedRuntime, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { make, type Options } from "../coding/landing.ts"
import type { AppendObservation, AppendPreparation, QueuedAppend } from "../coding/landing-schema.ts"

const options: Options = { apiBaseUrl: "https://api.example.test/api", repositorySlug: "owner/repo", repositoryId: 42,
  workspaceId: "11111111-1111-4111-a111-111111111111", token: Redacted.make("fixture-private-token") }
const requestId = "22222222-2222-4222-a222-222222222222"
const preparation: AppendPreparation = { status: "prepared", target_bookmark: "main", expected_commit_id: "a".repeat(40),
  source_commit_id: "b".repeat(40), source_base_commit_id: "c".repeat(40),
  changes: [{ change_id: "k".repeat(32), commit_id: "d".repeat(40) }, { change_id: "l".repeat(32), commit_id: "b".repeat(40) }] }
const description = "✨ feat: finalize the validated request"
const landing = { request_id: requestId, number: 7, target_bookmark: "main", change_ids: preparation.changes.map(change => change.change_id), agent_authored: true }
const queued: QueuedAppend = { requestId, number: 7, taskId: 12, preparation,
  request: { commit_id: preparation.source_commit_id, expected_commit_id: preparation.expected_commit_id,
    source_base_commit_id: preparation.source_base_commit_id, description } }
const observation: AppendObservation = { status: "landed", task_id: 12, request: {
  change_ids: landing.change_ids, target_bookmark: "main", expected_commit_id: preparation.expected_commit_id,
  operation_key: "existing-native-operation", append: { source_commit_id: preparation.source_commit_id,
    source_base_commit_id: preparation.source_base_commit_id, description }
}, result: { landed_count: 2, target_bookmark: "main", target_commit_id: "e".repeat(40) } }
const body = (request: HttpClientRequest.HttpClientRequest) => request.body._tag === "Uint8Array"
  ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
const configured = async (handle: (request: HttpClientRequest.HttpClientRequest, call: number) => Response) => {
  const calls: HttpClientRequest.HttpClientRequest[] = []
  const client = HttpClient.make(request => Effect.sync(() => {
    calls.push(request)
    return HttpClientResponse.fromWeb(request, handle(request, calls.length))
  }))
  const service = await Effect.runPromise(make(options).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  return { service, calls }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

test("landing client uses native prepare, replay-safe creation, exact queue and immutable result", async () => {
  const { service, calls } = await configured((request, call) => {
    assert.equal(request.headers.authorization, "Bearer fixture-private-token")
    if (call === 1) return json({ items: [{ name: "main", target_change_id: "remote", target_commit_id: "0".repeat(40), is_tracking_remote: true }], next_cursor: "opaque+next" })
    if (call === 2) {
      assert.ok(request.urlParams.params.some(([key, value]) => key === "cursor" && value === "opaque+next"))
      return json({ items: [{ name: "main", target_change_id: "native", target_commit_id: preparation.expected_commit_id, is_tracking_remote: false }], next_cursor: "" })
    }
    if (request.url.endsWith("/append/prepare")) return json(preparation)
    if (request.url.includes("/requests/")) return json(landing, 201)
    if (request.method === "PUT") return json({ ...landing, task_id: 12 }, 202)
    return json(observation)
  })
  assert.equal(await Effect.runPromise(service.readMain), preparation.expected_commit_id)
  assert.deepEqual(await Effect.runPromise(service.prepare(preparation)), preparation)
  const identity = await Effect.runPromise(service.create(requestId, preparation, description))
  assert.deepEqual(await Effect.runPromise(service.create(requestId, preparation, description)), identity)
  assert.equal(calls[3]!.url, calls[4]!.url)
  assert.deepEqual(body(calls[3]!), body(calls[4]!))
  assert.deepEqual(body(calls[3]!), { title: description, body: description, target_bookmark: "main", change_ids: landing.change_ids })
  assert.deepEqual(await Effect.runPromise(service.queue(identity, preparation, queued.request)), queued)
  assert.deepEqual(await Effect.runPromise(service.observe(queued)), observation)
  assert.equal(calls.length, 7, "native append receipt is sufficient after main moves; do not reread current main")
})

for (const mode of ["missing", "duplicate", "invalid", "cycle", "empty-next"] as const) {
  test(`main observation refuses ${mode}`, async () => {
    const bookmark = { name: "main", target_change_id: "native", target_commit_id: mode === "invalid" ? "short" : preparation.expected_commit_id, is_tracking_remote: false }
    const { service } = await configured(() => json({ items: mode === "missing" || mode === "empty-next" ? [] : mode === "duplicate" ? [bookmark, bookmark] : [bookmark],
      next_cursor: mode === "cycle" || mode === "empty-next" ? "same" : "" }))
    await assert.rejects(Effect.runPromise(service.readMain), /unambiguous|incomplete|cyclic/)
  })
}
for (const mode of ["source", "base", "main", "duplicate-change", "duplicate-commit", "last", "old-route"] as const) {
  test(`native preparation refuses ${mode}`, async () => {
    const reply = structuredClone(preparation)
    if (mode === "source") Object.assign(reply, { source_commit_id: "f".repeat(40) })
    if (mode === "base") Object.assign(reply, { source_base_commit_id: "f".repeat(40) })
    if (mode === "main") Object.assign(reply, { expected_commit_id: "f".repeat(40) })
    if (mode === "duplicate-change") Object.assign(reply.changes[0]!, { change_id: reply.changes[1]!.change_id })
    if (mode === "duplicate-commit") Object.assign(reply.changes[0]!, { commit_id: reply.changes[1]!.commit_id })
    if (mode === "last") Object.assign(reply.changes[1]!, { commit_id: "f".repeat(40) })
    const { service, calls } = await configured(() => mode === "old-route" ? json({}, 404) : json(reply))
    await assert.rejects(Effect.runPromise(service.prepare(preparation)))
    assert.equal(calls.length, 1)
  })
}
for (const mode of ["missing-identity", "other-request", "other-stack", "human", "oversized-summary"] as const) {
  test(`landing creation refuses ${mode}`, async () => {
    const reply: Record<string, unknown> = { ...landing }
    if (mode === "missing-identity") delete reply.request_id
    if (mode === "other-request") reply.request_id = options.workspaceId
    if (mode === "other-stack") reply.change_ids = ["m".repeat(32)]
    if (mode === "human") reply.agent_authored = false
    const { service, calls } = await configured(() => json(reply, 201))
    await assert.rejects(Effect.runPromise(service.create(requestId, preparation, mode === "oversized-summary" ? "界".repeat(11_000) : description)))
    assert.equal(calls.length, mode === "oversized-summary" ? 0 : 1)
  })
}
for (const mode of ["task", "source", "base", "main", "description", "count", "stack", "pending-result", "missing-result"] as const) {
  test(`append observation refuses ${mode}`, async () => {
    const reply = structuredClone(observation)
    if (mode === "task") Object.assign(reply, { task_id: 99 })
    if (mode === "source") Object.assign(reply.request.append, { source_commit_id: "f".repeat(40) })
    if (mode === "base") Object.assign(reply.request.append, { source_base_commit_id: "f".repeat(40) })
    if (mode === "main") Object.assign(reply.request, { expected_commit_id: "f".repeat(40) })
    if (mode === "description") Object.assign(reply.request.append, { description: "another request" })
    if (mode === "stack") Object.assign(reply.request, { change_ids: [...reply.request.change_ids].reverse() })
    if (mode === "count") Object.assign(reply.result, { landed_count: 1 })
    if (mode === "pending-result") Object.assign(reply, { status: "pending" })
    if (mode === "missing-result") Reflect.deleteProperty(reply, "result")
    const { service } = await configured(() => json(reply))
    await assert.rejects(Effect.runPromise(service.observe(queued)))
  })
}
for (const status of ["pending", "running", "failed"] as const) {
  test(`append observation preserves ${status} without inventing a result`, async () => {
    const reply = { status, task_id: 12, request: observation.request }
    const { service } = await configured(() => json(reply))
    assert.deepEqual(await Effect.runPromise(service.observe(queued)), reply)
  })
}
test("queue refuses changed input before any request", async () => {
  const { service, calls } = await configured(() => { throw new Error("unexpected write") })
  await assert.rejects(Effect.runPromise(service.queue(queued, preparation, { ...queued.request, expected_commit_id: "f".repeat(40) })))
  assert.equal(calls.length, 0)
})
for (const mode of ["status", "bad-json", "large-declared", "large-stream", "defect"] as const) {
  test(`landing HTTP boundary refuses ${mode} without leaking credential/body`, async () => {
    const { service } = await configured(() => {
      if (mode === "status") return json({ diagnostic: "fixture-private-token" }, 503)
      if (mode === "bad-json") return new Response("fixture-private-token")
      if (mode === "large-declared") return new Response("fixture-private-token", { headers: { "content-length": "3000000" } })
      if (mode === "large-stream") return new Response("x".repeat(2 * 1024 * 1024 + 1))
      throw new Error("fixture-private-token")
    })
    await assert.rejects(Effect.runPromise(service.observe(queued)), error => {
      assert.ok(error instanceof Error)
      assert.ok(!String(error).includes("fixture-private-token"))
      return true
    })
  })
}
test("actual selected Node/Bun HTTP transport refuses redirects and replays lost creation ACK", async t => {
  let redirected = 0, attempts = 0
  const writes: string[] = []
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/bookmarks?limit=100")) { response.writeHead(302, { location: "/redirect-target" }); response.end(); return }
    if (request.url === "/redirect-target") { redirected++; response.end("{}"); return }
    let input = ""
    for await (const chunk of request) input += chunk
    writes.push(input); attempts++
    if (attempts === 1) { request.socket.destroy(); return }
    response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify(landing))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  // Bun's node:http reports ERR_SERVER_NOT_RUNNING after closeAllConnections; either way the port is released.
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const platform = "Bun" in globalThis ? (await import("@effect/platform-bun/BunHttpClient")).layer
    : (await import("@effect/platform-node/NodeHttpClient")).layerUndici
  const runtime = ManagedRuntime.make(platform)
  t.after(() => runtime.dispose())
  const service = await runtime.runPromise(make({ ...options, apiBaseUrl: `http://127.0.0.1:${address.port}/api` }))
  await assert.rejects(runtime.runPromise(service.readMain), /HTTP 302/)
  assert.equal(redirected, 0)
  // Undici surfaces the reset; Bun retries once on a reused keep-alive connection.
  // Either way the identical immutable body reaches the server exactly twice.
  const first = await runtime.runPromiseExit(service.create(requestId, preparation, description))
  const identity = Exit.isFailure(first) ? await runtime.runPromise(service.create(requestId, preparation, description)) : first.value
  assert.deepEqual(identity, { requestId, number: 7 })
  assert.equal(attempts, 2)
  assert.equal(writes[0], writes[1], "ambiguous transport outcome retries the original immutable create body")
})
