import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { CallFact, Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Clock, Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { fixture, onFile } from "./ExecutionSnapshotFixture.ts"
import { sha256 } from "./Sha256.ts"

const owner = { hostId: "call-facts", pid: 1, nonce: "owner" }
const call: CallFact.Call = {
  callId: `cell-call-v1:${"a".repeat(64)}`,
  identity: { runId: "calls", frame: 2, cell: "cell", ordinal: 3, declaration: "declaration", layers: ["base"] },
  flowName: "write",
  input: { token: "never-public-input", path: "a" }
}
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
/** The same call, with the display projection its declaration carried. */
const described: CallFact.Call = {
  ...call,
  descriptor: {
    name: "write",
    activity: "writes",
    presentation: {
      verb: { pending: "writing", success: "wrote", failure: "failed to write" },
      subject: "path",
      result: "write"
    }
  }
}
const dispatch = (
  phase: "invoked" | "settled",
  execute: Effect.Effect<unknown>,
  annotated = true,
  annotated_call: CallFact.Call = call
) =>
  ActionPersistence.make({
    runId: "calls",
    owner,
    sourceId: "test-calls",
    idempotencyKey: phase,
    execute: () => execute
  })({
    action: {
      name: `call/${phase}`,
      ...(annotated && phase === "settled" ? { successSchema: CallFact.Result } : {}),
      annotations: annotated
        ? Context.make(CallFact.Annotation, { phase, call: annotated_call })
        : Context.empty()
    },
    key: phase,
    attempt: 1,
    tier: "irreversible"
  })
const facts = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return (yield* journal.entries({ runId: JournalEvent.RunId.make("calls"), limit: 1000 })).entries
    .filter((entry) => entry.eventType === CallFact.eventType)
})
const failing = (journal: Journal.Service, phase: "invoked" | "settled") =>
  Journal.make({
    ...journal,
    emitDurable: (input, fence) =>
      journal.emitDurable(input, fence).pipe(Effect.tap(() =>
        input.eventType === CallFact.eventType && (input.payload as CallFact.Fact).phase === phase
          ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "fault after call fact insert" }))
          : Effect.void
      ))
  })

