// Steering a TODO's agent, in the parts no real tab or ChatApi answers (docs/features/runs.md#steering): the page's fold of
// the run's journal and this device's own messages, which refusals are final, and the steer step where its tab is gone
// or won't keep the message. The whole path, a tab through ChatApi to the run's queue, runs in remote.test.ts; the agent
// reading a message, in worker/flows/Todo.test.ts.
import { WebCrypto } from "@smthrs/crypto"
import { Collection, Outbox } from "@smthrs/effect-tanstack-db"
import { FlowRuntime } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Cause, type Crypto, Effect, Exit, Layer, Metric, Option } from "effect"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { deviceRegistry } from "../../device/registry"
import * as RunCredentials from "../../flows/credentials"
import { faultyPersistenceOn } from "../../test/deviceFixture"
import { afterFailedSteer } from "./actions"
import { STEERED_ACTION } from "./contract"
import { SteerStepRefused } from "./flows"
import { steersQueued } from "./metrics"
import { type PageStep, responseStep, steerOpen, steersOf } from "./page"
import { type Inspection, type RunPage, type RunsCall, type SteerSending, type SteerSent, SteerSent as SteerSentRow } from "./schema"
import { queueSteer, TabRuns } from "./steps"
import { RemoteRunsClient, SteerFailed } from "./api"
import { finalReasonOf, keep, send } from "./writes"

const RUN = "todo:0b9e6a3c-1f2d-4c5e-8a7b-9c0d1e2f3a4b"
const value = (text: string, clipped = false) => ({ text, bytes: text.length, clipped })

/** A journal event of the run's notification queue: an admission or a promotion. */
const admitted = (seq: number, at: number, id: string, body: string, login = "maya") => ({
  seq,
  eventType: "flows/notifications/Admitted",
  emittedAtMs: at,
  payload: value(JSON.stringify({
    notification: {
      _tag: "human-steer",
      id,
      delivery: "steer",
      targetLineageId: RUN,
      provenance: {
        sourceRunId: RUN,
        sourceLineageId: RUN,
        sourceTurn: 0,
        sourceActor: "person:person-maya",
        attribution: { login, via: "person" },
      },
      payload: { kind: "Message", body },
    },
    decision: "admitted",
  })),
})
const promoted = (seq: number, at: number, ids: ReadonlyArray<string>, lineage = RUN) => ({
  seq,
  eventType: "flows/notifications/Promoted",
  emittedAtMs: at,
  payload: value(JSON.stringify({ boundary: `${seq}:0`, targetLineageId: lineage, ids })),
})

/** A cell call the agent made: the journal's record that a turn acted. */
const acted = (seq: number) => ({ seq, eventType: "flows.harness.call-fact.v1", emittedAtMs: seq * 100, payload: value("{}") })

const step = (action: string | null, status: string, settledAtMs: number | null = null) => ({
  nodeId: `n-${action}`,
  action,
  kind: "ActionCall",
  status,
  scheduledAtMs: 0,
  settledAtMs,
  seq: 0,
  output: null,
  attempts: [],
})

const pageOf = (
  events: ReadonlyArray<unknown>,
  options: { readonly status?: string; readonly steps?: ReadonlyArray<unknown>; readonly more?: ReadonlyArray<unknown> } = {},
): RunPage => ({
  id: RUN,
  state: "read",
  inspection: {
    run: {
      runId: RUN,
      flowName: "todo",
      status: options.status ?? "running",
      createdAtMs: 0,
      startedAtMs: 0,
      finishedAtMs: null,
      parentRunId: null,
      cancelRequestedAtMs: null,
      waiting: null,
      lastSeq: 99,
      input: value("{}"),
      result: null,
    },
    steps: options.steps ?? [step(STEERED_ACTION, "running")],
    children: [],
    journal: { events, nextSeq: 99, hasMore: false },
  },
  more: options.more ?? [],
  hasMore: false,
})

const sending = (id: string, body: string, queuedAt: number, runId = RUN): SteerSending => ({ id, runId, body, queuedAt, v: 1 })
const sent = (id: string, body: string, queuedAt: number, status: SteerSent["status"], reason: SteerSent["reason"] = null): SteerSent => ({
  id,
  runId: RUN,
  body,
  queuedAt,
  status,
  reason,
})

