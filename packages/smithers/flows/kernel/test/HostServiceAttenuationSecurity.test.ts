/**
 * Pre-layered kernel host service attenuation security suite (#4531).
 *
 * Verifies that `CapabilitySet.attenuate` narrows pre-layered `FileSystem`,
 * `HttpClient`, `ChildProcessSpawner`, and `Jj` instances via
 * `Symbol.for("@smthrs/capability/attenuateService")` so `Effect.forkDetach` +
 * `Context.pick` (stripping `CurrentCapabilities` and `GrantStore`) cannot
 * escape the capability ceiling.
 */
import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { PermissionDenied, Rule } from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import {
  Context,
  Effect,
  Fiber,
  FileSystem as EffectFileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Sink,
  Stream
} from "effect"
import * as EffectHttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcess from "effect/process/ChildProcess"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import * as CapabilitySet from "../src/CapabilitySet.ts"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as FileSystem from "../src/FileSystem.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Containment from "../src/internal/Containment.ts"
import * as Jj from "../src/Jj.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as Workspace from "../src/Workspace.ts"

const ATTENUATE_SERVICE_SYMBOL = Symbol.for("@smthrs/capability/attenuateService")

const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })
const allowAll = [new Rule({ effect: "allow", pattern: pattern("*", "**") })]

const grantLayer = GrantStore.layer({
  attended: false,
  rules: allowAll
}).pipe(Layer.provide(Workspace.layer("/workspace")))

const assertHardenedHook = (service: object): (ceiling: CapabilitySet.CapabilitySet) => unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(service, ATTENUATE_SERVICE_SYMBOL)
  expect(descriptor).toBeDefined()
  expect(descriptor?.enumerable).toBe(false)
  expect(descriptor?.writable).toBe(false)
  expect(descriptor?.configurable).toBe(false)
  expect(typeof descriptor?.value).toBe("function")
  return descriptor!.value as (ceiling: CapabilitySet.CapabilitySet) => unknown
}

const expectPlatformOutsideCeiling = (error: PlatformError.PlatformError): void => {
  const denial = Option.getOrThrow(Permission.fromPlatformError(error))
  expect(denial).toBeInstanceOf(PermissionDenied)
  expect((denial as PermissionDenied).reason).toBe("outside capability ceiling")
}

const runDetachedWithOnly = <I, S, A, E>(
  tag: Context.Service<I, S>,
  service: S,
  body: (svc: S) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    const picked = Context.make(tag, service)
    const fiber = yield* Effect.forkDetach(
      Effect.provideContext(body(service), picked)
    )
    return yield* Fiber.join(fiber)
  })

