import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Policy from "../src/internal/ExecDestinationPolicy.ts"

const native = { mechanism: { _tag: "bubblewrap" }, network: "none" }

describe("destination restriction compatibility", () => {
  it("permits an absent allowlist without imposing a destination broker", () => {
    expect(Policy.refused(undefined, undefined, 0)).toBe(false)
  })
  it("permits a present allowlist only through a closed native launcher without secrets", () => {
    expect(Policy.refused([], native, 0)).toBe(false)
    expect(Policy.refused([], undefined, 0)).toBe(true)
    expect(Policy.refused([], { ...native, mechanism: { _tag: "docker" } }, 0)).toBe(true)
    expect(Policy.refused([], { ...native, network: "loopback" }, 0)).toBe(true)
    expect(Policy.refused([], native, 1)).toBe(true)
  })
})

it("returns the exact typed refusal before incompatible enforcement can proceed", async () => {
  const error = await Effect.runPromise(Effect.flip(Policy.validate([], undefined, 0, ["tool"], ".")))
  expect(error).toEqual({
    _tag: "smithers-build/ExecError",
    argv: ["tool"],
    cwd: ".",
    exitCode: -1,
    code: "sandbox_unenforceable",
    stdout: "",
    stderr: "sandbox: destination allowlists require bubblewrap with a closed network and no secret proxy"
  })
  expect(await Effect.runPromise(Policy.validate([], native, 0, ["tool"], "."))).toBeUndefined()
})
