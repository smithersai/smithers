/**
 * A database connection lost while a step's outcome is being recorded is an
 * infrastructure failure, not the step's outcome. The attempt must stay
 * adoptable, and a later drive must record the step's result.
 *
 * The engine runs against Postgres directly and through PgBouncer in
 * transaction pooling, the way Cloudflare Hyperdrive treats a client. The
 * step holds the engine schema's writer lock as it returns, so the engine's
 * transaction recording the outcome waits on it; the case then terminates
 * that server connection mid-transaction and lets the lock go.
 */
import * as Pg from "@effect/sql-pg"
import { DurableWriter, PostgresDatabase } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { withCrypto } from "./Sha256.ts"

/** The compose Postgres (`apps/mvp/docker-compose.yml`), which the compose PgBouncer fronts. */
const composePostgresUrl = process.env.SMITHERS_TEST_COMPOSE_PG_URL ??
  "postgresql://smithers:smithers@127.0.0.1:54321/smithers"
/** The server the storage matrix provides, else the compose Postgres. */
const postgresUrl = process.env.SMITHERS_TEST_PG_URL ?? composePostgresUrl
const pgbouncerUrl = process.env.SMITHERS_TEST_PGBOUNCER_URL ??
  "postgresql://smithers:smithers@127.0.0.1:54322/smithers"

/** Only a refused connection means the service is absent; any other error fails the suite. */
const listening = (url: string): Promise<boolean> => {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port || 5432) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once(
      "error",
      (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve(false) : reject(error)
    )
  })
}

/**
 * Each engine endpoint, with `server`, the Postgres whose sessions the engine's
 * connections are: the case locks and terminates them there.
 */
const targets = [
  { name: "Postgres", url: postgresUrl, server: postgresUrl, available: await listening(postgresUrl) },
  {
    name: "PgBouncer in transaction pooling",
    url: pgbouncerUrl,
    server: composePostgresUrl,
    available: (await listening(composePostgresUrl)) && (await listening(pgbouncerUrl))
  }
].map((target) => ({
  ...target,
  label: target.available
    ? target.name
    : `${target.name}, skipped: nothing listens at ${
      new URL(target.url).host
    } (docker compose up -d postgres pgbouncer in apps/mvp)`
}))

/** Runs `effect` with a plain client on the Postgres `server`, outside any engine schema and pool. */
const admin = <A, E>(server: string, effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Pg.PgClient.layer({ url: Redacted.make(server), maxConnections: 1 })),
      Effect.scoped
    )
  )

const Record = Action.make("connection-loss/Record", { payload: { label: Schema.String }, success: Schema.String })
const Answer = Flow.make("connection-loss/Answer", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Record.call({ label: "question" }).pipe(Node.andThen(Record.call({ label: "answer" }))))
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "loss" as never, changeId: "loss" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** An earlier incarnation on the same host is gone; the host runs one at a time. */
const singleInstance: Ownership.LivenessCheck = (owner, context) =>
  owner.hostId === context.claimant.hostId ? Effect.succeed(false) : Ownership.leaseLiveness()(owner, context)

/**
 * One incarnation's runtime: the engine for `executionId` at `url`, in
 * `schema`, its server connections named after the schema so the step can
 * find and terminate them.
 */
const incarnation = (
  url: string,
  schema: string,
  executionId: string,
  owner: Ownership.OwnerId,
  record: (label: string) => Effect.Effect<string>
) => {
  const database = PostgresDatabase.layer({
    url,
    driver: Pg,
    schema,
    postgres: { applicationName: schema }
  })
  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, DurableWriter.layer())))
  const engine = EngineStore.layer({
    owner: { hostId: owner.hostId },
    journalSource: `${owner.hostId}-engine`,
    isAlive: singleInstance,
    canExecute: (row) => Effect.succeed(row.runId === executionId),
    sweep: { host: executionId }
  }).pipe(
    Layer.provide(OwnerIdentity.layerConstant(owner)),
    Layer.provideMerge(Layer.mergeAll(stores, StepBoundary.layerUnsupported, jj)),
    Layer.provideMerge(database)
  )
  return Interpreter.layerWithImplementations(Answer, Record.toLayer(({ label }) => record(label))).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(engine)
  )
}

describe("a connection lost while a step's outcome is recorded", () => {
  for (const target of targets) {
    it.skipIf(!target.available)(`leaves the attempt adoptable for a later drive (${target.label})`, async () => {
      const schema = `loss_${randomUUID().replaceAll("-", "")}`
      const executionId = `answer-${randomUUID()}`
      const recorded: Array<string> = []
      let cut: Promise<void> | undefined
      /**
       * Takes the engine schema's writer lock on a session of its own, waits
       * for the engine's next transaction to queue on it, terminates that
       * server connection, and lets the lock go.
       */
      const dropNextTransaction = (locked: () => void) =>
        admin(
          target.server,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`SELECT pg_advisory_lock(hashtextextended(${schema}, 2099))`
            locked()
            yield* TestDatabase.until(Effect.map(
              sql<{ readonly waiting: number }>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE application_name = ${schema} AND wait_event_type = 'Lock'
          `,
              (rows) => rows[0]!.waiting > 0
            ))
            yield* sql`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name = ${schema} AND wait_event_type = 'Lock'
        `
            yield* sql`SELECT pg_advisory_unlock(hashtextextended(${schema}, 2099))`
          })
        )
      const record = (label: string) =>
        Effect.gen(function*() {
          recorded.push(label)
          if (label === "answer" && cut === undefined) {
            yield* Effect.callback<void>((resume) => {
              cut = dropNextTransaction(() => resume(Effect.void))
            })
          }
          return label
        })
      const first: Ownership.OwnerId = { hostId: "execution-object", pid: 1, nonce: "first" }
      const second: Ownership.OwnerId = { hostId: "execution-object", pid: 2, nonce: "second" }
      const drive = (owner: Ownership.OwnerId) =>
        Effect.runPromise(withCrypto(Effect.scoped(
          Effect.gen(function*() {
            const driven = yield* EngineStore.drive(Answer, { executionId, payload: {} })
            const answer = yield* (yield* FlowRuntime.FlowRuntime).poll(Answer, executionId)
            return { driven, answer }
          }).pipe(Effect.provide(incarnation(target.url, schema, executionId, owner, record)))
        )))
      try {
        // The lost connection is not the step's outcome: the run did not
        // settle, and its owner released it for the next drive, due at once.
        expect((await drive(first)).driven).toEqual({ _tag: "Unfinished" })
        await cut

        const recovered = await drive(second)
        expect(recovered.driven).toEqual({ _tag: "Settled", status: "completed" })
        expect(Option.map(recovered.answer, (result) => result._tag === "Complete" && result.exit))
          .toEqual(Option.some(Exit.succeed("answer")))
        // The answer step's attempt was adopted and run again; the question
        // step's recorded result was replayed.
        expect(recorded).toEqual(["question", "answer", "answer"])
      } finally {
        await admin(
          target.server,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
          })
        )
      }
    })
  }
})
