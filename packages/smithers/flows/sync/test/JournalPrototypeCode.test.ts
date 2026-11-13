import { describe, expect, it } from "@effect/vitest"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Effect, Layer } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

class HostJournalError extends Error {
  readonly code: string

  constructor(code: string) {
    super("private journal details")
    this.code = code
    this.name = "HostJournalError"
  }
}

describe("host journal error codes", () => {
  for (const code of [...Object.getOwnPropertyNames(Object.prototype), "sequence_conflict"]) {
    it.effect(`keeps ${code} as a typed unknown failure`, () =>
      Effect.gen(function*() {
        const runId = "host-error" as JournalEvent.RunId
        // The host adapter chooses its error class and code at this seam.
        const cause = new HostJournalError(code) as unknown as Journal.JournalError
        const server = yield* SyncServer.makeLive.pipe(
          Effect.provide(Layer.mergeAll(
            Journal.layerNoop({ entries: () => Effect.fail(cause) }),
            RunCatalog.layerStatic([runId])
          ))
        )
        const refusal = yield* server.read({
          protocolVersion: 1,
          scope: { _tag: "Workspace" },
          cursors: [],
          limit: 1
        }).pipe(Effect.provide(SyncPrincipal.layerWorkspace("host-error")), Effect.flip)
        expect(refusal).toBeInstanceOf(SyncError)
        expect(refusal.code).toBe("unknown")
        expect(refusal.message).toBe(`Journal read failed for run ${runId}`)
        expect(refusal.cause).not.toContain("private journal details")
      }))
  }
})
