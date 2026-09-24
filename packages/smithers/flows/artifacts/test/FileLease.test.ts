import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as FileLease from "../src/FileLease.ts"

const platformError = (tag: PlatformError.SystemErrorTag, method: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: tag, module: "test", method })

const info = (type: FileSystem.File.Type, mtime: number) =>
  ({ type, mtime: Option.some(new Date(mtime)), size: BigInt(0) }) as FileSystem.File.Info

const temp = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-file-lease-" })
  return { fs, lockPath: `${directory}/lease.lock`, directory }
})

const onNode = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeFileSystem.layer))

/** Moves the test clock to the wall clock, so real file mtimes read as fresh. */
const wallClock = Effect.suspend(() => TestClock.setTime(Date.now()))

/** Lets real filesystem callbacks run while the test clock stands still. */
const realPause = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))

const backdate = (fs: FileSystem.FileSystem, path: string, ms: number) =>
  Effect.suspend(() => {
    const then = new Date(Date.now() - ms)
    return fs.utimes(path, then, then)
  })

describe("FileLease", () => {
  it.effect("holds a token-owned lock file for the effect and removes it after", () =>
    onNode(Effect.gen(function*() {
      const { fs, lockPath } = yield* temp
      const seen = yield* FileLease.withLease(fs, lockPath, fs.readFileString(lockPath), (cause) => cause)
      expect(seen).toMatch(/^[0-9a-z]+-[0-9a-z]+-\d+$/)
      expect(yield* fs.exists(lockPath)).toBe(false)
    })))

  it.effect("holds a lease with no deadline or acquisition hook", () =>
    onNode(Effect.gen(function*() {
      const { fs, lockPath } = yield* temp
      expect(yield* FileLease.hold(fs, lockPath, fs.exists(lockPath), (cause) => cause)).toBe(true)
      expect(yield* fs.exists(lockPath)).toBe(false)
    })))

  it.effect("reclaims a stale lock left by a killed owner", () =>
    onNode(Effect.gen(function*() {
      yield* wallClock
      const { directory, fs, lockPath } = yield* temp
      yield* fs.writeFileString(lockPath, "killed-owner")
      yield* backdate(fs, lockPath, 61_000)
      yield* FileLease.withLease(fs, lockPath, Effect.void, (cause) => cause)
      expect(yield* fs.readDirectory(directory)).toEqual([])
    })))

  it.effect("reclaims a stale legacy lock directory", () =>
    onNode(Effect.gen(function*() {
      yield* wallClock
      const { directory, fs, lockPath } = yield* temp
      yield* fs.makeDirectory(lockPath)
      yield* backdate(fs, lockPath, 61_000)
      yield* FileLease.withLease(fs, lockPath, Effect.void, (cause) => cause)
      expect(yield* fs.readDirectory(directory)).toEqual([])
    })))

  it.effect("waits on a fresh legacy lock directory and times out with a TimeoutError", () =>
    onNode(Effect.gen(function*() {
      // The test clock stays at zero, so the directory's real mtime never ages.
      const { fs, lockPath } = yield* temp
      yield* fs.makeDirectory(lockPath)
      const waiting = yield* FileLease.withLease(fs, lockPath, Effect.void, (cause) => cause, {
        acquireWithin: "5 seconds"
      }).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* realPause
      yield* TestClock.adjust("5 seconds")
      const exit = yield* Fiber.join(waiting)
      expect(Exit.isFailure(exit) && Cause.isTimeoutError(Cause.squash(exit.cause))).toBe(true)
      expect((yield* fs.stat(lockPath)).type).toBe("Directory")
    })))

  it.effect("propagates an owner read refusal when the lock cannot be stat'd either", () =>
    Effect.gen(function*() {
      const refused = platformError("PermissionDenied", "readFileString")
      const fs = FileSystem.makeNoop({
        writeFileString: (() => Effect.fail(platformError("AlreadyExists", "writeFileString"))) as never,
        readFileString: (() => Effect.fail(refused)) as never,
        stat: (() => Effect.fail(platformError("PermissionDenied", "stat"))) as never
      })
      const exit = yield* FileLease.withLease(fs, "lease.lock", Effect.void, (cause) => cause).pipe(Effect.exit)
      expect(exit).toStrictEqual(Exit.fail(refused))
    }))

  it.effect("does not hand back a directory that a stale file lock was renamed over", () =>
    Effect.gen(function*() {
      let held = false
      const removed: Array<string> = []
      const writes: Array<string> = []
      const fs = FileSystem.makeNoop({
        writeFileString: ((path: string) =>
          Effect.suspend(() => {
            writes.push(path)
            if (path === "lease.lock" && !held) {
              held = true
              return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            }
            return Effect.void
          })) as never,
        readFileString: ((path: string) =>
          path === "lease.lock"
            ? Effect.succeed("stale-owner")
            : path.includes(".reclaim-")
            ? Effect.succeed("claimant")
            : Effect.fail(platformError("Unknown", "readFileString"))) as never,
        stat: ((path: string) =>
          Effect.succeed(info(path.includes(".stale-") ? "Directory" : "File", -120_000))) as never,
        rename: (() => Effect.void) as never,
        remove: ((path: string) => Effect.sync(() => void removed.push(path))) as never
      })
      yield* FileLease.withLease(fs, "lease.lock", Effect.void, (cause) => cause)
      // One failed create, the claim, and the successful create: no hand-back.
      expect(writes.filter((path) => path === "lease.lock")).toHaveLength(2)
      expect(removed.some((path) => path.startsWith("lease.lock.stale-"))).toBe(true)
    }))

  it.effect("names the lock by its label when a live holder's lock is reclaimed", () =>
    onNode(Effect.gen(function*() {
      const { fs, lockPath } = yield* temp
      const messages: Array<unknown> = []
      const logger = Logger.layer([Logger.make<unknown, void>(({ message }) => messages.push(message))])
      const removed = yield* Deferred.make<void>()
      const holding = yield* FileLease.withLease(
        fs,
        lockPath,
        fs.remove(lockPath).pipe(Effect.andThen(Deferred.succeed(removed, undefined)), Effect.andThen(Effect.never)),
        (cause) => cause,
        { label: "Test lock", heartbeatEvery: "1 second" }
      ).pipe(Effect.provide(logger), Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(removed)
      for (let beat = 0; beat < 50 && messages.length === 0; beat++) {
        yield* TestClock.adjust("1 second")
        yield* realPause
      }
      yield* Fiber.interrupt(holding)
      expect(messages.flat()).toContain("Test lock was reclaimed while its holder was still running")
    })))
})
