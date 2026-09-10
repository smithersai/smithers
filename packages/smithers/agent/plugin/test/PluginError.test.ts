import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { PluginError, PluginErrorCode } from "../src/PluginError.ts"

describe("PluginError wire identity", () => {
  it("round-trips the persisted tagged-error golden vector with its prototype", () => {
    const golden = {
      _tag: "flows/plugin/PluginError",
      code: "hook_failed",
      message: "hook failed at the host boundary",
      plugin: "flows-plugin-golden",
      hook: "configResolved",
      path: "$.hooks.configResolved",
      cause: { reason: "observer failure", retryable: false }
    } as const
    const error = new PluginError({
      code: golden.code,
      message: golden.message,
      plugin: golden.plugin,
      hook: golden.hook,
      path: golden.path,
      cause: golden.cause
    })

    const encoded = Schema.encodeUnknownSync(PluginError)(error)
    expect(encoded).toEqual(golden)
    const decoded = Schema.decodeUnknownSync(PluginError)(encoded)
    expect(decoded).toBeInstanceOf(PluginError)
    expect(Schema.encodeUnknownSync(PluginError)(decoded)).toEqual(golden)
  })

  it("pins the exact ordered failure-code wire set", () => {
    expect(PluginErrorCode.literals).toEqual([
      "duplicate_name",
      "unknown_hook",
      "hook_kind_mismatch",
      "invalid_plugin",
      "apply_failed",
      "config_invalid",
      "cache_environment_invalid",
      "invalid_hook_result",
      "resource_limit",
      "hook_failed",
      "layer_failed"
    ])
  })
})
