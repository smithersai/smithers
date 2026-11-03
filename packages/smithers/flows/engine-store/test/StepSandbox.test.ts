import { describe, expect, it } from "@effect/vitest"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as SandboxedExecution from "../src/internal/SandboxedExecution.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const decoder = new TextDecoder()
const descriptor: FileBoundary = {
  readSet: [{ path: "src/input.txt", digest: sha256("input") }],
  writeSet: ["out/result.txt"],
  boundaryMode: "hard"
}

describe("StepSandbox", () => {
  it.effect("exposes declared reads and copies declared writes back", () =>
    Effect.gen(function*() {
      const memory = yield* withCrypto(WorkspaceSandbox.makeMemory({ "src/input.txt": "input" }))
      const service = StepSandbox.make(memory.service)
      const sandbox = yield* withCrypto(service.open)
      const settlement = yield* withCrypto(SandboxedExecution.execute({
        sandbox,
        descriptor,
        workflow: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const input = yield* fs.readFileString("src/input.txt")
          yield* fs.writeFileString("out/result.txt", `${input}!`)
          return input
        })
      }))
      expect(settlement.result).toBe("input")
      expect(settlement.files.map((file) => file.path)).toEqual(["out/result.txt"])
      const files = yield* withCrypto(memory.files)
      expect(decoder.decode(files.find((file) => file.path === "out/result.txt")?.content)).toBe("input!")
    }))

  it.effect("turns an undeclared read into the typed refusal", () =>
    Effect.gen(function*() {
      const memory = yield* withCrypto(WorkspaceSandbox.makeMemory({
        "src/input.txt": "input",
        "src/secret.txt": "secret"
      }))
      const failure = yield* withCrypto(Effect.flip(SandboxedExecution.execute({
        sandbox: memory.service,
        descriptor,
        workflow: Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("src/secret.txt"))
      })))
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/UndeclaredRead",
        code: "undeclared_read",
        paths: ["src/secret.txt"]
      })
    }))

  it.effect("keeps the typed refusal when the host copied only declared reads", () =>
    Effect.gen(function*() {
      const sandbox = WorkspaceSandbox.makeHosted({
        root: "",
        snapshot: () => Effect.succeed(new Map([["src/input.txt", new TextEncoder().encode("input")]])),
        baseline: () => Effect.succeed(undefined),
        retain: (bytes) => Effect.succeed(bytes),
        commit: () => Effect.void
      })
      const failure = yield* withCrypto(Effect.flip(SandboxedExecution.execute({
        sandbox,
        descriptor,
        workflow: Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("src/secret.txt"))
      })))
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/UndeclaredRead",
        code: "undeclared_read",
        paths: ["src/secret.txt"]
      })
    }))

  it.effect("leaves the host untouched when the scoped execution is interrupted", () =>
    Effect.gen(function*() {
      const memory = yield* withCrypto(WorkspaceSandbox.makeMemory({ "src/input.txt": "input" }))
      yield* withCrypto(Effect.gen(function*() {
        const fiber = yield* SandboxedExecution.execute({
          sandbox: memory.service,
          descriptor,
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/result.txt", "partial")
            return yield* Effect.never
          })
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(fiber)
      }))
      expect((yield* withCrypto(memory.files)).some((file) => file.path === "out/result.txt")).toBe(false)
    }))

  it.effect("provides deterministic and fail-closed layers", () =>
    Effect.gen(function*() {
      const opened = yield* withCrypto(
        Effect.flatMap(StepSandbox.StepSandbox, (service) => service.open).pipe(
          Effect.provide(StepSandbox.layerTest({ "src/input.txt": "input" }))
        )
      )
      expect(opened).toBeDefined()
      const unsupported = yield* withCrypto(
        Effect.flatMap(StepSandbox.StepSandbox, (service) => Effect.flip(service.open)).pipe(
          Effect.provide(StepSandbox.layerNoop)
        )
      )
      expect(unsupported).toMatchObject({ code: "unsupported_boundary" })
    }))
})