describe("the run page's steers", () => {
  test("a message the agent acted on after its promotion is Delivered there; one waiting is Sent; oldest first", () => {
    const page = pageOf([
      admitted(3, 300, "a", "Use tabs"),
      { seq: 4, eventType: "flows/engine/node-settled", emittedAtMs: 350, payload: value("{}") },
      admitted(5, 400, "b", "Then add a test", "ben"),
      promoted(6, 500, ["a"]),
      acted(7),
      // A later drain that names it again changes nothing.
      promoted(8, 700, ["a"]),
    ])
    expect(steersOf(page, [], [])).toEqual([
      { id: "a", body: "Use tabs", by: "maya", state: "delivered", reason: null, atMs: 300, deliveredAtMs: 500 },
      { id: "b", body: "Then add a test", by: "ben", state: "sent", reason: null, atMs: 400, deliveredAtMs: null },
    ])
  })

  test("a steer that names no one, or carries no message, still lists: no sender, no words", () => {
    const bare = JSON.parse(admitted(3, 300, "seat", "x").payload.text)
    bare.notification.provenance = { sourceRunId: RUN, sourceLineageId: RUN, sourceTurn: 0, sourceActor: "machine:ci" }
    bare.notification.payload = { kind: "Seat", seat: "fast" }
    const item = steersOf(pageOf([{ ...admitted(3, 300, "seat", "x"), payload: value(JSON.stringify(bare)) }]), [], [])[0]!
    expect([item.by, item.body]).toEqual([null, ""])
  })

  test("journal pages read past the first count, and a cut or foreign event is skipped", () => {
    const page = pageOf([admitted(3, 300, "a", "Use tabs")], {
      more: [
        { ...admitted(4, 350, "cut", "x"), payload: value("{\"notification\":", true) },
        { ...admitted(5, 360, "bad", "x"), payload: value("not json") },
        { ...admitted(6, 370, "follow", "x"), payload: value(JSON.stringify({ decision: "admitted", notification: { _tag: "system-event", id: "s", delivery: "queue", targetLineageId: RUN, provenance: { sourceRunId: "ci", sourceLineageId: "ci", sourceTurn: 0, sourceActor: "machine:ci" }, payload: {} } })) },
        promoted(7, 400, ["a"], "another-lineage"),
        promoted(8, 410, ["a"]),
        acted(9),
      ],
    })
    expect(steersOf(page, [], []).map((item) => [item.id, item.state, item.deliveredAtMs])).toEqual([["a", "delivered", 410]])
  })

  test("handed to a turn is not yet read: Sent until the agent acts or answers, Not delivered if it stops first", () => {
    const handed = [acted(2), admitted(3, 300, "a", "Use tabs"), promoted(4, 400, ["a"])]
    expect(steersOf(pageOf(handed), [], [])[0]!.state).toBe("sent")
    // The run failed before the turn the queue handed it to.
    expect(steersOf(pageOf(handed, { status: "failed", steps: [step(STEERED_ACTION, "failed")] }), [], [])[0]!.state)
      .toBe("not_delivered")
    // The agent's answer came after it: its last turn read it.
    const answered = steersOf(pageOf(handed, { steps: [step(STEERED_ACTION, "completed", 450)] }), [], [])[0]!
    expect([answered.state, answered.deliveredAtMs]).toEqual(["delivered", 400])
    // An answer from before it was handed over is no proof.
    expect(steersOf(pageOf(handed, { steps: [step(STEERED_ACTION, "completed", 390)] }), [], [])[0]!.state)
      .toBe("not_delivered")
  })

  test("a message no turn read before the agent ended is Not delivered, whether the run or only its agent ended", () => {
    const events = [admitted(3, 300, "a", "Too late")]
    expect(steersOf(pageOf(events, { status: "completed" }), [], [])[0]!.state).toBe("not_delivered")
    expect(steersOf(pageOf(events, { steps: [step(STEERED_ACTION, "completed")] }), [], [])[0]!.state).toBe("not_delivered")
    expect(steersOf(pageOf(events, { steps: [step(STEERED_ACTION, "waiting")] }), [], [])[0]!.state).toBe("sent")
  })

  test("this device's own messages show until the journal does: Sending in the outbox, then Sent or Not sent", () => {
    const page = pageOf([admitted(3, 300, "a", "In the journal")])
    const items = steersOf(
      page,
      [sending("a", "In the journal", 250), sending("s", "Sending", 260), sending("n", "Answered", 270), sending("x", "Other run", 1, "todo:other")],
      [sent("a", "In the journal", 250, "sent"), sent("n", "Answered", 270, "not_sent", "not_working"), sent("t", "Taken", 280, "sent")],
    )
    expect(items.map((item) => [item.id, item.state, item.reason])).toEqual([
      ["s", "sending", null],
      ["n", "not_sent", "not_working"],
      ["t", "sent", null],
      ["a", "sent", null],
    ])
    // Taken, then the agent ended before the page read the journal again.
    expect(steersOf(pageOf([], { status: "failed" }), [], [sent("t", "Taken", 1, "sent")])[0]!.state).toBe("not_delivered")
    // A page with no run read shows none.
    expect(steersOf({ ...page, state: "unavailable", inspection: null }, [sending("s", "x", 1)], [])).toEqual([])
  })

  test("the composer is offered on a TODO's run until it or its agent ends", () => {
    const of = (page: RunPage) => steerOpen(page.inspection as Inspection)
    expect(of(pageOf([]))).toBe(true)
    expect(of(pageOf([], { steps: [] }))).toBe(true)
    expect(of(pageOf([], { status: "cancelled" }))).toBe(false)
    expect(of(pageOf([], { steps: [step(STEERED_ACTION, "failed")] }))).toBe(false)
    const local = pageOf([])
    expect(steerOpen({ ...(local.inspection as Inspection), run: { ...(local.inspection as Inspection).run, runId: "run-1" } }))
      .toBe(false)
  })

  test("a delivered message's response is the agent's first step that began at or after it", () => {
    const at = (id: string, startedAtMs: number) => ({ row: { id, startedAtMs } }) as unknown as PageStep
    const steps = [at("late", 900), at("before", 100), at("next", 500), at("same", 400)]
    expect(responseStep(steps, 400)).toBe("same")
    expect(responseStep(steps, 401)).toBe("next")
    expect(responseStep(steps, 1_000)).toBeNull()
  })
})

