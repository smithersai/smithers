import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeRemote } from "../repository/remote.ts"
import type { Event } from "../repository/schema.ts"

test("GitHub PR capture validates the recorded source, PR number and exact base/head while allowing a fork head", async t => {
  const head = "b".repeat(40), base = "a".repeat(40)
  const actual = { number: 7, title: "Fix the greeting", body: "Inspect greeting.mjs",
    head: { sha: head, ref: "fix", repo: { full_name: "contributor/fork" } },
    base: { sha: base, ref: "main", repo: { full_name: "original/source" } } }
  let selected = actual
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/repos/local/mirror/repository-source") {
      response.end(JSON.stringify({ source: "github", full_name: "original/source" })); return
    }
    assert.equal(request.url, "/api/repos/local/mirror/github-proxy")
    let text = ""; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    assert.equal(body.method, "GET")
    paths.push(body.path)
    response.end(JSON.stringify(selected))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(makeRemote({ apiBaseUrl: `http://127.0.0.1:${address.port}/api`, repositorySlug: "local/mirror", repositoryId: 1,
    workspaceId: "22222222-2222-4222-8222-222222222222", token: Redacted.make("fixture-token"), gatewayId: "11111111-1111-4111-8111-111111111111", credential: "fixture-gateway" })
    .pipe(Effect.provide(FetchHttpClient.layer)))
  const event: typeof Event.Type = { source: "github", type: "pull_request", action: "opened", issueNumber: 7, deliveryKey: "github:signed-pr",
    payload: { repository: { full_name: "original/source" }, pull_request: actual } }
  const captured = await Effect.runPromise(remote.resolveReview!(event))
  assert.equal(captured.sourceRevision, head)
  assert.deepEqual(paths, ["/repos/original/source/pulls/7"])
  assert.equal((captured.payload as any).pull_request.head.repo.full_name, "contributor/fork")
  await assert.rejects(Effect.runPromise(remote.resolveReview!({ ...event, payload: { repository: { full_name: "other/repo" }, pull_request: actual } })), /different GitHub repository/)
  assert.equal(paths.length, 1, "a foreign event cannot make a source request")
  selected = { ...actual, head: { ...actual.head, sha: "c".repeat(40) } }
  await assert.rejects(Effect.runPromise(remote.resolveReview!(event)), /selected PR changed/)
  selected = { ...actual, number: 8 }
  await assert.rejects(Effect.runPromise(remote.resolveReview!(event)), /no verified repository/)
})
