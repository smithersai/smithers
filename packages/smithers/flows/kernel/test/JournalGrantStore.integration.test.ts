import { afterEach, describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { PermissionRequired } from "@smthrs/capability/Permission"
import { DatabaseError, DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal } from "@smthrs/journal/Journal"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Context, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as GrantStore from "../src/GrantStore.ts"
import * as JournalGrantStore from "../src/JournalGrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const directories = new Set<string>()
const journalOptions: SqlJournal.SqlJournalOptions = { capacity: 64, overflow: "reject" }

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "flows-kernel-journal-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const database = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
  )

const journalLayer = (filename: string) => SqlJournal.layer(journalOptions).pipe(Layer.provide(database(filename)))

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

const buildJournal = (
  services: Layer.Layer<DurableWriter | SqlClient.SqlClient>
) =>
  Effect.map(
    Layer.build(SqlJournal.layer(journalOptions).pipe(Layer.provide(services))),
    (context) => Context.get(context, Journal)
  )

const options = {
  runId: "run-1",
  policyRunId: "policy",
  sourceId: "kernel",
  planDigest: "plan-1"
} as const

describe("JournalGrantStore real SQL integration", () => {
  it.effect("persists a grant, recreates the service, and replays authority from disk", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const filename = join(directory, "journal.sqlite")
      const workspace = join(directory, "workspace")
      const capability = new Capability({ action: "fs:read", resource: join(workspace, "readme.md") })
      const pattern = new CapabilityPattern({ action: "fs:read", resource: `${workspace}/**` })

      yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* JournalGrantStore.make(options)
            const waiter = yield* store.check(capability).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const pending = yield* awaitPending(store)
            yield* store.reply(pending.requestId, "remembered", pattern)
            yield* Fiber.join(waiter)
          }).pipe(Effect.provide(journalLayer(filename)))
        ).pipe(Effect.provide(Workspace.layer(workspace)))
      )

      yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const replayed = yield* JournalGrantStore.make({ ...options, attended: false })
            yield* replayed.check(capability)
            const journal = yield* Journal
            const page = yield* journal.entries({ runId: options.policyRunId as never, limit: 10 })
            expect(page.entries).toHaveLength(1)
          }).pipe(Effect.provide(journalLayer(filename)))
        ).pipe(Effect.provide(Workspace.layer(workspace)))
      )
    }))

  it.effect("rolls back an injected commit failure and activates no authority", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const filename = join(directory, "journal.sqlite")
      const workspace = join(directory, "workspace")
      const capability = new Capability({ action: "fs:read", resource: join(workspace, "readme.md") })
      const pattern = new CapabilityPattern({ action: "fs:read", resource: `${workspace}/**` })

      yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const writer = yield* DurableWriter
            const failingWriter = DurableWriter.of({
              write: (effect) =>
                writer.write(
                  Effect.flatMap(effect, () => Effect.fail(new DatabaseError({ code: "constraint" })))
                )
            })
            const failingServices = Layer.merge(
              Layer.succeed(SqlClient.SqlClient)(sql),
              Layer.succeed(DurableWriter)(failingWriter)
            )
            const failingJournal = yield* buildJournal(failingServices)
            const store = yield* JournalGrantStore.make(options).pipe(
              Effect.provideService(Journal, failingJournal)
            )
            const waiter = yield* store.check(capability).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const pending = yield* awaitPending(store)

            const failure = yield* Effect.flip(store.reply(pending.requestId, "remembered", pattern))
            expect(failure.code).toBe("journal_failed")
            expect(waiter.pollUnsafe()).toBeUndefined()
            expect(yield* store.list).toEqual([pending])
            const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_journal_events WHERE run_id = ${options.policyRunId}
          `
            expect(rows[0]?.count).toBe(0)
            yield* Fiber.interrupt(waiter)

            const healthyServices = Layer.merge(
              Layer.succeed(SqlClient.SqlClient)(sql),
              Layer.succeed(DurableWriter)(writer)
            )
            const healthyJournal = yield* buildJournal(healthyServices)
            const replayed = yield* JournalGrantStore.make({ ...options, attended: false }).pipe(
              Effect.provideService(Journal, healthyJournal)
            )
            expect(yield* Effect.flip(replayed.check(capability))).toBeInstanceOf(PermissionRequired)
          }).pipe(Effect.provide(database(filename)))
        ).pipe(Effect.provide(Workspace.layer(workspace)))
      )
    }))
})
