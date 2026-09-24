import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import * as ArtifactBackupLease from "../src/ArtifactBackupLease.ts"

const directory = ".objects"
const marker = `${directory}/.backup-lease`

const platformError = (tag: PlatformError.SystemErrorTag, method: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: tag, module: "test", method })

const fileInfo = (mtime: Option.Option<Date>) => ({ type: "File", mtime, size: BigInt(0) }) as FileSystem.File.Info

interface Hooks {
  readonly makeDirectory?: () => Effect.Effect<void, unknown>
  readonly write?: (path: string, value: string, exists: boolean) => Effect.Effect<void, unknown> | undefined
  readonly read?: (path: string) => Effect.Effect<string, unknown> | undefined
  readonly stat?: (path: string) => Effect.Effect<FileSystem.File.Info, unknown> | undefined
  readonly remove?: (path: string) => Effect.Effect<void, unknown> | undefined
}

const host = (hooks: Hooks = {}) => {
  const files = new Map<string, string>()
  const mtimes = new Map<string, Option.Option<Date>>()
  const heartbeats: Array<string> = []
  const fs = FileSystem.makeNoop({
    makeDirectory: (() => hooks.makeDirectory?.() ?? Effect.void) as never,
    writeFileString: ((path: string, value: string, options?: { readonly flag?: string }) =>
      Effect.suspend(() => {
        const exists = files.has(path)
        const hooked = hooks.write?.(path, value, exists)
        if (hooked !== undefined) return hooked
        if (options?.flag === "wx" && exists) {
          return Effect.fail(platformError("AlreadyExists", "writeFileString"))
        }
        files.set(path, value)
        mtimes.set(path, Option.some(new Date(0)))
        return Effect.void
      })) as never,
    readFileString: ((path: string) =>
      Effect.suspend(() => {
        const hooked = hooks.read?.(path)
        if (hooked !== undefined) return hooked
        const value = files.get(path)
        return value === undefined
          ? Effect.fail(platformError("NotFound", "readFileString"))
          : Effect.succeed(value)
      })) as never,
    stat: ((path: string) =>
      Effect.suspend(() => {
        const hooked = hooks.stat?.(path)
        if (hooked !== undefined) return hooked
        return files.has(path)
          ? Effect.succeed(fileInfo(mtimes.get(path) ?? Option.none()))
          : Effect.fail(platformError("NotFound", "stat"))
      })) as never,
    remove: ((path: string) =>
      Effect.suspend(() => {
        const hooked = hooks.remove?.(path)
        if (hooked !== undefined) return hooked
        if (!files.delete(path)) return Effect.fail(platformError("NotFound", "remove"))
        mtimes.delete(path)
        return Effect.void
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        const value = files.get(from)
        if (value === undefined) return Effect.fail(platformError("NotFound", "rename"))
        files.delete(from)
        files.set(to, value)
        mtimes.set(to, mtimes.get(from) ?? Option.some(new Date(0)))
        mtimes.delete(from)
        return Effect.void
      })) as never,
    utimes: ((path: string, _atime: Date | number, mtime: Date | number) =>
      Effect.suspend(() => {
        if (!files.has(path)) return Effect.fail(platformError("NotFound", "utimes"))
        heartbeats.push(path)
        mtimes.set(path, Option.some(typeof mtime === "number" ? new Date(mtime) : mtime))
        return Effect.void
      })) as never
  })
  return {
    files,
    fs,
    heartbeats,
    mtimes,
    seed: (path: string, value: string, mtime: Option.Option<Date> = Option.some(new Date(0))) => {
      files.set(path, value)
      mtimes.set(path, mtime)
    }
  }
}

const failure = (cause: unknown): unknown => cause

