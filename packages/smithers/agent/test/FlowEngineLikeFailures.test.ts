import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * The failure edges of the flow-engine port.
 *
 * The happy paths are asserted where they belong: `CellSandbox` for the
 * workspace transaction and `FlowEngineLike` for the port itself. What is left
 * is what only shows up when a seam refuses: an unkeyable sealed call, a
 * sandbox that cannot execute or materialize, and an invalidated execution.
 * Every one has to arrive as a typed `HarnessError`, because the cell boundary
 * can only catch what is typed.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Option } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { describe, expect, it } from "vitest"
import * as FlowEngineLike from "../src/FlowEngineLike.vibe"
import * as InMemoryWorkspaceSandbox from "../src/InMemoryWorkspaceSandbox.ts"
import type * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"

const run = <A, E>(effect: Effect.Effect<A, E, (EffectDigest.Digest | SecureRandom.SecureRandom)>) =>
  Effect.runPromise(Effect.provide(effect, NodeCrypto.layer))

const effects: Descriptor.EffectDeclaration = {
  reads: [],
  writes: [],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
}

const identity = new Cell.CallIdentity({
  session: "session-failures",
  frame: 0,
  cell: "cell-digest",
  ordinal: 0,
  declaration: "declaration-digest",
  layers: ["layer-a"]
})

const call = (input: unknown = { path: "notes/todo.md" }) =>
  new Cell.Call({
    flowName: "fs/write",
    input: input as Cell.Call["input"],
    capabilities: [],
    effects,
    placement: Option.none(),
    identity
  })

const provenance: WorkspaceSandbox.Provenance = {
  baseRevision: "base",
  inputs: [],
  outputs: []
}

/** A runner that never runs: every case here fails before or around it. */
const runner: FlowEngineLike.WorkspaceCallRunner = {
  run: () => Effect.succeed(Cell.CallResult.new({ outcome: "success", value: "ran" }))
}

/**
 * The loose shape a sandbox stub is written against.
 *
 * `WorkspaceSandbox.Service.execute` is generic in the workflow's own output
 * and error and requires `Crypto`; a stub that ignores its argument cannot
 * produce either type parameter, and a stub that runs the workflow inherits
 * the workflow's declared `Workspace | FileSystem` requirements. Every
 * workflow these cases supply needs nothing from the workspace, so the stubs
 * are written against this shape and widened once in {@link sandboxOf}.
 */
interface SandboxStub {
  readonly execute: (
    execution: WorkspaceSandbox.Execution<unknown, unknown>
  ) => Effect.Effect<unknown, unknown, never>
  readonly materialize: (
    accepted: WorkspaceSandbox.Accepted<unknown>
  ) => Effect.Effect<void, unknown, never>
}

const sandboxOf = (
  overrides: Partial<SandboxStub>
): WorkspaceSandbox.Service =>
  ({
    execute: (execution) =>
      Effect.map(execution.workflow as Effect.Effect<unknown, unknown>, (output) => ({
        _tag: "Accepted" as const,
        result: { output, files: [], provenance, effects: [] },
        cache: "disabled" as const,
        violations: []
      })),
    materialize: () => Effect.void,
    ...overrides
  } satisfies SandboxStub) as unknown as WorkspaceSandbox.Service

