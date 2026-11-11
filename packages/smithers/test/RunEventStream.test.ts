/** An engine observation can settle before the control journal's terminal transaction. */
import { NodeCrypto } from "@effect/platform-node"
import { Control, ControlExecutor, ControlLive, ControlRuntime } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as RunEventStream from "../src/cli/RunEventStream.ts"
import * as ControlDatabase from "../src/internal/ControlDatabase.ts"

const stack = (executor: ControlExecutor.Service) => {
  const database = Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "run-event-stream-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    ).pipe(Effect.map((directory) => ControlDatabase.layer(join(directory, "control.sqlite"))))
  )
  const journal = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
    Layer.provide(database),
    Layer.orDie
  )
  const dependencies = Layer.mergeAll(
    ControlRuntime.layerMemory({
      flows: [{
        flowId: "system/test",
        description: "Terminal transaction probe",
        deployClass: false,
        envelope: { capabilities: [], flows: [], budget: {} }
      }]
    }).pipe(Layer.provide(NodeCrypto.layer)),
    journal,
    NotificationQueue.layer.pipe(Layer.provide(journal)),
    ControlExecutor.layer(executor),
    Registry.layerNoop()
  )
  return ControlLive.layer.pipe(Layer.provideMerge(dependencies))
}

for (const status of ["completed", "failed", "cancelled"] as const) {
  it.each([undefined, { sequence: 1_000_000 }])(
    `waits for committed ${status} before draining the journal (after=%j)`,
    async (after) => {
      // The injected executor deliberately reports an engine ahead of the
      // real control runtime and journal. Their own transitions stay real.
      const executor = ControlExecutor.makeNoop({
        readExecution: () => Effect.succeed({ _tag: "Observed" as const, status })
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime.ControlRuntime
          const real = yield* Control.Control
          const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
          const token = yield* runtime.lookupApproval(card.approval.target)
          yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
          const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
          if (launched._tag !== "Started") return yield* Effect.die("expected admission")
          const runId = launched.run.runId
          const secondRead = yield* Deferred.make<void>()
          let reads = 0
          const observed = Control.Control.of({
            ...real,
            list: (request) =>
              real.list(request).pipe(Effect.tap(() => {
                reads++
                return reads === 2 ? Deferred.succeed(secondRead, undefined) : Effect.void
              }))
          })
          const followed = yield* RunEventStream.events(runId, true, after).pipe(
            Stream.runCollect,
            Effect.provideService(Control.Control, observed),
            Effect.forkChild({ startImmediately: true })
          )
          // An observed terminal state alone must not close the stream. A
          // second status read proves it stayed live without a sleep race.
          yield* Deferred.await(secondRead).pipe(Effect.timeout("2 seconds"))
          expect((yield* runtime.getRun(runId)).status).toBe("accepted")
          const receipt = yield* real.cancel({ runId, idempotencyKey: `settle-${status}` })
          expect(receipt).toMatchObject({ _tag: "Terminal", status })
          const events = Array.from(yield* Fiber.join(followed).pipe(Effect.timeout("2 seconds")))
          if (after === undefined) {
            expect(events.filter((event) => event.kind === `control.run.${status}`)).toHaveLength(1)
            expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length)
          } else expect(events).toEqual([])
        }).pipe(
          Effect.provide(stack(executor)),
          Effect.scoped
        )
      )
    }
  )
}

it.each(
  [
    ["absent", undefined],
    ["legacy", "memory-owner"],
    ["invalid", "{}"],
    ["foreign", JSON.stringify({ hostId: "foreign-host", pid: 2_147_483_647, nonce: "foreign" })],
    ["uninspectable", JSON.stringify({ hostId: hostname(), pid: 0, nonce: "unknown" })]
  ] as const
)("keeps following when a terminal engine's owner is %s", async (_, ownerId) => {
  const executor = ControlExecutor.makeNoop({
    readExecution: () => Effect.succeed({ _tag: "Observed" as const, status: "completed" as const })
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime.ControlRuntime
      const real = yield* Control.Control
      const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
      const token = yield* runtime.lookupApproval(card.approval.target)
      yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
      const launch = yield* runtime.launch(card.planId, card.digest, card.envelope)
      if (launch._tag !== "Started") return yield* Effect.die("expected admission")
      const secondRead = yield* Deferred.make<void>()
      let reads = 0
      // Fault injection at the Effect service boundary: an absent, legacy or
      // foreign identity is not proof that a local writer has died.
      const uncertain = Control.Control.of({
        ...real,
        list: (request) =>
          real.list(request).pipe(
            Effect.map((page) =>
              page._tag === "runs"
                ? { ...page, items: page.items.map((run) => ({ ...run, ownerId, parkedBy: undefined })) }
                : page
            ),
            Effect.tap(() => {
              reads++
              return reads === 2 ? Deferred.succeed(secondRead, undefined) : Effect.void
            })
          )
      })
      const followed = yield* RunEventStream.events(launch.run.runId, true).pipe(
        Stream.runCollect,
        Effect.provideService(Control.Control, uncertain),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(secondRead).pipe(Effect.timeout("2 seconds"))
      expect((yield* runtime.getRun(launch.run.runId)).status).toBe("accepted")
      yield* Fiber.interrupt(followed)
    }).pipe(Effect.provide(stack(executor)), Effect.scoped)
  )
})

/** One promotion row expands into itself plus one delivery per message, all at one sequence. */
const expanded = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    for (
      const [eventType, payload] of [
        ["flows/notifications/Promoted", { boundary: "turn", ids: ["one", "two"] }],
        ["plain", {}]
      ] as const
    ) {
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make("/test"),
          eventType,
          payload
        })
      )
    }
  })

it("resumes a page that ends inside an expanded journal entry without skipping its deliveries", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const runId = "paged-expansion"
      yield* expanded(runId)
      const full = Array.from(yield* RunEventStream.events(runId, false).pipe(Stream.runCollect))
      expect(full.map((event) => event.kind)).toEqual([
        "flows/notifications/Promoted",
        "control.steer.delivered",
        "control.steer.delivered",
        "plain"
      ])
      for (let count = 1; count <= full.length; count++) {
        const last = full[count - 1]!.cursor!
        const resumed = yield* RunEventStream.events(runId, false, last).pipe(Stream.runCollect)
        expect([...full.slice(0, count), ...resumed]).toEqual(full)
      }
    }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.orDie)
  )
})

it("drains the rest of an expanded entry after a follow ends inside it", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const runId = "followed-expansion"
      yield* expanded(runId)
      const real = yield* Control.Control
      const promoted = yield* Deferred.make<void>()
      // Fault injection at the Effect service boundary: the live watch stalls
      // right after the promotion, then the run reads as terminal, so the
      // final drain must resume inside the promotion's expansion.
      const stalled = Control.Control.of({
        ...real,
        list: () =>
          Deferred.await(promoted).pipe(
            Effect.as({ _tag: "runs" as const, items: [{ runId, status: "completed" }] } as never)
          ),
        watch: (filter) =>
          filter.follow === true
            ? real.watch(filter).pipe(
              Stream.take(1),
              Stream.tap(() => Deferred.succeed(promoted, undefined)),
              Stream.concat(Stream.never)
            )
            : real.watch(filter)
      })
      const followed = yield* RunEventStream.events(runId, true).pipe(
        Stream.runCollect,
        Effect.provideService(Control.Control, stalled),
        Effect.timeout("2 seconds")
      )
      expect(Array.from(followed)).toEqual(
        Array.from(yield* real.watch({ runId, follow: false }).pipe(Stream.runCollect))
      )
    }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.orDie)
  )
})
