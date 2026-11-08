/**
 * The docs quickstart as a runnable program: compose a durable engine over one
 * SQLite file, run a sealed flow, then run it again from a second engine over
 * the same file and count how often the step body executed.
 *
 * `test/examples.test.ts` runs it against a temporary directory, so
 * `docs/quickstart.md` and this program stay in step.
 *
 * @since 1.0.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import {
  DurableEngineState,
  EngineStore,
  Migrations,
  OwnerIdentity,
  StepBoundary,
  WorkspaceSandbox
} from "@smthrs/engine-store"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import * as Workspace from "@smthrs/kernel/Workspace"
import { NodeHost } from "@smthrs/platform-node"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

const Measure = Action.make("quickstart/Measure", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "quickstart/measure/v1",
  implementationVersion: "measure/v1"
})

const Analyse = Flow.make("quickstart/Analyse", {
  payload: {},
  success: Schema.String,
  body: (payload) => Measure.call(payload)
})

const database = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )

const stores = (filename: string, root: string) =>
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    OwnerIdentity.layer,
    Workspace.layer(root),
    ArtifactStore.layerFileSystem({ directory: `${root}/.flows/objects` })
  ).pipe(Layer.provideMerge(database(filename)))

const engine = (filename: string, root: string, hostId: string) =>
  EngineStore.layer({
    owner: { hostId },
    journalSource: `${hostId}-engine`,
    isAlive: Ownership.sameHostPidProbe
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), NodeHost.layer)
    ),
    Layer.provideMerge(stores(filename, root)),
    Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, AtomicFileSystem.layer, NodePath.layer))
  )

/**
 * What the two quickstart runs observed.
 *
 * @category models
 * @since 1.0.0
 */
export interface QuickstartResult {
  /** The first engine's flow result. */
  readonly first: string
  /** The second engine's flow result, replayed from the recorded attempt. */
  readonly second: string
  /** How many times the sealed step body ran across both engines. */
  readonly executions: number
}

/**
 * Runs execution `analyse-1` on engine `worker-a`, then again on a second
 * engine, `worker-b`, built over the same SQLite file. The second run replays
 * the sealed step, so `executions` is 1 on a fresh file and 0 when the file
 * already holds the succeeded attempt.
 *
 * @param filename - The SQLite database file to create or open.
 * @param root - The workspace root; artifacts land under `<root>/.flows/objects`.
 * @returns Both flow results and the number of step-body executions.
 * @throws A defect when the composition, migrations, or either run fails.
 * @since 1.0.0
 * @category examples
 */
export const quickstart = (filename: string, root: string): Promise<QuickstartResult> => {
  const program = Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
    let executions = 0

    const implementation = Measure.toLayer(() =>
      Effect.sync(() => {
        executions += 1
        return "42"
      }), { implementationVersion: "measure/v1" })

    const flow = Layer.mergeAll(implementation, Interpreter.layer(Analyse)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    )

    const first = yield* Effect.scoped(
      Analyse.execute({}, { executionId: "analyse-1" }).pipe(
        Effect.provide(flow.pipe(Layer.provideMerge(engine(filename, root, "worker-a"))))
      )
    )

    // A second engine over the same file: a different process, in effect.
    const second = yield* Effect.scoped(
      Analyse.execute({}, { executionId: "analyse-1" }).pipe(
        Effect.provide(flow.pipe(Layer.provideMerge(engine(filename, root, "worker-b"))))
      )
    )

    return { first, second, executions }
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)), Effect.orDie)

  return Effect.runPromise(program)
}
