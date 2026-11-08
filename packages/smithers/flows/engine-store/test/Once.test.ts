import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * `Action.once` on the durable engine: a write keyed by the execution and the
 * dispatch survives a crash at every point around it, with exactly one object
 * made and the step settling to it.
 *
 * Each case runs two incarnations of one engine over one SQLite file, as a
 * Durable Object host does after an eviction (`HostedEngine.test.ts`): the
 * first stops at a chosen point and never answers, the second takes the run
 * and adopts the attempt the first left running. The provider is a real table
 * in the same store, written and read through the injected `SqlClient`; the
 * crash is a gate the first incarnation's own services park on, and for the
 * record its real journal and attempt store, wrapped so that no write lands
 * after the `succeeded` crossing commits. Nothing is mocked.
 *
 * - Before the write: the second incarnation re-runs the body and writes once.
 * - After the write, before the record: the second re-runs the body, and
 *   `once` finds the first's object instead of writing again.
 * - During the record (the `succeeded` crossing committed, `finish` not): the
 *   second settles from the crossing and the body never runs again.
 */
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership } from "@smthrs/run-store"
import * as Context from "effect/Context"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "once" as never, changeId: "once" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** A single-instance host: an earlier incarnation on this host is gone, because the host runs one at a time. */
const singleInstance: Ownership.LivenessCheck = (owner, context) =>
  owner.hostId === context.claimant.hostId
    ? Effect.succeed(false)
    : Ownership.leaseLiveness()(owner, context)

const first: Ownership.OwnerId = { hostId: "durable-object", pid: 1, nonce: "first" }
const second: Ownership.OwnerId = { hostId: "durable-object", pid: 2, nonce: "second" }

let directory: string
let filename: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "once-engine-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | (EffectDigest.Digest | SecureRandom.SecureRandom)>
) => Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

/** The one step: send a message through `once`, answering the message the provider holds. */
const Send = Action.make("Once/Send", {
  payload: {},
  success: Schema.String,
  tier: "irreversible",
  idempotencyKey: "once"
})
const Sender = Flow.make("Once/Sender", {
  payload: {},
  success: Schema.String,
  body: () => Send.call({})
})

/** Where the first incarnation stops: never, before the write, after the write, or while recording the outcome. */
type Crash = "none" | "before-write" | "after-write" | "during-record"

/** What both incarnations did, shared across them as the provider's table is. */
interface Observed {
  /** Each entry into the step's body: which incarnation, whether it re-ran an unsettled attempt, the key it read. */
  readonly entries: Array<{ readonly by: string; readonly redispatch: boolean; readonly key: string }>
  /** Each call the provider answered, by incarnation. */
  readonly calls: Array<{ readonly by: string; readonly call: "find" | "perform" }>
}

/** The provider: one row per message, keyed by the write's key, in the engine's own database. */
const sends = (crash: Crash, gate: Deferred.Deferred<void>, reached: Deferred.Deferred<void>, observed: Observed) =>
  Send.toLayer(() =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const fence = yield* Action.CurrentFence
      if (fence === undefined) return yield* Effect.die("the durable engine supplies a fence")
      const by = fence.owner.nonce
      const key = yield* Action.effectKey("send")
      observed.entries.push({ by, redispatch: yield* Action.CurrentRedispatch, key })
      // The first incarnation dies here: it took the attempt and never reached the write.
      if (by === "first" && crash === "before-write") {
        yield* Deferred.succeed(reached, undefined)
        yield* Deferred.await(gate)
      }
      return yield* Action.once(
        "send",
        Action.keyed({
          find: (key) =>
            Effect.gen(function*() {
              observed.calls.push({ by, call: "find" })
              const rows = yield* sql<{ readonly text: string }>`SELECT text FROM effect_objects WHERE key = ${key}`
              return Option.fromUndefinedOr(rows[0]?.text)
            }).pipe(Effect.orDie),
          perform: (key) =>
            Effect.gen(function*() {
              observed.calls.push({ by, call: "perform" })
              yield* sql`INSERT INTO effect_objects (key, text) VALUES (${key}, ${`sent by ${by}`})`.pipe(Effect.orDie)
              // The first incarnation dies here: the provider made the message, and its answer never came back.
              if (by === "first" && crash === "after-write") {
                yield* Deferred.succeed(reached, undefined)
                yield* Deferred.await(gate)
              }
              return `sent by ${by}`
            })
        })
      )
    })
  )

