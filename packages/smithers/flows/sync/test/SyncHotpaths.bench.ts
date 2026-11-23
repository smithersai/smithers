import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { beforeAll, describe, test } from "vitest"
import type * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"
import * as TestEntry from "./fixtures/entry.ts"

const branchId = "bench-branch-1" as BranchProtocol.BranchId
const runId = "bench-sync-run-1" as JournalEvent.RunId
const secret = Redacted.make("bench-hmac-signing-secret-0123456789abcdef0123456789")

const entries100 = Array.from({ length: 100 }, (_, seq) =>
  TestEntry.entry(runId, seq, {
    eventId: `ev-${seq}`,
    eventType: "step.completed",
    payload: { step: seq, output: `result-${seq}` }
  }))

const samplePage: SyncProtocol.ServerReadResponse = {
  entries: entries100.slice(0, 25),
  cursors: [{ generation: 0, runId, afterSeq: 24 as JournalEvent.Seq }],
  done: false
}

const isServerReadResponse = Schema.is(SyncProtocol.ServerReadResponse)

let branchShare: BranchShare.Service
let workspaceShare: WorkspaceShare.Service
let mintedBranchCap: BranchProtocol.ShareCapability
let mintedWorkspaceCap: WorkspaceShare.WorkspaceCapability
let syncServer: SyncServer.Service

beforeAll(async () => {
  branchShare = await Effect.runPromise(
    BranchShare.makeHmac({ activeKid: "k1", keys: [{ kid: "k1", secret }] })
  )
  workspaceShare = await Effect.runPromise(
    WorkspaceShare.makeHmac({ activeKid: "k1", keys: [{ kid: "k1", secret }] })
  )
  mintedBranchCap = await Effect.runPromise(
    branchShare.mint({ branchId, capabilityId: "cap-hot", access: "write", ttlMs: 3_600_000 })
  )
  mintedWorkspaceCap = await Effect.runPromise(
    workspaceShare.mint({ capabilityId: "ws-hot", access: "read", ttlMs: 3_600_000 })
  )
  syncServer = await Effect.runPromise(
    SyncServer.makeLive.pipe(
      Effect.provide(
        Layer.mergeAll(
          Journal.layerNoop({
            entries: ({ after, limit }) =>
              Effect.sync(() => {
                const start = (after ?? -1) + 1
                const slice = entries100.slice(start, start + limit)
                return { entries: slice, hasMore: start + slice.length < entries100.length }
              })
          }),
          RunCatalog.layerStatic([runId])
        )
      )
    )
  )
})

describe("SyncHotpaths", () => {
  test("BranchShare.mint + verify (HMAC-SHA-256)", async ({ bench }) => {
    let counter = 0
    await bench("BranchShare mint+verify", async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const cap = yield* branchShare.mint({
            branchId,
            capabilityId: `cap-${counter++}`,
            access: "write",
            ttlMs: 60_000
          })
          return yield* branchShare.verify(cap, { branchId, access: "write" })
        })
      )
    }).run({ time: 150, warmupTime: 30 })
  })

  test("BranchShare.verify (hot capability)", async ({ bench }) => {
    const program = branchShare.verify(mintedBranchCap, { branchId, access: "read" })
    await bench("BranchShare.verify", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("WorkspaceShare.verify (hot capability)", async ({ bench }) => {
    const program = workspaceShare.verify(mintedWorkspaceCap, { access: "read" })
    await bench("WorkspaceShare.verify", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("SyncProtocol.encodedByteLength + ServerReadResponse validation", async ({ bench }) => {
    await bench("SyncProtocol frame validation", () => {
      let bytes = 0
      for (let index = 0; index < samplePage.entries.length; index++) {
        bytes += SyncProtocol.encodedByteLength(samplePage.entries[index]!)
      }
      if (!isServerReadResponse(samplePage)) throw new Error("invalid page")
      return bytes
    }).run({ time: 120, warmupTime: 30 })
  })

  test("SyncServer.read (100-entry journal page under Workspace principal)", async ({ bench }) => {
    const program = syncServer.read({
      protocolVersion: 1,
      scope: { _tag: "Run", runId },
      cursors: [],
      limit: 100
    }).pipe(Effect.provide(SyncPrincipal.layerWorkspace("bench-workspace")))
    await bench("SyncServer.read 100 entries", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })
})
