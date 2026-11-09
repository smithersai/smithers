import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { NodeHost, NodeRuntime } from "@smthrs/platform-node"
import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { Failure, fromIntegrationError } from "../src/core/ActionFailure.vibe"
import { CursorStore, makeMemory } from "../src/core/CursorStore.vibe"
import { runWithCursor } from "../src/core/Source.vibe"

it("reopens SQLite after handling and replays the batch and handler before committing the cursor", async () => {
  const root = mkdtempSync(join(tmpdir(), "integration-source-resume-"))
  const reachedCommit = Effect.runSync(Deferred.make<void>())
  const cursors = Effect.runSync(makeMemory)
  let holdCommit = true
  let polls = 0
  let handled = 0
  // Inject a stalled cursor service at the precise crash boundary. Reads and
  // successful writes still go to the real in-memory CursorStore.
  const cursorLayer = Layer.succeed(
    CursorStore,
    CursorStore.of({
      get: cursors.get,
      set: (id, cursor) =>
        Effect.suspend(() =>
          holdCommit
            ? Effect.andThen(Deferred.succeed(reachedCommit, undefined), Effect.never)
            : cursors.set(id, cursor)
        )
    })
  )
  const step = Action.make("test/source/resume-step", {
    payload: {},
    error: Failure,
    tier: "irreversible",
    idempotencyKey: "source-driver/v1"
  })
  const flow = Flow.make("test/source/resume", { payload: {}, error: Failure, body: () => step.call({}) })
  const registration = Interpreter.layer(flow).pipe(
    Layer.provideMerge(step.toLayer(() =>
      runWithCursor("source", () =>
        Effect.sync(() => {
          polls++
          return { events: [], cursor: "next" }
        }), () =>
        Effect.sync(() => {
          handled++
        }), { maxTurns: 1 }).pipe(Effect.mapError(fromIntegrationError))
    )),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provide(cursorLayer)
  )
  const boot = () =>
    ManagedRuntime.make(
      NodeRuntime.layer(
        {
          filename: join(root, "engine.sqlite"),
          workspaceRoot: root,
          owner: { hostId: "source-resume-test" },
          // Both incarnations are sequential; the first is disposed before recovery.
          isAlive: () => Effect.succeed(false)
        },
        EngineStore.StepBoundary.layer,
        EngineStore.WorkspaceSandbox.layerFileSystem(),
        registration
      ).pipe(
        Layer.provide(Layer.merge(NodeHost.layerAt(root), NodeCrypto.layer))
      )
    )
  const execute = FlowRuntime.FlowRuntime.pipe(
    Effect.flatMap((engine) => engine.execute(flow, { payload: {}, executionId: "source-recovery" }))
  )
  const first = boot()
  let second: ReturnType<typeof boot> | undefined
  try {
    const pending = first.runPromise(execute).then(() => "complete", () => "interrupted")
    await Effect.runPromise(Deferred.await(reachedCommit))
    expect(polls).toBe(1)
    expect(handled).toBe(1)
    expect(Effect.runSync(cursors.get("source"))).toBeNull()
    await first.dispose()
    expect(await pending).toBe("interrupted")
    holdCommit = false
    second = boot()
    await second.runPromise(Effect.flatMap(FlowRuntime.FlowRuntime, (engine) => engine.resume(flow, "source-recovery")))
    await second.runPromise(execute)
    expect(Effect.runSync(cursors.get("source"))).toBe("next")
    expect(polls).toBe(1)
    expect(handled).toBe(1)
  } finally {
    await first.dispose()
    await second?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
