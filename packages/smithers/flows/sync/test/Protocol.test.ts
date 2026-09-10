/**
 * Predicates on the sync wire contract.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { SyncError, SyncGapError } from "../src/SyncError.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import type * as SyncServer from "../src/SyncServer.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

describe("SyncProtocol.covers", () => {
  it("a workspace scope covers every run", () => {
    expect(SyncProtocol.covers({ _tag: "Workspace" }, runId("anything"))).toBe(true)
  })

  it("a run scope covers only its own run", () => {
    const scope = { _tag: "Run", runId: runId("mine") } as const
    expect(SyncProtocol.covers(scope, runId("mine"))).toBe(true)
    expect(SyncProtocol.covers(scope, runId("other"))).toBe(false)
  })
})

describe("SyncError.is", () => {
  it("recognises sync errors and rejects other values", () => {
    expect(SyncError.is(new SyncError({ code: "closed", message: "closed" }))).toBe(true)
    expect(
      SyncError.is(
        new SyncGapError({
          runId: runId("run"),
          expectedFrom: 0 as JournalEvent.Seq,
          receivedFrom: 3 as JournalEvent.Seq
        })
      )
    ).toBe(false)
    expect(SyncError.is(new Error("boom"))).toBe(false)
    expect(SyncError.is(undefined)).toBe(false)
  })

  // The argument is `unknown`, and this guard decides whether a follow
  // reconnects and whether a cursor moves past a compaction floor. A shape
  // question that raises instead of answering turns an adversarial value into
  // a defect in the client's control flow.
  it("answers false for a value whose fields throw when read", () => {
    expect(
      SyncError.is({
        _tag: "@smthrs/sync/SyncError",
        code: "closed",
        get message(): string {
          throw new Error("boom")
        }
      })
    ).toBe(false)
  })
})

/**
 * A server states a generation; a request may omit one.
 *
 * The request schemas stay lenient so a persisted generation-zero cursor still
 * decodes and a non-conforming server is refused with a typed
 * `protocol_violation` rather than a bare decode failure. The server shapes
 * carry the other half of that contract: an implementation that omits a
 * generation does not compile.
 */
describe("server response shapes", () => {
  const position = { runId: runId("run"), afterSeq: seq(2) }
  const frame = { _tag: "Entries" as const, runId: position.runId, fromSeq: seq(1), toSeq: seq(2), entries: [] }

  it("requires a generation in a server cursor and admits one without it in a request", () => {
    expect(Schema.is(SyncProtocol.RunCursor)(position)).toBe(true)
    expect(Schema.is(SyncProtocol.ServerCursor)(position)).toBe(false)
    expect(Schema.is(SyncProtocol.ServerCursor)({ ...position, generation: 0 })).toBe(true)
    expect(Schema.is(SyncProtocol.ServerCursor)({ ...position, generation: -1 })).toBe(false)
  })

  it("requires a generation in a server page and a server frame", () => {
    const page = { entries: [], done: true }
    expect(Schema.is(SyncProtocol.ReadResponse)({ ...page, cursors: [position] })).toBe(true)
    expect(Schema.is(SyncProtocol.ServerReadResponse)({ ...page, cursors: [position] })).toBe(false)
    expect(Schema.is(SyncProtocol.ServerReadResponse)({ ...page, cursors: [{ ...position, generation: 3 }] }))
      .toBe(true)
    expect(Schema.is(SyncProtocol.EntriesFrame)(frame)).toBe(true)
    expect(Schema.is(SyncProtocol.ServerEntriesFrame)(frame)).toBe(false)
    expect(Schema.is(SyncProtocol.ServerEntriesFrame)({ ...frame, generation: 0 })).toBe(true)
    expect(Schema.is(SyncProtocol.ServerFrame)({ _tag: "Closed", reason: "done" })).toBe(true)
    expect(Schema.is(SyncProtocol.ServerFrame)({ _tag: "Heartbeat" })).toBe(true)
    expect(Schema.is(SyncProtocol.ServerFrame)(frame)).toBe(false)
  })

  it("does not type a server that answers without a generation", () => {
    const read: SyncServer.Service["read"] = () =>
      // @ts-expect-error a response cursor without a generation is not a server position
      Effect.succeed({ entries: [], cursors: [position], done: true })
    const subscribe: SyncServer.Service["subscribe"] = () =>
      // @ts-expect-error a frame without a generation is not a server frame
      Stream.succeed(frame)
    expect([read, subscribe].every((operation) => typeof operation === "function")).toBe(true)
  })
})

describe("SyncProtocol.RequestEnvelope", () => {
  it("names the scope and cursors every read and subscribe request carries", () => {
    const envelope = { scope: { _tag: "Workspace" }, cursors: [{ runId: runId("run"), afterSeq: seq(0) }] }
    expect(Schema.is(SyncProtocol.RequestEnvelope)(envelope)).toBe(true)
    expect(Schema.is(SyncProtocol.RequestEnvelope)({ ...envelope, cursors: [{ runId: runId("run") }] })).toBe(false)
    expect(Schema.is(SyncProtocol.RequestEnvelope)({ ...envelope, scope: { _tag: "Nothing" } })).toBe(false)
  })

  it("is the one schema the server and client admission sites use", () => {
    for (const source of ["src/SyncServer.ts", "src/SyncClient.ts"]) {
      const text = readFileSync(new URL(`../${source}`, import.meta.url), "utf8")
      expect(text).toContain("RequestEnvelope, input, \"invalid_request\"")
      expect(text).not.toMatch(/Schema\.Struct\(\{\s*scope:/)
    }
  })
})
