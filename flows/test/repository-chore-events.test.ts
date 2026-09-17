import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { NativeCoding } from "../coding/native.ts"
import { activationLayers, normalEvents, Register } from "../repository/activation.ts"
import { selectedSteps } from "../repository/execution.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { Draft, type JobInput, type SetupInput } from "../repository/schema.ts"

const modes = ["automatic", "approved", "manual", "off"] as const
const choreEvents = ["none", "push", "labeled"] as const
const issueEvents = { type: "issues", actions: ["opened", "edited", "reopened", "labeled"] }
const pullRequest = { type: "pull_request", actions: ["opened", "synchronize", "reopened"] }
const source = "a".repeat(40), base = "b".repeat(40)

const candidate = (job: JobInput["job"], mode: typeof modes[number],
  draft: Partial<{ choreEvent: typeof choreEvents[number]; label: string; schedule: string }> = {}) => {
  const initial = initialSetup("example/repo", job, "maintainer")
  return { ...initial, draft: { ...initial.draft, ...draft, steps: initial.draft.steps.map(step => ({ ...step, mode })) } }
}
const setupInput = (job: JobInput["job"], mode: typeof modes[number],
  draft: Parameters<typeof candidate>[2] = {}, operation: SetupInput["operation"] = "apply"): SetupInput => {
  const setup = candidate(job, mode, draft)
  return { requestId: "chore-events", repo: setup.repo, job, operation, revision: setup.revision,
    digest: setupCandidate(setup), draft: setup.draft as typeof Draft.Type }
}
const registered = (job: JobInput["job"], mode: typeof modes[number], draft: Parameters<typeof candidate>[2] = {}) =>
  normalEvents(setupInput(job, mode, draft))

const pushPayload = (ref: string, defaultBranch: string | null = "main") => ({
  ref, before: base, after: source, created: false, deleted: false,
  repository: defaultBranch === null ? {} : { default_branch: defaultBranch }
})
const selected = (job: JobInput["job"], mode: typeof modes[number], event: Partial<JobInput["event"]>,
  draft: Parameters<typeof candidate>[2] = {}) =>
  selectedSteps({ job, configuration: candidate(job, mode, draft).draft as typeof Draft.Type,
    event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "delivery-1",
      payload: { issue: { number: 3, title: "Tidy up", body: "Remove the dead module" } }, ...event } }).map(step => step.id)
const pushed = (job: JobInput["job"], mode: typeof modes[number], ref: string, defaultBranch: string | null = "main") =>
  selected(job, mode, { source: "github", type: "push", action: "pushed", deliveryKey: `push:${ref}`, payload: pushPayload(ref, defaultBranch) },
    { choreEvent: "push" })

test("a chore registers exactly the event rule its draft chose", () => {
  for (const mode of modes) {
    for (const choreEvent of choreEvents) {
      assert.deepEqual(registered("chores", mode, { choreEvent, label: "chore" }),
        choreEvent === "push" ? [{ type: "push", actions: [] }]
          : choreEvent === "labeled" ? [{ type: "issues", actions: ["labeled"] }] : [], `${mode} ${choreEvent}`)
    }
  }
})

test("the other four jobs register byte-identical events whatever a chore chose", () => {
  assert.deepEqual(registered("issues", "automatic"), [issueEvents, { type: "issue_comment", actions: ["created"] }])
  assert.deepEqual(registered("review", "automatic"), [pullRequest])
  assert.deepEqual(registered("ci", "automatic"), [pullRequest, { type: "push", actions: [] }])
  assert.deepEqual(registered("feature", "automatic"), [issueEvents])
  assert.deepEqual(registered("feature", "manual"), [])
  for (const job of ["issues", "review", "ci", "feature"] as const) {
    for (const choreEvent of choreEvents) {
      assert.deepEqual(registered(job, "automatic", { choreEvent, label: "chore" }), registered(job, "automatic"), `${job} ${choreEvent}`)
    }
  }
})

test("only a push to the repository's default branch starts a chore", () => {
  for (const mode of ["automatic", "approved"] as const) {
    assert.deepEqual(pushed("chores", mode, "refs/heads/main"), ["chore"], mode)
    assert.deepEqual(pushed("chores", mode, "refs/heads/release", "release"), ["chore"], mode)
    assert.deepEqual(pushed("chores", mode, "refs/heads/feature/x"), [], mode)
    assert.deepEqual(pushed("chores", mode, "refs/tags/v1.0.0"), [], mode)
    assert.deepEqual(pushed("chores", mode, "refs/heads/main", null), [], mode)
  }
  for (const mode of ["manual", "off"] as const) assert.deepEqual(pushed("chores", mode, "refs/heads/main"), [], mode)
})

test("the CI job keeps starting on a side branch push", () => {
  assert.deepEqual(pushed("ci", "automatic", "refs/heads/feature/x"), ["checks"])
  assert.deepEqual(pushed("ci", "automatic", "refs/tags/v1.0.0"), ["checks"])
})

test("a labeled chore selects its step from the issue event Plue filtered", () => {
  for (const mode of modes) {
    assert.deepEqual(selected("chores", mode, { type: "issues", action: "labeled" }, { choreEvent: "labeled", label: "chore" }),
      mode === "automatic" || mode === "approved" ? ["chore"] : [], mode)
  }
})

