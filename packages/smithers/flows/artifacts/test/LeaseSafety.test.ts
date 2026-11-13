import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactSweep from "../src/ArtifactSweep.ts"
import * as FileLease from "../src/FileLease.ts"
import { bytes, sha256 } from "./Crypto.ts"

const onNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | EffectDigest.Digest | Scope.Scope>
) => Effect.scoped(effect).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)))
const failure = (cause: unknown) => cause
const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "fault" })
const fixture = Effect.gen(function*() {
  yield* TestClock.setTime(Date.now())
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "artifact-safety-" })
  return { fs, directory, lock: `${directory}/lease.lock` }
})

describe("lease safety regressions", () => {
  it.effect("fails protected work when the file lease owner is lost", () =>
    onNode(Effect.gen(function*() {
      const { fs, lock } = yield* fixture
      const observed = yield* Deferred.make<void>()
      let replaced = false
      const faulty = {
        ...fs,
        readFileString: (path: string) =>
          fs.readFileString(path).pipe(
            Effect.onExit(() => path === lock && replaced ? Deferred.succeed(observed, undefined) : Effect.void)
          )
      }
      const exit = yield* FileLease.withLease(
        faulty,
        lock,
        Effect.gen(function*() {
          yield* fs.writeFileString(lock, "replacement")
          replaced = true
          yield* TestClock.adjust("10 seconds")
          yield* Deferred.await(observed)
          yield* Effect.yieldNow
          return "continued without ownership"
        }),
        failure
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.readFileString(lock)).toBe("replacement")
    })))

  it.effect("release excludes reclamation until its conditional remove finishes", () =>
    onNode(Effect.gen(function*() {
      const { fs, lock } = yield* fixture
      const read = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      let releasing = false
      const faulty = {
        ...fs,
        readFileString: (path: string) =>
          fs.readFileString(path).pipe(Effect.tap(() =>
            path === lock && releasing
              ? Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void
          ))
      }
      const holder = yield* FileLease.withLease(
        faulty,
        lock,
        Effect.sync(() => {
          releasing = true
        }),
        failure
      )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(read)
      yield* fs.utimes(lock, new Date(0), new Date(0))
      const attempted = yield* Deferred.make<void>()
      const contenderFs = {
        ...fs,
        writeFileString: (
          path: string,
          value: string,
          options?: Parameters<FileSystem.FileSystem["writeFileString"]>[2]
        ) =>
          fs.writeFileString(path, value, options).pipe(
            Effect.tapError(() => path.includes(".reclaim-") ? Deferred.succeed(attempted, undefined) : Effect.void)
          )
      }
      const contender = yield* FileLease.withLease(
        contenderFs,
        lock,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.succeed(attempted, undefined)),
          Effect.andThen(Effect.never)
        ),
        failure
      )
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(attempted)
      const replacementEntered = yield* Deferred.isDone(entered)
      yield* Deferred.succeed(resume, undefined)
      yield* Fiber.join(holder)
      yield* Fiber.interrupt(contender)
      expect(replacementEntered).toBe(false)
    })))

  it.effect("reclamation excludes an old owner's release until its rename finishes", () =>
    onNode(Effect.gen(function*() {
      const { fs, lock } = yield* fixture
      const entered = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const renaming = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const holder = yield* FileLease.withLease(
        fs,
        lock,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        failure
      )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const original = yield* fs.readFileString(lock)
      yield* fs.utimes(lock, new Date(0), new Date(0))
      const faulty = {
        ...fs,
        rename: (from: string, to: string) =>
          (from === lock
            ? Deferred.succeed(renaming, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void)
            .pipe(Effect.andThen(fs.rename(from, to)))
      }
      const contender = yield* FileLease.withLease(faulty, lock, Effect.never, failure)
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(renaming)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(holder)
      const retained = yield* fs.readFileString(lock).pipe(Effect.orElseSucceed(() => "removed"))
      yield* Deferred.succeed(resume, undefined)
      yield* Fiber.interrupt(contender)
      expect(retained).toBe(original)
    })))
})

describe("artifact filesystem safety regressions", () => {
  it.effect("fails inventory when a fanout cannot be listed", () =>
    onNode(Effect.gen(function*() {
      const { fs, directory } = yield* fixture
      yield* fs.makeDirectory(`${directory}/aa`)
      const faulty = {
        ...fs,
        readDirectory: (path: string) =>
          path.endsWith("/aa")
            ? Effect.fail(denied) :
            fs.readDirectory(path)
      }
      expect(Exit.isFailure(yield* ArtifactSweep.makeFileSystem(faulty, { directory }).inventory.pipe(Effect.exit)))
        .toBe(true)
    })))

  it.effect("tolerates a fanout that disappears before listing", () =>
    onNode(Effect.gen(function*() {
      const { fs, directory } = yield* fixture
      yield* fs.makeDirectory(`${directory}/aa`)
      const faulty = {
        ...fs,
        readDirectory: (path: string) =>
          path.endsWith("/aa")
            ? fs.remove(path, { recursive: true }).pipe(Effect.andThen(fs.readDirectory(path))) :
            fs.readDirectory(path)
      }
      expect(yield* ArtifactSweep.makeFileSystem(faulty, { directory }).inventory).toEqual([])
    })))

  it.effect("rewrites a verified blob that vanishes before its path guard", () =>
    onNode(Effect.gen(function*() {
      const { fs, directory } = yield* fixture
      const content = bytes("verified then vanished")
      const digest = sha256(content)
      const blob = `${directory}/${digest.slice(0, 2)}/${digest}`
      const store = ArtifactStore.makeFileSystem(fs, yield* Path.Path, { directory, coordination: "process" })
      yield* store.put(content)
      const faulty = {
        ...fs,
        readFile: (path: string) =>
          fs.readFile(path).pipe(
            Effect.tap(() => path === blob ? fs.remove(blob) : Effect.void)
          )
      }
      const racing = ArtifactStore.makeFileSystem(faulty, yield* Path.Path, { directory, coordination: "process" })
      expect(yield* racing.put(content)).toBe(digest)
      expect(Array.from(yield* store.get(digest))).toEqual(Array.from(content))
    })))
})
