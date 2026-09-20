import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Layer } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { platform } from "../src/internal/NodeControlHost.ts"
import * as NodeControl from "../src/NodeControl.ts"

afterEach(() => vi.unstubAllEnvs())

it("refuses every local native entry before constructing or acquiring a database", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  let databases = 0
  const host = NativeControl.make({
    ...platform,
    database: () => {
      databases++
      return Layer.empty as never
    }
  })
  expect(() => host.layerHost({ root: "/unused" })).toThrow(CliError.UsageError)
  expect(() => host.layerControl({ root: "/unused" })).toThrow(/smithers run\/serve needs AI_GATEWAY_API_KEY,/)
  expect(databases).toBe(0)
  // The public Node wrapper used to materialize the stores before delegating.
  expect(() => NodeControl.layer({ root: "/unused" })).toThrow(CliError.UsageError)
  expect(() => NodeControl.layerControl({ root: "/unused" })).toThrow(CliError.UsageError)
})

it("accepts an explicitly scripted judge without reading credentials", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  const host = NativeControl.make({ ...platform, evaluator: ScriptedJudge.layer })
  expect(() => host.layerHost({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused", evaluator: ScriptedJudge.layer })).not.toThrow()
})

it("does not demand local credentials from a remote control client", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  expect(() => NodeControl.layerControl({ remote: "http://127.0.0.1:5300" })).not.toThrow()
})

it("preserves failures unrelated to evaluator configuration", () => {
  const failure = new Error("environment lookup failed")
  const environment = {
    get AI_GATEWAY_API_KEY(): string {
      throw failure
    }
  }
  const host = NativeControl.make(platform)
  expect(() => host.evaluatorFor(environment)).toThrow(failure)
})
