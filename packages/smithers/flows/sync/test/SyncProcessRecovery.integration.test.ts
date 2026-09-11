/**
 * Durable sync recovery with a killable child server, a file SQLite journal,
 * a separately running TCP client, and a cursor persisted outside either
 * server generation.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Schema, Stream } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as BranchProjection from "../src/BranchProjection.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncRpcs from "../src/SyncRpcs.ts"

const fixture = fileURLToPath(new URL("./fixtures/sync-process-server-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const branchId = "process-recovery" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const entryCount = 300
const firstPageConsumption = 128
const timeoutMs = 120_000

interface ServerHarness {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<Record<string, unknown>>
  readonly stderr: () => string
}

interface Ready {
  readonly mode: "first" | "second"
  readonly port: number
  readonly capability: BranchProtocol.ShareCapability
  readonly retry: unknown
  readonly durableCount: number
}

const startServer = (mode: Ready["mode"], filename: string): ServerHarness => {
  const child = spawn(process.execPath, [fixture, mode, filename], { cwd: repositoryRoot })
  let stdout = ""
  let stderr = ""
  let settled = false
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`server ${mode} did not become ready\n${stderr}\n${stdout}`))
    }, timeoutMs)
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline < 0 || settled) return
      settled = true
      clearTimeout(timeout)
      resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`server ${mode} exited with ${code ?? signal}\n${stderr}\n${stdout}`))
    })
  })
  return { child, ready, stderr: () => stderr }
}

const decodeReady = (value: Record<string, unknown>): Ready => {
  if (
    value.phase !== "ready" ||
    (value.mode !== "first" && value.mode !== "second") ||
    typeof value.port !== "number" ||
    typeof value.durableCount !== "number"
  ) {
    throw new Error(`invalid server-ready payload: ${JSON.stringify(value)}`)
  }
  return {
    mode: value.mode,
    port: value.port,
    capability: Schema.decodeUnknownSync(BranchProtocol.ShareCapability)(value.capability),
    retry: value.retry,
    durableCount: value.durableCount
  }
}

const killHard = async (server: ServerHarness): Promise<void> => {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return
  const exited = once(server.child, "exit")
  server.child.kill("SIGKILL")
  await exited
}

const connect = (port: number) =>
  Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port })
    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerNdjson)
    )
    const client = yield* RpcClient.make(SyncRpcs.SyncRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )
    return yield* SyncClient.make({ client })
  })

describe("sync recovery across a killed server process", () => {
  it.effect(
    "resumes a partially consumed 256-entry page without loss, projection duplicates, or command replay",
    () =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-sync-process-recovery-")))
        const filename = join(directory, "sync.sqlite")
        const cursorFilename = join(directory, "consumer-cursor.json")
        const servers: Array<ServerHarness> = []
        try {
          const firstServer = startServer("first", filename)
          servers.push(firstServer)
          const firstReady = decodeReady(yield* Effect.promise(() => firstServer.ready))
          expect(firstReady).toMatchObject({ mode: "first", durableCount: entryCount })

          const first = yield* (
            Effect.scoped(
              Effect.gen(function*() {
                const client = yield* connect(firstReady.port)
                const entries = yield* Stream.runCollect(
                  Stream.take(
                    client.subscribe({
                      scope: { _tag: "Run", runId },
                      cursors: [],
                      capability: firstReady.capability
                    }),
                    firstPageConsumption
                  )
                )
                const cursors = (yield* client.progress).delivered
                // Kill the server while this client/socket scope is still live,
                // after only half of its 256-entry bootstrap page was admitted.
                yield* Effect.promise(() => killHard(firstServer))
                return { cursors, entries: Array.from(entries) }
              })
            )
          )

          yield* Effect.promise(() => writeFile(cursorFilename, JSON.stringify(first.cursors)))
          const persistedCursors = Schema.decodeUnknownSync(SyncProtocol.WorkspaceCursor)(
            JSON.parse(yield* Effect.promise(() => readFile(cursorFilename, "utf8"))) as unknown
          )
          expect(persistedCursors).toEqual(first.cursors)

          const secondServer = startServer("second", filename)
          servers.push(secondServer)
          const secondReady = decodeReady(yield* Effect.promise(() => secondServer.ready))
          expect(secondReady).toMatchObject({
            mode: "second",
            durableCount: entryCount,
            retry: { status: "duplicate" }
          })
          const second = yield* (
            Effect.scoped(
              Effect.gen(function*() {
                const client = yield* connect(secondReady.port)
                const entries = yield* Stream.runCollect(
                  Stream.take(
                    client.subscribe({
                      scope: { _tag: "Run", runId },
                      cursors: persistedCursors,
                      capability: secondReady.capability
                    }),
                    entryCount - firstPageConsumption
                  )
                )
                return Array.from(entries)
              })
            )
          )

          const all = [...first.entries, ...second]
          const projection = BranchProjection.project(branchId, all)
          expect(first.entries).toHaveLength(firstPageConsumption)
          expect(first.cursors).toEqual([{
            generation: 0,
            runId,
            afterSeq: first.entries[first.entries.length - 1]?.seq
          }])
          expect(second).toHaveLength(entryCount - firstPageConsumption)
          expect(all.map((entry) => entry.seq)).toEqual(
            Array.from({ length: entryCount }, (_, index) => index as JournalEvent.Seq)
          )
          expect(projection.commands).toHaveLength(entryCount)
          expect(new Set(projection.commands.map((command) => command.commandId)).size).toBe(entryCount)
        } finally {
          yield* Effect.promise(() => Promise.all(servers.map(killHard)))
          const failed = servers.find((server) => server.child.exitCode !== null && server.child.exitCode !== 0)
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
          if (failed !== undefined) throw new Error(`sync child failed\n${failed.stderr()}`)
        }
      }),
    timeoutMs
  )
})
