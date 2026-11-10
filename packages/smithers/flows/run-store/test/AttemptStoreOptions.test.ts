import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as AttemptStore from "../src/AttemptStore.vibe"
import * as Migrations from "../src/Migrations.vibe"
import type { OwnerId } from "../src/Ownership.vibe"
import * as RunStore from "../src/RunStore.vibe"

const owner: OwnerId = { hostId: "host", pid: 1, nonce: "n" }

const base = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const withStore = <A, E>(
  options: AttemptStore.Options,
  body: (store: AttemptStore.Service) => Effect.Effect<A, E, RunStore.RunStore | DurableWriter | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const store = yield* AttemptStore.makeWith(options)
    const runs = yield* RunStore.RunStore
    yield* runs.create("run", "{}")
    yield* runs.claimAndOwn("run", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)
    return yield* body(store)
  }).pipe(Effect.provide(base), Effect.scoped)

const attempt = (overrides: Partial<AttemptStore.Attempt> = {}): AttemptStore.Attempt => ({
  runId: "run",
  stepKeyDigest: "digest",
  attempt: 0,
  state: "in-progress",
  startedAtMs: 1,
  meta: { a: 1 },
  ...overrides
})

describe("AttemptStore options", () => {
  it.effect("accepts a configured in-progress vocabulary", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.put(attempt(), owner)).toEqual({ _tag: "Inserted" })
          expect(yield* store.heartbeat("run", "digest", 0, owner, 2, { c: 1 })).toEqual({ _tag: "Updated" })
          expect(
            yield* store.finish(
              { runId: "run", stepKeyDigest: "digest", attempt: 0, state: "succeeded", finishedAtMs: 3 },
              owner
            )
          ).toEqual({ _tag: "Finished" })
        })
    ))

  it.effect("rejects finishing into a state the store still considers in progress", () =>
    withStore(
      { inProgressStates: ["in-progress", "retrying"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          const failure = yield* Effect.flip(
            store.finish(
              { runId: "run", stepKeyDigest: "digest", attempt: 0, state: "retrying", finishedAtMs: 3 },
              owner
            )
          )
          expect(failure.code).toBe("invalid_attempt")
        })
    ))

  it.effect("preserves a recorded error when finish omits one", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt({ error: { message: "mid-flight" } }), owner)
          yield* store.finish(
            { runId: "run", stepKeyDigest: "digest", attempt: 0, state: "failed", finishedAtMs: 3 },
            owner
          )
          const row = yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 })
          expect(Option.getOrThrow(row).error).toEqual({ message: "mid-flight" })
        })
    ))

  it.effect("lets finish replace a recorded error", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt({ error: { message: "mid-flight" } }), owner)
          yield* store.finish(
            {
              runId: "run",
              stepKeyDigest: "digest",
              attempt: 0,
              state: "failed",
              finishedAtMs: 3,
              error: { message: "terminal" }
            },
            owner
          )
          const row = yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 })
          expect(Option.getOrThrow(row).error).toEqual({ message: "terminal" })
        })
    ))

  it.effect("upserts a re-put attempt when configured to", () =>
    withStore(
      { inProgressStates: ["in-progress"], putMode: "upsert" },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          expect(yield* store.put(attempt({ meta: { a: 2 }, startedAtMs: 9 }), owner)).toEqual({ _tag: "Upserted" })
          const row = Option.getOrThrow(yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 }))
          expect(row.meta).toEqual({ a: 2 })
          expect(row.startedAtMs).toBe(9)
        })
    ))

  it.effect("never reopens a terminal attempt in upsert mode", () =>
    withStore(
      { inProgressStates: ["in-progress"], putMode: "upsert" },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          yield* store.finish({
            runId: "run",
            stepKeyDigest: "digest",
            attempt: 0,
            state: "succeeded",
            finishedAtMs: 3
          }, owner)
          const terminal = attempt({ state: "succeeded", finishedAtMs: 3 })
          expect(yield* store.put(terminal, owner)).toEqual({ _tag: "ExistingSame" })
          expect(yield* store.put({ ...terminal, meta: { a: 2 } }, owner)).toEqual({ _tag: "Conflict" })
          expect(Option.getOrThrow(
            yield* store.get({
              runId: terminal.runId,
              stepKeyDigest: terminal.stepKeyDigest,
              attempt: terminal.attempt
            })
          )).toMatchObject({
            state: "succeeded",
            finishedAtMs: 3,
            meta: { a: 1 }
          })
        })
    ))

  it.effect("snapshots the in-progress vocabulary when the store is built", () => {
    const states = ["in-progress"]
    return withStore(
      { inProgressStates: states, putMode: "upsert" },
      (store) =>
        Effect.gen(function*() {
          states[0] = "replaced"
          states.push("succeeded")
          yield* store.put(attempt(), owner)
          expect(yield* store.heartbeat("run", "digest", 0, owner, 2)).toEqual({ _tag: "Updated" })
          expect(
            yield* store.finish({
              runId: "run",
              stepKeyDigest: "digest",
              attempt: 0,
              state: "succeeded",
              finishedAtMs: 3
            }, owner)
          ).toEqual({ _tag: "Finished" })
        })
    )
  })

  it.effect("keeps first-writer-wins by default", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          expect(yield* store.put(attempt({ meta: { a: 2 } }), owner)).toEqual({ _tag: "Conflict" })
        })
    ))

  it.effect("upsert still respects the run fence", () =>
    withStore(
      { putMode: "upsert" },
      (store) =>
        Effect.gen(function*() {
          const other: OwnerId = { hostId: "host", pid: 2, nonce: "other" }
          expect(yield* store.put(attempt({ state: "running" }), other)).toEqual({ _tag: "FenceLost" })
          const original = attempt({
            state: "running",
            heartbeatAtMs: 2,
            checkpoint: { cursor: "original" },
            error: { message: "original" },
            outcome: { writer: "original" }
          })
          expect(yield* store.put(original, owner)).toEqual({ _tag: "Inserted" })
          const id = { runId: original.runId, stepKeyDigest: original.stepKeyDigest, attempt: original.attempt }
          const sql = yield* SqlClient.SqlClient
          const before = JSON.stringify(yield* sql`SELECT * FROM flows_attempts`)
          const runs = yield* RunStore.RunStore
          const stale = yield* runs.get("run")
          yield* TestClock.adjust("31001 millis")
          expect(
            yield* runs.claimAndOwn(
              "run",
              { status: stale.status, owner: stale.owner, heartbeatAtMs: stale.heartbeatAtMs },
              other,
              31_001,
              { expectedOwner: owner, checkedAtMs: 31_001, kind: "same-host-pid-dead" }
            )
          ).toEqual({ _tag: "Activated" })
          const replacement = attempt({
            state: "completed",
            startedAtMs: 9,
            heartbeatAtMs: 10,
            finishedAtMs: 11,
            checkpoint: { cursor: "replacement" },
            error: { message: "replacement" },
            outcome: { writer: "replacement" },
            meta: { a: 2 }
          })
          const stalePut = yield* store.put(replacement, owner)
          expect(JSON.stringify(yield* sql`SELECT * FROM flows_attempts`)).toBe(before)
          expect(Option.getOrThrow(yield* store.get(id))).toEqual(original)
          expect(stalePut).toEqual({ _tag: "FenceLost" })
          expect(yield* store.put(replacement, other)).toEqual({ _tag: "Upserted" })
          expect(Option.getOrThrow(yield* store.get(id))).toEqual(replacement)
        })
    ))

  it.effect("honours a configured checkpoint cap", () =>
    withStore(
      { inProgressStates: ["in-progress"], maxCheckpointBytes: 32 },
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.put(attempt({ checkpoint: "x".repeat(30) }), owner)).toEqual({ _tag: "Inserted" })
          expect(yield* store.put(attempt({ attempt: 1, checkpoint: "é".repeat(15) }), owner)).toEqual({
            _tag: "Inserted"
          })
          const failure = yield* Effect.flip(
            store.put(attempt({ attempt: 2, checkpoint: "x".repeat(31) }), owner)
          )
          expect(failure.code).toBe("invalid_attempt")
        })
    ))

  it.effect("admits an agent-session checkpoint above the historical 1 MiB cap", () =>
    withStore(
      { inProgressStates: ["in-progress"], maxCheckpointBytes: 8 * 1024 * 1024 },
      (store) =>
        Effect.gen(function*() {
          const conversation = "x".repeat(2 * 1024 * 1024)
          expect(yield* store.put(attempt({ checkpoint: { conversation } }), owner)).toEqual({ _tag: "Inserted" })
        })
    ))

  it.effect("patches opaque fields without touching state", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt({ error: { message: "kept" } }), owner)
          expect(yield* store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, { meta: { a: 3 } }, owner))
            .toEqual({ _tag: "Patched" })
          const row = Option.getOrThrow(yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 }))
          expect(row.meta).toEqual({ a: 3 })
          expect(row.error).toEqual({ message: "kept" })
          expect(row.state).toBe("in-progress")
        })
    ))

  it.effect("patch reports a missing row and an empty patch", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.patch({ runId: "run", stepKeyDigest: "missing", attempt: 0 }, { meta: 1 }, owner))
            .toEqual({ _tag: "NotFound" })
          yield* store.put(attempt(), owner)
          expect(yield* store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, {}, owner))
            .toEqual({ _tag: "Patched" })
        })
    ))

  it.effect("patch enforces the checkpoint cap and validates ids", () =>
    withStore(
      { maxCheckpointBytes: 16 },
      (store) =>
        Effect.gen(function*() {
          expect(
            (yield* Effect.flip(
              store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, { checkpoint: "y".repeat(64) }, owner)
            )).code
          ).toBe("invalid_attempt")
          expect(
            (yield* Effect.flip(store.patch({ runId: "", stepKeyDigest: "digest", attempt: 0 }, {}, owner))).code
          ).toBe("invalid_attempt")
        })
    ))

  it.effect("patch writes every optional field", () =>
    withStore(
      { inProgressStates: ["in-progress"] },
      (store) =>
        Effect.gen(function*() {
          yield* store.put(attempt(), owner)
          expect(
            yield* store.patch({ runId: "run", stepKeyDigest: "digest", attempt: 0 }, {
              checkpoint: { c: 1 },
              error: { e: 1 },
              outcome: { o: 1 },
              meta: { m: 1 }
            }, owner)
          ).toEqual({ _tag: "Patched" })
          const row = Option.getOrThrow(yield* store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 }))
          expect(row).toMatchObject({
            checkpoint: { c: 1 },
            error: { e: 1 },
            outcome: { o: 1 },
            meta: { m: 1 }
          })
        })
    ))

  it.effect("rejects an invalid options vocabulary", () =>
    Effect.gen(function*() {
      const hostile = Object.defineProperty({}, "inProgressStates", {
        enumerable: true,
        get: () => ["running"]
      })
      const failures = yield* Effect.forEach([
        { inProgressStates: [] },
        { inProgressStates: ["running", "running"] },
        { inProgressStates: [""] },
        { maxCheckpointBytes: 0 },
        { maxCheckpointBytes: AttemptStore.maximumCheckpointBytes + 1 },
        { putMode: "replace" },
        hostile
      ], (options) => Effect.flip(AttemptStore.makeWith(options as never)))
      expect(failures.every((failure) => failure.code === "invalid_attempt")).toBe(true)
      expect(failures.every((failure) => failure.method === "makeWith")).toBe(true)
      expect(
        failures.every((failure) => failure.message.startsWith("invalid_attempt: AttemptStore.makeWith: "))
      ).toBe(true)
    }).pipe(Effect.provide(base), Effect.scoped))

  it.effect("the noop store reports patch as unavailable", () =>
    Effect.gen(function*() {
      const store = AttemptStore.makeNoop()
      const failure = yield* Effect.flip(store.patch({ runId: "r", stepKeyDigest: "d", attempt: 0 }, {}, owner))
      expect(failure).toMatchObject({
        code: "unknown",
        method: "patch",
        message: "unknown: AttemptStore.patch: the store is unavailable in this environment"
      })
    }))

  it.effect("layerWith provides a configured store", () =>
    Effect.gen(function*() {
      const store = yield* AttemptStore.AttemptStore
      const runs = yield* RunStore.RunStore
      yield* runs.create("run", "{}")
      yield* runs.claimAndOwn("run", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)
      expect(yield* store.put(attempt(), owner)).toEqual({ _tag: "Inserted" })
    }).pipe(
      Effect.provide(
        Layer.provideMerge(AttemptStore.layerWith({ inProgressStates: ["in-progress"] }), base)
      ),
      Effect.scoped
    ))
})