describe("a steer that couldn't be queued", () => {
  const view = { id: "view" as const, runId: RUN, listOpen: false, selected: null, tab: "steps" as const, acting: null, refusal: null }
  test("gives its words back to the composer it came from, and says why", () => {
    expect(afterFailedSteer({ ...view, steerDraft: "" }, RUN, "Use tabs")).toEqual({ steerDraft: "Use tabs", refusal: "unavailable" })
    expect(afterFailedSteer(view, RUN, "Use tabs")).toEqual({ steerDraft: "Use tabs", refusal: "unavailable" })
  })
  test("never over what was typed since, nor into another run's composer", () => {
    expect(afterFailedSteer({ ...view, steerDraft: "Newer" }, RUN, "Use tabs")).toEqual({ refusal: "unavailable" })
    expect(afterFailedSteer({ ...view, runId: "todo:other" }, RUN, "Use tabs")).toEqual({ refusal: "unavailable" })
  })
})

describe("a steer's send", () => {
  test("is sent again when the device can't store the route's answer, rather than settling with no record", async () => {
    const store = faultyPersistenceOn(join(tmpdir(), `mvp-steer-keep-${crypto.randomUUID()}.sqlite`), deviceRegistry)
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const sent = yield* Collection.persisted<SteerSent, string>({ id: "steer-sent", schema: SteerSentRow, getKey: (row) => row.id, schemaVersion: 1 })
        yield* sent.preload
        store.failWrites()
        return yield* Effect.exit(keep(sent, sending("a", "Use tabs", 5), "not_sent", "not_working"))
      }).pipe(Effect.provide(Layer.fresh(store.layer)), Effect.scoped),
    )
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(Outbox.Retry)
  })

  /** Sends `row` through a client that answers `answer`, into a fresh `sent`; answers the outbox's verdict and the rows. */
  const sendWith = (answer: Effect.Effect<{ readonly id: string; readonly existing: boolean }, SteerFailed>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const sent = yield* Collection.local<SteerSent, string>({ id: `steer-sent-${crypto.randomUUID()}`, schema: SteerSentRow, getKey: (row) => row.id })
        const verdict = yield* Effect.exit(send(sent, { rows: [sending("a", "Use tabs", 5)] }))
        return { verdict, rows: (yield* sent.toArray).map((row) => [row.status, row.reason]) }
      }).pipe(
        Effect.provideService(RemoteRunsClient, RemoteRunsClient.of({ inspect: () => Effect.die("unused"), steer: () => answer, stop: () => Effect.die("unused"), list: Effect.succeed([]) })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.scoped,
      ),
    )
  const errorOf = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

  test("taken or had: Sent; a final refusal: Not sent with why, and never again; anything else: sent again", async () => {
    expect((await sendWith(Effect.succeed({ id: "a", existing: false }))).rows).toEqual([["sent", null]])
    expect((await sendWith(Effect.succeed({ id: "a", existing: true }))).rows).toEqual([["sent", null]])
    const refused = await sendWith(Effect.fail(new SteerFailed({ status: 409, code: "not_working" })))
    expect(refused.rows).toEqual([["not_sent", "not_working"]])
    expect(errorOf(refused.verdict)).toMatchObject({ _tag: "Refused", status: 409 })
    const full = await sendWith(Effect.fail(new SteerFailed({ status: 429, code: "full" })))
    expect([full.rows, errorOf(full.verdict)]).toMatchObject([[], { _tag: "Retry", status: 429 }])
    const offline = await sendWith(Effect.fail(new SteerFailed({})))
    expect(offline.rows).toEqual([])
    expect(errorOf(offline.verdict)).toMatchObject({ _tag: "Retry" })
    expect(errorOf(offline.verdict)).not.toHaveProperty("status")
  })

  test("keeps the route's answer on the device, replacing one a replayed send finds there, never the credential", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function*() {
        const sent = yield* Collection.local<SteerSent, string>({ id: `steer-sent-${crypto.randomUUID()}`, schema: SteerSentRow, getKey: (row) => row.id })
        const row: SteerSending = { ...sending("a", "Use tabs", 5), credential: "run-token" }
        yield* keep(sent, row, "sent", null)
        const first = yield* sent.toArray
        yield* keep(sent, row, "not_sent", "not_working")
        return { first, then: yield* sent.toArray }
      }).pipe(Effect.scoped),
    )
    expect(kept.first).toMatchObject([{ id: "a", runId: RUN, body: "Use tabs", queuedAt: 5, status: "sent", reason: null }])
    expect(kept.then).toMatchObject([{ id: "a", runId: RUN, body: "Use tabs", queuedAt: 5, status: "not_sent", reason: "not_working" }])
    expect(kept.then[0]).not.toHaveProperty("credential")
  })

  test("refusals the route names, or whose status says so, are final; anything else is sent again", () => {
    expect(finalReasonOf(409, "not_working")).toBe("not_working")
    expect(finalReasonOf(409, "conflict")).toBe("conflict")
    expect(finalReasonOf(400, undefined)).toBe("invalid")
    expect(finalReasonOf(401, "elsewhere")).toBe("authentication")
    expect(finalReasonOf(403, undefined)).toBe("forbidden")
    expect(finalReasonOf(404, undefined)).toBe("not_found")
    expect(finalReasonOf(413, undefined)).toBe("too_large")
    // Full waits for the agent to read what it holds; unavailable for the service.
    expect(finalReasonOf(429, "full")).toBeUndefined()
    expect(finalReasonOf(503, "unavailable")).toBeUndefined()
    expect(finalReasonOf(409, undefined)).toBeUndefined()
    expect(finalReasonOf(undefined, undefined)).toBeUndefined()
  })
})

