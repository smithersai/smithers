import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test, type TestContext } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { NativeCoding } from "../coding/native.ts"
import { activationLayers, Register } from "../repository/activation.ts"
import { makeRemote, RepositoryRemote } from "../repository/remote.ts"
import { Draft, SetupInput } from "../repository/schema.ts"

const source = "a".repeat(40), gateway = "11111111-1111-4111-8111-111111111111"
const workspace = "22222222-2222-4222-8222-222222222222"
/** The draft the canary pinned: the only required check is a command, so the
 * feature step's landing path exists and the draft has to pass a live trial. */
const candidate = (revision: number) => {
  const initial = initialSetup("codeplanesmithers/canary-sandbox", "feature", "maintainer")
  const draft = { ...initial.draft, landing: "checks" as const, revision,
    steps: initial.draft.steps.map(step => ({ ...step, mode: "approved" as const })),
    checks: [{ id: "docs-only-scope", name: "Docs only", kind: "ai" as const, policy: "report" as const,
      paths: ["docs/**"], rule: "Only documentation changes belong in this scope." },
      { id: "5ebc63b3-8e2e-4faf-8d84-0522c838c910", name: "Hello file", kind: "command" as const,
        policy: "required" as const, paths: ["docs/nested/hello.txt"], rule: "test -f docs/nested/hello.txt" }] }
  const setup = { ...initial, revision, draft }
  return { ...setup, digest: setupCandidate(setup) }
}
const setupInput = (requestId: string, revision = 11): SetupInput => {
  const setup = candidate(revision)
  return { requestId, repo: setup.repo, job: "feature", operation: "trial", revision,
    digest: setup.digest, draft: setup.draft as typeof Draft.Type, workspaceId: workspace }
}

/** Plue's own two rules, and nothing else: a trial request is idempotent per
 * (repository, job, request id) — `internal/services/repository_job_trial.go`
 * — and `db/queries/repository_jobs.sql` re-registers one `(repository, job,
 * mode)` row only at a higher revision, or at the same revision when the whole
 * stored configuration is identical. */
