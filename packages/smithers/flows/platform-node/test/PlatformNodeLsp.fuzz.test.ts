import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { LanguageServer, Lsp } from "@smthrs/std"
import { Arbitrary, Cause, Deferred, Effect, Exit, Layer, Logger, Option, Queue, Schema, Sink, Stream } from "effect"
import * as ByteSize from "effect/ByteSize"
import * as FileSystem from "effect/FileSystem"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const fastExecutions = Math.max(16, Math.min(baseExecutions, 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-lsp-fuzz-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const regularFile: FileSystem.File.Info = {
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(16),
  blksize: Option.none(),
  blocks: Option.none()
}

const encodeFrame = (value: unknown): Uint8Array => {
  const body = encoder.encode(JSON.stringify(value))
  const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`)
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header)
  frame.set(body, header.length)
  return frame
}

const decodeFrames = (buf: Uint8Array): Array<Readonly<Record<string, unknown>>> => {
  const out: Array<Readonly<Record<string, unknown>>> = []
  let text = decoder.decode(buf)
  while (text.length > 0) {
    const idx = text.indexOf("\r\n\r\n")
    if (idx < 0) break
    const header = text.slice(0, idx)
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) break
    const len = Number(match[1])
    const rest = text.slice(idx + 4)
    const bodyBytes = encoder.encode(rest).slice(0, len)
    const bodyStr = decoder.decode(bodyBytes)
    out.push(JSON.parse(bodyStr) as Readonly<Record<string, unknown>>)
    text = decoder.decode(encoder.encode(rest).slice(len))
  }
  return out
}

const makeScriptedSpawner = (
  onMessage: (
    msg: Readonly<Record<string, unknown>>,
    output: Queue.Queue<Uint8Array, Cause.Done>,
    exitGate: Deferred.Deferred<ExitCode>
  ) => Effect.Effect<void, Cause.Done>,
  options: { readonly chunkSize?: number | undefined; readonly failSpawn?: boolean | undefined } = {}
) =>
  ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.gen(function*() {
        if (options.failSpawn) {
          return yield* Effect.fail(new Error("spawn ENOENT") as never)
        }
        const standard = command as ChildProcess.StandardCommand
        const stdinConfig = standard.options.stdin as ChildProcess.StdinConfig
        const stdin = stdinConfig.stream as Stream.Stream<Uint8Array>
        const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        const exitGate = yield* Deferred.make<ExitCode>()
        let pending = ""
        yield* stdin.pipe(
          Stream.runForEach((bytes) =>
            Effect.gen(function*() {
              pending += decoder.decode(bytes)
              while (true) {
                const idx = pending.indexOf("\r\n\r\n")
                if (idx < 0) break
                const header = pending.slice(0, idx)
                const m = /Content-Length:\s*(\d+)/i.exec(header)
                if (!m) break
                const len = Number(m[1])
                const restBytes = encoder.encode(pending.slice(idx + 4))
                if (restBytes.byteLength < len) break
                const msg = JSON.parse(decoder.decode(restBytes.slice(0, len))) as Readonly<Record<string, unknown>>
                pending = decoder.decode(restBytes.slice(len))
                yield* onMessage(msg, output, exitGate).pipe(Effect.ignore)
              }
            })
          ),
          Effect.forkScoped({ startImmediately: true })
        )

        const rawStream = Stream.fromQueue(output)
        const chunkedStream = options.chunkSize !== undefined && options.chunkSize > 0
          ? rawStream.pipe(
            Stream.flatMap((chunk) => {
              const parts: Array<Uint8Array> = []
              for (let i = 0; i < chunk.byteLength; i += options.chunkSize!) {
                parts.push(chunk.subarray(i, Math.min(i + options.chunkSize!, chunk.byteLength)))
              }
              return Stream.fromIterable(parts)
            })
          )
          : rawStream

        return makeHandle({
          pid: ProcessId(42),
          exitCode: Deferred.await(exitGate),
          isRunning: Effect.map(Deferred.isDone(exitGate), (done) => !done),
          kill: () => Deferred.succeed(exitGate, ExitCode(0)).pipe(Effect.asVoid),
          stdin: Sink.drain,
          stdout: chunkedStream,
          stderr: Stream.empty,
          all: chunkedStream,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  })

describe("@smthrs/platform-node NodeLanguageServer fuzz", () => {
  it("fuzzes LSP operations, chunk fragmentation, language IDs, server requests, sync changes & make/makeLazy/layer/layerLazy", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        operation: Schema.Literals([
          "hover",
          "definition",
          "references",
          "documentSymbols",
          "workspaceSymbols",
          "diagnostics-pull",
          "diagnostics-push"
        ]),
        ext: Schema.Literals([".ts", ".tsx", ".py", ".rs", ".go", ".md", ".unknown", ""]),
        chunkSize: Schema.Literals([0, 1, 7, 32]),
        lazy: Schema.Boolean,
        sendServerRequest: Schema.Boolean,
        updateFile: Schema.Boolean
      })
    )

    let idx = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              idx += 1
              const filePath = join(root, `sample-${idx}${tc.ext}`)
              const v1 = `export const x${idx} = 1\n`
              const v2 = `export const x${idx} = 2 // edited\n`
              writeFileSync(filePath, v1, "utf8")
              let currentText = v1
              const seenMethods: Array<string> = []

              const spawner = makeScriptedSpawner(
                (msg, output, exitGate) =>
                  Effect.gen(function*() {
                    const method = typeof msg.method === "string" ? msg.method : undefined
                    if (method !== undefined) seenMethods.push(method)

                    if (method === "initialize") {
                      const pullDiag = tc.operation === "diagnostics-pull"
                      yield* Queue.offer(
                        output,
                        encodeFrame({
                          jsonrpc: "2.0",
                          id: msg.id,
                          result: {
                            capabilities: {
                              hoverProvider: true,
                              definitionProvider: true,
                              referencesProvider: true,
                              documentSymbolProvider: true,
                              workspaceSymbolProvider: true,
                              textDocumentSync: { openClose: true, change: 1, save: true },
                              ...(pullDiag
                                ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
                                : {})
                            }
                          }
                        })
                      )
                      if (tc.sendServerRequest) {
                        // Exercise server->client request handling (workspace/configuration, client/registerCapability, unknown)
                        yield* Queue.offer(
                          output,
                          encodeFrame({
                            jsonrpc: "2.0",
                            id: "srv-1",
                            method: "workspace/configuration",
                            params: { items: [{}] }
                          })
                        )
                        yield* Queue.offer(
                          output,
                          encodeFrame({
                            jsonrpc: "2.0",
                            id: "srv-2",
                            method: "client/registerCapability",
                            params: { registrations: [] }
                          })
                        )
                        yield* Queue.offer(
                          output,
                          encodeFrame({
                            jsonrpc: "2.0",
                            id: "srv-3",
                            method: "window/workDoneProgress/create",
                            params: { token: "t1" }
                          })
                        )
                        yield* Queue.offer(
                          output,
                          encodeFrame({ jsonrpc: "2.0", id: "srv-4", method: "custom/unknown", params: {} })
                        )
                      }
                      return
                    }

                    if (method === "shutdown") {
                      yield* Queue.offer(output, encodeFrame({ jsonrpc: "2.0", id: msg.id, result: null }))
                      return
                    }
                    if (method === "exit") {
                      yield* Deferred.succeed(exitGate, ExitCode(0))
                      return
                    }

                    if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
                      if (tc.operation === "diagnostics-push") {
                        const params = msg.params as { textDocument?: { uri?: string; version?: number } }
                        yield* Queue.offer(
                          output,
                          encodeFrame({
                            jsonrpc: "2.0",
                            method: "textDocument/publishDiagnostics",
                            params: {
                              uri: params.textDocument?.uri,
                              version: params.textDocument?.version,
                              diagnostics: [{
                                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                                severity: 1,
                                message: "fuzz diagnostic"
                              }]
                            }
                          })
                        )
                      }
                      return
                    }

                    if (typeof msg.id !== "number") return

                    if (method === "textDocument/hover") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({ jsonrpc: "2.0", id: msg.id, result: { contents: "hover-ok" } })
                      )
                    } else if (method === "textDocument/definition") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({
                          jsonrpc: "2.0",
                          id: msg.id,
                          result: [{
                            uri: `file://${filePath}`,
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
                          }]
                        })
                      )
                    } else if (method === "textDocument/references") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({
                          jsonrpc: "2.0",
                          id: msg.id,
                          result: [{
                            uri: `file://${filePath}`,
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
                          }]
                        })
                      )
                    } else if (method === "textDocument/documentSymbol") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({
                          jsonrpc: "2.0",
                          id: msg.id,
                          result: [{
                            name: `x${idx}`,
                            kind: 13,
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }
                          }]
                        })
                      )
                    } else if (method === "workspace/symbol") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({
                          jsonrpc: "2.0",
                          id: msg.id,
                          result: [{
                            name: `x${idx}`,
                            kind: 13,
                            location: {
                              uri: `file://${filePath}`,
                              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }
                            }
                          }]
                        })
                      )
                    } else if (method === "textDocument/diagnostic") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({
                          jsonrpc: "2.0",
                          id: msg.id,
                          result: {
                            kind: "full",
                            items: [{
                              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                              severity: 2,
                              message: "pull diag"
                            }]
                          }
                        })
                      )
                    } else {
                      yield* Queue.offer(output, encodeFrame({ jsonrpc: "2.0", id: msg.id, result: null }))
                    }
                  }),
                { chunkSize: tc.chunkSize }
              )

              const fsLayer = FileSystem.layerNoop({
                stat: () => Effect.succeed(regularFile),
                readFileString: () => Effect.succeed(currentText),
                readFile: () => Effect.succeed(encoder.encode(currentText))
              })

              const cfg: NodeLanguageServer.Config = {
                command: "fuzz-lsp",
                args: ["--stdio"],
                cwd: root,
                initializationOptions: { fuzz: true },
                timeoutMs: 2000,
                settleMs: 300,
                quietMs: 20,
                ...(tc.ext.length > 0 ? { extensions: [tc.ext] } : {})
              }

              const serverLayer = tc.lazy
                ? NodeLanguageServer.layerLazy(cfg).pipe(
                  Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
                )
                : NodeLanguageServer.layer(cfg).pipe(
                  Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
                )

              const envLayer = Layer.mergeAll(serverLayer, fsLayer)

              const invoke = () => {
                if (tc.operation === "hover") {
                  return Lsp.run({ operation: "hover", path: filePath, line: 1, character: 1 })
                }
                if (tc.operation === "definition") {
                  return Lsp.run({ operation: "definition", path: filePath, line: 1, character: 1 })
                }
                if (tc.operation === "references") {
                  return Lsp.run({ operation: "references", path: filePath, line: 1, character: 1 })
                }
                if (tc.operation === "documentSymbols") {
                  return Lsp.run({ operation: "documentSymbols", path: filePath, line: 1, character: 1 })
                }
                if (tc.operation === "workspaceSymbols") {
                  return Lsp.run({
                    operation: "workspaceSymbols",
                    path: filePath,
                    query: `x${idx}`,
                    line: 1,
                    character: 1
                  })
                }
                return Lsp.run({ operation: "diagnostics", path: filePath })
              }

              yield* Effect.gen(function*() {
                const r1 = yield* invoke()
                expect(r1).toBeDefined()
                if (tc.updateFile && tc.operation !== "workspaceSymbols") {
                  currentText = v2
                  writeFileSync(filePath, v2, "utf8")
                  const r2 = yield* invoke()
                  expect(r2).toBeDefined()
                }
              }).pipe(Effect.provide(envLayer))

              expect(seenMethods).toContain("initialize")
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("fuzzes LSP framing errors, malformed headers, JSON-RPC errors, early exit, timeouts & crash recovery", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fault: Schema.Literals([
          "bad-header-no-cl",
          "huge-header",
          "negative-cl",
          "oversized-cl",
          "bad-json",
          "rpc-error",
          "method-not-found",
          "early-exit",
          "timeout",
          "spawn-fail"
        ])
      })
    )

    const filePath = join(root, "fault-sample.ts")
    writeFileSync(filePath, "export const a = 1\n", "utf8")

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fault }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const spawner = makeScriptedSpawner(
                (msg, output, exitGate) =>
                  Effect.gen(function*() {
                    if (msg.method === "initialize") {
                      if (fault === "early-exit") {
                        yield* Deferred.succeed(exitGate, ExitCode(1))
                        yield* Queue.end(output)
                        return
                      }
                      yield* Queue.offer(
                        output,
                        encodeFrame({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } })
                      )
                      return
                    }
                    if (msg.method === "shutdown") {
                      yield* Queue.offer(output, encodeFrame({ jsonrpc: "2.0", id: msg.id, result: null }))
                      return
                    }
                    if (typeof msg.id !== "number") return

                    if (fault === "bad-header-no-cl") {
                      yield* Queue.offer(output, encoder.encode("X-Other: 1\r\n\r\n{}"))
                    } else if (fault === "huge-header") {
                      yield* Queue.offer(output, encoder.encode(`X-Pad: ${"a".repeat(9000)}\r\n\r\n`))
                    } else if (fault === "negative-cl") {
                      yield* Queue.offer(output, encoder.encode("Content-Length: -5\r\n\r\n"))
                    } else if (fault === "oversized-cl") {
                      yield* Queue.offer(output, encoder.encode("Content-Length: 99999999\r\n\r\n"))
                    } else if (fault === "bad-json") {
                      const body = "{bad json"
                      yield* Queue.offer(output, encoder.encode(`Content-Length: ${body.length}\r\n\r\n${body}`))
                    } else if (fault === "rpc-error") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "internal err" } })
                      )
                    } else if (fault === "method-not-found") {
                      yield* Queue.offer(
                        output,
                        encodeFrame({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } })
                      )
                    } else if (fault === "timeout") {
                      // Deliberately never respond
                    }
                  }),
                { failSpawn: fault === "spawn-fail" }
              )

              const serverExit = yield* NodeLanguageServer.make({
                command: "fuzz-lsp",
                cwd: root,
                timeoutMs: fault === "timeout" ? 40 : 1500
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.exit
              )

              if (fault === "spawn-fail" || fault === "early-exit") {
                expect(Exit.isFailure(serverExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(serverExit)).toBe(true)
              if (Exit.isFailure(serverExit)) return false

              const callExit = yield* Lsp.run({
                operation: "hover",
                path: filePath,
                line: 1,
                character: 1
              }).pipe(
                Effect.provideService(LanguageServer.LanguageServer, serverExit.value),
                Effect.provide(FileSystem.layerNoop({
                  stat: () => Effect.succeed(regularFile),
                  readFileString: () => Effect.succeed("export const a = 1\n")
                })),
                Effect.exit
              )
              expect(Exit.isFailure(callExit)).toBe(true)
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions: Math.max(12, Math.min(fastExecutions, 30)) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })
})
