import { describe, expect, it } from "vitest"
import { gateARun } from "../examples/gate-a-run.vibe"

describe("examples", () => {
  it("gate-a-run passes an unchanged run and fails a run whose score dropped", async () => {
    const { regressed, unchanged } = await gateARun()
    expect(unchanged.exitCode).toBe(0)
    expect(regressed.exitCode).toBe(1)
    expect(regressed.markdown).toContain("ada")
    expect(regressed.markdown).toContain("grace")
  })
})
