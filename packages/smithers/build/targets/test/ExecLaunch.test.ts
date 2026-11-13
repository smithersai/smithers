import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import { failureMessage } from "../src/GeneratedFile.ts"
import * as Launch from "../src/internal/ExecLaunch.ts"

const host = { shape: Exec.spawnShape, describe: failureMessage }
const refusal = (message: string, code: "spawn_failed") => ({ message, code })

it("prepares the actual platform-selected launcher without changing its arguments", async () => {
  expect(await Effect.runPromise(Launch.prepare(host, ["tool", "argument"], { platform: "linux" }, refusal)))
    .toEqual({ file: "tool", args: ["argument"], windowsVerbatimArguments: false })
})

it("maps the real Windows shim quoting refusal before any child can launch", async () => {
  const error = await Effect.runPromise(Effect.flip(
    Launch.prepare(host, ["tool.cmd", "%unrepresentable"], { platform: "win32", env: {} }, refusal)
  ))
  expect(error.code).toBe("spawn_failed")
  expect(error.message).toContain("cannot reach a Windows .cmd shim")
})
