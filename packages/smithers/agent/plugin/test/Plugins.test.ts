import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { SequentialHook } from "../src/Hooks.vibe"
import type { FlowsPlugin } from "../src/index.ts"
import * as Kernel from "../src/Kernel.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

const invalidResults = [
  { name: "forgot-return", handler: () => undefined, type: "undefined" },
  { name: "scalar", handler: () => 42, type: "number" },
  { name: "async", handler: () => Promise.resolve(), type: "object" }
]

interface TestHooks {
  readonly observe: SequentialHook<() => Effect.Effect<void>>
}

describe("non-Effect handler results", () => {
  describe.each([1, 16])("observer concurrency %i", (parallelConcurrency) => {
    it.each(invalidResults)("isolates $name without rejecting Kernel.make", async ({ name, handler, type }) => {
      const seen: Array<string> = []
      const kernel = await Effect.runPromise(Kernel.make(
        [
          { name, hooks: { configResolved: handler } } as unknown as FlowsPlugin,
          { name: "sibling", hooks: { configResolved: () => Effect.sync(() => void seen.push("sibling")) } }
        ],
        {},
        { parallelConcurrency }
      ))
      expect(kernel.observerErrors).toHaveLength(1)
      expect(kernel.observerErrors[0]).toMatchObject({ code: "hook_failed", plugin: name, hook: "configResolved" })
      expect(kernel.observerErrors[0]?.message).toContain(type)
      expect(kernel.observerErrors[0]?.message).toContain(name)
      expect(kernel.observerErrors[0]?.message).toContain("configResolved")
      expect(seen).toEqual(["sibling"])
    })

    it("collects one attributed failure per bad observer and runs siblings", async () => {
      const seen: Array<string> = []
      const kernel = await Effect.runPromise(Kernel.make(
        [
          ...invalidResults.map(({ name, handler }) =>
            ({ name, hooks: { configResolved: handler } }) as unknown as FlowsPlugin
          ),
          { name: "sibling", hooks: { configResolved: () => Effect.sync(() => void seen.push("sibling")) } }
        ],
        {},
        { parallelConcurrency }
      ))
      expect(kernel.observerErrors.map(({ code, plugin, hook }) => ({ code, plugin, hook }))).toEqual(
        invalidResults.map(({ name }) => ({ code: "hook_failed", plugin: name, hook: "configResolved" }))
      )
      expect(seen).toEqual(["sibling"])
    })
  })

  it.each(invalidResults)(
    "fails sequential dispatch at $name through the typed channel",
    async ({ name, handler, type }) => {
      const seen: Array<string> = []
      const resolved = await Effect.runPromise(Resolve.resolve<TestHooks>([
        { name: "before", hooks: { observe: () => Effect.sync(() => void seen.push("before")) } },
        { name, hooks: { observe: handler } } as unknown as FlowsPlugin<TestHooks>,
        { name: "after", hooks: { observe: () => Effect.sync(() => void seen.push("after")) } }
      ], { hooks: { observe: "sequential" } }))
      const error = await Effect.runPromise(Plugins.make(resolved).sequential("observe").pipe(Effect.flip))
      expect(error).toMatchObject({ code: "hook_failed", plugin: name, hook: "observe" })
      expect(error.message).toContain(type)
      expect(seen).toEqual(["before"])
    }
  )
})
