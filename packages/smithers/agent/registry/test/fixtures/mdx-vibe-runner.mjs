import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, Exit, Layer, Scope } from "effect"
import { Discovery, Executable, ExecutionSnapshot } from "../../src/index.ts"

const root = await mkdtemp(fileURLToPath(new URL("./.mdx-vibe-", import.meta.url)))
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const scope = await Effect.runPromise(Scope.make())
const context = await Effect.runPromise(
  Layer.buildWithScope(Layer.mergeAll(platform, FlowEngine.layerMemory, Action.layerImplementations), scope)
)
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(context), Effect.provideService(Scope.Scope, scope)))
const scan = () =>
  run(
    Effect.gen(function*() {
      const discovery = yield* Discovery.Discovery
      return yield* discovery.scan({ root, naming: "path", source: "project" })
    }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))))
  )
const load = (descriptor, options = {}) => run(Executable.fromDescriptor(descriptor, { delegates: [], ...options }))

try {
  const flowDir = `${root}/review`
  await mkdir(flowDir, { recursive: true })
  await writeFile(`${flowDir}/package.json`, '{"name":"mdx-vibe-fixture","type":"module"}\n')
  await writeFile(
    `${flowDir}/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        allowArbitraryExtensions: true
      },
      include: ["*.vibe"]
    }, null, 2) + "\n"
  )
  await writeFile(`${flowDir}/prompt.mdx`, "# Review\n\nInspect **{props.args ?? \"repo\"}**.\n")
  await writeFile(
    `${flowDir}/prompt.d.mdx.ts`,
    'import type { Component } from "@smthrs/registry/Prompt"\n\ndeclare const Instructions: Component<{ readonly args?: string }>\nexport default Instructions\n'
  )
  await writeFile(
    `${flowDir}/flow.vibe`,
    `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import Instructions from "./prompt.mdx"

function acceptPrompt(prompt: (props: { readonly args?: string }) => string, args: string): string {
  return prompt({ args })
}

const Render = Action.make("review/Render", {
  implementationVersion: "review-render/v1",
  payload: { args: Schema.String },
  success: Schema.String
})

export const layer = Render.toLayer(
  ({ args }) => Effect.sync(() => acceptPrompt(Instructions, args)),
  { implementationVersion: "review-render/v1" }
)

export default Flow.make("review", {
  description: "Render a typed imported MDX prompt from a strict VibeLang flow.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: { args: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Render.name, implementationVersion: "review-render/v1" }, (props) => Render.call(props))
})
`
  )

  const discovered = await scan()
  assert.equal(discovered.warnings.length, 0, JSON.stringify(discovered.warnings))
  const descriptor = discovered.entries[0]
  assert.ok(descriptor.body.imports.some((entry) => entry.path === "prompt.mdx" && entry.contentDigest))
  assert.ok(descriptor.body.imports.some((entry) => entry.path === "prompt.d.mdx.ts" && entry.contentDigest))

  // Load and execute strict .vibe entry without allowJs (no TS7016, no EK0402)
  const loaded = await load(descriptor)
  const rendered = await run(
    loaded.flow.execute({ input: { args: "packages" } }, { executionId: "mdx-vibe-1" }).pipe(
      Effect.provide(loaded.layer)
    )
  )
  assert.equal(rendered, "# Review\n\nInspect **packages**.")

  // Private .vibe, .mjs, and .d.mts siblings are cleaned up after load
  const leftover = (await readdir(flowDir)).filter((name) => name.startsWith("smithers-"))
  assert.deepEqual(leftover, [])

  // Pinning and restoring through ExecutionSnapshot retains the measured declaration
  const snapshots = await run(ExecutionSnapshot.makeFileSystem({ root }))
  await run(snapshots.pin(loaded))

  // Tampering with prompt.d.mdx.ts after approval fails closed
  await writeFile(
    `${flowDir}/prompt.d.mdx.ts`,
    'import type { Component } from "@smthrs/registry/Prompt"\n\ndeclare const Instructions: Component<{ readonly args: number }>\nexport default Instructions\n'
  )
  await assert.rejects(load(descriptor), /changed at "prompt\.d\.mdx\.ts"/)

  // Restoring the pinned snapshot still loads and executes the approved declaration
  const restored = await load(descriptor, { snapshots, approvedDigest: descriptor.executionDigest })
  const restoredOutput = await run(
    restored.flow.execute({ input: { args: "snapshot" } }, { executionId: "mdx-vibe-2" }).pipe(
      Effect.provide(restored.layer)
    )
  )
  assert.equal(restoredOutput, "# Review\n\nInspect **snapshot**.")

  // Re-scanning with incompatible prompt.d.mdx.ts fails VibeLang typechecking (declaration is enforced, not any)
  const mismatched = (await scan()).entries[0]
  await assert.rejects(load(mismatched), (err) => {
    const cause = err && typeof err === "object" ? err.cause : undefined
    const causeMsg = cause && typeof cause === "object" && "message" in cause ? String(cause.message) : String(cause ?? "")
    const causeCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""
    return err?.code === "body_unavailable" && (causeCode === "ERR_VIBELANG_COMPILE" || /Type 'string' is not assignable to type 'number'|TS2345|TS2322/.test(causeMsg))
  })

  process.stdout.write(JSON.stringify({ runtime: "vibe-mdx", assertions: "passed" }))
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await rm(root, { recursive: true, force: true })
}