/**
 * The stores an incarnation runs over. For a crash while recording, the first incarnation dies between the two
 * records that settle its attempt: the `succeeded` crossing (a patch of the attempt row) has committed, and no write
 * after it lands. Every later journal transaction fails, which rolls back whatever it opened, as a dead process's
 * would; parking one instead would hold SQLite's write lock, which no dead process does.
 */
const stores = (crash: Crash, owner: Ownership.OwnerId, reached: Deferred.Deferred<void>) => {
  const real = Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj)
  if (crash !== "during-record" || owner.nonce !== "first") return real
  let crossed = false
  const attempts = Layer.effect(
    AttemptStore.AttemptStore,
    Effect.map(AttemptStore.AttemptStore, (store) => ({
      ...store,
      patch: (id: AttemptStore.AttemptId, patch: AttemptStore.AttemptPatch, by: Ownership.OwnerId) =>
        Effect.tap(store.patch(id, patch, by), (patched) =>
          Effect.sync(() => {
            if (
              patched._tag === "Patched" && JSON.stringify(patch.meta ?? null).includes(`"effectCrossing":"succeeded"`)
            ) {
              crossed = true
            }
          }))
    }))
  )
  const journal = Layer.effect(
    Journal.Journal,
    Effect.map(Journal.Journal, (store) => ({
      ...store,
      emitDeferred: (input, by) =>
        Effect.suspend(() =>
          crossed
            ? Effect.interrupt
            : store.emitDeferred!(input, by)
        ),
      transact: <A, E, R>(effect: Effect.Effect<A, E, R>, options?: { readonly partition?: string | undefined }) =>
        Effect.suspend(() =>
          crossed
            ? Effect.andThen(Deferred.succeed(reached, undefined), Effect.die("the process died after the crossing"))
            : store.transact(effect, options)
        )
    }))
  )
  return Layer.provideMerge(Layer.merge(attempts, journal), real)
}

const incarnation = (
  crash: Crash,
  owner: Ownership.OwnerId,
  gate: Deferred.Deferred<void>,
  reached: Deferred.Deferred<void>,
  observed: Observed
) =>
  Layer.build(
    Interpreter.layer(Sender).pipe(
      Layer.provideMerge(sends(crash, gate, reached, observed)),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        EngineStore.layer({
          owner: { hostId: owner.hostId },
          journalSource: `${owner.hostId}-engine`,
          isAlive: singleInstance,
          sweep: { host: "once" }
        }).pipe(
          Layer.provide(OwnerIdentity.layerConstant(owner)),
          Layer.provideMerge(stores(crash, owner, reached))
        )
      )
    )
  )

const rows = (context: Context.Context<SqlClient.SqlClient>) =>
  Effect.provide(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly key: string; readonly text: string }>`SELECT key, text FROM effect_objects`),
    context
  ).pipe(Effect.orDie)

const once = { executionId: "once", payload: {} }

/**
 * Starts the run on the first incarnation and waits until it stops at `crash`; then the second incarnation takes the
 * run, adopts the attempt the first left running, and settles it. The first is released afterwards, and its drive
 * ends on the fence it lost. Answers what the second settled to and what both did.
 */
const crashAt = (crash: Exclude<Crash, "none">) =>
  Effect.gen(function*() {
    const gate = yield* Deferred.make<void>()
    const reached = yield* Deferred.make<void>()
    const observed: Observed = { entries: [], calls: [] }
    const firstContext = yield* incarnation(crash, first, gate, reached, observed)
    yield* Effect.provide(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`CREATE TABLE effect_objects (key TEXT PRIMARY KEY, text TEXT NOT NULL)`).pipe(Effect.orDie),
      firstContext
    )
    const firstRuntime = yield* Effect.provide(FlowRuntime.FlowRuntime, firstContext)
    yield* firstRuntime.execute(Sender, { ...once, discard: true })
    yield* Deferred.await(reached)

    const secondContext = yield* incarnation(crash, second, gate, reached, observed)
    const secondRuntime = yield* Effect.provide(FlowRuntime.FlowRuntime, secondContext)
    expect(yield* Effect.provide(EngineStore.drive(Sender, once), secondContext))
      .toEqual({ _tag: "Settled", status: "completed" })
    const settled = yield* secondRuntime.poll(Sender, "once")

    yield* Deferred.succeed(gate, undefined)
    expect(yield* Effect.provide(EngineStore.drive(Sender, once), firstContext))
      .toEqual({ _tag: "Settled", status: "completed" })
    // The released incarnation changed nothing the second one settled.
    expect(yield* secondRuntime.poll(Sender, "once")).toEqual(settled)
    return { settled, observed, rows: yield* rows(secondContext) }
  })

