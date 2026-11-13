import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Cause, Effect, Exit, Layer } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import { describe, expect, it } from "vitest"
import * as InMemoryWorkspaceSandbox from "../src/InMemoryWorkspaceSandbox.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const descriptor = (
  reads: ReadonlyArray<string> = [],
  writes: ReadonlyArray<string> = [],
  boundaryMode: FileBoundary["boundaryMode"] = "hard"
): FileBoundary => ({
  readSet: reads.map((path) => ({ path, digest: `prepared:${path}` })),
  writeSet: writes,
  boundaryMode
})

const run = <A, E>(effect: Effect.Effect<A, E, (EffectDigest.Digest | SecureRandom.SecureRandom)>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeCrypto.layer)))

const text = (files: ReadonlyArray<InMemoryWorkspaceSandbox.HostFile>, path: string): string | undefined => {
  const file = files.find((candidate) => candidate.path === path)
  return file === undefined ? undefined : decoder.decode(file.content)
}

describe("WorkspaceSandbox", () => {
  it("returns functional files and queued effects without changing the host before materialization", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make({ "src/input.txt": "hello" }))
    const execution = test.service.execute({
      descriptor: descriptor(["src/input.txt"], ["out/result.txt"]),
      cacheKey: "render-v1",
      workflow: Effect.gen(function*() {
        const workspace = yield* WorkspaceSandbox.Workspace
        const input = decoder.decode(yield* workspace.readFile("src/input.txt"))
        yield* workspace.writeFile("out/result.txt", encoder.encode(`${input} world`))
        yield* workspace.queueEffect({
          protocol: "chat/v1",
          idempotencyKey: "reply-1",
          payload: { message: "finished" }
        })
        return { rendered: true, count: 1 }
      })
    })

    const accepted = await run(execution)
    expect(accepted._tag).toBe("Accepted")
    expect(text(await Effect.runPromise(test.files), "out/result.txt")).toBeUndefined()
    if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
    expect(accepted.result.output).toEqual({ rendered: true, count: 1 })
    expect(accepted.result.provenance.inputs).toHaveLength(1)
    expect(accepted.result.provenance.outputs).toHaveLength(1)
    expect(accepted.result.effects).toEqual([{
      protocol: "chat/v1",
      idempotencyKey: "reply-1",
      payload: { message: "finished" }
    }])
    expect(decoder.decode(accepted.result.files[0]?.after)).toBe("hello world")

    await run(test.service.materialize(accepted))
    expect(text(await Effect.runPromise(test.files), "out/result.txt")).toBe("hello world")
  })

  it("invalidates and discards undeclared reads and writes", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make({
      "src/declared.txt": "declared",
      "src/secret.txt": "secret"
    }))
    const invalidated = await run(test.service.execute({
      descriptor: descriptor(["src/declared.txt"], ["out/declared.txt"]),
      workflow: Effect.gen(function*() {
        const workspace = yield* WorkspaceSandbox.Workspace
        const secret = yield* workspace.readFile("src/secret.txt")
        yield* workspace.writeFile("out/surprise.txt", secret)
        yield* workspace.queueEffect({
          protocol: "chat/v1",
          idempotencyKey: "must-not-dispatch",
          payload: { leaked: true }
        })
        return { leaked: true }
      })
    }))

    expect(invalidated).toMatchObject({
      _tag: "Invalidated",
      violations: [
        { kind: "undeclared-read", resource: { kind: "file", id: "src/secret.txt" } },
        { kind: "undeclared-write", resource: { kind: "file", id: "out/surprise.txt" } }
      ]
    })
    expect(text(await Effect.runPromise(test.files), "out/surprise.txt")).toBeUndefined()
  })

  it("replays memoized results by the engine-supplied cache key", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make({ "src/input.txt": "same input" }))
    let runs = 0
    const workflow = Effect.gen(function*() {
      runs = runs + 1
      const workspace = yield* WorkspaceSandbox.Workspace
      const input = yield* workspace.readFile("src/input.txt")
      yield* workspace.writeFile("out/result.txt", input)
      return { value: decoder.decode(input) }
    })
    const execution = {
      descriptor: descriptor(["src/input.txt"], ["out/result.txt"]),
      cacheKey: "same-render-v1",
      workflow
    }

    const first = await run(test.service.execute(execution))
    const replay = await run(test.service.execute(execution))

    expect(first).toMatchObject({ _tag: "Accepted", cache: { status: "miss" } })
    expect(replay).toMatchObject({ _tag: "Accepted", cache: { status: "hit" } })
    expect(runs).toBe(1)
  })

  it("refuses to materialize over a changed output base", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make({ "out/result.txt": "base" }))
    const execute = (value: string) =>
      test.service.execute({
        descriptor: descriptor([], ["out/result.txt"]),
        cacheKey: `writer:${value}`,
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          yield* workspace.writeFile("out/result.txt", encoder.encode(value))
          return { value }
        })
      })

    const stale = await run(execute("stale"))
    const current = await run(execute("current"))
    if (stale._tag !== "Accepted" || current._tag !== "Accepted") throw new Error("expected accepted executions")
    await run(test.service.materialize(current))
    const conflict = await Effect.runPromiseExit(
      test.service.materialize(stale).pipe(Effect.provide(NodeCrypto.layer))
    )

    expect(Exit.isFailure(conflict) ? Cause.findErrorOption(conflict.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: WorkspaceSandbox.MaterializationConflict.identifier, paths: ["out/result.txt"] }
    })
    expect(text(await Effect.runPromise(test.files), "out/result.txt")).toBe("current")
  })

  it("supports removals and replays their functional result", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make({ "out/old.txt": "old" }))
    let runs = 0
    const execution = {
      descriptor: descriptor([], ["out/old.txt"]),
      cacheKey: "remove-old-v1",
      workflow: Effect.gen(function*() {
        runs = runs + 1
        const workspace = yield* WorkspaceSandbox.Workspace
        yield* workspace.removeFile("out/old.txt")
        return ["removed"]
      })
    }

    const first = await run(test.service.execute(execution))
    const replay = await run(test.service.execute(execution))
    if (first._tag !== "Accepted" || replay._tag !== "Accepted") throw new Error("expected accepted executions")
    expect(first.result.files).toMatchObject([{
      path: "out/old.txt",
      afterDigest: undefined
    }])
    expect(replay.cache.status).toBe("hit")
    expect(runs).toBe(1)

    await run(test.service.materialize(replay))
    expect(text(await Effect.runPromise(test.files), "out/old.txt")).toBeUndefined()
  })

  it("disables memoization when the engine supplies no cache key", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make())
    let runs = 0
    const execution = {
      descriptor: descriptor(),
      workflow: Effect.sync(() => ({ run: ++runs }))
    }

    const first = await run(test.service.execute(execution))
    const second = await run(test.service.execute(execution))

    expect(first).toMatchObject({ _tag: "Accepted", cache: { status: "disabled" } })
    expect(second).toMatchObject({ _tag: "Accepted", cache: { status: "disabled" } })
    expect(runs).toBe(2)
  })

  it("rejects invalid paths and missing files", async () => {
    for (const path of ["", "/absolute.txt", "nested/../escape.txt", "."]) {
      const invalid = await Effect.runPromiseExit(
        InMemoryWorkspaceSandbox.make({ [path]: "invalid" }).pipe(Effect.provide(NodeCrypto.layer))
      )
      expect(Exit.isFailure(invalid) ? Cause.findErrorOption(invalid.cause) : undefined).toMatchObject({
        _tag: "Some",
        value: { _tag: WorkspaceSandbox.WorkspaceError.identifier, code: "invalid_path" }
      })
    }

    const test = await run(InMemoryWorkspaceSandbox.make({ "bytes.bin": encoder.encode("bytes") }))
    const missing = await Effect.runPromiseExit(
      test.service.execute({
        descriptor: descriptor(["missing.txt"]),
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          yield* workspace.readFile("missing.txt")
          return null
        })
      }).pipe(Effect.provide(NodeCrypto.layer))
    )
    expect(Exit.isFailure(missing) ? Cause.findErrorOption(missing.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: WorkspaceSandbox.WorkspaceError.identifier, code: "not_found" }
    })
    expect(text(await Effect.runPromise(test.files), "bytes.bin")).toBe("bytes")
  })

  it("normalizes relative paths and omits unchanged writes from the file diff", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make({
      "src/b.txt": "b",
      "src/a.txt": "a"
    }))
    const accepted = await run(test.service.execute({
      descriptor: descriptor(["src/a.txt"], ["src/**"]),
      workflow: Effect.gen(function*() {
        const workspace = yield* WorkspaceSandbox.Workspace
        const input = yield* workspace.readFile("./src//a.txt")
        yield* workspace.writeFile("src/a.txt", input)
        return { unchanged: true }
      })
    }))

    if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
    expect(accepted.result.files).toEqual([])
    expect(accepted.result.provenance.inputs[0]?.resource.id).toBe("src/a.txt")
  })

  it("provides the implementation as an Effect layer", async () => {
    const test = await run(InMemoryWorkspaceSandbox.make())
    const resolved = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* WorkspaceSandbox.WorkspaceSandbox
      }).pipe(Effect.provide(WorkspaceSandbox.layer(test.service)))
    )

    expect(resolved).toBe(test.service)
    expect(Layer.isLayer(WorkspaceSandbox.layer(test.service))).toBe(true)
  })
})
