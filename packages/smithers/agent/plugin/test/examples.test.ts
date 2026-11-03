import { describe, expect, it } from "vitest"
import { hostAHook } from "../examples/host-a-hook.vibe"

describe("examples", () => {
  it("host-a-hook freezes the agreed config and runs the pre plugin's tools first", async () => {
    const result = await hostAHook()
    expect(result.config).toEqual({ host: { name: "example" }, editor: { readOnly: false } })
    expect(Object.isFrozen(result.config)).toBe(true)
    expect(result.tools).toEqual(["grep", "read", "write"])
    expect(result.observerErrors).toEqual([])
  })
})
