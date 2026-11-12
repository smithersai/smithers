/**
 * The shared contract suite is itself test infrastructure every host package
 * depends on, so its two load-bearing helpers get their own cases: the code
 * normalizer must not invent a code, and the failure assertion must not let a
 * capability declared unsupported quietly succeed.
 */
import { describe, expect, it } from "@effect/vitest"
import { type Jj, JjError } from "@smthrs/jj"
import { Cause, Effect, Exit, type FileSystem } from "effect"
import { tmpdir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import { expectTypeOf } from "vitest"
import {
  assertFailure,
  defaultScratchPath,
  errorCode,
  type FileSystemOperation,
  FileSystemOperations,
  type JjOperation,
  JjOperations
} from "./HostContract.ts"

describe("operation lists", () => {
  // Type-level: the lists are the services' method names, no more and no
  // less, so a method Effect or `@smthrs/jj` adds fails compilation here
  // instead of passing the contract unprobed. The one non-method key is the
  // `~`-prefixed type id Effect brands its services with.
  it("names every method of Effect's filesystem service exactly once", () => {
    expectTypeOf<FileSystemOperation>().toEqualTypeOf<Exclude<keyof FileSystem.FileSystem, `~${string}`>>()
    expect(new Set(FileSystemOperations).size).toBe(FileSystemOperations.length)
  })

  it("names every method of the Jj service exactly once", () => {
    expectTypeOf<JjOperation>().toEqualTypeOf<keyof Jj>()
    expect(new Set(JjOperations).size).toBe(JjOperations.length)
  })
})

describe("errorCode", () => {
  it("prefers a string `code` field", () => {
    expect(errorCode(new JjError({ code: "conflict", message: "slow" }))).toBe("conflict")
  })

  it("falls back to a nested `reason._tag`", () => {
    expect(errorCode({ reason: { _tag: "TransportError" } })).toBe("TransportError")
  })

  it("falls back to a bare `_tag` when there is no reason", () => {
    expect(errorCode({ _tag: "NoFileUrls" })).toBe("NoFileUrls")
  })

  it("reports no code for values that carry none", () => {
    expect(errorCode(undefined)).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
    expect(errorCode("not_found")).toBeUndefined()
    expect(errorCode({})).toBeUndefined()
    expect(errorCode({ code: 500 })).toBeUndefined()
    expect(errorCode({ reason: "TransportError" })).toBeUndefined()
    expect(errorCode({ reason: { tag: "TransportError" } })).toBeUndefined()
    expect(errorCode({ _tag: 7 })).toBeUndefined()
  })
})

describe("assertFailure", () => {
  it.effect("passes when the effect fails with the declared code", () =>
    Effect.gen(function*() {
      expect(yield* assertFailure(Effect.fail(new JjError({ code: "conflict", message: "slow" })), "conflict"))
        .toBeUndefined()
    }))

  it.effect("rejects a capability declared unsupported that actually succeeds", () =>
    Effect.gen(function*() {
      // The helper throws rather than failing, so the refusal arrives as a defect.
      const exit = yield* Effect.exit(assertFailure(Effect.succeed("worked"), "unsupported"))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Cause.squash((exit as Exit.Failure<never, never>).cause)).toMatchObject({
        message: expect.stringContaining("expected typed failure unsupported")
      })
    }))

  it.effect("rejects a failure carrying a different code", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        assertFailure(Effect.fail(new JjError({ code: "not_installed", message: "no" })), "unsupported")
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("defaultScratchPath", () => {
  const outsideCwd = (path: string) => {
    const rel = relative(process.cwd(), path)
    return rel.startsWith("..") || isAbsolute(rel)
  }

  it("is absolute and lands under the OS temp directory, never the working tree", () => {
    const path = defaultScratchPath("NodeHost defaults")
    expect(isAbsolute(path)).toBe(true)
    expect(path.startsWith(tmpdir() + sep)).toBe(true)
    expect(outsideCwd(path)).toBe(true)
  })

  it("scopes the path by process id so concurrent test processes cannot race it", () => {
    expect(defaultScratchPath("NodeHost defaults")).toContain(`-${process.pid}-`)
  })

  it("never hands the same path to two suites, or to one suite twice", () => {
    const paths = [
      defaultScratchPath("NodeHost defaults"),
      defaultScratchPath("NodeHost defaults"),
      defaultScratchPath("BunHost defaults")
    ]
    expect(new Set(paths).size).toBe(3)
  })

  it("keeps the suite name recognizable but path-safe", () => {
    const path = defaultScratchPath("NodeHost defaults/../escape")
    expect(path).toContain("nodehost-defaults")
    expect(path).not.toContain("..")
  })

  it("falls back to a stable slug when the suite name leaves nothing path-safe", () => {
    expect(defaultScratchPath("/../")).toMatch(/-host$/)
    expect(defaultScratchPath("")).toMatch(/-host$/)
  })
})