/** The person's own press, and the agent's call in an answer (src/flows/catalog.ts `childExecutionId`). */
const PERSON = "8a7f0c2e-5d1b-4c4a-9a43-0f2a1f7e9b10"
const AGENT = "answer-1/chat/Respond@abc:1/call/1.0"

/** The run credentials of a run that is the person's press, has `token`, or can't have one (`reason`). */
const acting = (as: { readonly token?: string; readonly reason?: string } = {}) =>
  RunCredentials.RunCredentials.of({
    bearer: as.reason !== undefined
      ? Effect.fail(new RunCredentials.CredentialUnavailable({ reason: as.reason }))
      : Effect.succeed(Option.fromNullishOr(as.token)),
  })

const run = <A, E>(
  effect: Effect.Effect<A, E, FlowRuntime.FlowInstance | TabRuns | Crypto.Crypto | RunCredentials.RunCredentials>,
  executionId: string,
  tabs: Layer.Layer<TabRuns>,
  registry: Metric.MetricRegistry,
  credentials: RunCredentials.RunCredentials["Service"] = acting(),
) =>
  Effect.runPromise(
    Effect.exit(
      effect.pipe(
        // Only the execution id is read.
        Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
        Effect.provideService(RunCredentials.RunCredentials, credentials),
        Effect.provide(tabs),
        Effect.provide(WebCrypto.layer),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ),
  )

/** A tab that answers every call, recording what it was asked. */
const recordingTab = (kept: boolean) => {
  const asked: Array<{ readonly requester: string; readonly call: RunsCall }> = []
  return {
    asked,
    layer: Layer.succeed(TabRuns, TabRuns.of({
      ask: (call) => Effect.sync(() => {
        asked.push(call)
        return Option.some({ door: "composer" as const, kept })
      }),
    })),
  }
}

/** No tab listens on this engine's channel (Node's own `BroadcastChannel`): the tab that asked is gone. */
const noTab = TabRuns.layerChannel({ name: `none-${crypto.randomUUID()}`, within: "100 millis" }).pipe(Layer.provide(TabChannel.layer))

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const count = (registry: Metric.MetricRegistry, attributes: Record<string, string>) =>
  Effect.runSync(
    Metric.value(Metric.withAttributes(steersQueued, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  ).count

describe("the steer step", () => {
  test("asks the tab that started it to queue the message under an id derived from the run, the same each time", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    const first = await run(queueSteer({ runId: RUN, body: "Use tabs" }), PERSON, tab.layer, registry)
    const again = await run(queueSteer({ runId: RUN, body: "Use tabs" }), PERSON, tab.layer, registry)
    expect(Exit.isSuccess(first) && first.value.status).toBe("requested")
    expect(first).toEqual(again)
    const steerId = Exit.isSuccess(first) ? first.value.steerId : ""
    expect(tab.asked).toEqual([
      { requester: PERSON, call: { kind: "steer", steer: { id: steerId, runId: RUN, body: "Use tabs" } } },
      { requester: PERSON, call: { kind: "steer", steer: { id: steerId, runId: RUN, body: "Use tabs" } } },
    ])
    expect(count(registry, { door: "composer", outcome: "kept" })).toBe(2)
  })

  test("the agent's call asks the tab whose answer it belongs to with its run credential, and counts as the agent's", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    const exit = await run(queueSteer({ runId: RUN, body: "Keep it short" }), AGENT, tab.layer, registry, acting({ token: "run-token" }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(tab.asked[0]!.requester).toBe("answer-1")
    expect(tab.asked[0]!.call.steer.credential).toBe("run-token")
    expect(count(registry, { door: "agent", outcome: "kept" })).toBe(1)
  })

  test("a run with no credential to send queues nothing: its message never goes in the person's session", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const tab = recordingTab(true)
    const exit = await run(queueSteer({ runId: RUN, body: "x" }), AGENT, tab.layer, registry, acting({ reason: "expired" }))
    expect(failure(exit)).toEqual(new SteerStepRefused({ reason: "no_credential" }))
    expect(tab.asked).toEqual([])
    expect(count(registry, { door: "agent", outcome: "no_credential" })).toBe(1)
  })

  test("a tab that won't keep it, or none at all, fails the step with why", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const refused = await run(queueSteer({ runId: RUN, body: "x" }), PERSON, recordingTab(false).layer, registry)
    expect(failure(refused)).toEqual(new SteerStepRefused({ reason: "not_kept" }))
    const gone = await run(queueSteer({ runId: RUN, body: "x" }), PERSON, noTab, registry)
    expect(failure(gone)).toEqual(new SteerStepRefused({ reason: "tab_gone" }))
    expect(count(registry, { door: "composer", outcome: "not_kept" })).toBe(1)
    expect(count(registry, { door: "unknown", outcome: "tab_gone" })).toBe(1)
  })
})
