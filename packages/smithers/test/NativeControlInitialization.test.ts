import { NodeServices } from "@effect/platform-node"
import { ControlRuntime } from "@smthrs/control"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer } from "effect"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as ControlDatabase from "../src/internal/ControlDatabase.vibe"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { platform } from "../src/internal/NodeControlHost.vibe"
import * as NodeControl from "../src/NodeControl.ts"

it("constructs reusable hosts without evaluating approval configuration", async () => {
  let reads = 0
  const host = NativeControl.make({
    ...platform,
    bearerPrincipal: {
      get id() {
        reads++
        return "gateway" as const
      },
      kind: "bearer"
    }
  })
  const authorization = host.gatewayApprovalAuthority.authorize({
    principal: { id: "gateway", kind: "bearer", stampedAt: 1 },
    target: { _tag: "Plan", planId: "plan", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } },
    decision: "approved",
    scope: "once"
  })
  expect(reads).toBe(0)
  await Effect.runPromise(authorization)
  expect(reads).toBe(1)
})

it.skipIf(process.platform === "win32")("preserves an existing caller-selected database parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-db-parent-"))
  try {
    await chmod(root, 0o750)
    const file = join(root, "control.sqlite")
    await Effect.runPromise(Effect.void.pipe(Effect.provide(ControlDatabase.layer(file))))
    expect((await stat(root)).mode & 0o777).toBe(0o750)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("shares one initial disk registry across concurrent drift reads and releases it", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-disk-registry-"))
  let acquired = 0
  let released = 0
  try {
    const directory = join(root, ".smithers", "flows", "review")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "flow.mdx"), "---\ndescription: Review\nmodel: anthropic:test-model\n---\nReview\n")
    const registry = Registry.layerProject({ root }).pipe(
      Layer.provide(NodeServices.layer),
      Layer.orDie,
      Layer.tap(() =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired++
          }).pipe(Effect.andThen(Effect.sleep("50 millis"))),
          () =>
            Effect.sync(() => {
              released++
            })
        )
      )
    )
    const engine = NodeControl.engineDurable(root, registry)
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "review", input: {} })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal(), "run")
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die("run not started")
        const read = runtime.codeDrift(launched.run.runId)
        const results = yield* Effect.all([read, read, read], { concurrency: "unbounded" })
        expect(results).toEqual([undefined, undefined, undefined])
        expect(acquired).toBe(2)
        yield* read
        expect(acquired).toBe(2)
        expect(released).toBe(0)
      }).pipe(Effect.provide(engine.runtime), Effect.scoped)
    )
    expect(released).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
