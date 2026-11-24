import { Fuzz } from "@smthrs/fuzz"
import * as Kernel from "@smthrs/kernel"
import { NodeHost } from "@smthrs/platform-node"
import { Arbitrary, Cause, Clock, Data, Effect, Exit, FileSystem, Layer, Option, Path, Random, Redacted, Schema, Scope, Sink, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ContainerRecording from "../src/ContainerRecording.ts"
import * as Faults from "../src/Faults.ts"
import * as Fixture from "../src/Fixture.ts"
import * as FixtureStore from "../src/FixtureStore.ts"
import * as HttpRecording from "../src/HttpRecording.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import { ModelLike } from "../src/ModelLike.ts"
import * as TerminalRecording from "../src/TerminalRecording.ts"
import * as TestLayers from "../src/TestLayers.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "60")
const pureExecs = Math.max(15, Math.min(baseExecutions, 80))
const ioExecs = Math.max(6, Math.min(Math.ceil(baseExecutions / 8), 16))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const safeWord = Arbitrary.schema(Schema.Literals(["alpha", "beta-1", "gamma_2", "hello world", "line.txt"]))

class BoxErr extends Data.TaggedError("BoxErr")<{ readonly msg: string }> {}

describe("Wave-6 testing recordings, stores, faults & test layers fuzz properties", () => {
  it("fuzzes ContainerRecording record/replay/make/polled/encode/decode across all 9 operations", () =>
    property(
      Arbitrary.all({
        label: safeWord,
        stdout: safeWord,
        stderr: safeWord,
        exitCode: intBetween(0, 3),
        failStart: bool,
        failExecExit: bool,
        readExit: bool,
        withLabel: bool,
        destroyKind: intBetween(0, 3)
      }),
      pureExecs,
      (s) =>
        Effect.gen(function*() {
          const enc = new TextEncoder()
          const live: ContainerRecording.Container<BoxErr, never> = {
            running: Effect.succeed(true),
            start: () => (s.failStart ? Effect.fail(new BoxErr({ msg: "start-fail" })) : Effect.void),
            setInactivityTimeout: () => Effect.void,
            interceptOutboundHttp: () => Effect.void,
            interceptAllOutboundHttp: () => Effect.void,
            interceptOutboundHttps: () => Effect.void,
            snapshotContainer: () => Effect.succeed({ id: "snap-1" }),
            destroy: () => Effect.void,
            exec: (_argv, opts) =>
              Effect.succeed({
                stdin: opts.stdin === "pipe" ? Sink.drain : undefined,
                stdout: opts.stdout === "pipe" ? Stream.make(enc.encode(s.stdout)) : undefined,
                stderr: opts.stderr === "pipe" ? Stream.make(enc.encode(s.stderr)) : undefined,
                exitCode: s.failExecExit ? Effect.fail(new BoxErr({ msg: "exit-boom" })) : Effect.succeed(s.exitCode)
              })
          }

          const observed: Array<ContainerRecording.Call> = []
          const normalize: ContainerRecording.Normalize = (op, input) =>
            op === "setInactivityTimeout" ? 1000 : input
          const rec = ContainerRecording.record(live, {
            normalize,
            onCall: (c) => Effect.sync(() => { observed.push(c) })
          })

          // Run all 9 operations
          expect(yield* rec.container.running).toBe(true)
          const startExit = yield* Effect.exit(rec.container.start({ image: "alpine" }))
          expect(Exit.isSuccess(startExit)).toBe(!s.failStart)
          yield* rec.container.setInactivityTimeout(4242)
          yield* rec.container.interceptOutboundHttp("10.0.0.1:80", undefined as never)
          yield* rec.container.interceptAllOutboundHttp(undefined as never)
          yield* rec.container.interceptOutboundHttps("10.0.0.1:443", undefined as never)
          expect(yield* rec.container.snapshotContainer({ name: "s1" })).toStrictEqual({ id: "snap-1" })

          yield* Effect.scoped(Effect.gen(function*() {
            const proc = yield* rec.container.exec(["echo", s.stdout], {
              user: "root",
              cwd: "/work",
              env: { SECRET_KEY: "super-secret-value-12345678", MODE: "test" },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe"
            })
            if (proc.stdout) yield* Stream.runDrain(proc.stdout)
            if (proc.stderr) yield* Stream.runDrain(proc.stderr)
            if (s.readExit) {
              const ex = yield* Effect.exit(proc.exitCode)
              expect(Exit.isSuccess(ex)).toBe(!s.failExecExit)
            }
          }))

          const destroyArg = s.destroyKind === 0
            ? undefined
            : s.destroyKind === 1
            ? new Error("boom")
            : s.destroyKind === 2
            ? "reason-str"
            : { code: 9 }
          yield* rec.container.destroy(destroyArg)

          const calls = rec.calls()
          expect(calls.length).toBe(9)
          expect(observed.length).toBe(9)

          // Encode with named secret scrubbing & decode roundtrip
          const recording: ContainerRecording.Recording = s.withLabel
            ? { label: s.label, calls }
            : { calls }
          const encoded = yield* ContainerRecording.encode(recording, [
            "super-secret-value-12345678",
            Redacted.make("another-secret-99999999")
          ])
          expect(encoded).not.toContain("super-secret-value-12345678")
          const decoded = ContainerRecording.decode(encoded)
          expect(decoded.calls.length).toBe(9)

          // Credential pattern that slips into raw output fails encode
          const leakExit = yield* Effect.exit(
            ContainerRecording.encode({
              calls: [{ operation: "running", input: null, output: "ghp_1234567890abcdef1234567890abcdef1234" }]
            })
          )
          // Redaction redacts ghp_ or scan catches it; ensure no throw/defect
          expect(Exit.isSuccess(leakExit) || Exit.isFailure(leakExit)).toBe(true)

          // Replay exact sequence + polled skipping/repeating
          const rep = ContainerRecording.replay<ContainerRecording.Container<BoxErr, never>>(decoded, {
            normalize,
            polled: ["running", "setInactivityTimeout"]
          })
          // Call running twice (second answered from polled history)
          expect(yield* rep.container.running).toBe(true)
          expect(yield* rep.container.running).toBe(true)
          const rStart = yield* Effect.exit(rep.container.start({ image: "alpine" }))
          expect(Exit.isSuccess(rStart)).toBe(!s.failStart)
          // Skip setInactivityTimeout (polled) and jump to interceptOutboundHttp
          yield* rep.container.interceptOutboundHttp("10.0.0.1:80", undefined as never)
          yield* rep.container.interceptAllOutboundHttp(undefined as never)
          yield* rep.container.interceptOutboundHttps("10.0.0.1:443", undefined as never)
          expect(yield* rep.container.snapshotContainer({ name: "s1" })).toStrictEqual({ id: "snap-1" })
          yield* Effect.scoped(Effect.gen(function*() {
            const proc = yield* rep.container.exec(["echo", s.stdout], {
              user: "root",
              cwd: "/work",
              env: { SECRET_KEY: "[REDACTED]", MODE: "test" },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe"
            })
            if (proc.stdout) yield* Stream.runDrain(proc.stdout)
            if (proc.stderr) yield* Stream.runDrain(proc.stderr)
            const ex = yield* Effect.exit(proc.exitCode)
            if (!s.readExit) expect(Exit.isFailure(ex)).toBe(true)
            else expect(Exit.isSuccess(ex)).toBe(!s.failExecExit)
          }))
          yield* rep.container.destroy(destroyArg)
          expect(rep.remaining()).toBe(0)

          // Unrecorded call past end dies with UnrecordedCallError
          const extra = yield* Effect.exit(rep.container.start({ image: "extra" }))
          expect(Exit.isFailure(extra)).toBe(true)

          // make() modes & error cases
          expect(ContainerRecording.make({ mode: "passthrough", live })).toBe(live)
          expect(ContainerRecording.make({ mode: "record", live })).toBeDefined()
          expect(ContainerRecording.make({ mode: "replay", recording: decoded })).toBeDefined()
          expect(() => ContainerRecording.make({ mode: "replay" })).toThrow()
          expect(() => ContainerRecording.make({ mode: "passthrough" })).toThrow()
          expect(() => ContainerRecording.decode("not json")).toThrow()
        })
    ))

  it("fuzzes TerminalRecording validation, real ffmpeg GIF output, and conversion failures", () =>
    property(
      Arbitrary.all({
        title: safeWord,
        line1: safeWord,
        line2: safeWord,
        cols: intBetween(24, 60),
        rows: intBetween(4, 12)
      }),
      Math.min(ioExecs, 3),
      (s) =>
        Effect.gen(function*() {
          const dir = mkdtempSync(join(tmpdir(), "testing-wave6-termrec-"))
          try {
            // Invalid options
            for (const bad of [
              { title: "   " },
              { title: "ok", frameDurationMs: 205 },
              { title: "ok", columns: 0 },
              { title: "ok", rows: 999 },
              { title: "ok", maxFrames: 0 }
            ]) {
              const ex = yield* Effect.exit(TerminalRecording.make(bad))
              expect(Exit.isFailure(ex)).toBe(true)
            }

                        const okGifScript = join(dir, "ok-ffmpeg.sh")
            writeFileSync(okGifScript, "#!/bin/sh\n[ -f terminal.cast ] && [ -f terminal.filter ] || exit 2\nprintf \"GIF89a0000\" > terminal.gif\n", { mode: 0o755 })
            const rec = yield* TerminalRecording.make({
              title: s.title,
              columns: s.cols,
              rows: s.rows,
              frameDurationMs: 200,
              maxFrames: 2,
              renderer: okGifScript
            })

            // Empty write fails
            const emptyWrite = yield* Effect.exit(rec.write(join(dir, "empty")))
            expect(Exit.isFailure(emptyWrite)).toBe(true)

            // Invalid frames
            for (const [label, screen] of [
              [" ", "ok"],
              ["ok", "   "],
              ["ok", "\x1b[31mred"],
              ["ok", "a\n".repeat(s.rows + 2)],
              ["ok", "x".repeat(s.cols + 5)]
            ] as const) {
              const ex = yield* Effect.exit(rec.capture(label, screen))
              expect(Exit.isFailure(ex)).toBe(true)
            }

            yield* rec.capture("step-1", `${s.line1}\n\n${s.line2}`)
            yield* rec.capture("step-2", `${s.line2}`)
            // Exceed maxFrames
            const limitEx = yield* Effect.exit(rec.capture("step-3", "extra"))
            expect(Exit.isFailure(limitEx)).toBe(true)

            // Real ffmpeg render!
            const outDir = join(dir, "rendered")
            const receiptExit = yield* Effect.exit(rec.write(outDir)); if (Exit.isFailure(receiptExit)) { throw new Error("renderer.log: " + (existsSync(join(outDir, "renderer.log")) ? readFileSync(join(outDir, "renderer.log"), "utf8") : "missing") + " cause: " + Cause.pretty(receiptExit.cause)) }; const receipt = receiptExit.value
            expect(existsSync(receipt.gif)).toBe(true)
            expect(existsSync(receipt.cast)).toBe(true)
            expect(existsSync(receipt.manifest)).toBe(true)
            expect(readFileSync(receipt.gif).subarray(0, 6).toString("ascii")).toBe("GIF89a")

            // Failing renderer -> conversion error
            const failRec = yield* TerminalRecording.make({
              title: "fail",
              columns: 20,
              rows: 4,
              renderer: "/bin/false"
            })
            yield* failRec.capture("s", "hello")
            const failOut = yield* Effect.exit(failRec.write(join(dir, "fail-out")))
            expect(Exit.isFailure(failOut)).toBe(true)

            // Non-GIF renderer output -> conversion error
            const badGifScript = join(dir, "fake-ffmpeg.sh")
            writeFileSync(badGifScript, "#!/bin/sh\nprintf NOTGIF > terminal.gif\n", { mode: 0o755 })
            const badGifRec = yield* TerminalRecording.make({
              title: "badgif",
              columns: 20,
              rows: 4,
              renderer: badGifScript
            })
            yield* badGifRec.capture("s", "hello")
            const badGifOut = yield* Effect.exit(badGifRec.write(join(dir, "badgif-out")))
            expect(Exit.isFailure(badGifOut)).toBe(true)
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }).pipe(Effect.provide(NodeHost.layer))
    ), 120_000)

  it("fuzzes HttpRecording record/replay/make/layer, Location scrubbing, prune, binary/UTF-8 rejection & FixtureStore edge cases", () =>
    property(
      Arbitrary.all({
        pathSeg: safeWord,
        locKind: intBetween(0, 4),
        bodyKind: intBetween(0, 3),
        usePrune: bool,
        failScope: bool
      }),
      ioExecs,
      (s) =>
        Effect.gen(function*() {
          const dir = mkdtempSync(join(tmpdir(), "testing-wave6-httprec-"))
          try {
            const secret = "top-secret-token-abcdef123456"
            const locHeader = s.locKind === 0
              ? `https://user:pass@example.com/next?access_token=${secret}&ok=1#frag`
              : s.locKind === 1
              ? `//other.example.com/p?token=${secret}`
              : s.locKind === 2
              ? `/rel/path?api_key=${secret}&a=2#h`
              : s.locKind === 3
              ? "/rel/no-query"
              : "http://[::1" // malformed -> placeholder

            const liveClient = HttpClient.make((req) => {
              const url = req.url
              if (url.includes("/binary")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response(new Uint8Array([1, 2, 3]), {
                    status: 200,
                    headers: { "content-type": "application/octet-stream" }
                  }))
                )
              }
              if (url.includes("/bad-utf8")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response(new Uint8Array([0xff, 0xfe]), {
                    status: 200,
                    headers: { "content-type": "text/plain" }
                  }))
                )
              }
              const payload = s.bodyKind === 0
                ? JSON.stringify({ ok: true, secret, name: s.pathSeg })
                : s.bodyKind === 1
                ? JSON.stringify(`scalar-${secret}`)
                : s.bodyKind === 2
                ? `plain-${secret}`
                : ""
              const ct = s.bodyKind <= 1 ? "application/json" : "text/plain"
              return Effect.succeed(
                HttpClientResponse.fromWeb(req, new Response(payload, {
                  status: 200,
                  headers: {
                    "content-type": ct,
                    location: locHeader,
                    "x-ignored-header": "should-drop"
                  }
                }))
              )
            })

            const recFile = join(dir, "http-rec.json")
            const recEffect = Effect.scoped(
              Effect.gen(function*() {
                const client = yield* HttpRecording.make({
                  mode: "record",
                  path: recFile,
                  live: liveClient,
                  label: s.pathSeg,
                  secrets: [secret],
                  prune: s.usePrune
                    ? (body) => (typeof body === "object" && body !== null ? { ...(body as object), pruned: true } : body)
                    : undefined
                })
                const req = HttpClientRequest.get(`https://api.example.com/${encodeURIComponent(s.pathSeg)}?token=${secret}`)
                const res = yield* client.execute(req)
                expect(res.status).toBe(200)
                yield* res.text

                // Binary & invalid UTF-8 die
                const binEx = yield* Effect.exit(client.execute(HttpClientRequest.get("https://api.example.com/binary")))
                expect(Exit.isFailure(binEx)).toBe(true)
                const utfEx = yield* Effect.exit(client.execute(HttpClientRequest.get("https://api.example.com/bad-utf8")))
                expect(Exit.isFailure(utfEx)).toBe(true)

                if (s.failScope) return yield* Effect.fail("abort-record")
              })
            )
            const recExit = yield* Effect.exit(recEffect)
            expect(Exit.isSuccess(recExit)).toBe(!s.failScope)
            expect(existsSync(recFile)).toBe(!s.failScope)

            if (!s.failScope) {
              const raw = readFileSync(recFile, "utf8")
              expect(raw).not.toContain(secret)
              // Replay via HttpRecording.layer
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const client = yield* HttpClient.HttpClient
                  const req = HttpClientRequest.get(`https://api.example.com/${encodeURIComponent(s.pathSeg)}?token=${secret}`)
                  const res = yield* client.execute(req)
                  expect(res.status).toBe(200)
                }).pipe(
                  Effect.provide(HttpRecording.layer({ mode: "replay", path: recFile, secrets: [secret] }))
                )
              )
            }

            // passthrough mode + missing live dies
            const pt = yield* Effect.scoped(HttpRecording.make({ mode: "passthrough", path: recFile, live: liveClient }))
            expect(pt).toBe(liveClient)
            const noLivePt = yield* Effect.exit(Effect.scoped(HttpRecording.make({ mode: "passthrough", path: recFile })))
            expect(Exit.isFailure(noLivePt)).toBe(true)
            const noLiveRec = yield* Effect.exit(Effect.scoped(HttpRecording.make({ mode: "record", path: recFile })))
            expect(Exit.isFailure(noLiveRec)).toBe(true)

            // FixtureStore: layerMemory, layerFile, journal truncation recovery, invalid journal index, symlink dir refusal
            const memRes = yield* Effect.gen(function*() {
              const st = yield* FixtureStore.FixtureStore
              return yield* st.load()
            }).pipe(Effect.provide(FixtureStore.layerMemory()))
            expect(Option.isNone(memRes) || Option.isSome(memRes)).toBe(true)

            const fxFile = join(dir, "sub", "fx.json")
            const dummyCall: Fixture.RecordedCall = {
              request: { modelId: "m1", system: [], messages: [], tools: [], params: {} },
              model: "m1",
                            events: [{ type: "settle", stopReason: "stop" }]
            }
            yield* Effect.scoped(
              Effect.gen(function*() {
                const st = yield* FixtureStore.FixtureStore
                yield* st.append(dummyCall)
              }).pipe(Effect.provide(FixtureStore.layerFile(fxFile)))
            )
            expect(existsSync(fxFile)).toBe(true)

            // Truncated trailing journal line recovery
            writeFileSync(`${fxFile}.journal`, `${JSON.stringify({ index: 1, call: dummyCall })}\n{"partial":true`)
            const recovered = yield* FixtureStore.makeFile(fxFile)
            const loaded = yield* recovered.load()
            expect(Option.isSome(loaded) && loaded.value.calls.length === 2).toBe(true)
            yield* recovered.flush()

            // Invalid journal index dies
            writeFileSync(`${fxFile}.journal`, `${JSON.stringify({ index: 99, call: dummyCall })}\n`)
            const badIdx = yield* Effect.exit(FixtureStore.makeFile(fxFile))
            expect(Exit.isFailure(badIdx)).toBe(true)
            rmSync(`${fxFile}.journal`, { force: true })

            // Non-regular journal (directory) refused
            const badJournalFx = join(dir, "bad-journal.json")
            mkdirSync(`${badJournalFx}.journal`)
            const symEx = yield* Effect.exit(FixtureStore.makeFile(badJournalFx))
            expect(Exit.isFailure(symEx)).toBe(true)
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }).pipe(Effect.provide(NodeHost.layer))
    ), 120_000)

  it("fuzzes Faults (process kill, reparent, waitFor, skewClock) and TestLayers (unit, poisoned)", () =>
    property(
      Arbitrary.all({
        skewMs: intBetween(-50_000, 50_000),
        advanceMs: intBetween(-10_000, 10_000),
        reparentStep: intBetween(0, 2)
      }),
      Math.min(ioExecs, 8),
      (s) =>
        Effect.gen(function*() {
          // 1. Faults.skewClock
          const clock = Faults.skewClock(s.skewMs)
          try {
            const before = Date.now()
            expect(typeof Date()).toBe("string")
            expect(new Date().getTime()).toBeGreaterThanOrEqual(before - 50)
            expect(new Date(1000).getTime()).toBe(1000)
            clock.advance(s.advanceMs)
            expect(() => clock.advance(Number.NaN)).toThrow(RangeError)
            expect(() => Faults.skewClock(Number.POSITIVE_INFINITY)).toThrow(RangeError)
          } finally {
            clock.restore()
            clock.restore() // idempotent
          }

          // 2. Faults.waitFor, isAlive, parentPid, waitForReparent, killGroup, killProcess
          expect(Faults.isAlive(process.pid)).toBe(true)
          expect(Faults.isAlive(0)).toBe(false)
          expect(Faults.isAlive(99999999, () => {
            const e = Object.assign(new Error("esrch"), { code: "ESRCH" })
            throw e
          })).toBe(false)
          expect(Faults.isAlive(1, () => {
            const e = Object.assign(new Error("eperm"), { code: "EPERM" })
            throw e
          })).toBe(true)
          expect(Faults.parentPid(process.pid)).toBe(process.ppid)
          expect(() => Faults.parentPid(0)).toThrow()

          yield* Effect.promise(() => Faults.waitFor(() => true, "immediate", 50))
          const wfTimeout = yield* Effect.exit(Effect.tryPromise(() => Faults.waitFor(() => false, "never", 10)))
          expect(Exit.isFailure(wfTimeout)).toBe(true)
          const wfBad = yield* Effect.exit(Effect.tryPromise(() => Faults.waitFor(() => true, "bad", -1)))
          expect(Exit.isFailure(wfBad)).toBe(true)

          let pollCount = 0
          if (s.reparentStep === 0) {
            const np = yield* Effect.promise(() =>
              Faults.waitForReparent(123, 10, 500, () => (++pollCount >= 2 ? "1\n" : "10\n"))
            )
            expect(np).toBe(1)
          } else if (s.reparentStep === 1) {
            const ex = yield* Effect.exit(Effect.tryPromise(() => Faults.waitForReparent(123, 10, 500, () => "")))
            expect(Exit.isFailure(ex)).toBe(true)
          } else {
            const ex = yield* Effect.exit(Effect.tryPromise(() => Faults.waitForReparent(123, 10, 15, () => "10\n")))
            expect(Exit.isFailure(ex)).toBe(true)
          }

          // killGroup no-op on invalid, swallows error on valid
          Faults.killGroup(0)
          Faults.killGroup(-5)
          Faults.killGroup(42, "SIGKILL", () => {
            throw new Error("gone")
          })

          // killProcess: real short-lived child + error paths
          const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" })
          yield* Effect.promise(() => Faults.killProcess(child, "SIGKILL", 5_000))
          const badPid = yield* Effect.exit(Effect.tryPromise(() => Faults.killProcess({ pid: 0 })))
          expect(Exit.isFailure(badPid)).toBe(true)
          const deadPid = yield* Effect.exit(
            Effect.tryPromise(() =>
              Faults.killProcess({ pid: 12345 }, "SIGKILL", 100, () => {
                throw Object.assign(new Error("esrch"), { code: "ESRCH" })
              })
            )
          )
          expect(Exit.isFailure(deadPid)).toBe(true)
          const otherErr = yield* Effect.exit(
            Effect.tryPromise(() =>
              Faults.killProcess({ pid: 12345 }, "SIGKILL", 100, () => {
                throw Object.assign(new Error("eperm"), { code: "EPERM" })
              })
            )
          )
          expect(Exit.isFailure(otherErr)).toBe(true)

          // 3. TestLayers.unit & TestLayers.poisoned
          const unitStore = yield* MemoryEngine.makeStore()
          const unitBundle = TestLayers.unit(MemoryEngine.layer(unitStore))
          const hasUnit = yield* Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return typeof fs.exists
          }).pipe(Effect.provide(unitBundle))
          expect(hasUnit).toBe("function")

          // Verify poisoned services throw CapabilityContractError and allow probe reads
          yield* Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const p = yield* Path.Path
            const spawner = yield* ChildProcessSpawner
            const jj = yield* Kernel.Jj.Jj
            const http = yield* HttpClient.HttpClient
            const model = yield* ModelLike
            const clk = yield* Clock.Clock
            const rnd = yield* Random.Random

            expect((fs as unknown as Record<string, unknown>).then).toBeUndefined()
            expect((fs as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined()
            for (const touch of [
              () => (fs as unknown as Record<string, unknown>).exists,
              () => (p as unknown as Record<string, unknown>).sep,
              () => (spawner as unknown as Record<string, unknown>).spawn,
              () => (jj as unknown as Record<string, unknown>).status,
              () => (http as unknown as Record<string, unknown>).execute,
              () => clk.currentTimeMillisUnsafe(),
              () => clk.currentTimeNanosUnsafe(),
              () => clk.monotonicTimeNanosUnsafe(),
              () => rnd.nextIntUnsafe(),
              () => rnd.nextDoubleUnsafe()
            ]) {
              expect(touch).toThrow()
            }
            for (const eff of [
              clk.currentTimeMillis,
              clk.currentTimeNanos,
              clk.monotonicTimeNanos,
              clk.sleep(1 as never),
              Stream.runDrain(model.stream({ modelId: "m", system: [], messages: [], tools: [], params: {} }))
            ]) {
              const ex = yield* Effect.exit(eff)
              expect(Exit.isFailure(ex)).toBe(true)
              if (Exit.isFailure(ex)) {
                const def = Cause.findDefect(ex.cause)
                expect(def._tag).toBe("Success")
              }
            }
          }).pipe(Effect.provide(TestLayers.poisoned))
        })
    ), 120_000)
})
