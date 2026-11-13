import { describe, expect, it } from "vitest"
import * as Reference from "../src/Reference.ts"
import * as Shell from "../src/Shell.ts"

describe("Shell exec payload boundary values", () => {
  it("retains literal argv order and workspace flag sentinel references", () => {
    const flag = Reference.FlagRef.make({ name: "jobs" })
    const payload = Shell.execPayload({
      bin: Reference.runtimeBin,
      args: ["run", flag, "entry.ts"]
    })
    expect(payload.argv).toEqual([
      Shell.toolToken(Reference.runtimeBin),
      "run",
      Shell.flagToken("jobs"),
      "entry.ts"
    ])
  })

  it("copies an explicitly declared environment into the exec payload", () => {
    const env = { BUILD_MODE: "release" }
    const payload = Shell.execPayload({ shell: "echo ready", env })
    expect(payload.env).toEqual({ BUILD_MODE: "release" })
    expect(payload.env).not.toBe(env)
    env.BUILD_MODE = "debug"
    expect(payload.env).toEqual({ BUILD_MODE: "release" })
  })
})