describe("ArtifactBackupLease", () => {
  it.effect("cleans its marker when interrupted after creation before host completion", () =>
    Effect.gen(function*() {
      const written = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<void>()
      let bodyRan = false
      const fixture = host({
        write: (path, value) =>
          path === marker
            ? Effect.sync(() => fixture.seed(path, value)).pipe(
              Effect.andThen(Deferred.succeed(written, undefined)),
              Effect.andThen(Deferred.await(complete))
            )
            : undefined
      })
      const running = yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Effect.sync(() => {
          bodyRan = true
        }),
        failure
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(written)
      const stopping = yield* Fiber.interrupt(running).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Deferred.succeed(complete, undefined)
      yield* Fiber.join(stopping)
      expect(bodyRan).toBe(false)
      expect(fixture.files.has(marker)).toBe(false)
    }))

  it.effect("cleans its marker when interrupted while releasing the acquisition gate", () =>
    Effect.gen(function*() {
      const releasing = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<void>()
      let paused = false
      let bodyRan = false
      const fixture = host({
        remove: (path) => {
          if (!path.endsWith("/.backup-lease-gate.lock") || paused) return undefined
          paused = true
          return Effect.sync(() => {
            fixture.files.delete(path)
          }).pipe(
            Effect.andThen(Deferred.succeed(releasing, undefined)),
            Effect.andThen(Deferred.await(complete))
          )
        }
      })
      const running = yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Effect.sync(() => {
          bodyRan = true
        }),
        failure
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(releasing)
      const stopping = yield* Fiber.interrupt(running).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Deferred.succeed(complete, undefined)
      yield* Fiber.join(stopping)
      expect(bodyRan).toBe(false)
      expect(fixture.files.has(marker)).toBe(false)
    }))

  it.effect("cleans its marker when releasing the acquisition gate fails", () =>
    Effect.gen(function*() {
      let refused = false
      const fixture = host({
        remove: (path) => {
          if (!path.endsWith("/.backup-lease-gate.lock") || refused) return undefined
          refused = true
          return Effect.fail(platformError("PermissionDenied", "remove"))
        }
      })
      const running = yield* ArtifactBackupLease.withLease(fixture.fs, directory, Effect.void, failure).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust("3 minutes")
      expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
      expect(fixture.files.has(marker)).toBe(false)
    }))

  it.effect("fences deletion, heartbeats, releases, and then admits deletion", () =>
    Effect.gen(function*() {
      const fixture = host()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const leased = yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        failure
      ).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(entered)
      expect(Option.isNone(
        yield* ArtifactBackupLease.unlessActive(
          fixture.fs,
          directory,
          Effect.succeed("must not run"),
          failure
        )
      )).toBe(true)
      yield* TestClock.adjust("10 seconds")
      yield* Effect.yieldNow
      expect(fixture.heartbeats).toContain(marker)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(leased)
      const admitted = yield* ArtifactBackupLease.unlessActive(
        fixture.fs,
        directory,
        Effect.succeed("ran"),
        failure
      )
      expect(admitted).toEqual(Option.some("ran"))
    }))

  it.effect("reaps a stale lease before admitting the deletion", () =>
    Effect.gen(function*() {
      const fixture = host()
      fixture.seed(marker, "stale")
      yield* TestClock.adjust("61 seconds")
      const result = yield* ArtifactBackupLease.unlessActive(
        fixture.fs,
        directory,
        Effect.succeed(1),
        failure
      )
      expect(result).toEqual(Option.some(1))
      expect(fixture.files.has(marker)).toBe(false)
    }))

  it.effect("treats an owner with no timestamp as active", () =>
    Effect.gen(function*() {
      const fixture = host()
      fixture.seed(marker, "owner", Option.none())
      expect(Option.isNone(
        yield* ArtifactBackupLease.unlessActive(
          fixture.fs,
          directory,
          Effect.succeed(1),
          failure
        )
      )).toBe(true)
    }))

  it.effect("normalizes marker stat and stale-removal failures", () =>
    Effect.gen(function*() {
      const deniedStat = host({
        stat: (path) =>
          path === marker
            ? Effect.fail(platformError("PermissionDenied", "stat"))
            : undefined
      })
      expect(Exit.isFailure(
        yield* ArtifactBackupLease.unlessActive(
          deniedStat.fs,
          directory,
          Effect.void,
          failure
        ).pipe(Effect.exit)
      )).toBe(true)

      let vanished = false
      const missingRemove = host({
        remove: (path) => {
          if (path !== marker || vanished) return undefined
          vanished = true
          return Effect.fail(platformError("NotFound", "remove"))
        }
      })
      missingRemove.seed(marker, "stale")
      yield* TestClock.adjust("61 seconds")
      expect(Option.isSome(
        yield* ArtifactBackupLease.unlessActive(
          missingRemove.fs,
          directory,
          Effect.void,
          failure
        )
      )).toBe(true)

      const deniedRemove = host({
        remove: (path) =>
          path === marker
            ? Effect.fail(platformError("PermissionDenied", "remove"))
            : undefined
      })
      deniedRemove.seed(marker, "stale")
      expect(Exit.isFailure(
        yield* ArtifactBackupLease.unlessActive(
          deniedRemove.fs,
          directory,
          Effect.void,
          failure
        ).pipe(Effect.exit)
      )).toBe(true)
    }))

  it.effect("retries an atomic marker race and rejects other acquisition failures", () =>
    Effect.gen(function*() {
      let raced = false
      const racing = host({
        write: (path) => {
          if (path !== marker || raced) return undefined
          raced = true
          return Effect.fail(platformError("AlreadyExists", "writeFileString"))
        }
      })
      const running = yield* ArtifactBackupLease.withLease(
        racing.fs,
        directory,
        Effect.succeed("done"),
        failure
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("25 millis")
      expect(yield* Fiber.join(running)).toBe("done")
      expect(raced).toBe(true)

      const deniedWrite = host({
        write: (path) =>
          path === marker
            ? Effect.fail(platformError("PermissionDenied", "writeFileString"))
            : undefined
      })
      expect(Exit.isFailure(
        yield* ArtifactBackupLease.withLease(
          deniedWrite.fs,
          directory,
          Effect.void,
          failure
        ).pipe(Effect.exit)
      )).toBe(true)

      const deniedDirectory = host({
        makeDirectory: () => Effect.fail(platformError("PermissionDenied", "makeDirectory"))
      })
      expect(Exit.isFailure(
        yield* ArtifactBackupLease.withLease(
          deniedDirectory.fs,
          directory,
          Effect.void,
          failure
        ).pipe(Effect.exit)
      )).toBe(true)
    }))

  it.effect("bounds acquisition while a live owner never releases", () =>
    Effect.gen(function*() {
      const fixture = host()
      fixture.seed(marker, "live", Option.none())
      const waiting = yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Effect.void,
        failure
      ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("2 minutes")
      expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true)
    }))

  it.effect("does not heartbeat or remove a marker replaced by another owner, and warns", () =>
    Effect.gen(function*() {
      const fixture = host()
      const logged: Array<unknown> = []
      const capture = Logger.make<unknown, void>(({ message }) => {
        logged.push(message)
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const running = yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        failure
      ).pipe(Effect.provide(Logger.layer([capture])), Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      fixture.files.set(marker, "replacement")
      yield* TestClock.adjust("10 seconds")
      yield* Effect.yieldNow
      expect(fixture.heartbeats).not.toContain(marker)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(fixture.files.get(marker)).toBe("replacement")
      expect(logged.flat()).toContain("Artifact backup lease was reclaimed while its backup was still running")
    }))

  it.effect("releases without a warning when the marker was already reaped", () =>
    Effect.gen(function*() {
      // A backup whose heartbeat lapsed has its marker reaped by whoever
      // noticed. That is the ordinary end of a slow lease, so the release must
      // classify it exactly as the sibling lock release does: nothing left to
      // release, nothing to report.
      const fixture = host()
      const logged: Array<unknown> = []
      const capture = Logger.make<unknown, void>(({ message }) => {
        logged.push(message)
      })
      yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Effect.sync(() => {
          fixture.files.delete(marker)
        }),
        failure
      ).pipe(Effect.provide(Logger.layer([capture])))
      expect(logged).toEqual([])
    }))

  it.effect("warns when the heartbeat finds its marker already reaped", () =>
    Effect.gen(function*() {
      const fixture = host()
      const logged: Array<unknown> = []
      const capture = Logger.make<unknown, void>(({ message }) => {
        logged.push(message)
      })
      yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Effect.sync(() => {
          fixture.files.delete(marker)
        }).pipe(Effect.andThen(TestClock.adjust("10 seconds"))),
        failure
      ).pipe(Effect.provide(Logger.layer([capture])))
      expect(logged.flat()).toContain("Artifact backup lease was reclaimed while its backup was still running")
    }))

  it.effect("keeps the lease through heartbeat and release read refusals, and warns", () =>
    Effect.gen(function*() {
      const logged: Array<unknown> = []
      const capture = Logger.make<unknown, void>(({ message }) => {
        logged.push(message)
      })
      let refuseReads = false
      const fixture = host({
        read: (path) =>
          path === marker && refuseReads
            ? Effect.fail(platformError("PermissionDenied", "readFileString"))
            : undefined
      })
      yield* ArtifactBackupLease.withLease(
        fixture.fs,
        directory,
        Effect.sync(() => {
          refuseReads = true
        }).pipe(Effect.andThen(TestClock.adjust("10 seconds"))),
        failure
      ).pipe(Effect.provide(Logger.layer([capture])))
      expect(fixture.files.has(marker)).toBe(true)
      expect(logged.flat()).toContain("Artifact backup lease heartbeat failed")
    }))
})