describe("the sandboxed call runner", () => {
  it("reports an unkeyable sealed call as a typed harness failure", async () => {
    // A lone surrogate has no canonical form, so the call cannot be digested
    // into the cache key a sealed call is addressed by.
    const error = await run(
      Effect.gen(function*() {
        const sandbox = yield* InMemoryWorkspaceSandbox.make()
        const calls = yield* FlowEngineLike.sandboxed(sandbox.service, runner)
        return yield* Effect.flip(
          calls.run(call({ path: "\uD800" })).pipe(
            Effect.provideService(Action.CurrentCacheEnvironment, { layers: [], capabilities: {} })
          )
        )
      })
    )

    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe("engine_failed")
    expect(error.message).toContain("could not be keyed")
  })

  it("wraps a sandbox that cannot execute, and passes a typed one through", async () => {
    const wrapped = await run(
      Effect.gen(function*() {
        const calls = yield* FlowEngineLike.sandboxed(
          sandboxOf({ execute: () => Effect.fail(new Error("the host lost the workspace")) }),
          runner
        )
        return yield* Effect.flip(calls.run(call()))
      })
    )
    expect(wrapped.message).toContain("could not run in its workspace sandbox")

    // A `HarnessError` from the body is already the boundary's vocabulary and
    // travels unchanged rather than being wrapped a second time.
    const typed = new HarnessError({ code: "engine_failed", message: "unknown flow" })
    const passed = await run(
      Effect.gen(function*() {
        const calls = yield* FlowEngineLike.sandboxed(
          sandboxOf({ execute: () => Effect.fail(typed) }),
          runner
        )
        return yield* Effect.flip(calls.run(call()))
      })
    )
    expect(passed).toBe(typed)
  })

  it("turns an invalidated execution into a catchable call failure, not a run failure", async () => {
    const result = await run(
      Effect.gen(function*() {
        const calls = yield* FlowEngineLike.sandboxed(
          sandboxOf({
            execute: () =>
              Effect.succeed({
                _tag: "Invalidated" as const,
                provenance,
                violations: [{ kind: "undeclared-write" as const, resource: { kind: "file", id: "notes/secret.md" } }]
              })
          }),
          runner
        )
        return yield* calls.run(call())
      })
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("undeclared-write notes/secret.md")
  })

  it("reports a materialization that cannot be applied", async () => {
    const error = await run(
      Effect.gen(function*() {
        const calls = yield* FlowEngineLike.sandboxed(
          sandboxOf({ materialize: () => Effect.fail(new Error("copy-back lost its precondition")) }),
          runner
        )
        return yield* Effect.flip(calls.run(call()))
      })
    )

    expect(error.message).toContain("could not materialize its workspace changes")
  })

  it("keys an unsealed placed call by cell identity instead of by content", async () => {
    // Not sealed: the call carries no cache key, so the sandbox memo is
    // disabled and the material folds in the whole cell identity. A placement
    // is part of that material too.
    const executed: Array<WorkspaceSandbox.Execution<unknown, unknown>> = []
    const result = await run(
      Effect.gen(function*() {
        const calls = yield* FlowEngineLike.sandboxed(
          sandboxOf({
            execute: (execution) => {
              executed.push(execution)
              return Effect.map(execution.workflow as Effect.Effect<unknown, unknown>, (output) => ({
                _tag: "Accepted" as const,
                result: { output, files: [], provenance, effects: [] },
                cache: "disabled" as const,
                violations: []
              }))
            }
          }),
          runner
        )
        return yield* calls.run(
          new Cell.Call({
            flowName: "fs/write",
            input: { path: "notes/todo.md" },
            capabilities: [],
            effects: { ...effects, tier: "compensable" },
            placement: Option.some("sandbox" as const),
            identity
          })
        )
      })
    )

    expect(result.outcome).toBe("success")
    expect(executed).toHaveLength(1)
    expect(executed[0]!.cacheKey).toBeUndefined()
  })

  it("carries the wrapped runner's authorization decision", async () => {
    const authorize = () => Effect.succeed(true)
    const calls = await run(
      FlowEngineLike.sandboxed(sandboxOf({}), { ...runner, authorize })
    )

    expect(calls.authorize).toBe(authorize)
  })
})

describe("callMaterial", () => {
  it("content-addresses a sealed call and folds its placement in", () => {
    const material = FlowEngineLike.callMaterial(
      new Cell.Call({
        flowName: "fs/write",
        input: { path: "notes/todo.md" },
        capabilities: [],
        effects,
        placement: Option.some("remote" as const),
        identity
      }),
      ["layer-a"]
    )

    expect(material.kind).toBe("sealed")
    expect(material.body).toMatchObject({ _tag: "CellCall", placement: "remote" })
    // Sealed means reusable wherever the same declaration appears, so nothing
    // about *which* cell issued it may enter the material.
    expect(material.body).not.toHaveProperty("session")
    expect(material.layers).toEqual(["layer-a"])
  })

  it("folds the checkpoint a call names into what the call asked for", () => {
    // A reading of the pinned tree and the same command against the tree as it
    // stands are two different questions, so they key differently. A call that
    // names none keys byte-identically to every call written before checkpoints
    // existed, because an absent `at` spreads to nothing.
    const at = FlowEngineLike.callMaterial(
      new Cell.Call({
        flowName: "bash",
        input: { command: "run-tests" },
        capabilities: [],
        effects,
        placement: Option.none(),
        identity,
        at: "cp-0-0"
      })
    )
    const live = FlowEngineLike.callMaterial(
      new Cell.Call({
        flowName: "bash",
        input: { command: "run-tests" },
        capabilities: [],
        effects,
        placement: Option.none(),
        identity
      })
    )

    expect(at.body).toMatchObject({ at: "cp-0-0" })
    expect(live.body).not.toHaveProperty("at")
  })

  it("scopes an unsealed call to the cell invocation that issued it", () => {
    const material = FlowEngineLike.callMaterial(
      new Cell.Call({
        flowName: "fs/write",
        input: { path: "notes/todo.md" },
        capabilities: [],
        effects: { ...effects, tier: "compensable" },
        placement: Option.none(),
        identity
      })
    )

    expect(material.kind).toBe("compensable")
    expect(material.body).toMatchObject({
      session: "session-failures",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0
    })
    expect(material.body).not.toHaveProperty("placement")
  })
})