describe("#4531: Pre-layered kernel host service attenuation", () => {
  it.effect("FileSystem narrows closure-bound grants across forkDetach + Context.pick, nested ceilings, and forged ceilings", () =>
    Effect.scoped(Effect.gen(function*() {
      const reads: Array<string> = []
      const rawFs = FileSystem.withIsolatedFileSystem(
        EffectFileSystem.makeNoop({
          realPath: (value) => Effect.succeed(value),
          readFileString: (value) =>
            Effect.sync(() => {
              reads.push(value)
              return `content:${value}`
            })
        })
      )
      const fsLayer = FileSystem.layer.pipe(
        Layer.provide(Layer.succeed(EffectFileSystem.FileSystem, rawFs)),
        Layer.provide(Path.layer),
        Layer.provide(Workspace.layer("/workspace")),
        Layer.provide(grantLayer)
      )

      yield* Effect.gen(function*() {
        const rootFs = yield* EffectFileSystem.FileSystem
        const hook = assertHardenedHook(rootFs)

        // Direct forged ceiling fails closed.
        const forgedFs = hook({ groups: [] } as unknown as CapabilitySet.CapabilitySet) as EffectFileSystem.FileSystem
        const forgedErr = yield* Effect.flip(forgedFs.readFileString("/workspace/allowed.txt"))
        expectPlatformOutsideCeiling(forgedErr)

        // Attenuate to allowed.txt + nested.txt, then further to allowed.txt only.
        const outerCeiling = [
          pattern("fs:read", "/workspace/allowed.txt"),
          pattern("fs:read", "/workspace/nested.txt")
        ]
        const innerCeiling = [
          pattern("fs:read", "/workspace/allowed.txt")
        ]

        yield* CapabilitySet.attenuate(outerCeiling)(
          Effect.gen(function*() {
            const outerFs = yield* EffectFileSystem.FileSystem
            // Detached fiber with ONLY FileSystem (CurrentCapabilities & GrantStore stripped).
            const allowedText = yield* runDetachedWithOnly(
              EffectFileSystem.FileSystem,
              outerFs,
              (fs) => fs.readFileString("/workspace/allowed.txt")
            )
            expect(allowedText).toBe("content:/workspace/allowed.txt")

            const secretErr = yield* runDetachedWithOnly(
              EffectFileSystem.FileSystem,
              outerFs,
              (fs) => Effect.flip(fs.readFileString("/workspace/secret.env"))
            )
            expectPlatformOutsideCeiling(secretErr)

            // Nested attenuation monotonically restricts further.
            yield* CapabilitySet.attenuate(innerCeiling)(
              Effect.gen(function*() {
                const innerFs = yield* EffectFileSystem.FileSystem
                const nestedErr = yield* runDetachedWithOnly(
                  EffectFileSystem.FileSystem,
                  innerFs,
                  (fs) => Effect.flip(fs.readFileString("/workspace/nested.txt"))
                )
                expectPlatformOutsideCeiling(nestedErr)
              })
            )
          })
        )
      }).pipe(Effect.provide(fsLayer))

      expect(reads).toEqual(["/workspace/allowed.txt"])
    })))

  it.effect("HttpClient narrows closure-bound grants across forkDetach + Context.pick and preserves destination pinning", () =>
    Effect.scoped(Effect.gen(function*() {
      const urls: Array<string> = []
      const rawClient = HttpClient.withDestinationPinning(
        EffectHttpClient.make((request) =>
          Effect.sync(() => {
            urls.push(request.url)
            return { status: 200, headers: {}, request } as HttpClientResponse.HttpClientResponse
          })
        )
      )
      const httpLayer = HttpClient.layer.pipe(
        Layer.provide(Layer.succeed(EffectHttpClient.HttpClient, rawClient)),
        Layer.provide(grantLayer)
      )

      yield* Effect.gen(function*() {
        const rootClient = yield* EffectHttpClient.HttpClient
        assertHardenedHook(rootClient)
        expect(HttpClient.supportsDestinationPinning(rootClient)).toBe(true)

        const ceiling = [
          pattern("net:get", "allowed.example")
        ]

        yield* CapabilitySet.attenuate(ceiling)(
          Effect.gen(function*() {
            const narrowed = yield* EffectHttpClient.HttpClient
            expect(HttpClient.supportsDestinationPinning(narrowed)).toBe(true)

            const ok = yield* runDetachedWithOnly(
              EffectHttpClient.HttpClient,
              narrowed,
              (client) => client.execute(HttpClientRequest.get("https://allowed.example/ok"))
            )
            expect(ok.status).toBe(200)

            const deniedErr = yield* runDetachedWithOnly(
              EffectHttpClient.HttpClient,
              narrowed,
              (client) => Effect.flip(client.execute(HttpClientRequest.get("https://denied.example/secret")))
            )
            expect(deniedErr.cause).toBeInstanceOf(PermissionDenied)
            expect((deniedErr.cause as PermissionDenied).reason).toBe("outside capability ceiling")
          })
        )
      }).pipe(Effect.provide(httpLayer))

      expect(urls).toEqual(["https://allowed.example/ok"])
    })))

  it.effect("ChildProcessSpawner narrows closure-bound grants across forkDetach + Context.pick and preserves Containment", () =>
    Effect.scoped(Effect.gen(function*() {
      const spawned: Array<string> = []
      const rawSpawner = Containment.mark(
        makeSpawner((command) => {
          const standard = command as ChildProcess.StandardCommand
          spawned.push(`${standard.command} ${standard.args.join(" ")}`.trim())
          return Effect.succeed(
            makeHandle({
              pid: ProcessId(42),
              exitCode: Effect.succeed(ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty
            })
          )
        })
      )
      const spawnerLayer = ChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.succeed(HostChildProcessSpawner, rawSpawner)),
        Layer.provide(ProcessConfinement.layerNoop),
        Layer.provide(Workspace.layer("/workspace")),
        Layer.provide(Path.layer),
        Layer.provide(grantLayer)
      )

      yield* Effect.gen(function*() {
        const rootSpawner = yield* HostChildProcessSpawner
        assertHardenedHook(rootSpawner)
        expect(Containment.isContained(rootSpawner)).toBe(true)

        const ceiling = [
          pattern("proc:spawn", "echo ok")
        ]

        yield* CapabilitySet.attenuate(ceiling)(
          Effect.gen(function*() {
            const narrowed = yield* HostChildProcessSpawner
            expect(Containment.isContained(narrowed)).toBe(true)

            yield* runDetachedWithOnly(
              HostChildProcessSpawner,
              narrowed,
              (spawner) => Effect.scoped(spawner.spawn(ChildProcess.make("echo", ["ok"])))
            )

            const deniedErr = yield* runDetachedWithOnly(
              HostChildProcessSpawner,
              narrowed,
              (spawner) => Effect.flip(Effect.scoped(spawner.spawn(ChildProcess.make("rm", ["-rf", "."]))))
            )
            expectPlatformOutsideCeiling(deniedErr)
          })
        )
      }).pipe(Effect.provide(spawnerLayer))

      expect(spawned).toEqual(["echo ok"])
    })))

  it.effect("Jj narrows closure-bound grants across forkDetach + Context.pick and preserves absent optional methods", () =>
    Effect.scoped(Effect.gen(function*() {
      const calls: Array<string> = []
      const rawJj = HostJj.Jj.of({
        status: () =>
          Effect.sync(() => {
            calls.push("status")
            return "clean"
          }),
        diff: (from, to) =>
          Effect.sync(() => {
            calls.push(`diff:${from}:${to}`)
            return "patch"
          }),
        snapshot: () => Effect.succeed({ commitId: "c1", changeId: "ch1" }),
        restore: () => Effect.void,
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void
      })
      const rawFs = EffectFileSystem.makeNoop({
        realPath: (value) => Effect.succeed(value)
      })
      const jjLayer = Jj.layer.pipe(
        Layer.provide(Layer.succeed(HostJj.Jj, rawJj)),
        Layer.provide(Layer.succeed(EffectFileSystem.FileSystem, rawFs)),
        Layer.provide(Path.layer),
        Layer.provide(Workspace.layer("/workspace")),
        Layer.provide(grantLayer)
      )

      yield* Effect.gen(function*() {
        const rootJj = yield* HostJj.Jj
        assertHardenedHook(rootJj)
        expect(rootJj.revert).toBeUndefined()
        expect(rootJj.opRestore).toBeUndefined()

        const ceiling = [
          pattern("jj:status", ".")
        ]

        yield* CapabilitySet.attenuate(ceiling)(
          Effect.gen(function*() {
            const narrowed = yield* HostJj.Jj
            expect(narrowed.revert).toBeUndefined()
            expect(narrowed.opRestore).toBeUndefined()

            const status = yield* runDetachedWithOnly(
              HostJj.Jj,
              narrowed,
              (jj) => jj.status()
            )
            expect(status).toBe("clean")

            const deniedErr = yield* runDetachedWithOnly(
              HostJj.Jj,
              narrowed,
              (jj) => Effect.flip(jj.diff("a", "b"))
            )
            expect(deniedErr).toBeInstanceOf(PermissionDenied)
            expect((deniedErr as PermissionDenied).reason).toBe("outside capability ceiling")
          })
        )
      }).pipe(Effect.provide(jjLayer))

      expect(calls).toEqual(["status"])
    })))
})
