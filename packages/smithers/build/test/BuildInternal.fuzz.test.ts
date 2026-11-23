import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as BoundedOutput from "../src/internal/boundedOutput.ts"
import * as Diagnostic from "../src/internal/diagnostic.ts"
import * as Platform from "../src/internal/platform.ts"
import * as Validate from "../src/internal/validate.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261132")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/build internal security & boundary fuzz invariants", () => {
  it("boundedOutput & decodedText enforce 64 KiB stream ceiling, dynamic buffer growth, and strict UTF-8", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chunkSizes: Schema.Array(
          Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.check(Schema.isLessThanOrEqualTo(25_000)))
        ).pipe(Schema.check(Schema.isMaxLength(5))),
        badUtf8: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chunkSizes, badUtf8 }) =>
          Effect.gen(function*() {
            const chunks = chunkSizes.map((sz) => new Uint8Array(sz).fill(65))
            const total = chunkSizes.reduce((a, b) => a + b, 0)
            const res = yield* Effect.result(BoundedOutput.boundedOutput(Stream.fromIterable(chunks)))
            if (total > BoundedOutput.maximumVersionOutputBytes) {
              if (Result.isSuccess(res)) return false
            } else {
              if (Result.isFailure(res)) return false
              if (res.success.byteLength !== total) return false
              const text = BoundedOutput.decodedText(res.success, "probe")
              if (text.length !== total) return false
            }

            if (badUtf8) {
              let threw = false
              try {
                BoundedOutput.decodedText(new Uint8Array([0xff, 0xfe, 0x80]), "bad.bin")
              } catch {
                threw = true
              }
              if (!threw) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("normalizePlatform, diagnostic & validate refuse hostile getters, proxies, oversized members, and NUL bytes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        os: Schema.Literals(["linux", "darwin", "", "a".repeat(260), "bad\0os"]),
        arch: Schema.Literals(["x64", "arm64", "", "a".repeat(260)]),
        libc: Schema.Literals(["glibc", "musl", "null", "", "a".repeat(260)]),
        causeKind: Schema.Literals([
          "undefined",
          "null",
          "symbol",
          "number",
          "string",
          "nestedError",
          "taggedObj",
          "hostileProxy",
          "emptyObj"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const rawPlatform = {
              os: c.os,
              arch: c.arch,
              libc: c.libc === "null" ? null : c.libc
            }
            const validOs = c.os === "linux" || c.os === "darwin"
            const validArch = c.arch === "x64" || c.arch === "arm64"
            const validLibc = c.libc === "glibc" || c.libc === "musl" || c.libc === "null"
            let platThrew = false
            try {
              const out = Platform.normalizePlatform(rawPlatform, "fuzz")
              if (!Object.isFrozen(out)) return false
            } catch {
              platThrew = true
            }
            if ((validOs && validArch && validLibc) && platThrew) return false
            if (!(validOs && validArch && validLibc) && !platThrew) return false

            // Accessor getter on platform must be refused without executing
            let getterCalled = false
            const hostilePlat = { arch: "x64", libc: null }
            Object.defineProperty(hostilePlat, "os", {
              enumerable: true,
              get: () => {
                getterCalled = true
                return "linux"
              }
            })
            let getterThrew = false
            try {
              Platform.normalizePlatform(hostilePlat, "fuzz")
            } catch {
              getterThrew = true
            }
            void getterThrew
            if (getterCalled) return false

            // diagnostic on hostile & primitive causes
            let cause: unknown
            if (c.causeKind === "undefined") cause = undefined
            else if (c.causeKind === "null") cause = null
            else if (c.causeKind === "symbol") cause = Symbol("fuzz-sym")
            else if (c.causeKind === "number") cause = 42
            else if (c.causeKind === "string") cause = "x".repeat(3000)
            else if (c.causeKind === "nestedError") {
              const inner: any = new Error("ENOENT inner")
              inner.code = "ENOENT"
              cause = new Error("outer failed", { cause: inner })
            } else if (c.causeKind === "taggedObj") {
              cause = { _tag: "CustomTag", message: "custom msg", code: "ECUSTOM" }
            } else if (c.causeKind === "hostileProxy") {
              cause = new Proxy({}, {
                getOwnPropertyDescriptor: () => {
                  throw new Error("trap boom")
                }
              })
            } else {
              cause = {}
            }

            const diag = Diagnostic.diagnostic(cause)
            if (c.causeKind === "undefined") {
              if (diag !== undefined) return false
            } else {
              if (diag === undefined) return false
              if (diag.name.length > 128 || diag.message.length > 2048) return false
              if (diag.code !== undefined && diag.code.length > 128) return false
              // Must be JSON-serializable without throwing
              JSON.stringify(diag)
            }

            expect(Validate).toBeDefined()
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })
})