describe("native call facts over file SQLite", () => {
  it.effect("a store that loses its just-finished outcome cannot commit a fact or return a delivered result", () =>
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
            const outcome = yield* dispatch("settled", Effect.succeed({ outcome: "success", value: "saved" })).pipe(
              Effect.provideService(AttemptStore.AttemptStore, inconsistent),
              Effect.exit
            )
            expect(Exit.isFailure(outcome)).toBe(true)
            expect(yield* facts).toEqual([])
            const row = yield* actual.get({ runId: "calls", stepKeyDigest: sha256("settled"), attempt: 1 })
            expect(Option.isSome(row) && row.value.state).toBe("running")
          }).pipe(Effect.provide(services))
        )
      )
    ))

  it.effect("an invocation insert failure rolls back admission, publishes nothing and never invokes the handler", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            yield* activate
            const journal = yield* Journal.Journal
            const attempts = yield* AttemptStore.AttemptStore
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
            let calls = 0
            const body = Effect.sync(() => {
              calls++
              return { outcome: "success", value: "ok" }
            })
            expect(
              Exit.isFailure(
                yield* dispatch("invoked", body).pipe(
                  Effect.provideService(Journal.Journal, failing(journal, "invoked")),
                  Effect.exit
                )
              )
            ).toBe(true)
            expect(calls).toBe(0)
            expect(Option.isNone(yield* attempts.get({ runId: "calls", stepKeyDigest: sha256("invoked"), attempt: 1 })))
              .toBe(true)
            expect(yield* facts).toEqual([])
            yield* Effect.yieldNow
            expect(published).toEqual([])
            yield* dispatch("invoked", body)
            yield* dispatch("invoked", body)
            expect(calls).toBe(1)
            const recorded = yield* facts
            expect(recorded).toHaveLength(1)
            expect(recorded[0]?.payload).toMatchObject({
              version: 1,
              phase: "invoked",
              callId: call.callId,
              identity: call.identity,
              input: { token: "[REDACTED]", path: "a" }
            })
          }).pipe(Effect.provide(services))
        )
      )
    ))

  it.effect("the delivered timeout/failure record and fact commit together, then reopen without rerunning the completed boundary", () =>
    fixture((file) =>
      Effect.gen(function*() {
        let deliveries = 0
        let executions = 0
        const result = {
          outcome: "failure",
          value: { token: "never-public-result", text: "x".repeat(70_000) },
          code: "timeout",
          message: "The call timed out"
        }
        const body = Effect.sync(() => {
          executions++
          return result
        })
        yield* onFile(
          file,
          Effect.scoped(
            Effect.gen(function*() {
              yield* activate
              yield* dispatch("invoked", Effect.succeed({ outcome: "success", value: "host answer" }))
              const journal = yield* Journal.Journal
              expect(Exit.isFailure(
                yield* dispatch("settled", body).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      deliveries++
                    })
                  ),
                  Effect.provideService(Journal.Journal, failing(journal, "settled")),
                  Effect.exit
                )
              )).toBe(true)
              expect(deliveries).toBe(0)
              expect((yield* facts).map((entry) => (entry.payload as CallFact.Fact).phase)).toEqual(["invoked"])
              const attempts = yield* AttemptStore.AttemptStore
              const row = yield* attempts.get({ runId: "calls", stepKeyDigest: sha256("settled"), attempt: 1 })
              expect(Option.isSome(row) && row.value.state).toBe("running")
            }).pipe(Effect.provide(services))
          )
        )
        yield* onFile(
          file,
          Effect.scoped(
            Effect.gen(function*() {
              expect(yield* dispatch("settled", body)).toEqual(result)
              expect(yield* dispatch("settled", body)).toEqual(result)
              expect(executions).toBe(1)
              const recorded = yield* facts
              expect(recorded).toHaveLength(2)
              expect(recorded[1]?.payload).toMatchObject({
                phase: "settled",
                callId: call.callId,
                identity: call.identity,
                outcome: "failure",
                code: "timeout",
                value: { truncated: true },
                message: result.message
              })
              expect(JSON.stringify(recorded)).not.toContain("never-public")
            }).pipe(Effect.provide(services))
          )
        )
      })
    ))

  it.effect("legacy durable controller outcomes acquire facts by observation without another handler execution", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            yield* activate
            let executions = 0
            const result = { outcome: "success", value: { answer: 42 } }
            const body = Effect.sync(() => {
              executions++
              return result
            })
            yield* dispatch("settled", body, false)
            expect(yield* facts).toEqual([])
            expect(yield* dispatch("settled", body)).toEqual(result)
            yield* dispatch("settled", body)
            expect(executions).toBe(1)
            expect(yield* facts).toHaveLength(1)
            expect((yield* facts)[0]?.payload).toMatchObject({
              phase: "settled",
              outcome: "success",
              value: { answer: 42 }
            })
          }).pipe(Effect.provide(services))
        )
      )
    ))
  it.effect("a corrupt old controller outcome cannot become a published deliverable fact", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            yield* activate
            const invalid = { outcome: "success", value: null, code: "timeout" }
            yield* dispatch("settled", Effect.succeed(invalid), false)
            const refused = yield* Effect.exit(
              dispatch("settled", Effect.succeed({ outcome: "success", value: "new" }))
            )
            expect(Exit.isFailure(refused)).toBe(true)
            expect(yield* facts).toEqual([])
            expect(Schema.is(CallFact.Result)(invalid)).toBe(false)
          }).pipe(Effect.provide(services))
        )
      )
    ))
  it.effect("an invoked fact carries the declaration's display projection whole, and omits it when there is none", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            yield* activate
            yield* dispatch("invoked", Effect.succeed("ran"), true, described)
            const [row] = yield* facts
            // Whole, not bounded: four short fields its owner already
            // validated, where a truncation marker would read as a
            // declaration that claimed something unreadable.
            expect(row?.payload).toMatchObject({ phase: "invoked", descriptor: described.descriptor })
            // A declaration that claimed nothing writes no key, not a null.
            expect(
              Schema.encodeUnknownSync(CallFact.Fact)({
                version: 1,
                phase: "invoked",
                callId: call.callId,
                identity: call.identity,
                flowName: call.flowName,
                input: call.input
              })
            ).not.toHaveProperty("descriptor")
          }).pipe(Effect.provide(services))
        )
      )
    ))
})
