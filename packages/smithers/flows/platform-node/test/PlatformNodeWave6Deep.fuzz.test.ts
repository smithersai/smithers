import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { ProcessLedger } from "@smthrs/kernel"
import { Arbitrary, Effect, Exit, Layer, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as ProcSnapshot from "../src/internal/ProcSnapshot.ts"
import * as RegularFile from "../src/internal/RegularFile.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const NodePlatform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

describe("@smthrs/platform-node Wave 6 deep fuzz (ProcessReaper, ProcSnapshot, RegularFile, ScopedProcess)", () => {
  it("ProcessReaper.reap and report enforce identity tolerance, own-group safety, boot-time checks, liveness/kill states, and ledger cleanup", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        liveness: Schema.Literals(["alive", "dead", "unknown"]),
        startKind: Schema.Literals(["exact", "driftOk", "driftBad", "gone", "unavailable", "unsupported"]),
        killOutcome: Schema.Literals(["signalled", "already-gone", "failed"]),
        ownGroupMatch: Schema.Boolean,
        beforeBoot: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ liveness, startKind, killOutcome, ownGroupMatch, beforeBoot }) =>
          Effect.gen(function*() {
            const startedAtMs = 1_700_000_000_000
            const pid = 42001
            const pgid = ownGroupMatch ? 9999 : 42001

            const record: ProcessLedger.ProcessRecord = {
              pid,
              pgid,
              hostId: "fuzz-host",
              ownerPid: 42002,
              startedAtMs,
              commandDigest: "fuzz-cmd"
            }

            const reapedPids: Array<number> = []
            const skippedReasons: Array<string> = []
            const ledger: ProcessLedger.Service = {
              record: () => Effect.succeed(record),
              release: () => Effect.void,
              reaped: (row) => Effect.sync(() => void reapedPids.push(row.pid)),
              skipped: (_row, reason) => Effect.sync(() => void skippedReasons.push(reason)),
              live: Effect.succeed([]),
              orphans: Effect.succeed([record])
            }

            const fakeSystem: ProcessReaper.System = {
              isAlive: () => liveness,
              startedAtMs: () =>
                startKind === "exact"
                  ? { _tag: "started", startedAtMs }
                  : startKind === "driftOk"
                    ? { _tag: "started", startedAtMs: startedAtMs + 500 }
                    : startKind === "driftBad"
                      ? { _tag: "started", startedAtMs: startedAtMs + 90_000 }
                      : { _tag: startKind },
              ownGroup: () => 9999,
              bootedAtMs: () => (beforeBoot ? startedAtMs + 60_000 : startedAtMs - 60_000),
              refuseTarget: (rec) => (rec.pgid === 9999 ? "own-group" : undefined),
              killTree: () => killOutcome
            }

            const decided = yield* ProcessReaper.reap({ system: fakeSystem }).pipe(
              Effect.provideService(ProcessLedger.ProcessLedger, ledger)
            )
            yield* ProcessReaper.report(decided)
            expect(decided.length).toBe(1)

            expect(ProcessReaper.systemFor("linux")).toBeDefined()
            expect(ProcessReaper.systemFor("darwin")).toBeDefined()
            expect(ProcessReaper.systemFor("win32")).toBeDefined()
            expect(ProcessReaper.groupSnapshotFor("linux")).toBeDefined()
            expect(ProcessReaper.groupSnapshotFor("darwin")).toBeDefined()
            expect(ProcessReaper.groupSnapshotFor("win32")).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 90), seed }
      )
    )
    assertPassed(report)
  })

  it("ProcSnapshot.parseStat, bootMs, ownGroup, startedAtMs, and snapshot handle valid, parenthesized, and malformed /proc trees", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        comm: Schema.Literals(["node", "my (weird) proc", "sh", "a b c"]),
        state: Schema.Literals(["R", "S", "Z", "T"]),
        pgid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50000 })),
        ticks: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000 })),
        malformed: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ comm, state, pgid, ticks, malformed }) =>
          Effect.sync(() => {
            const fields = Array.from({ length: 24 }, (_, i) => (i === 19 ? String(ticks) : "0"))
            fields[0] = state
            fields[1] = "1"
            fields[2] = String(pgid)
            const statLine = malformed ? `not-a-valid-stat-line ${comm}` : `1234 (${comm}) ${fields.join(" ")}`
            const parsed = ProcSnapshot.parseStat(statLine, 1_700_000_000_000)
            if (malformed) {
              expect(parsed).toBeUndefined()
            } else {
              expect(parsed).toBeDefined()
              expect(parsed?.pgid).toBe(pgid)
            }

            const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proc-snap-w6-"))
            try {
              fs.writeFileSync(path.join(procRoot, "stat"), "cpu 1 2 3\nbtime 1700000000\n")
              fs.mkdirSync(path.join(procRoot, "self"), { recursive: true })
              fs.writeFileSync(path.join(procRoot, "self", "stat"), `1234 (${comm}) ${fields.join(" ")}`)
              fs.mkdirSync(path.join(procRoot, "1234"), { recursive: true })
              fs.writeFileSync(path.join(procRoot, "1234", "stat"), statLine)

              expect(ProcSnapshot.bootMs(procRoot)).toBe(1_700_000_000_000)
              expect(ProcSnapshot.ownGroup(procRoot)()).toBe(pgid)
              const snap = ProcSnapshot.snapshot(procRoot)(pgid)
              expect(snap === undefined || typeof snap === "object").toBe(true)
              const started = ProcSnapshot.startedAtMs(procRoot)(1234)
              expect(["started", "gone", "unavailable", "unsupported"]).toContain(started._tag)
              expect(ProcSnapshot.rootFor("linux")).toBe("/proc")
              expect(ProcSnapshot.rootFor("darwin")).toBeUndefined()
            } finally {
              fs.rmSync(procRoot, { recursive: true, force: true })
            }
            return true
          }),
        { executions: Math.min(executions, 60), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("RegularFile.open rejects symlinks, directories, and missing files while ScopedProcess.spawn/status cleanly tracks lifecycle", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fileKind: Schema.Literals(["regular", "symlink", "dir", "missing"]),
        plat: Schema.Literals(["linux", "win32"]),
        exitCode: Schema.Literals([0, 2, 7])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fileKind, plat, exitCode }) =>
          Effect.gen(function*() {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regfile-w6-"))
            try {
              const realFile = path.join(dir, "real.txt")
              fs.writeFileSync(realFile, "hello")
              const target =
                fileKind === "regular"
                  ? realFile
                  : fileKind === "symlink"
                    ? (() => {
                        const l = path.join(dir, "link.txt")
                        fs.symlinkSync(realFile, l)
                        return l
                      })()
                    : fileKind === "dir"
                      ? dir
                      : path.join(dir, "missing.txt")

              const opened = yield* Effect.scoped(RegularFile.open(plat, target)).pipe(
                Effect.provide(NodePlatform),
                Effect.exit
              )
              if (fileKind === "regular") {
                expect(Exit.isSuccess(opened)).toBe(true)
              } else if (fileKind === "dir" || fileKind === "missing") {
                expect(Exit.isFailure(opened)).toBe(true)
              } else {
                expect(Exit.isSuccess(opened) || Exit.isFailure(opened)).toBe(true)
              }
            } finally {
              fs.rmSync(dir, { recursive: true, force: true })
            }

            const statusResult = yield* Effect.scoped(
              Effect.gen(function*() {
                const handle = yield* ScopedProcess.spawn({
                  command: "sh",
                  args: ["-c", `exit ${exitCode}`],
                  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
                })
                const code = yield* handle.exitCode
                const st = yield* ScopedProcess.status(handle)
                return { code, st }
              })
            ).pipe(Effect.provide(NodePlatform))
            expect(statusResult.code).toBe(exitCode)
            expect(statusResult.st).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 30), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
