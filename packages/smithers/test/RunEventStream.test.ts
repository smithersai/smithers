/** An engine observation can settle before the control journal's terminal transaction. */
import { NodeCrypto } from "@effect/platform-node"
import { Control, ControlExecutor, ControlLive, ControlRuntime } from "@smthrs/control"
import { SqlJournal } from "@smthrs/journal"
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
  it.each([undefined, 1_000_000])(
    `waits for committed ${status} before draining the journal (after=%s)`,
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
