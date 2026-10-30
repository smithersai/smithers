import { NodeRuntime } from "@smthrs/platform-node"
import { Effect } from "effect"
import { expect, it } from "vitest"
import * as EvaluationHost from "../src/evaluation/EvaluationHost.ts"

it("selects the real Bun adapter from an injected host identity under Node", async () => {
  expect("Bun" in globalThis).toBe(false)
  const selected = await Effect.runPromise(EvaluationHost.runtime.pipe(
    Effect.provideService(EvaluationHost.Host, { bun: true })
  ))
  expect(selected).toBe((await import("@smthrs/platform-bun")).BunRuntime)
  expect(selected).not.toBe(NodeRuntime)
  expect("Bun" in globalThis).toBe(false)
  expect(await Effect.runPromise(EvaluationHost.runtime)).toBe(NodeRuntime)
})
