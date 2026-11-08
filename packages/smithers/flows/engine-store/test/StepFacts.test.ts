import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent, SqlJournal, StepFact } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { fixture, onFile } from "./ExecutionSnapshotFixture.ts"
import { sha256 } from "./Sha256.ts"

const owner = { hostId: "call-facts", pid: 1, nonce: "owner" }
const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  StepBoundary.layerTest(),
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () => Effect.succeed({ commitId: "snapshot" as never, changeId: "snapshot" as never }),
      restore: () => Effect.void,
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  ),
  NodeCrypto.layer
)
const activate = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create("calls", "{}")
  const row = yield* runs.get("calls")
  expect(
    (yield* runs.claimAndOwn(
      "calls",
      { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
      owner,
      yield* Clock.currentTimeMillis
    ))._tag
  ).toBe("Activated")
})
const fact: StepFact.Fact = {
  version: 1,
  step: { stepId: "a".repeat(64), executionId: "calls", action: "agent", attempt: 1, ask: 0, retry: 1, scope: "scope" },
  generation: 0,
  frame: 0,
  ordinal: 0,
  cell: "cell",
  at: 123,
  eventType: "control.agent.cell-started",
  sourceSequence: 42,
  payload: { text: "original" }
}
const dispatch = (value = fact) =>
  ActionPersistence.make({
    runId: "calls",
    owner,
    sourceId: "test-step",
    idempotencyKey: "checkpoint",
    execute: () => Effect.succeed(value)
  })({
    action: {
      name: "agent/checkpoint",
      successSchema: StepFact.Fact,
      annotations: Context.make(StepFact.Annotation, {})
    },
    key: "checkpoint",
    attempt: 1,
    tier: "sealed"
  })
const entries = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return (yield* journal.entries({ runId: JournalEvent.RunId.make("calls"), limit: 1000 })).entries
})

describe("native step facts over file SQLite", () => {
  it.effect("a missing post-finish checkpoint outcome fails with a typed storage error and rolls back", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            yield* activate
            const actual = yield* AttemptStore.AttemptStore
            let finished = false
            const inconsistent: AttemptStore.Service = {
              ...actual,
              finish: (input, owner) =>
                actual.finish(input, owner).pipe(Effect.tap((receipt) =>
                  Effect.sync(() => {
                    finished = receipt._tag === "Finished"
                  })
                )),
              get: (id) => finished ? Effect.succeed(Option.none()) : actual.get(id)
            }
            const outcome = yield* dispatch().pipe(
              Effect.provideService(AttemptStore.AttemptStore, inconsistent),
              Effect.exit
            )
            expect(Exit.isFailure(outcome)).toBe(true)
            if (Exit.isFailure(outcome)) {
              expect(Cause.squash(outcome.cause)).toMatchObject({
                _tag: "@smthrs/run-store/AttemptStoreError",
                code: "persistence_failed",
                method: "get",
                cause: { runId: "calls", stepKeyDigest: sha256("checkpoint"), attempt: 1 }
              })
            }
            const saved = yield* entries
            expect(saved.filter((row) => row.eventType === StepFact.eventType)).toEqual([])
            expect(saved.some((row) => row.eventType.includes("attempt-finished"))).toBe(false)
            const row = yield* actual.get({ runId: "calls", stepKeyDigest: sha256("checkpoint"), attempt: 1 })
            expect(Option.isSome(row) && row.value.state).toBe("running")
          }).pipe(Effect.provide(services))
        )
      )
    ))
  it("refuses malformed durable coordinates and accepts a repair observation", () => {
    expect(Schema.is(StepFact.Fact)({ ...fact, step: { ...fact.step, ask: "repair" }, frame: -1 })).toBe(true)
    const malformed = [
      { ...fact, generation: -1 },
      { ...fact, frame: -2 },
      { ...fact, ordinal: -1 },
      { ...fact, at: -1 },
      { ...fact, sourceSequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...fact, eventType: "control.run.completed" },
      { ...fact, step: { ...fact.step, stepId: "bad" } },
      { ...fact, step: { ...fact.step, attempt: 0 } },
      { ...fact, step: { ...fact.step, retry: 0 } },
      { ...fact, step: { ...fact.step, ask: -1 } }
    ]
    for (const value of malformed) expect(Schema.is(StepFact.Fact)(value)).toBe(false)
  })
  it.effect("commits before checkpoint completion and reopens with the first observation", () =>
    fixture((file) =>
      Effect.gen(function*() {
        yield* onFile(
          file,
          Effect.scoped(
            Effect.gen(function*() {
              yield* activate
              yield* dispatch()
              const recorded = yield* entries
              const index = recorded.findIndex((entry) => entry.eventType === StepFact.eventType)
              expect(index).toBeGreaterThanOrEqual(0)
              expect(recorded[index]?.payload).toEqual(fact)
              expect(recorded[index]?.sourceId).toBe(`step-fact-v1:${fact.step.stepId}:1:0:1`)
              expect(recorded[index]?.sourceSeq).toBe(fact.sourceSequence)
              const finished = recorded.findIndex((entry) => entry.eventType.includes("attempt-finished"))
              expect(finished).toBeGreaterThan(index)
            }).pipe(Effect.provide(services))
          )
        )
        yield* onFile(
          file,
          Effect.scoped(
            Effect.gen(function*() {
              expect(yield* dispatch({ ...fact, generation: 9, at: 999, payload: { text: "new" } })).toEqual(fact)
              const facts = (yield* entries).filter((entry) => entry.eventType === StepFact.eventType)
              expect(facts).toHaveLength(1)
              expect(facts[0]?.payload).toEqual(fact)
            }).pipe(Effect.provide(services))
          )
        )
      })
    ))
  it.effect("rolls back the fact and terminal attempt when insertion fails, including publication", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            yield* activate
            const journal = yield* Journal.Journal
            const published: Array<string> = []
            const changes = yield* journal.changes
            yield* Stream.fromSubscription(changes).pipe(
              Stream.runForEach((entry) =>
                Effect.sync(() => {
                  published.push(entry.eventType)
                })
              ),
              Effect.forkScoped
            )
            const failing = Journal.make({
              ...journal,
              emitDurable: (input, fence) =>
                journal.emitDurable(input, fence).pipe(
                  Effect.tap(() =>
                    input.eventType === StepFact.eventType
                      ? Effect.fail(
                        new Journal.JournalError({ code: "sink_failed", message: "after step fact insert" })
                      )
                      : Effect.void
                  )
                )
            })
            expect(Exit.isFailure(yield* dispatch().pipe(Effect.provideService(Journal.Journal, failing), Effect.exit)))
              .toBe(true)
            const attempts = yield* AttemptStore.AttemptStore
            const row = yield* attempts.get({ runId: "calls", stepKeyDigest: sha256("checkpoint"), attempt: 1 })
            expect(Option.isSome(row) && row.value.state).toBe("running")
            expect((yield* entries).filter((entry) => entry.eventType === StepFact.eventType)).toEqual([])
            yield* Effect.yieldNow
            expect(published).not.toContain(StepFact.eventType)
          }).pipe(Effect.provide(services))
        )
      )
    ))
})
