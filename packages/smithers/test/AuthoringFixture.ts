/** Scripted authoring, real filesystem transactions and real engine receipts. */
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { Plan } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as ArtifactStore from "../flows/artifacts/src/ArtifactStore.ts"

export const authoredFlowId = "authoring-demo"
export const authoredPath = `flows/${authoredFlowId}/flow.ts`
export const Read = Action.make("authoring/Read", { payload: {}, success: Schema.String })
export const Validate = Action.make("authoring/Validate", { payload: {}, success: Schema.String })

const source = (version: number) => `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Read, Validate } from ${JSON.stringify(import.meta.url)}
export const flow = Flow.make("authoring-demo", {
  payload: {}, success: Schema.Unknown, error: Schema.Unknown,
  body: () => Node.all({ read: Read.call({})${version === 2 ? ", validate: Validate.call({})" : ""} })
})
`

const WriteSource = Action.make("authoring/WriteSource", {
  payload: { version: Schema.Number }, success: Schema.String,
  implementationVersion: "1", fileBoundary: { readSet: [], writeSet: [authoredPath], boundaryMode: "hard" },
  idempotencyKey: ({ version }: { readonly version: number }) => `author-source:${version}`
})
export const ScriptedAuthor = Flow.make("create-flow", {
  payload: { args: Schema.String }, success: Schema.Unknown, error: Schema.Unknown,
  body: ({ args }) => WriteSource.call({ version: args.startsWith("Add validation") ? 2 : 1 })
})

// Flow.call splices the newly imported source graph into the wrapper's interpreter.
type Authored = ReturnType<typeof Flow.make<"authoring-demo", {}, typeof Schema.Unknown, typeof Schema.Unknown, never>>

export const makeAuthoringFixture = (root: string) => {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n')
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
  const nodes = new Map<string, ReturnType<typeof ScriptedAuthor.call>>()
  const compile = (flow: typeof ScriptedAuthor | Authored, input: unknown, planId: string, flowId: string) => {
    const built = Graph.build(flow, input as never)
    nodes.set(planId, flow === ScriptedAuthor ? ScriptedAuthor.child(input as { args: string }) : (flow as Authored).call({}))
    return Plan.compile({ planId, flow: flowId, nodes: Graph.drafts(built) }).pipe(
      Effect.map(plan => ({ plan, graph: { edges: Graph.edges(built) } })),
      Effect.provide(NodeCrypto.layer), Effect.orDie
    )
  }
  const envelope = { capabilities: [], flows: [], budget: {} }
  const flows: ReadonlyArray<DurableFlow> = [
    { flowId: "create-flow", description: "Scripted source authoring fixture", deployClass: false, envelope,
      plan: (input, planId) => compile(ScriptedAuthor, input, planId, "create-flow") },
    { flowId: authoredFlowId, description: "Flow written by the authoring fixture", deployClass: false, envelope,
      plan: (_input, planId) => Effect.promise(async () => {
        // Import the bytes just read under their digest. Retain that module for
        // this plan's execution, even if a later edit changes the working file.
        const path = join(root, authoredPath)
        const bytes = readFileSync(path)
        const digest = createHash("sha256").update(bytes).digest("hex")
        const pinned = join(root, `flow-${digest}.ts`)
        writeFileSync(pinned, bytes)
        return await import(pathToFileURL(pinned).href) as { flow: Authored }
      }).pipe(Effect.flatMap(module => compile(module.flow, {}, planId, authoredFlowId)), Effect.orDie) }
  ]
  const host = KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer), Layer.provide(Path.layer),
    Layer.provide(KernelWorkspace.layer(root)), Layer.provide(GrantStore.layerNoop)
  )
  const artifacts = ArtifactStore.layerMemory.pipe(Layer.provideMerge(host))
  const filesystem = Layer.mergeAll(
    StepBoundary.layer.pipe(Layer.provide(artifacts)),
    WorkspaceSandbox.layerFileSystem().pipe(Layer.provide(artifacts), Layer.provide(KernelWorkspace.layer(root)))
  ).pipe(Layer.provideMerge(artifacts))
  const implementations = Layer.mergeAll(
    Read.toLayer(() => Effect.succeed("read")), Validate.toLayer(() => Effect.succeed("validated")),
    WriteSource.toLayer(({ version }: { readonly version: number }) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(authoredPath, source(version))
      return authoredPath
    }).pipe(Effect.orDie), { implementationVersion: "1" })
  )
  return { root, flows, filesystem, implementations, node: (planId: string) => nodes.get(planId) }
}
