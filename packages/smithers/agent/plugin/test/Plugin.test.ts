import { describe, expect, it } from "vitest"
import * as Plugin from "../src/Plugin.vibe"

describe("Plugin.make", () => {
  it("is an identity constructor that returns the same plugin object", () => {
    const plugin = { name: "flows-plugin-test" }
    expect(Plugin.make(plugin)).toBe(plugin)
  })

  it("preserves declared enforce, apply, and hooks", () => {
    const apply = () => true
    const plugin = Plugin.make({ name: "flows-plugin-full", enforce: "pre", apply, hooks: {} })
    expect(plugin.enforce).toBe("pre")
    expect(plugin.apply).toBe(apply)
    expect(plugin.hooks).toEqual({})
  })
})
