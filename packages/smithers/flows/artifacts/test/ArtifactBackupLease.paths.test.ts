import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
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

const failure = (cause: unknown) => cause

const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const parent = yield* fs.makeTempDirectoryScoped()
  const directory = `${parent}/objects`
  const outside = `${parent}/outside`
  const marker = `${directory}/.backup-lease`
  const victim = `${outside}/.backup-lease`
  yield* fs.makeDirectory(outside)
  const replaceRoot = (link = true) =>
    fs.rename(directory, `${parent}/saved`).pipe(
      Effect.andThen(link ? fs.symlink(outside, directory) : fs.makeDirectory(directory))
    )
  return { fs, directory, outside, marker, victim, replaceRoot }
})

const refused = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toMatchObject({
      reason: { _tag: "PermissionDenied", module: "ArtifactPath" }
    })
  }
}

describe("backup lease objects root", () => {
  for (const operation of ["backup", "sweep"] as const) {
    it.effect(`refuses a symlinked root before ${operation} creates locks or markers`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { fs, directory, outside } = yield* fixture
        yield* fs.symlink(outside, directory)
        let entered = false
        const body = Effect.sync(() => {
          entered = true
        })
        const run = operation === "backup" ? ArtifactBackupLease.withLease : ArtifactBackupLease.unlessActive
        refused(yield* run(fs, directory, body, failure).pipe(Effect.exit))
        expect(entered).toBe(false)
        expect(yield* fs.readDirectory(outside)).toEqual([])
      })).pipe(Effect.provide(NodeFileSystem.layer)))
  }

  it.effect("creates a private objects root before the first backup", () =>
    Effect.scoped(Effect.gen(function*() {
      const { fs, directory, marker } = yield* fixture
      yield* ArtifactBackupLease.withLease(
        fs,
        directory,
        Effect.gen(function*() {
          expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700)
          expect((yield* fs.stat(`${directory}/.locks`)).mode & 0o777).toBe(0o700)
          expect((yield* fs.stat(marker)).mode & 0o777).toBe(0o600)
        }),
        failure
      )
      expect(yield* fs.exists(marker)).toBe(false)
    })).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("refuses a root swapped for a symlink during directory creation", () =>
    Effect.scoped(Effect.gen(function*() {
      const { fs, directory, outside, replaceRoot } = yield* fixture
      const faulty: FileSystem.FileSystem = {
        ...fs,
        makeDirectory: (path, options) =>
          fs.makeDirectory(path, options).pipe(
            Effect.andThen(path === directory ? replaceRoot() : Effect.void)
          )
      }
      refused(yield* ArtifactBackupLease.withLease(faulty, directory, Effect.void, failure).pipe(Effect.exit))
      expect(yield* fs.readDirectory(outside)).toEqual([])
    })).pipe(Effect.provide(NodeFileSystem.layer)))

  for (const operation of ["backup", "sweep"] as const) {
    it.effect(`rechecks the root after acquiring the ${operation} gate`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { fs, directory, outside, replaceRoot } = yield* fixture
        yield* fs.makeDirectory(directory)
        yield* fs.makeDirectory(`${outside}/.locks`)
        const gatePath = `${directory}/.locks/.backup-lease-gate.lock`
        const faulty: FileSystem.FileSystem = {
          ...fs,
          writeFileString: (path, value, options) =>
            fs.writeFileString(path, value, options).pipe(
              Effect.andThen(path === gatePath ? replaceRoot() : Effect.void)
            )
        }
        let entered = false
        const run = operation === "backup" ? ArtifactBackupLease.withLease : ArtifactBackupLease.unlessActive
        refused(
          yield* run(
            faulty,
            directory,
            Effect.sync(() => {
              entered = true
            }),
            failure
          ).pipe(Effect.exit)
        )
        expect(entered).toBe(false)
        expect(yield* fs.readDirectory(outside)).toEqual([".locks"])
        expect(yield* fs.readDirectory(`${outside}/.locks`)).toEqual([])
      })).pipe(Effect.provide(NodeFileSystem.layer)))
  }

  it.effect("rechecks the root between a missing marker probe and its exclusive write", () =>
    Effect.scoped(Effect.gen(function*() {
      const { fs, directory, outside, marker, replaceRoot } = yield* fixture
      const faulty: FileSystem.FileSystem = {
        ...fs,
        stat: (path) =>
          path === marker
            ? fs.stat(path).pipe(Effect.onError(() => replaceRoot().pipe(Effect.orDie)))
            : fs.stat(path)
      }
      refused(yield* ArtifactBackupLease.withLease(faulty, directory, Effect.void, failure).pipe(Effect.exit))
      expect(yield* fs.readDirectory(outside)).toEqual([])
    })).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("refuses a root replacement during a missing sweep marker probe", () =>
    Effect.scoped(Effect.gen(function*() {
      const { fs, directory, outside, marker, replaceRoot } = yield* fixture
      const faulty: FileSystem.FileSystem = {
        ...fs,
        stat: (path) =>
          path === marker
            ? fs.stat(path).pipe(Effect.onError(() => replaceRoot().pipe(Effect.orDie)))
            : fs.stat(path)
      }
      let entered = false
      refused(
        yield* ArtifactBackupLease.unlessActive(
          faulty,
          directory,
          Effect.sync(() => {
            entered = true
          }),
          failure
        ).pipe(Effect.exit)
      )
      expect(entered).toBe(false)
      expect(yield* fs.readDirectory(outside)).toEqual([])
    })).pipe(Effect.provide(NodeFileSystem.layer)))

  for (const mutation of ["write", "remove"] as const) {
    it.effect(`rechecks the root immediately before marker ${mutation} after checking the clock`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { fs, directory, marker, victim, outside, replaceRoot } = yield* fixture
        const clock = yield* Clock.Clock
        yield* fs.makeDirectory(directory)
        if (mutation === "remove") {
          yield* fs.writeFileString(marker, "stale")
          yield* fs.utimes(marker, new Date(-120_000), new Date(-120_000))
          yield* fs.writeFileString(victim, "unrelated")
        }
        let armed = false
        let swapped = false
        const faulty: FileSystem.FileSystem = {
          ...fs,
          stat: (path) =>
            fs.stat(path).pipe(Effect.onExit(() =>
              Effect.sync(() => {
                if (path === marker) armed = true
              })
            ))
        }
        const racingClock: Clock.Clock = {
          ...clock,
          currentTimeMillis: Effect.suspend(() => {
            if (!armed || swapped) return clock.currentTimeMillis
            swapped = true
            return replaceRoot().pipe(Effect.orDie, Effect.andThen(clock.currentTimeMillis))
          })
        }
        let entered = false
        const run = mutation === "write" ? ArtifactBackupLease.withLease : ArtifactBackupLease.unlessActive
        refused(
          yield* run(
            faulty,
            directory,
            Effect.sync(() => {
              entered = true
            }),
            failure
          ).pipe(Effect.provideService(Clock.Clock, racingClock), Effect.exit)
        )
        expect(swapped).toBe(true)
        expect(entered).toBe(false)
        if (mutation === "remove") expect(yield* fs.readFileString(victim)).toBe("unrelated")
        else expect(yield* fs.readDirectory(outside)).toEqual([])
      })).pipe(Effect.provide(NodeFileSystem.layer)))
  }

  for (const replacement of ["symlink", "directory"] as const) {
    it.effect(`refuses stale marker removal after a root ${replacement} replacement`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { fs, directory, marker, victim, replaceRoot } = yield* fixture
        yield* fs.makeDirectory(directory)
        yield* fs.writeFileString(marker, "stale")
        yield* fs.utimes(marker, new Date(-120_000), new Date(-120_000))
        yield* fs.writeFileString(victim, "unrelated")
        const faulty: FileSystem.FileSystem = {
          ...fs,
          stat: (path) =>
            fs.stat(path).pipe(Effect.tap(() =>
              path === marker
                ? replaceRoot(replacement === "symlink").pipe(Effect.andThen(
                  replacement === "directory" ? fs.writeFileString(marker, "replacement") : Effect.void
                ))
                : Effect.void
            ))
        }
        let entered = false
        refused(
          yield* ArtifactBackupLease.unlessActive(
            faulty,
            directory,
            Effect.sync(() => {
              entered = true
            }),
            failure
          ).pipe(Effect.exit)
        )
        expect(entered).toBe(false)
        expect(yield* fs.readFileString(victim)).toBe("unrelated")
        if (replacement === "directory") expect(yield* fs.readFileString(marker)).toBe("replacement")
      })).pipe(Effect.provide(NodeFileSystem.layer)))
  }

  it.effect("stops the backup without touching a marker redirected after the heartbeat read", () =>
    Effect.scoped(Effect.gen(function*() {
      const { fs, directory, marker, victim, replaceRoot } = yield* fixture
      const entered = yield* Deferred.make<void>()
      let armed = false
      let swapped = false
      let stopped = false
      const timestamp = new Date(123_000)
      let touched = false
      const faulty: FileSystem.FileSystem = {
        ...fs,
        utimes: (path, atime, mtime) =>
          path === marker
            ? Effect.suspend(() => {
              touched = true
              return Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "test",
                method: "utimes"
              }))
            })
            : fs.utimes(path, atime, mtime),
        readFileString: (path, options) =>
          fs.readFileString(path, options).pipe(Effect.tap((owner) =>
            Effect.gen(function*() {
              if (path !== marker || !armed || swapped) return
              swapped = true
              yield* fs.writeFileString(victim, owner)
              yield* fs.utimes(victim, timestamp, timestamp)
              yield* replaceRoot()
            })
          ))
      }
      const running = yield* ArtifactBackupLease.withLease(
        faulty,
        directory,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            stopped = true
          }))
        ),
        failure
      ).pipe(Effect.provide(Logger.layer([])), Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      armed = true
      yield* TestClock.adjust("10 seconds")
      const finished = yield* Fiber.join(running)
      expect(swapped).toBe(true)
      expect(touched).toBe(false)
      expect(stopped).toBe(true)
      refused(finished)
      expect(yield* fs.exists(victim)).toBe(true)
      expect((yield* fs.stat(victim)).mtime).toEqual(Option.some(timestamp))
    })).pipe(Effect.provide(NodeFileSystem.layer)))

  it.effect("does not release a marker through a root replaced after the ownership read", () =>
    Effect.scoped(Effect.gen(function*() {
      const { fs, directory, marker, victim, replaceRoot } = yield* fixture
      let armed = false
      let swapped = false
      const warnings: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        warnings.push(message)
      })
      const faulty: FileSystem.FileSystem = {
        ...fs,
        readFileString: (path, options) =>
          fs.readFileString(path, options).pipe(Effect.tap((owner) =>
            Effect.gen(function*() {
              if (path !== marker || !armed || swapped) return
              swapped = true
              yield* fs.writeFileString(victim, owner)
              yield* replaceRoot()
            })
          ))
      }
      expect(
        yield* ArtifactBackupLease.withLease(
          faulty,
          directory,
          Effect.sync(() => {
            armed = true
            return "copied"
          }),
          failure
        ).pipe(Effect.provide(Logger.layer([logger])))
      ).toBe("copied")
      expect(swapped).toBe(true)
      expect((yield* fs.readFileString(victim)).length).toBeGreaterThan(0)
      expect(warnings.flat()).toContain("Artifact backup lease release failed")
    })).pipe(Effect.provide(NodeFileSystem.layer)))
})
