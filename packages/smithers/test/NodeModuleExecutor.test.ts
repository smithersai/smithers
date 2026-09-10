/** Real control admission, discovery, native children and durable host policy. */
import { NodeCrypto } from "@effect/platform-node"
import * as Budget from "@smthrs/agent/Budget"
import { Control, ControlRuntime } from "@smthrs/control"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as CoreFlow from "../flows/core/src/Flow.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { ModuleOwner } from "../src/internal/ModuleOwner.ts"

const definition = {
  description: "A native module with durable children.",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Unknown,
  capabilities: ["fs:read:**"],
  flows: ["test/Module"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

describe("NodeControl native modules", () => {
  it.each(["narrow", "drift", "sql"] as const)(
    "restores authority and rechecks approved source between native children (mode: %s)",
    async (mode) => {
      const drift = mode === "drift"
      const root = await mkdtemp(join(tmpdir(), "smithers-module-host-"))
      const observed: Array<unknown> = []
      const owners: Array<{ readonly rootId: string; readonly flowId: string }> = []
      let admittedRoot: string | undefined
      try {
        await mkdir(join(root, "flows", "native"), { recursive: true })
        await writeFile(
          join(root, "flows", "native", "flow.ts"),
          `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({
  description: "A native module with durable children.",
  input: Schema.Struct({ value: Schema.String }), output: Schema.Unknown,
  capabilities: ["fs:read:**"], flows: ["test/Module"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`
        )
        const Probe = Action.make("test/Probe", {
          payload: { value: Schema.String },
          success: Schema.Number,
          error: Schema.Unknown
        })
        const Child = Flow.make("test/Child", {
          payload: { value: Schema.String },
          success: Schema.Number,
          error: Schema.Unknown,
          body: Probe.call
        })
        const Module = Flow.make("test/Module", {
          payload: Executable.Invocation,
          success: Schema.Number,
          error: Schema.Unknown,
          body: ({ input }) =>
            Child.child({ value: `${(input as { value: string }).value}/first` }).pipe(
              Node.andThen(Child.child({ value: `${(input as { value: string }).value}/second` }))
            )
        })
        const native = Layer.mergeAll(
          Interpreter.layer(Module),
          Interpreter.layer(Child),
          Probe.toLayer(({ value }) =>
            Effect.gen(function*() {
              const authority = yield* CapabilitySet.current
              const owner = yield* Effect.serviceOption(ModuleOwner)
              if (Option.isNone(owner)) return yield* Effect.die("native handler has no proved owner")
              owners.push(owner.value)
              const budget = yield* Budget.Budget
              yield* budget.record("same-step", { totalTokens: 3 })
              const usage = yield* budget.usage
              const verdict = yield* budget.check("next-step")
              observed.push({ value, groups: authority.groups, usage, verdict: verdict._tag })
              if (drift && value.endsWith("/first")) {
                yield* Effect.promise(() =>
                  writeFile(join(root, "flows", "native", "flow.ts"), "// changed after approval\n")
                )
              }
              return usage.tokens
            })
          )
        )
        const modules = Executable.layer({
          delegates: [Module],
          load: () => Effect.succeed({ default: CoreFlow.make(definition) })
        }).pipe(Layer.provideMerge(native), Layer.orDie)
        const registry = NodeControl.layerRegistry(root)
        const descriptor = await Effect.runPromise(Registry.Registry.pipe(
          Effect.flatMap((service) => service.get("native")),
          Effect.provide(registry),
          Effect.scoped
        ))
        const engine = NodeControl.engineDurable(root, registry)
        // The actual approved envelope is deliberately narrower than discovery's
        // conservative collaborator wildcard. A child must preserve it on its
        // own scheduler fiber, and siblings must share its spending ceiling.
        const runtime = ControlRuntime.layerMemory({
          flows: [{
            flowId: "native",
            executionDigest: Descriptor.executionDigest(descriptor),
            description: definition.description,
            deployClass: false,
            envelope: { capabilities: ["fs:read:**"], flows: ["test/Module"], budget: { tokens: 6 } }
          }]
        }).pipe(Layer.provide(NodeCrypto.layer))
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control.Control
            const card = yield* control.plan({ flowId: "native", input: { value: "approved" } })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: "native-test"
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected admission")
            }
            admittedRoot = receipt.runId
            // These are the existing control events read by the gateway. Native
            // completion must reach this journal, not just the engine database.
            return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
              Stream.filter((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("30 seconds")
            )
          }).pipe(
            Effect.provide(
              NodeControl.layerControl({ root }, registry, mode === "sql" ? engine : { ...engine, runtime }, modules)
            ),
            Effect.scoped
          )
        )
        expect(result[0]?.kind).toBe(drift ? "control.run.failed" : "control.run.completed")
        const expected = [
          {
            value: "approved/first",
            groups: mode === "sql" ? expect.any(Array) : [[{ action: "fs:read", resource: "**" }]],
            usage: { tokens: 3, calls: 1, largestCall: 3 },
            verdict: "proceed"
          },
          {
            value: "approved/second",
            groups: mode === "sql" ? expect.any(Array) : [[{ action: "fs:read", resource: "**" }]],
            usage: { tokens: 6, calls: 2, largestCall: 3 },
            verdict: mode === "sql" ? "proceed" : "refuse"
          }
        ]
        expect(observed).toEqual(drift ? expected.slice(0, 1) : expected)
        expect(owners).toEqual(observed.map(() => ({ rootId: admittedRoot, flowId: "native" })))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )
})
