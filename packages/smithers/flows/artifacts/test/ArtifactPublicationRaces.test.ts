import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactStoreMetrics from "../src/ArtifactStoreMetrics.ts"
import * as CombinedArtifacts from "../src/CombinedArtifacts.ts"
import { bytes, text, withCrypto } from "./Crypto.ts"
import { hostPath } from "./HostPath.ts"

const payload = bytes("a verified artifact")
const options = { coordination: "process", durability: "best-effort" } as const
const refusal = () =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "test",
    method: "injected",
    description: "private host error detail"
  })

describe("artifact publication races", () => {
  for (const mutation of ["remove", "heal", "corrupt"] as const) {
    it.live(`handles a concurrent ${mutation}`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const store = ArtifactStore.makeFileSystem(fs, hostPath, { ...options, directory })
        const digest = yield* store.put(payload)
        const target = `${directory}/${digest.slice(0, 2)}/${digest}`
        const racingFs: FileSystem.FileSystem = {
          ...fs,
          readFile: (path) =>
            fs.readFile(path).pipe(Effect.tap(() =>
              Effect.gen(function*() {
                if (path !== target) return
                if (mutation === "remove") yield* fs.remove(path)
                else {
                  yield* fs.writeFile(`${path}.replacement`, mutation === "heal" ? payload : bytes("corrupt"))
                  yield* fs.rename(`${path}.replacement`, path)
                }
              })
            ))
        }
        const local = ArtifactStore.makeFileSystem(racingFs, hostPath, { ...options, directory })
        if (mutation === "remove") {
          const missing = yield* Effect.flip(local.get(digest))
          expect(missing).toMatchObject({ code: "artifact_missing", digest })
          // Re-seed for the same sweep race through the public composition.
          yield* store.put(payload)
          const remote = ArtifactStore.makeMemory()
          yield* remote.put(payload)
          const combined = yield* CombinedArtifacts.make({ local, remote, downloadPolicy: "minimal" })
          expect([...(yield* combined.get(digest))]).toEqual([...payload])
        } else {
          expect([...(yield* local.get(digest))]).toEqual([...payload])
          if (mutation === "corrupt") {
            expect(yield* Effect.flip(store.get(digest))).toMatchObject({ code: "artifact_corruption" })
          }
        }
      })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
  }

  it.live("verifies the captured bytes even when a healing rename wins the read race", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const store = ArtifactStore.makeFileSystem(fs, hostPath, { ...options, directory })
      const digest = yield* store.put(payload)
      const target = `${directory}/${digest.slice(0, 2)}/${digest}`
      yield* fs.writeFile(target, bytes("corrupt"))
      const local = ArtifactStore.makeFileSystem(
        {
          ...fs,
          readFile: (path) =>
            fs.readFile(path).pipe(
              Effect.tap(() =>
                fs.writeFile(`${path}.replacement`, payload).pipe(
                  Effect.andThen(fs.rename(`${path}.replacement`, path))
                )
              )
            )
        },
        hostPath,
        { ...options, directory }
      )
      expect(yield* Effect.flip(local.get(digest))).toMatchObject({ code: "artifact_corruption" })
      expect([...(yield* store.get(digest))]).toEqual([...payload])
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))

  it.live("keeps a failed post-read existence probe visible as unavailable", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const base = ArtifactStore.makeFileSystem(fs, hostPath, { ...options, directory })
      const digest = yield* base.put(payload)
      const local = ArtifactStore.makeFileSystem(
        {
          ...fs,
          exists: () => Effect.fail(refusal())
        },
        hostPath,
        { ...options, directory }
      )
      expect(yield* Effect.flip(local.get(digest))).toMatchObject({ code: "unavailable" })
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))

  for (const entry of ["root", "fanout"] as const) {
    it.live(`refuses a ${entry} directory replacement after reading`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const store = ArtifactStore.makeFileSystem(fs, hostPath, { ...options, directory })
        const digest = yield* store.put(payload)
        const parent = `${directory}/${digest.slice(0, 2)}`
        const target = `${parent}/${digest}`
        const replacement = entry === "root" ? directory : parent
        const saved = `${replacement}-saved`
        yield* Effect.addFinalizer(() => fs.remove(saved, { recursive: true }).pipe(Effect.orDie))
        const local = ArtifactStore.makeFileSystem(
          {
            ...fs,
            readFile: (path) =>
              fs.readFile(path).pipe(Effect.tap(() =>
                Effect.gen(function*() {
                  yield* fs.rename(replacement, saved)
                  yield* fs.makeDirectory(replacement)
                })
              ))
          },
          hostPath,
          { ...options, directory }
        )
        expect(yield* Effect.flip(local.get(digest))).toMatchObject({ code: "unavailable" })
        expect(yield* fs.exists(target)).toBe(false)
      })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
  }

  for (const stage of ["stat", "guard"] as const) {
    for (const failure of ["refusal", "interruption"] as const) {
      it.live(`cleans exclusive scratch on ${failure} during its first ${stage}`, () =>
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* fs.makeTempDirectoryScoped()
          const entered = yield* Deferred.make<void>()
          let injected = false
          const fault = Effect.gen(function*() {
            injected = true
            yield* Deferred.succeed(entered, undefined)
            if (failure === "interruption") return yield* Effect.never
            return yield* Effect.fail(refusal())
          })
          const host: FileSystem.FileSystem = {
            ...fs,
            open: (path, openOptions) =>
              fs.open(path, openOptions).pipe(Effect.map((file) =>
                openOptions?.flag !== "wx" ? file : {
                  ...file,
                  stat: Effect.suspend(() =>
                    stage === "stat" && !injected ? fault.pipe(Effect.andThen(file.stat)) : file.stat
                  )
                }
              )),
            readLink: (path) =>
              Effect.suspend(() =>
                stage === "guard" && path.includes(".tmp-") && !injected
                  ? fault.pipe(Effect.andThen(fs.readLink(path)))
                  : fs.readLink(path)
              )
          }
          const store = ArtifactStore.makeFileSystem(host, hostPath, { ...options, directory })
          if (failure === "interruption") {
            const fiber = yield* store.put(payload).pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            yield* Fiber.interrupt(fiber)
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          } else {
            expect(yield* Effect.flip(store.put(payload))).toMatchObject({ code: "unavailable" })
          }
          expect(injected).toBe(true)
          const fanouts = yield* fs.readDirectory(directory)
          for (const fanout of fanouts) {
            expect(yield* fs.readDirectory(`${directory}/${fanout}`)).toEqual([])
          }
        })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
    }
  }

  it.effect("counts every failed freshen and rate-limits sanitized warnings", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const base = ArtifactStore.makeFileSystem(fs, hostPath, { ...options, directory })
      const digest = yield* withCrypto(base.put(payload))
      const warnings: Array<{ message: unknown; annotations: Record<string, unknown> }> = []
      const capture = Logger.layer([Logger.make<unknown, void>((event) => {
        warnings.push(Logger.formatStructured.log(event))
      })])
      const store = ArtifactStore.makeFileSystem(
        {
          ...fs,
          utimes: () => Effect.fail(refusal())
        },
        hostPath,
        { ...options, directory }
      )
      const failedFreshens = ArtifactStoreMetrics.freshenFailures
      yield* Effect.gen(function*() {
        for (let i = 0; i < 3; i++) expect(yield* store.put(payload)).toBe(digest)
        expect((yield* Metric.value(failedFreshens)).count).toBe(3)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]!.annotations.digest).toBe(digest)
        expect(warnings[0]!.annotations.reason).toBe("PermissionDenied")
        expect(JSON.stringify(warnings)).not.toContain("private host error detail")
        yield* TestClock.adjust("1 minute")
        yield* store.put(payload)
        expect((yield* Metric.value(failedFreshens)).count).toBe(4)
        expect(warnings).toHaveLength(2)
        expect(text(yield* store.get(digest))).toBe(text(payload))
      }).pipe(Effect.provide(capture), Effect.provideService(Metric.MetricRegistry, new Map()), withCrypto)
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)))
})