/** The result a poll answered, when the run completed successfully. */
const result = (settled: Option.Option<Flow.Result<string, unknown>>) =>
  Option.flatMap(
    settled,
    (value) => value._tag === "Complete" && Exit.isSuccess(value.exit) ? Option.some(value.exit.value) : Option.none()
  )

describe("Action.once on the durable engine", () => {
  it("writes once and replays the settled step without asking the provider again", () =>
    run(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const reached = yield* Deferred.make<void>()
      const observed: Observed = { entries: [], calls: [] }
      const context = yield* incarnation("none", first, gate, reached, observed)
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`CREATE TABLE effect_objects (key TEXT PRIMARY KEY, text TEXT NOT NULL)`).pipe(Effect.orDie),
        context
      )
      const runtime = yield* Effect.provide(FlowRuntime.FlowRuntime, context)
      expect(yield* runtime.execute(Sender, once)).toBe("sent by first")
      expect(observed.calls).toEqual([{ by: "first", call: "find" }, { by: "first", call: "perform" }])

      // Another incarnation driving the settled run reads the record; the provider hears nothing.
      const later = yield* incarnation("none", second, gate, reached, observed)
      expect(yield* Effect.provide(EngineStore.drive(Sender, once), later))
        .toEqual({ _tag: "Settled", status: "completed" })
      expect(result(yield* (yield* Effect.provide(FlowRuntime.FlowRuntime, later)).poll(Sender, "once")))
        .toEqual(Option.some("sent by first"))
      expect(observed.calls).toHaveLength(2)
      expect(observed.entries).toEqual([{ by: "first", redispatch: false, key: observed.entries[0]!.key }])
      const made = yield* rows(later)
      expect(made).toEqual([{ key: observed.entries[0]!.key, text: "sent by first" }])
    })))

  it("re-runs a step that died before its write, and writes once", () =>
    run(Effect.gen(function*() {
      const { observed, rows: made, settled } = yield* crashAt("before-write")
      expect(made).toEqual([{ key: observed.entries[0]!.key, text: "sent by second" }])
      expect(result(settled)).toEqual(Option.some("sent by second"))
      const [died, adopted] = observed.entries
      expect(observed.entries.map(({ by, redispatch }) => ({ by, redispatch }))).toEqual([
        { by: "first", redispatch: false },
        { by: "second", redispatch: true }
      ])
      expect(adopted!.key).toBe(died!.key)
      // The released first incarnation looks before it writes and finds the second's message.
      expect(observed.calls).toEqual([
        { by: "second", call: "find" },
        { by: "second", call: "perform" },
        { by: "first", call: "find" }
      ])
    })))

  it("adopts the write a step made before it died, instead of writing again", () =>
    run(Effect.gen(function*() {
      const { observed, rows: made, settled } = yield* crashAt("after-write")
      expect(made).toEqual([{ key: observed.entries[0]!.key, text: "sent by first" }])
      expect(result(settled)).toEqual(Option.some("sent by first"))
      expect(observed.entries.map(({ by, redispatch }) => ({ by, redispatch }))).toEqual([
        { by: "first", redispatch: false },
        { by: "second", redispatch: true }
      ])
      expect(observed.entries[1]!.key).toBe(observed.entries[0]!.key)
      expect(observed.calls.filter(({ call }) => call === "perform")).toEqual([{ by: "first", call: "perform" }])
      expect(observed.calls).toEqual([
        { by: "first", call: "find" },
        { by: "first", call: "perform" },
        { by: "second", call: "find" }
      ])
    })))

  it("settles a step that died while recording its outcome from the crossing, without running it again", () =>
    run(Effect.gen(function*() {
      const { observed, rows: made, settled } = yield* crashAt("during-record")
      expect(made).toEqual([{ key: observed.entries[0]!.key, text: "sent by first" }])
      expect(result(settled)).toEqual(Option.some("sent by first"))
      // One entry into the body, one lookup, one write: the second incarnation read the committed crossing.
      expect(observed.entries.map(({ by, redispatch }) => ({ by, redispatch }))).toEqual([
        { by: "first", redispatch: false }
      ])
      expect(observed.calls).toEqual([{ by: "first", call: "find" }, { by: "first", call: "perform" }])
    })))
})
