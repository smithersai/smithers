import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Jj from "../src/Jj.ts"

describe("jjError", () => {
  it("builds jj errors with the Jj module default and carries the command", () => {
    const error = Jj.jjError({
      code: "conflict",
      method: "restore",
      description: "working copy conflicted",
      command: "jj restore --from abc"
    })

    expect(error._tag).toBe("@smthrs/jj/JjError")
    expect(error.module).toBe("Jj")
    expect(error.message).toBe("conflict: Jj.restore: working copy conflicted")
    expect(error.command).toBe("jj restore --from abc")
    expect(Jj.jjError({ code: "invalid_ref", module: "NodeJj", method: "diff" }).command)
      .toBeUndefined()
  })

  it("omits the description clause when none is given and honors a module override", () => {
    expect(Jj.jjError({ code: "unknown", module: "NodeJj", method: "status" }).message)
      .toBe("unknown: NodeJj.status")
  })
})

describe("JjError durability", () => {
  /**
   * The module header promises `JjError` round-trips through the journal, and a
   * journal round-trip is `JSON.stringify` somewhere along the way. An `Error`
   * stringifies to `{}` because its `message` and `stack` are non-enumerable,
   * so a `cause` holding the live host failure arrived on the other side of a
   * replay with the diagnosis gone. `jjErrorCause` copies the three fields out
   * instead, and this drives the whole trip to prove they survive it.
   */
  it("survives encode, JSON, and decode with its cause intact", () => {
    const spawnFailure = Object.assign(new Error("spawn jj ENOENT"), { code: "ENOENT", syscall: "spawn jj" })
    const error = new Jj.JjError({
      code: "not_installed",
      module: "NodeJj",
      method: "snapshot",
      message: "jj: command not found on PATH",
      command: "jj log -r @",
      cause: Jj.jjErrorCause(spawnFailure)
    })

    const journaled = JSON.parse(JSON.stringify(Schema.encodeUnknownSync(Jj.JjError)(error))) as unknown
    const restored = Schema.decodeUnknownSync(Jj.JjError)(journaled)

    expect(restored._tag).toBe("@smthrs/jj/JjError")
    expect(restored.code).toBe("not_installed")
    expect(restored.module).toBe("NodeJj")
    expect(restored.method).toBe("snapshot")
    expect(restored.message).toBe("jj: command not found on PATH")
    expect(restored.command).toBe("jj log -r @")
    expect(restored.cause).toEqual({ name: "Error", code: "ENOENT", message: "spawn jj ENOENT" })
  })

  it("projects a tagged failure and a non-object onto the same three fields", () => {
    expect(Jj.jjErrorCause({ _tag: "SystemError", message: "denied" }))
      .toEqual({ name: "SystemError", message: "denied" })
    expect(Jj.jjErrorCause("plain string")).toEqual({ message: "plain string" })
    expect(Jj.jjErrorCause({ code: 7 })).toEqual({ message: "[object Object]" })
  })

  it("bounds the cause message so a host failure cannot drag a payload into the journal", () => {
    const long = Jj.jjErrorCause(new Error("x".repeat(Jj.causeMessageLimit + 500)))

    expect(long.message).toHaveLength(Jj.causeMessageLimit)
    expect(long.message.endsWith("…")).toBe(true)
  })

  it("bounds every string projected from an arbitrary host failure", () => {
    const cause = Jj.jjErrorCause({
      name: "n".repeat(Jj.causeMessageLimit + 1),
      code: "c".repeat(Jj.causeMessageLimit + 1),
      message: "short"
    })

    expect(cause.name).toHaveLength(Jj.causeMessageLimit)
    expect(cause.name?.endsWith("…")).toBe(true)
    expect(cause.code).toHaveLength(Jj.causeMessageLimit)
    expect(cause.code?.endsWith("…")).toBe(true)
  })

  it("refuses an over-length cause at construction and journal decode", () => {
    const base = {
      _tag: "@smthrs/jj/JjError",
      code: "unknown",
      message: "bounded failure"
    } as const

    expect(() =>
      new Jj.JjError({
        code: "unknown",
        message: "bounded failure",
        cause: { message: "x".repeat(Jj.causeMessageLimit + 1) }
      })
    ).toThrow()
    for (const field of ["name", "code", "message"] as const) {
      const cause = { message: "bounded", [field]: "x".repeat(Jj.causeMessageLimit + 1) }
      expect(() => Schema.decodeUnknownSync(Jj.JjError)({ ...base, cause }), field).toThrow()
    }
  })
})

describe("Jj facade", () => {
  it.effect("fails every method with `not_installed` naming the method that was called", () =>
    Effect.gen(function*() {
      const jj = Jj.makeNoop({})
      const calls: ReadonlyArray<readonly [string, Effect.Effect<unknown, Jj.JjFailure | PlatformError>]> = [
        ["snapshot", jj.snapshot("msg")],
        ["restore", jj.restore("abc")],
        ["diff", jj.diff("a", "b")],
        ["workspaceAdd", jj.workspaceAdd("lane", "/tmp/lane")],
        ["workspaceForget", jj.workspaceForget("lane")],
        ["status", jj.status()],
        // The optional operations are stubbed too: a test that reaches one
        // gets the named failure, not `undefined is not a function`.
        ["root", jj.root!("/lane")],
        ["revert", jj.revert!("abc")]
      ]

      for (const [method, effect] of calls) {
        const error = yield* (Effect.flip(effect))
        expect(error).toMatchObject({
          code: "not_installed",
          module: "Jj",
          method,
          message: `not_installed: Jj.${method}: jj is not available on this host`
        })
      }
    }))

  it.effect("provides overrides through `layerNoop` while other methods stay unavailable", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const jj = yield* Jj.Jj
          const snapshot = yield* jj.snapshot()
          const failed = yield* Effect.flip(jj.status())
          return { snapshot, failed }
        }).pipe(Effect.provide(Jj.layerNoop({ snapshot: () => Effect.succeed({ commitId: "zzz", changeId: "zzz" }) })))
      )

      expect(result.snapshot.changeId).toBe("zzz")
      expect(result.failed).toMatchObject({ code: "not_installed", method: "status" })
    }))
})

describe("Jj constructor", () => {
  it.effect("passes a complete implementation through `make` unchanged", () =>
    Effect.gen(function*() {
      const jj = Jj.make(Jj.makeNoop({ status: () => Effect.succeed("clean") }))

      expect(yield* (jj.status())).toBe("clean")
      expect(yield* (Effect.flip(jj.diff("a", "b")))).toMatchObject({ code: "not_installed", method: "diff" })
    }))
})
