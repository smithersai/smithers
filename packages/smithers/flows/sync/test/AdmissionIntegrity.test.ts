import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as Protocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestEntry from "./fixtures/entry.ts"

const runId = "integrity-run" as JournalEvent.RunId
const entry = (sequence: number): JournalEvent.Entry =>
  TestEntry.entry(runId, sequence, { eventId: `entry-${sequence}`, emittedAtMs: 0 })
const scope = { _tag: "Run", runId } as const
const bad = [
  { label: "foreign run", entries: [entry(0), { ...entry(1), runId: "foreign" }], code: "protocol_violation" },
  { label: "descending sequence", entries: [entry(1), entry(0)], code: "protocol_violation" },
  { label: "duplicate sequence", entries: [entry(0), entry(0)], code: "protocol_violation" },
  { label: "malformed envelope", entries: [entry(0), { ...entry(1), sourceSeq: -1 }], code: "decode_failed" },
  { label: "non-JSON payload", entries: [entry(0), { ...entry(1), payload: Number.NaN }], code: "decode_failed" },
  {
    label: "malformed command",
    entries: [entry(0), { ...entry(1), eventType: BranchProtocol.CommandEvent, payload: { commandId: "c" } }],
    code: "decode_failed"
  },
  {
    label: "foreign branch payload",
    entries: [entry(0), {
      ...entry(1),
      eventType: BranchProtocol.CommandEvent,
      payload: { branchId: "foreign", commandId: "c", participantId: "p", name: "branch.say", args: "x", target: "" }
    }],
    code: "protocol_violation"
  }
] as const

describe("sync admission integrity", () => {
  for (const sample of bad) {
    for (const live of [false, true]) {
      it.effect(`refuses ${sample.label} before any client ${live ? "live" : "bootstrap"} application`, () =>
        Effect.gen(function*() {
          const values = sample.entries as unknown as ReadonlyArray<JournalEvent.Entry>
          let applied = 0
          const remote = yield* SyncClient.make({
            client: {
              "Sync.Read": () => Effect.succeed({ entries: live ? [] : values, cursors: [], done: true }),
              "Sync.Subscribe": () =>
                Stream.succeed({ generation: 0, _tag: "Entries", runId, fromSeq: 0, toSeq: 1, entries: values })
            } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
          })
          const error = yield* Effect.flip(
            remote.subscribe({
              scope,
              cursors: [],
              apply: () =>
                Effect.sync(() => {
                  applied++
                })
            })
              .pipe(Stream.take(2), Stream.runDrain)
          )
          expect(error).toMatchObject({ code: sample.code, cause: expect.any(String) })
          expect(applied).toBe(0)
          expect((yield* remote.progress).applied).toEqual([])
          expect((yield* remote.progress).delivered).toEqual([])
        }))
    }
    for (const path of ["read", "run live", "workspace live"] as const) {
      it.effect(`refuses ${sample.label} before serving a partial ${path} batch`, () =>
        Effect.gen(function*() {
          const entries = sample.entries as unknown as ReadonlyArray<JournalEvent.Entry>
          const server = yield* SyncServer.makeLive.pipe(Effect.provide(Layer.mergeAll(
            Journal.layerNoop({
              entries: () => Effect.succeed({ entries, hasMore: false }),
              stream: () => Stream.fromIterable(entries)
            }),
            RunCatalog.layerStatic([runId])
          )))
          const seen: Array<Protocol.Frame> = []
          const result = path === "read"
            ? server.read({ protocolVersion: 1, scope, cursors: [], limit: 10 })
            : server.subscribe({
              protocolVersion: 1,
              scope: path === "run live" ? scope : { _tag: "Workspace" },
              cursors: [],
              credit: 2
            })
              .pipe(
                Stream.tap((frame) =>
                  Effect.sync(() => {
                    seen.push(frame)
                  })
                ),
                Stream.runDrain
              )
          const error = yield* Effect.flip(result.pipe(Effect.provide(SyncPrincipal.layerWorkspace("integrity"))))
          expect(error).toMatchObject({ code: sample.code, cause: expect.any(String) })
          expect(seen).toEqual([])
        }))
    }
  }

  it.effect("validates direct request envelopes before accessing a journal or transport", () =>
    Effect.gen(function*() {
      let called = 0
      const server = yield* SyncServer.makeLive.pipe(Effect.provide(Layer.mergeAll(
        Journal.layerNoop({
          entries: () =>
            Effect.sync(() => {
              called++
              return { entries: [], hasMore: false }
            })
        }),
        RunCatalog.layerStatic([runId])
      )))
      const remote = yield* SyncClient.make({
        client: {
          "Sync.Read": () =>
            Effect.sync(() => {
              called++
              return { entries: [], cursors: [], done: true }
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      for (
        const input of [null, { scope: { _tag: "Invalid" }, cursors: [] }, {
          scope,
          cursors: [{ generation: 0, runId, afterSeq: -1 }]
        }]
      ) {
        for (
          const operation of [
            server.read(input as unknown as Protocol.ReadRequest),
            server.subscribe(input as unknown as Protocol.SubscribeRequest).pipe(Stream.runDrain),
            remote.subscribe(input as SyncClient.SubscribeOptions).pipe(Stream.runDrain)
          ]
        ) expect(yield* Effect.flip(operation)).toMatchObject({ code: "invalid_request", cause: expect.any(String) })
      }
      expect(called).toBe(0)
    }))

  it.effect("retains the existing defaults of admitted historical command fields", () =>
    Effect.gen(function*() {
      const branchId = "historic" as BranchProtocol.BranchId
      const historic = {
        ...entry(0),
        runId: BranchProtocol.branchRunId(branchId),
        eventType: BranchProtocol.CommandEvent,
        payload: { commandId: "old", participantId: "alice", name: "branch.say" }
      }
      const remote = yield* SyncClient.make({
        client: {
          "Sync.Read": () =>
            Effect.succeed({
              entries: [historic],
              cursors: [{ runId: historic.runId, afterSeq: historic.seq, generation: 0 }],
              done: true
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      expect(
        yield* remote.subscribe({ scope: { _tag: "Run", runId: historic.runId }, cursors: [] }).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )
        .toEqual([historic])
    }))

  it.effect("refuses a live frame wholly outside the requested run before apply", () =>
    Effect.gen(function*() {
      let applied = 0
      const foreign = "foreign" as JournalEvent.RunId
      const remote = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": () =>
            Stream.succeed({
              generation: 0,
              _tag: "Entries",
              runId: foreign,
              fromSeq: 0,
              toSeq: 0,
              entries: [{ ...entry(0), runId: foreign }]
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const error = yield* Effect.flip(
        remote.subscribe({
          scope,
          cursors: [],
          apply: () =>
            Effect.sync(() => {
              applied++
            })
        })
          .pipe(Stream.take(1), Stream.runDrain)
      )
      expect(error).toMatchObject({ code: "protocol_violation", cause: expect.any(String) })
      expect(applied).toBe(0)
      expect((yield* remote.progress).delivered).toEqual([])
    }))
})
