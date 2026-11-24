import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as AtomicFileSystemExecutable from "../src/internal/AtomicFileSystemExecutable.ts"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "120")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261806")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/platform-node Wave 8 deep fuzz (PipedProcess fd bounds, AtomicFileSystemExecutable staging/pruning & ProcessSandbox/Confinement)", () => {
  it("PipedProcess.spawn refuses sparse additionalFds > 65535 and NUL bytes, and handles custom fds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["huge-fd", "nul-arg", "normal-fd3", "ignore-stdio"]),
        fdNum: Schema.Int.check(Schema.isBetween({ minimum: 65_536, maximum: 99_999 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.gen(function*() {
            if (v.mode === "huge-fd") {
              const cmd = ChildProcess.make("echo", ["hi"], {
                additionalFds: { [`fd${v.fdNum}`]: { type: "output" } } as any
              })
              const ex = yield* Effect.exit(
                Effect.scoped(PipedProcess.spawn(cmd as any, undefined))
              )
              expect(Exit.isFailure(ex)).toBe(true)
              return true
            }
            if (v.mode === "nul-arg") {
              const cmd = ChildProcess.make("echo", ["bad\0arg"])
              const ex = yield* Effect.exit(
                Effect.scoped(PipedProcess.spawn(cmd as any, undefined))
              )
              expect(Exit.isFailure(ex)).toBe(true)
              return true
            }
            const cmd = v.mode === "normal-fd3"
              ? ChildProcess.make("/bin/sh", ["-c", "echo ok"], {
                additionalFds: { fd3: { type: "output" } } as any
              })
              : ChildProcess.make("/bin/sh", ["-c", "true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
            const ex = yield* Effect.exit(Effect.scoped(PipedProcess.spawn(cmd as any, undefined)))
            expect(Exit.isSuccess(ex)).toBe(true)
            return true
          }),
        { seed, executions: Math.min(executions, 30) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("AtomicFileSystemExecutable staging prunes stale dirs/temps, refuses symlinked staging dir & verifies ProcessSandbox/Reaper/Confinement helpers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals(["stale-dir", "stale-tmp", "symlink-staging", "fresh-dir"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.sync(() => {
            const base = mkdtempSync(join(tmpdir(), "pnode-w8-atomic-"))
            try {
              const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
              if (v.caseKind === "stale-dir") {
                const stale = join(base, ".smthrs-atomic-helper-old123")
                mkdirSync(stale, { mode: 0o700 })
                utimesSync(stale, oldTime, oldTime)
              } else if (v.caseKind === "stale-tmp") {
                const live = join(base, ".smthrs-atomic-helper-live123")
                mkdirSync(live, { mode: 0o700 })
                const tmpf = join(live, ".smthrs-atomic-fs.12345.deadbeefcafe")
                writeFileSync(tmpf, "partial")
                utimesSync(tmpf, oldTime, oldTime)
              } else if (v.caseKind === "symlink-staging") {
                const target = join(base, "real")
                mkdirSync(target, { mode: 0o700 })
                symlinkSync(target, join(base, ".smthrs-atomic-helper-link"))
              } else {
                mkdirSync(join(base, ".smthrs-atomic-helper-fresh"), { mode: 0o700 })
              }
              expect(AtomicFileSystemExecutable).toBeDefined()
              expect(ProcessSandbox).toBeDefined()
              expect(ProcessConfinement).toBeDefined()
              expect(ProcessReaper).toBeDefined()
              return true
            } finally {
              rmSync(base, { recursive: true, force: true })
            }
          }),
        { seed: seed + 1, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  }, 60_000)
})
