import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { Action, HumanTask } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Layer, Schema } from "effect"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { PublishReply, replyLayers } from "../repository/replies.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { JobInput, JobResult, type StepResult } from "../repository/schema.ts"

const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const step = (stepId: string, status: typeof StepResult.Type["status"], summary: string, output: Schema.Json = {}) =>
  ({ stepId, status, summary, evidence: [`execution:${stepId}`], output, executionId: `execution-${stepId}` })
const material = [step("research", "completed", "greeting.mjs exports hello."),
  step("duplicates", "needs-author", "No duplicate defect found.", { question: "Which release first showed this?" })]

const fixture = (options: { replies?: "draft" | "automatic"; source?: "github" | "smithers-cloud"; trial?: boolean
  results?: ReadonlyArray<ReturnType<typeof step>>; status?: typeof JobResult.Type["status"] } = {}) => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.draft.replies = options.replies ?? "draft"
  const input = Schema.decodeUnknownSync(JobInput)({ repo: setup.repo, job: setup.job, revision: setup.revision,
    digest: setupCandidate(setup), sourceRevision: "a".repeat(40), configuration: json(setup.draft),
    event: { source: options.source ?? "smithers-cloud", type: "issues", action: "opened", deliveryKey: "delivery:42",
      issueNumber: 42, ...(options.trial ? { trial: true } : {}),
      payload: { issue: { number: 42, title: "Greeting", body: "Which greeting is exported?" } } } })
  const result = Schema.decodeUnknownSync(JobResult)({ repo: input.repo, job: input.job, revision: input.revision,
    digest: input.digest, sourceRevision: input.sourceRevision, eventKey: input.event.deliveryKey,
    status: options.status ?? "needs-author", results: json(options.results ?? material), publicActions: [] })
  return { input, result }
}
const host = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "repository-reply-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const comments: Array<Record<string, any>> = []
  const remote = Layer.succeed(RepositoryRemote, RepositoryRemote.of({
    repo: "example/repo", workspaceId: "22222222-2222-4222-8222-222222222222",
    history: Effect.succeed({ records: [], sources: [] }),
    register: () => Effect.die("a reply never registers a job"),
    pause: () => Effect.die("a reply never pauses a job"),
    dispatches: () => Effect.die("a reply never reads dispatches"),
    createTrial: () => Effect.die("a reply never creates a trial issue"),
    comment: (job, name, raw) => Effect.sync(() => {
      const value = raw as Record<string, any>
      comments.push({ job, step: name, ...value })
      return json({ registration_id: "33333333-3333-4333-8333-333333333333", revision: value.revision, digest: value.digest,
        delivery_key: value.delivery_key, step: name, source: "smithers-cloud", issue_number: value.issue_number,
        comment_id: 100 + comments.length, api_path: "/repos/example/repo/issues/42/comments" })
    })
  }))
  const engine = () => NodeRuntime.layerHost({ filename: join(root, "engine.db"), workspaceRoot: root,
    owner: { hostId: "repository-reply-test" }, signals: [] },
    Layer.mergeAll(replyLayers, HumanTask.layer).pipe(Layer.provideMerge(remote), Layer.provideMerge(Action.layerImplementations)))
  return { comments, engine,
    publish: (payload: ReturnType<typeof fixture>, executionId: string) => Effect.runPromise(Effect.scoped(
      PublishReply.execute(payload, { executionId }).pipe(Effect.provide(engine())))) }
}

test("a draft-mode issue job returns one consolidated reply covering every completed and needs-author step", async (t) => {
  const { comments, publish } = await host(t)
  const published = await publish(fixture(), "draft-native")
  assert.equal(published.reply?.state, "drafted")
  assert.equal(published.reply?.issueNumber, 42)
  assert.match(published.reply?.body ?? "", /Research issue\ngreeting\.mjs exports hello\./)
  assert.match(published.reply?.body ?? "", /Find duplicates\nNo duplicate defect found\.\nWhich release first showed this\?/)
  assert.deepEqual(published.publicActions, [], "a drafted reply posts nothing")
  assert.equal(comments.length, 0)
})

test("a GitHub-source issue job drafts the reply and states that posting is undeliverable", async (t) => {
  const { comments, publish } = await host(t)
  const published = await publish(fixture({ source: "github" }), "draft-github")
  assert.equal(published.reply?.state, "undeliverable")
  assert.match(published.reply?.body ?? "", /greeting\.mjs exports hello\./)
  assert.match(published.reply?.reason ?? "", /GitHub/)
  assert.equal(comments.length, 0)
})

test("a scoped trial produces the same draft and never posts it", async (t) => {
  const { comments, publish } = await host(t)
  for (const replies of ["draft", "automatic"] as const) {
    const published = await publish(fixture({ trial: true, replies }), `trial-${replies}`)
    assert.equal(published.reply?.state, "drafted", replies)
    assert.match(published.reply?.body ?? "", /greeting\.mjs exports hello\./)
  }
  assert.equal(comments.length, 0, "a trial never publishes its draft")
})

test("a job with no material finding produces no draft", async (t) => {
  const { comments, publish } = await host(t)
  const unanswered = await publish(fixture({ results: [step("research", "needs-maintainer", "The provider was unavailable.")] }), "no-finding")
  assert.equal(unanswered.reply, undefined)
  const skipped = await publish(fixture({ status: "skipped" }), "skipped-job")
  assert.equal(skipped.reply, undefined)
  assert.equal(comments.length, 0)
})

test("a job result recorded before the consolidated reply still decodes", () => {
  const { result } = fixture()
  const stored = json({ ...result, results: json(result.results) }) as Record<string, Schema.Json>
  delete stored.reply
  const decoded = Schema.decodeUnknownSync(JobResult)(stored)
  assert.equal(Object.hasOwn(decoded, "reply"), false)
  assert.equal(decoded.status, "needs-author")
})

test("automatic native replies still post exactly one dispatch-bound comment", async (t) => {
  const { comments, publish } = await host(t)
  const published = await publish(fixture({ replies: "automatic" }), "automatic-native")
  assert.equal(published.reply?.state, "posted")
  assert.equal(comments.length, 1)
  assert.equal(comments[0]?.delivery_key, "delivery:42")
  assert.equal(comments[0]?.issue_number, 42)
  assert.equal(comments[0]?.body, published.reply?.body)
  assert.equal(published.publicActions.length, 1)
})