const plue = async (t: TestContext) => {
  const issues: number[] = [], registrations: string[] = []
  const trials = new Map<string, { number: number; revision: number; digest: string; title: string; body: string }>()
  const rows = new Map<string, { revision: number; configuration: string }>()
  const refuse = (response: import("node:http").ServerResponse, message: string) => {
    response.statusCode = 409
    response.end(JSON.stringify({ code: "CONFLICT", fault: "user", message }))
  }
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    let text = ""; for await (const chunk of request) text += chunk
    const body = JSON.parse(text || "{}")
    const trial = /^\/api\/gateways\/([^/]+)\/repository-jobs\/([^/]+)\/trials\/([^/]+)$/.exec(decodeURIComponent(request.url ?? ""))
    if (trial) {
      const existing = trials.get(trial[3]!)
      if (existing && (existing.revision !== body.revision || existing.digest !== body.digest ||
        existing.title !== body.title || existing.body !== body.body)) {
        refuse(response, "trial request already belongs to a different candidate"); return
      }
      const number = existing?.number ?? trials.size + 60
      if (!existing) { issues.push(number); trials.set(trial[3]!, { number, revision: body.revision, digest: body.digest, title: body.title, body: body.body }) }
      response.end(JSON.stringify({ request_id: trial[3], source: "smithers-cloud", number, issue_id: number,
        api_path: `/repos/${body.repo}/issues/${number}` }))
      return
    }
    const registration = /^\/api\/gateways\/([^/]+)\/repository-jobs\/([^/]+)$/.exec(request.url ?? "")
    assert(registration, `unexpected request ${request.url}`)
    const key = `${registration[2]}:${body.mode}`, stored = rows.get(key), configuration = JSON.stringify(body)
    if (stored && !(stored.revision < body.revision || (stored.revision === body.revision && stored.configuration === configuration))) {
      refuse(response, "registration was paused, replaced, or changed; apply a newer reviewed revision"); return
    }
    rows.set(key, { revision: body.revision, configuration })
    registrations.push(configuration)
    response.end(JSON.stringify({ registration_id: "registration-1", revision: body.revision, digest: body.digest,
      source_revision: body.source_revision, mode: body.mode, enabled: true }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(makeRemote({ apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
    repositorySlug: "codeplanesmithers/canary-sandbox", repositoryId: 3, workspaceId: workspace,
    token: Redacted.make("fixture-token"), gatewayId: gateway, credential: "fixture-gateway" })
    .pipe(Effect.provide(FetchHttpClient.layer)))
  return { remote, issues, registrations, rows }
}

/** The real Register action, its real HTTP remote, and stubs only for the
 * services a registration reads but does not decide with. */
const pressTest = (remote: Parameters<typeof RepositoryRemote.of>[0], input: SetupInput) => Effect.gen(function*() {
  const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
  const runtime = { register: (declared: { _tag: string }, action: unknown) => Effect.sync(() => handlers.set(declared._tag, action as never)),
    execute: () => Effect.succeed(undefined) }
  const services = Layer.mergeAll(
    Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
    Layer.succeed(RepositoryRemote, remote),
    Layer.succeed(Jj.Jj, { snapshot: () => Effect.void } as never),
    Layer.succeed(NativeCoding, { read: () => Effect.succeed({ head: { kind: "resolved", commitId: source } }) } as never),
    Layer.succeed(ControlRuntime, { plan: (planned: { flowId: string }) => Effect.succeed({ card: { flowId: planned.flowId,
      executionDigest: "c".repeat(64), envelope: { budget: { milliseconds: 600_000, tokens: 100_000 } } } }) } as never),
    Layer.succeed(SqlClient.SqlClient, undefined as never),
    Layer.succeed(RunStore.RunStore, undefined as never),
    Layer.succeed(DurableEngineState.DurableEngineState, undefined as never),
    Action.layerImplementations,
    FetchHttpClient.layer
  )
  yield* Layer.build(activationLayers.pipe(Layer.provide(services)))
  const handler = handlers.get("repository/register-candidate")
  if (!handler) return yield* Effect.die("repository/register-candidate has no implementation")
  return yield* handler(Schema.decodeUnknownSync(Register.payloadSchema)({ input, mode: "trial", deadlineAt: Date.now() + 600_000 }))
    .execute.pipe(Effect.provide(services), Effect.result)
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

const failure = (outcome: { _tag: string; failure?: unknown }) =>
  outcome._tag === "Failure" ? String((outcome.failure as { message?: unknown }).message) : ""
const issue = (outcome: { _tag: string; success?: unknown }) =>
  outcome._tag === "Success" ? (outcome.success as { trialIssue?: { number: number } }).trialIssue?.number : undefined

test("testing the same draft twice reuses its one trial issue and registration", async t => {
  const host = await plue(t)
  const first = await pressTest(host.remote, setupInput("press-1"))
  assert.equal(first._tag, "Success", failure(first))
  const second = await pressTest(host.remote, setupInput("press-2"))
  assert.equal(failure(second), "", "a second trial of the same candidate must not be refused")
  assert.equal(issue(second), issue(first), "the retry keeps the first trial's issue")
  assert.deepEqual(host.issues, [60], "one candidate revision opens one trial issue")
  assert.equal(host.registrations.length, 2)
  assert.equal(host.registrations[0], host.registrations[1], "the re-registration carries the identical configuration")
  const later = await pressTest(host.remote, setupInput("press-3", 12))
  assert.equal(later._tag, "Success", failure(later))
  assert.deepEqual(host.issues, [60, 61], "a new candidate revision opens its own trial issue")
})

test("a registration a trial cannot reuse names the conflict instead of its HTTP status", async t => {
  const host = await plue(t)
  host.rows.set("feature:trial", { revision: 11, configuration: JSON.stringify({ mode: "trial", revision: 11 }) })
  const refused = await pressTest(host.remote, setupInput("press-1"))
  const message = failure(refused)
  assert.doesNotMatch(message, /\b409\b/, message)
  assert.equal(message, "The feature trial registration at revision 11 belongs to an earlier request: "
    + "registration was paused, replaced, or changed; apply a newer reviewed revision")
})