test("manual dispatch and the scoped trial ignore the chosen chore event", () => {
  for (const choreEvent of choreEvents) {
    for (const mode of ["automatic", "approved", "manual"] as const) {
      assert.deepEqual(selected("chores", mode, { type: "manual", action: "manual:chore", manualStep: "chore" }, { choreEvent }), ["chore"], `${mode} ${choreEvent}`)
      assert.deepEqual(selected("chores", mode, { trial: true }, { choreEvent }), ["chore"], `${mode} ${choreEvent}`)
    }
    assert.deepEqual(selected("chores", "off", { trial: true }, { choreEvent }), [], choreEvent)
  }
})

const registerCandidate = (mode: "trial" | "enabled", input: SetupInput) => Effect.gen(function*() {
  const calls: Array<{ readonly name: string; readonly body: unknown }> = []
  const record = (name: string) => (...body: ReadonlyArray<unknown>) => {
    calls.push({ name, body: body[body.length - 1] })
    return Effect.succeed({ registration_id: "registration", revision: input.revision, digest: input.digest,
      source_revision: source, mode, enabled: true } as never)
  }
  const remote = RepositoryRemote.of({ repo: input.repo, workspaceId: "workspace",
    history: Effect.succeed({ records: [], sources: [] }), register: record("register"), pause: record("pause"),
    dispatches: record("dispatches"),
    createTrial: (job: never, requestId: string) => {
      calls.push({ name: "createTrial", body: requestId })
      return Effect.succeed({ source: "smithers-cloud", number: 4, issue_id: 4, request_id: requestId, api_path: "/api/issues/4" } as never)
    } } as never)
  const runtime = { register: (declared: { _tag: string }, action: unknown) => Effect.sync(() => handlers.set(declared._tag, action as never)),
    execute: () => Effect.succeed(undefined) }
  const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
  const services = Layer.mergeAll(
    Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
    Layer.succeed(RepositoryRemote, remote),
    Layer.succeed(Jj.Jj, { snapshot: (message: string) => Effect.sync(() => { calls.push({ name: "snapshot", body: message }) }) } as never),
    Layer.succeed(NativeCoding, { read: () => Effect.succeed({ head: { kind: "resolved", commitId: source } }) } as never),
    Layer.succeed(ControlRuntime, { plan: (planned: { flowId: string }) => Effect.succeed({ card: { flowId: planned.flowId,
      executionDigest: "c".repeat(64), envelope: { budget: { milliseconds: 600_000, tokens: 100_000 } } } }) } as never),
    Layer.succeed(SqlClient.SqlClient, undefined as never),
    Layer.succeed(RunStore.RunStore, undefined as never),
    Layer.succeed(DurableEngineState.DurableEngineState, undefined as never),
    Action.layerImplementations
  )
  yield* Layer.build(activationLayers.pipe(Layer.provide(services)))
  const handler = handlers.get("repository/register-candidate")
  if (!handler) return yield* Effect.die("repository/register-candidate has no implementation")
  const outcome = yield* handler(Schema.decodeUnknownSync(Register.payloadSchema)({ input, mode, deadlineAt: Date.now() + 600_000 }))
    .execute.pipe(Effect.provide(services), Effect.result)
  return { calls, outcome }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

const message = (outcome: { _tag: string; failure?: unknown }) =>
  outcome._tag === "Failure" ? String((outcome.failure as { message?: unknown }).message) : ""

test("enabling a chore registers its chosen event, label and schedule", async () => {
  const labeled = await registerCandidate("enabled", setupInput("chores", "automatic", { choreEvent: "labeled", label: "chore", schedule: "0 9 * * *" }))
  const body = labeled.calls.find(call => call.name === "register")!.body as Record<string, unknown>
  assert.deepEqual(body.events, [{ type: "issues", actions: ["labeled"] }])
  assert.equal(body.label, "chore")
  assert.equal(body.schedule, "0 9 * * *")
  const pushing = await registerCandidate("enabled", setupInput("chores", "automatic", { choreEvent: "push", label: "chore" }))
  const pushBody = pushing.calls.find(call => call.name === "register")!.body as Record<string, unknown>
  assert.deepEqual(pushBody.events, [{ type: "push", actions: [] }])
  assert.equal(pushBody.label, undefined)
})

test("a typed apply of a manual-only chore refuses before any registration side effect", async () => {
  for (const draft of [{ schedule: "0 9 * * *" }, { choreEvent: "push" as const }, { choreEvent: "labeled" as const, label: "chore" }]) {
    const refused = await registerCandidate("enabled", setupInput("chores", "manual", draft))
    assert.equal(message(refused.outcome), "Set the chore to run automatically or on approval.", JSON.stringify(draft))
    assert.deepEqual(refused.calls, [], JSON.stringify(draft))
  }
  const off = await registerCandidate("enabled", setupInput("chores", "off", { choreEvent: "push" }))
  assert.equal(message(off.outcome), "Set the chore to run automatically or on approval.")
})

test("the refusal spares an unscheduled chore, an automatic chore and the scoped trial", async () => {
  const unscheduled = await registerCandidate("enabled", setupInput("chores", "manual"))
  assert.equal(unscheduled.outcome._tag, "Success")
  const automatic = await registerCandidate("enabled", setupInput("chores", "automatic", { choreEvent: "push" }))
  assert.equal(automatic.outcome._tag, "Success")
  const approved = await registerCandidate("enabled", setupInput("chores", "approved", { schedule: "0 9 * * *" }))
  assert.equal(approved.outcome._tag, "Success")
  const trial = await registerCandidate("trial", setupInput("chores", "manual", { choreEvent: "push" }, "trial"))
  assert.equal(trial.outcome._tag, "Success")
  assert.ok(trial.calls.some(call => call.name === "createTrial"))
})
